import express from 'express';
import fetch from 'node-fetch';
import { createClient } from 'redis';
import { Redis as UpstashRedis } from '@upstash/redis';
import { promises as fs } from 'fs';
import { spawn } from 'child_process';
import path from 'path';

const router = express.Router();

const redisUrl = process.env.REDIS_URL;
const redisPassword = process.env.REDIS_PASSWORD;
const upstashRedisRestUrl = process.env.UPSTASH_REDIS_REST_URL;
const upstashRedisRestToken = process.env.UPSTASH_REDIS_REST_TOKEN;
const cacheTtlSeconds = Number(process.env.CACHE_TTL_SECONDS) || 3600;
const localRawDir = path.resolve(process.cwd(), 'data', 'raw');
const localRawBakDir = path.join(localRawDir, 'bak');
const localDerivedDir = path.resolve(process.cwd(), 'data', 'derived');
const rawKeysIndexPath = path.join(localDerivedDir, 'raw-keys-index.json');
const rawKeysIndexCacheTtlMs = Number(process.env.RAW_KEYS_INDEX_CACHE_TTL_MS) || 5 * 60 * 1000;
const rawFileSuffix = '.json';
const redisClient = redisUrl ? createClient({ url: redisUrl, password: redisPassword }) : null;
const upstashRedisClient = upstashRedisRestUrl && upstashRedisRestToken ? new UpstashRedis({ url: upstashRedisRestUrl, token: upstashRedisRestToken }) : null;
// Crawl throttling and retry configuration.
// First uncached requests run immediately so the UI can show early results, while
// retries still use the configured backoff window.
const crawlDelayMinMs = Number(process.env.CRAWL_DELAY_MS_MIN) || Number(process.env.CRAWL_DELAY_MS) || 8000; // default 8s retry base
const crawlDelayMaxMs = Number(process.env.CRAWL_DELAY_MS_MAX) || Math.max(crawlDelayMinMs, 23000); // default max 23s if not provided
const crawlInitialDelayMs = Number(process.env.CRAWL_INITIAL_DELAY_MS) || 0;
const crawlMaxRetries = Number(process.env.CRAWL_MAX_RETRIES) || 4;
const crawl429DelayMinMs = Number(process.env.CRAWL_429_DELAY_MS_MIN) || 2 * 60 * 1000;
const crawl429DelayMaxMs = Number(process.env.CRAWL_429_DELAY_MS_MAX) || 4 * 60 * 1000;

function randBetween(min, max) {
	const lo = Number(min) || 0;
	const hi = Number(max) || 0;
	if (hi <= lo) return lo;
	return Math.round(lo + Math.random() * (hi - lo));
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

function formatWaitMs(ms) {
	if (!Number.isFinite(ms) || ms <= 0) return 'a short time';
	if (ms < 60 * 1000) return `${Math.round(ms / 1000)}s`;
	const minutes = Math.round(ms / (60 * 1000));
	return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

async function getRedisClient() {
	if (!redisClient) return null;
	if (!redisClient.isOpen) {
		await redisClient.connect();
	}
	return redisClient;
}

async function getCacheValue(key) {
	if (upstashRedisClient) {
		const value = await upstashRedisClient.get(key);
		if (value == null) return null;
		return typeof value === 'string' ? value : JSON.stringify(value);
	}
	const client = await getRedisClient();
	if (!client) return null;
	return client.get(key);
}

async function setCacheValue(key, value, ttlSeconds) {
	if (upstashRedisClient) {
		if (ttlSeconds && ttlSeconds > 0) {
			await upstashRedisClient.set(key, value, { ex: Math.floor(ttlSeconds) });
			return;
		}
		await upstashRedisClient.set(key, value);
		return;
	}
	const client = await getRedisClient();
	if (!client) return;
	if (ttlSeconds && ttlSeconds > 0) {
		await client.set(key, value, { EX: Math.floor(ttlSeconds) });
		return;
	}
	await client.set(key, value);
}

async function scanRedisKeysByPatterns(patterns) {
	const normalizedPatterns = Array.from(new Set(patterns.filter(Boolean)));
	const keys = new Set();

	if (upstashRedisClient) {
		for (const pattern of normalizedPatterns) {
			let cursor = '0';
			do {
				const [nextCursor, batch] = await upstashRedisClient.scan(cursor, { match: pattern, count: 1000 });
				for (const key of batch || []) {
					keys.add(String(key));
				}
				cursor = String(nextCursor || '0');
			} while (cursor !== '0');
		}
		return Array.from(keys);
	}

	const client = await getRedisClient();
	if (!client) return [];
	for (const pattern of normalizedPatterns) {
		for await (const key of client.scanIterator({ MATCH: pattern, COUNT: 1000 })) {
			keys.add(String(key));
		}
	}

	return Array.from(keys);
}

function parseRedisSavedKey(key) {
	const match = String(key || '')
		.trim()
		.match(/^(finra|sec):(individual|firm):(\d+)(?:\.json)?$/i);
	if (!match) return null;
	return {
		key: String(key || '').trim(),
		type: match[2].toLowerCase(),
		crd: match[3],
		source: match[1].toLowerCase(),
	};
}

async function ensureLocalDerivedDir() {
	await fs.mkdir(localDerivedDir, { recursive: true });
}

async function readRawKeyIndexCacheFile() {
	try {
		const raw = await fs.readFile(rawKeysIndexPath, 'utf-8');
		const parsed = JSON.parse(raw);
		const entries = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.entries) ? parsed.entries : null;
		if (!entries) return null;
		const filtered = entries.filter((entry) => entry && typeof entry === 'object' && typeof entry.key === 'string' && typeof entry.crd === 'string' && (entry.type === 'individual' || entry.type === 'firm') && (entry.source === 'finra' || entry.source === 'sec'));
		const generatedAt = typeof parsed?.generatedAt === 'string' ? parsed.generatedAt : null;
		const stat = await fs.stat(rawKeysIndexPath).catch(() => null);
		return {
			entries: filtered,
			generatedAt,
			mtimeMs: stat ? stat.mtimeMs : 0,
		};
	} catch (error) {
		if (error?.code === 'ENOENT') return null;
		throw error;
	}
}

async function writeRawKeyIndexCacheFile(entries) {
	await ensureLocalDerivedDir();
	await fs.writeFile(
		rawKeysIndexPath,
		JSON.stringify({ generatedAt: new Date().toISOString(), entries }, null, 2),
		'utf-8',
	);
}

function extractDisplayNameFromPayload(payload, type) {
	if (!payload || typeof payload !== 'object') return null;
	const root = payload;
	const content = root.finraBrokerCheck || root.secInvestmentAdvisor || root.content || root.iacontent || root.bccontent || root;
	if (!content || typeof content !== 'object') return null;
	const bi = content.basicInformation && typeof content.basicInformation === 'object' ? content.basicInformation : {};
	const clean = (...values) => values.map((value) => String(value || '').trim()).filter(Boolean).join(' ').trim();
	if (type === 'individual') {
		return clean(bi.firstName, bi.middleName, bi.lastName, bi.suffix) || clean(content.firstName, content.middleName, content.lastName, content.suffix) || clean(bi.fullName, bi.individualName, content.fullName, content.individualName, content.name) || null;
	}
	return clean(bi.firmName, bi.orgName, bi.organizationName, bi.legalName) || clean(content.firmName, content.orgName, content.organizationName, content.legalName, content.name) || null;
}

function buildHighWaterSections(entries, checkedAt) {
	const grouped = new Map();
	for (const entry of entries) {
		const id = `${entry.type}:${entry.crd}`;
		if (!grouped.has(id)) {
			grouped.set(id, {
				id,
				type: entry.type,
				crd: entry.crd,
				name: entry.displayName || `#${entry.crd}`,
				foundAt: entry.mtime ? new Date(entry.mtime).toISOString() : checkedAt,
				sources: [entry.source],
				savedFiles: [entry.key],
			});
			continue;
		}
		const existing = grouped.get(id);
		if (!existing.sources.includes(entry.source)) existing.sources.push(entry.source);
		if (!existing.savedFiles.includes(entry.key)) existing.savedFiles.push(entry.key);
	}
	const sortByCrdDesc = (left, right) => Number(right.crd) - Number(left.crd) || String(right.foundAt || '').localeCompare(String(left.foundAt || ''));
	const values = Array.from(grouped.values());
	return {
		individual: values.filter((item) => item.type === 'individual').sort(sortByCrdDesc).slice(0, 12),
		firm: values.filter((item) => item.type === 'firm').sort(sortByCrdDesc).slice(0, 12),
	};
}

async function collectRedisHighWaterSummary() {
	const mode = redisClient ? 'redis-url' : upstashRedisClient ? 'upstash-rest' : 'none';
	const configured = mode !== 'none';
	const checkedAt = new Date().toISOString();
	const cached = await readRawKeyIndexCacheFile();
	const cacheAgeMs = cached
		? Math.max(0, Date.now() - (cached.generatedAt ? Date.parse(cached.generatedAt) : cached.mtimeMs || 0))
		: Number.POSITIVE_INFINITY;
	const cacheFresh = Number.isFinite(cacheAgeMs) && cacheAgeMs <= rawKeysIndexCacheTtlMs;

	const buildSummary = (entries, message) => {
		const sections = buildHighWaterSections(entries, checkedAt);
		return {
			configured,
			mode,
			checkedAt,
			totalSavedCrds: new Set(entries.map((entry) => `${entry.type}:${entry.crd}`)).size,
			sections,
			message,
		};
	};

	async function rebuildAndPersistRawKeyIndex() {
		const rawKeys = await scanRedisKeysByPatterns(['finra:individual:*', 'finra:firm:*', 'sec:individual:*', 'sec:firm:*']);
		const entries = [];
		const grouped = new Map();
		for (const rawKey of rawKeys) {
			const parsed = parseRedisSavedKey(rawKey);
			if (!parsed) continue;
			const id = `${parsed.type}:${parsed.crd}`;
			const source = String(rawKey).startsWith('finra:') ? 'finra' : 'sec';
			const existing = grouped.get(id);
			if (existing) {
				const sources = new Set(existing.sources);
				sources.add(source);
				const savedFiles = new Set(existing.savedFiles || []);
				savedFiles.add(rawKey);
				existing.sources = Array.from(sources);
				existing.savedFiles = Array.from(savedFiles);
				continue;
			}
			grouped.set(id, {
				id,
				type: parsed.type,
				crd: parsed.crd,
				name: `#${parsed.crd}`,
				foundAt: checkedAt,
				sources: [source],
				savedFiles: [rawKey],
			});
			entries.push({
				key: rawKey,
				type: parsed.type,
				crd: parsed.crd,
				source,
				mtime: Date.now(),
			});
		}
		await writeRawKeyIndexCacheFile(entries);
		return entries;
	}

	if (cached && (cacheFresh || !configured)) {
		return buildSummary(
			cached.entries,
			cached.entries.length > 0
				? 'Showing the highest CRD numbers currently saved in the local cache, split by person and firm.'
				: 'No CRDs are currently saved in the local cache.',
		);
	}

	if (cached && configured) {
		void rebuildAndPersistRawKeyIndex().catch((error) => {
			console.warn('Failed to refresh raw key index cache from Redis:', error?.message || error);
		});
		return buildSummary(
			cached.entries,
			cached.entries.length > 0
				? 'Showing the highest CRD numbers currently saved in the local cache, split by person and firm.'
				: 'No CRDs are currently saved in the local cache.',
		);
	}

	if (!configured) {
		return {
			configured,
			mode,
			checkedAt,
			totalSavedCrds: 0,
			sections: { individual: [], firm: [] },
			message: 'Redis is not configured.',
		};
	}

	const entries = await rebuildAndPersistRawKeyIndex();
	return buildSummary(
		entries,
		entries.length > 0
			? 'Showing the highest CRD numbers currently saved in Redis, split by person and firm.'
			: 'No CRDs are currently saved in Redis.',
	);
}

	// rate-limit / retry aware fetch with randomized delays/jitter
	let attempt = 0;
	let lastErr = null;
	while (true) {
		attempt += 1;
		// First uncached requests are immediate; retries keep the randomized backoff.
		if (attempt > 1) {
			// exponential backoff base using min delay
			const base = Math.min(crawlDelayMaxMs, crawlDelayMinMs * Math.pow(2, attempt - 2));
			// apply jitter to backoff
			const jittered = randBetween(Math.round(base * 0.6), Math.round(base * 1.4));
			await sleep(jittered);
		} else if (crawlInitialDelayMs > 0) {
			const initial = randBetween(0, crawlInitialDelayMs);
			await sleep(initial);
		}

		let response;
		try {
			response = await fetch(url);
		} catch (err) {
			lastErr = err;
			if (attempt >= crawlMaxRetries) throw err;
			continue;
		}

		// Handle 429 Too Many Requests
		if (response.status === 429) {
			lastErr = new Error('429 Too Many Requests');
			const retryAfterHeader = Number(response.headers.get('retry-after'));
			const retryAfterMs = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0 ? Math.round(retryAfterHeader * 1000) : null;
			const waitMs = retryAfterMs ?? randBetween(Math.min(crawl429DelayMinMs, crawl429DelayMaxMs), Math.max(crawl429DelayMinMs, crawl429DelayMaxMs));
			if (attempt >= crawlMaxRetries) {
				throw new Error(`Too Many Requests (429) after ${attempt} attempts for ${url}`);
			}
			if (onRateLimit) {
				try {
					await onRateLimit({ url, attempt, waitMs });
				} catch (e) {
					// ignore logging callback errors
				}
			}
			await sleep(waitMs);
			continue;
		}

		// Retry on 5xx
		if (response.status >= 500 && response.status < 600) {
			lastErr = new Error(`Upstream error ${response.status}`);
			if (attempt >= crawlMaxRetries) {
				const text = await response.text().catch(() => '');
				throw new Error(`Upstream error ${response.status}: ${text}`);
			}
			// retry after exponential backoff with jitter
			const baseBackoff = Math.min(crawlDelayMaxMs, crawlDelayMinMs * Math.pow(2, attempt - 1));
			const jitteredBackoff = randBetween(Math.round(baseBackoff * 0.6), Math.round(baseBackoff * 1.4));
			await sleep(jitteredBackoff);
			continue;
		}

		if (!response.ok) {
			const text = await response.text().catch(() => '');
			throw new Error(`HTTP ${response.status} ${response.statusText}${text ? ': ' + text : ''}`);
		}

		const data = await response.json();

		if ((redisClient || upstashRedisClient) && response.ok) {
			try {
				await setCacheValue(cacheKey, JSON.stringify(data), cacheTtlSeconds);
			} catch (error) {
				console.warn('Redis cache write failed:', error.message);
			}
		}

		return data;
	}
}

function buildEndpoint({ source, type, crd }) {
	if (source === 'finra') {
		// Use the canonical BrokerCheck detail endpoint with includePrevious for final captured results
		if (type === 'individual') return `https://api.brokercheck.finra.org/search/individual/${crd}?includePrevious=true`;
		if (type === 'firm') return `https://api.brokercheck.finra.org/search/firm/${crd}`;
	}
	if (source === 'sec') {
		// Use the canonical AdviserInfo detail endpoint with includePrevious for final captured results
		if (type === 'individual') return `https://api.adviserinfo.sec.gov/search/individual/${crd}?includePrevious=true`;
		if (type === 'firm') return `https://api.adviserinfo.sec.gov/search/firm/${crd}?wt=json`;
	}
	return null;
}

function buildUrlFromPath({ baseDomain, path, crd }) {
	const base = baseDomain.trim().replace(/\/+$/, '');
	let endpoint = path.trim();
	if (!endpoint.startsWith('/')) endpoint = '/' + endpoint;
	const queryIndex = endpoint.indexOf('?');
	if (endpoint.includes('{crd}')) {
		return `${base}${endpoint.replace('{crd}', crd)}`;
	}
	if (queryIndex >= 0) {
		const beforeQuery = endpoint.slice(0, queryIndex).replace(/\/+$/, '');
		const query = endpoint.slice(queryIndex);
		return `${base}${beforeQuery}/${crd}${query}`;
	}
	return `${base}${endpoint.replace(/\/+$/, '')}/${crd}`;
}

async function ensureLocalRawDir() {
	await fs.mkdir(localRawDir, { recursive: true });
}

async function ensureLocalRawBakDir() {
	await ensureLocalRawDir();
	await fs.mkdir(localRawBakDir, { recursive: true });
}

async function writeRawAndBackupFile(filename, serializedPayload) {
	await ensureLocalRawBakDir();
	const normalizedFilename = rawKeyToFilename(filename);
	await Promise.all([
		fs.writeFile(path.join(localRawDir, normalizedFilename), serializedPayload, 'utf-8'),
		fs.writeFile(path.join(localRawBakDir, normalizedFilename), serializedPayload, 'utf-8'),
	]);
	return path.join(localRawDir, normalizedFilename);
}

async function cleanupLegacyRawFiles() {
	await ensureLocalRawDir();
	const entries = await fs.readdir(localRawDir);
	for (const entry of entries) {
		if (entry.startsWith('api.brokercheck.finra.org_') || entry.startsWith('api.adviserinfo.sec.gov_')) {
			await fs.unlink(path.join(localRawDir, entry));
		}
	}
}

function rawKeyToFilename(key) {
	const normalized = String(key || '').trim();
	if (!normalized) throw new Error('Raw key cannot be empty');
	return normalized.toLowerCase().endsWith(rawFileSuffix) ? normalized : `${normalized}${rawFileSuffix}`;
}

function filenameToRawKey(filename) {
	return String(filename || '')
		.trim()
		.replace(/\.json$/i, '');
}

function tryParseJsonString(value) {
	const trimmed = String(value || '').trim();
	if (!trimmed) return null;
	if (!((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']')))) {
		return null;
	}
	try {
		return JSON.parse(trimmed);
	} catch (e) {
		return null;
	}
}

function normalizeRawPayload(payload) {
	if (typeof payload === 'string') {
		const parsed = tryParseJsonString(payload);
		return parsed == null ? payload : normalizeRawPayload(parsed);
	}
	if (Array.isArray(payload)) {
		return payload.map((item) => normalizeRawPayload(item));
	}
	if (!payload || typeof payload !== 'object') {
		return payload;
	}

	const normalizedEntries = Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, normalizeRawPayload(value)]));

	// 1. New standardized keys
	if (normalizedEntries.finraBrokerCheck && typeof normalizedEntries.finraBrokerCheck === 'object' && Object.keys(normalizedEntries).length === 1) {
		return normalizeRawPayload(normalizedEntries.finraBrokerCheck);
	}
	if (normalizedEntries.secInvestmentAdvisor && typeof normalizedEntries.secInvestmentAdvisor === 'object' && Object.keys(normalizedEntries).length === 1) {
		return normalizeRawPayload(normalizedEntries.secInvestmentAdvisor);
	}

	// 2. Legacy keys
	if (normalizedEntries.iacontent && typeof normalizedEntries.iacontent === 'object' && Object.keys(normalizedEntries).length === 1) {
		return normalizeRawPayload(normalizedEntries.iacontent);
	}
	if (normalizedEntries.content && typeof normalizedEntries.content === 'object' && Object.keys(normalizedEntries).length === 1) {
		return normalizeRawPayload(normalizedEntries.content);
	}

	const hit = normalizedEntries?.hits?.hits?.[0];
	if (normalizedEntries?.hits && Array.isArray(normalizedEntries.hits.hits) && normalizedEntries.hits.hits.length === 1 && hit && typeof hit === 'object') {
		if (hit._source && typeof hit._source === 'object' && hit._source.content != null) {
			return normalizeRawPayload(hit._source.content);
		}
		if (hit._source && typeof hit._source === 'object' && Object.keys(hit).every((key) => ['_source', '_type', '_id', '_index', '_score', 'sort'].includes(key))) {
			return normalizeRawPayload(hit._source);
		}
		if (hit.content != null) {
			return normalizeRawPayload(hit.content);
		}
		if (!Object.keys(hit).some((key) => key.startsWith('_'))) {
			return normalizeRawPayload(hit);
		}
	}

	if (normalizedEntries._source && typeof normalizedEntries._source === 'object' && normalizedEntries._source.content != null) {
		return normalizeRawPayload(normalizedEntries._source.content);
	}

	return normalizedEntries;
}

async function saveRawFile(filename, payload) {
	return writeRawAndBackupFile(filename, JSON.stringify(normalizeRawPayload(payload), null, 2));
}

async function removeSavedPayload(key) {
	const filename = rawKeyToFilename(key);
	let removed = false;
	for (const targetPath of [path.join(localRawDir, filename), path.join(localRawBakDir, filename)]) {
		try {
			await fs.unlink(targetPath);
			removed = true;
		} catch (error) {
			if (!error || error.code !== 'ENOENT') throw error;
		}
	}
	return removed;
}

async function listSavedKeys() {
	await ensureLocalRawDir();
	const entries = await fs.readdir(localRawDir);
	return entries.filter((entry) => entry.endsWith('.json')).map(filenameToRawKey);
}

async function listSavedKeysWithStats() {
	await ensureLocalRawDir();
	const entries = await fs.readdir(localRawDir);
	const files = entries.filter((entry) => entry.endsWith('.json'));
	const infos = await Promise.all(
		files.map(async (entry) => {
			try {
				const st = await fs.stat(path.join(localRawDir, entry));
				return { key: filenameToRawKey(entry), mtime: st.mtimeMs };
			} catch (e) {
				return { key: filenameToRawKey(entry), mtime: 0 };
			}
		}),
	);
	// sort newest first
	infos.sort((a, b) => b.mtime - a.mtime);
	return infos;
}

async function loadSavedPayload(key) {
	const filePath = path.join(localRawDir, rawKeyToFilename(key));
	const data = await fs.readFile(filePath, 'utf-8');
	return JSON.parse(data);
}

const seenKeysRedisKey = 'finra-sec:seenKeys';
const seenKeysFile = path.resolve(process.cwd(), 'data', 'seen-keys.json');
const derivedDir = path.resolve(process.cwd(), 'data', 'derived');
const highWaterReportPath = path.join(derivedDir, 'query-high-water-crds-report.json');
const highWaterFrontierPath = path.join(derivedDir, 'query-high-water-crds-frontier.json');
const newCrdsDashboardPath = path.join(derivedDir, 'new-crds-dashboard.json');
const newCrdsCheckIntervalMs = 24 * 60 * 60 * 1000;
const newCrdsManualCooldownMs = 15 * 60 * 1000;
const newCrdsLogTailLimit = 40;
let newCrdScanProcess = null;

async function readSeenKeys() {
	if (redisClient || upstashRedisClient) {
		try {
			const v = await getCacheValue(seenKeysRedisKey);
			if (v) return JSON.parse(v);
			return {};
		} catch (e) {
			console.warn('readSeenKeys redis failed', e.message);
		}
	}
	try {
		const content = await fs.readFile(seenKeysFile, 'utf-8');
		return JSON.parse(content || '{}');
	} catch (e) {
		return {};
	}
}

async function writeSeenKeys(obj) {
	const payload = JSON.stringify(obj || {});
	if (redisClient || upstashRedisClient) {
		try {
			await setCacheValue(seenKeysRedisKey, payload);
			return;
		} catch (e) {
			console.warn('writeSeenKeys redis failed', e.message);
		}
	}
	try {
		await fs.mkdir(path.dirname(seenKeysFile), { recursive: true });
		await fs.writeFile(seenKeysFile, payload, 'utf-8');
	} catch (e) {
		console.warn('writeSeenKeys file failed', e.message);
	}
}

function parseSavedKeyInfo(entry) {
	const key =
		typeof entry === 'string' ? entry
		: entry && typeof entry === 'object' && entry.key ? entry.key
		: '';
	const mtime = typeof entry === 'object' && entry && entry.mtime ? Number(entry.mtime) || 0 : 0;
	const match = String(key || '').match(/^(finra|sec):(individual|firm):(\d+)\.json$/i);
	if (!match) return null;
	return {
		key,
		source: match[1].toLowerCase(),
		type: match[2].toLowerCase(),
		crd: match[3],
		mtime,
	};
}

function parseIsoTime(value) {
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : 0;
}

function sanitizePositiveInt(value) {
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function parseCalendarDateValue(value) {
	const text = typeof value === 'string' ? value.trim() : '';
	if (!text) return null;
	let match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
	if (match) {
		const month = Number(match[1]);
		const day = Number(match[2]);
		const year = Number(match[3]);
		if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
			return {
				key: year * 10000 + month * 100 + day,
				iso: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
			};
		}
	}
	match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (match) {
		const year = Number(match[1]);
		const month = Number(match[2]);
		const day = Number(match[3]);
		if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
			return {
				key: year * 10000 + month * 100 + day,
				iso: `${match[1]}-${match[2]}-${match[3]}`,
			};
		}
	}
	return null;
}

function pickEarliestCalendarDate(values) {
	let best = null;
	for (const value of values) {
		const parsed = parseCalendarDateValue(value);
		if (!parsed) continue;
		if (!best || parsed.key < best.key) {
			best = parsed;
		}
	}
	return best ? best.iso : null;
}

function pickLatestCalendarDate(values) {
	let best = null;
	for (const value of values) {
		const parsed = parseCalendarDateValue(value);
		if (!parsed) continue;
		if (!best || parsed.key > best.key) {
			best = parsed;
		}
	}
	return best ? best.iso : null;
}

function collectObjectDateValues(entries, key) {
	if (!Array.isArray(entries)) return [];
	return entries.map((entry) => (entry && typeof entry === 'object' ? entry[key] : null)).filter(Boolean);
}

function unwrapSavedPayloadContent(payload) {
	if (payload && typeof payload === 'object') {
		if (payload.content && typeof payload.content === 'object') return payload.content;
		if (payload.iacontent && typeof payload.iacontent === 'object') return payload.iacontent;
	}
	return payload && typeof payload === 'object' ? payload : null;
}

function getSavedFileSource(savedFile) {
	const match = String(savedFile || '').match(/^(finra|sec):/i);
	return match ? match[1].toLowerCase() : '';
}

function extractFinraIndustryDate(payload) {
	const content = unwrapSavedPayloadContent(payload);
	if (!content || typeof content !== 'object') return null;
	const basicInformation = content.basicInformation && typeof content.basicInformation === 'object' ? content.basicInformation : {};
	return pickLatestCalendarDate([basicInformation.daysInIndustryCalculatedDate]);
}

function extractSecIndustryDate(payload) {
	const content = unwrapSavedPayloadContent(payload);
	if (!content || typeof content !== 'object') return null;
	const basicInformation = content.basicInformation && typeof content.basicInformation === 'object' ? content.basicInformation : {};
	return pickLatestCalendarDate([basicInformation.daysInIndustryCalculatedDateIAPD]);
}

function normalizeSourceDates(value) {
	if (!value || typeof value !== 'object') return {};
	const sourceDates = {};
	for (const source of ['finra', 'sec']) {
		const parsed = parseCalendarDateValue(value[source]);
		if (parsed) sourceDates[source] = parsed.iso;
	}
	return sourceDates;
}

async function resolveNewCrdSourceDates(savedFiles, type) {
	if (type !== 'individual' || !Array.isArray(savedFiles) || !savedFiles.length) return {};
	const entries = await Promise.all(
		savedFiles.map(async (savedFile) => ({
			source: getSavedFileSource(savedFile),
			payload: await loadSavedPayload(savedFile),
		})),
	);
	const sourceDates = {};
	const finraDate = pickLatestCalendarDate(entries.filter((entry) => entry.source === 'finra').map((entry) => extractFinraIndustryDate(entry.payload)));
	if (finraDate) sourceDates.finra = finraDate;
	const secDate = pickLatestCalendarDate(entries.filter((entry) => entry.source === 'sec').map((entry) => extractSecIndustryDate(entry.payload)));
	if (secDate) sourceDates.sec = secDate;
	return sourceDates;
}

function createEmptyNewCrdsState(savedMaxes = {}) {
	const now = new Date().toISOString();
	return {
		initializedAt: now,
		lastCheckedAt: null,
		nextCheckAt: null,
		lastRecordedMaxes: {
			individual: sanitizePositiveInt(savedMaxes.individual),
			firm: sanitizePositiveInt(savedMaxes.firm),
		},
		items: [],
		lastRun: {
			status: 'idle',
			startedAt: null,
			completedAt: null,
			exitCode: null,
			message: 'Waiting for the first high-water CRD check.',
			logTail: [],
		},
		manualCooldownUntil: null,
	};
}

async function ensureDerivedDir() {
	await fs.mkdir(derivedDir, { recursive: true });
}

async function collectSavedCrdGroups() {
	const entries = await listSavedKeysWithStats();
	const groups = new Map();
	const maxes = { individual: 0, firm: 0 };
	for (const entry of entries) {
		const parsed = parseSavedKeyInfo(entry);
		if (!parsed) continue;
		const groupKey = `${parsed.type}:${parsed.crd}`;
		if (!groups.has(groupKey)) {
			groups.set(groupKey, {
				id: groupKey,
				type: parsed.type,
				crd: parsed.crd,
				latestMtime: 0,
				sources: new Set(),
				savedFiles: [],
			});
		}
		const group = groups.get(groupKey);
		group.latestMtime = Math.max(group.latestMtime, parsed.mtime);
		group.sources.add(parsed.source);
		if (!group.savedFiles.includes(parsed.key)) {
			group.savedFiles.push(parsed.key);
		}
		const crdValue = sanitizePositiveInt(parsed.crd);
		if (crdValue > (maxes[parsed.type] || 0)) {
			maxes[parsed.type] = crdValue;
		}
	}
	for (const group of groups.values()) {
		group.savedFiles.sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' }));
	}
	return { groups: Array.from(groups.values()), maxes };
}

function normalizeNewCrdItem(item) {
	if (!item || typeof item !== 'object') return null;
	const type =
		item.type === 'firm' ? 'firm'
		: item.type === 'individual' ? 'individual'
		: null;
	const crd = String(item.crd || '').trim();
	if (!type || !/^\d+$/.test(crd)) return null;
	const sources =
		Array.isArray(item.sources) ?
			Array.from(new Set(item.sources.map((source) => String(source || '').toLowerCase()).filter((source) => source === 'finra' || source === 'sec')))
		:	[];
	const savedFiles = Array.isArray(item.savedFiles) ? Array.from(new Set(item.savedFiles.map((file) => String(file || '').trim()).filter(Boolean))) : [];
	const foundAt = parseIsoTime(item.foundAt) ? new Date(item.foundAt).toISOString() : null;
	return {
		id: `${type}:${crd}`,
		type,
		crd,
		foundAt,
		sourceDates: normalizeSourceDates(item.sourceDates),
		sources,
		savedFiles,
	};
}

function compareNewCrdItems(left, right) {
	return (
		parseIsoTime(right.foundAt) - parseIsoTime(left.foundAt) ||
		Number(right.crd) - Number(left.crd) ||
		left.id.localeCompare(right.id, undefined, { numeric: true, sensitivity: 'base' })
	);
}

function buildNewCrdItemFromGroup(group, existingItem = null) {
	return {
		id: group.id,
		type: group.type,
		crd: group.crd,
		foundAt:
			existingItem && parseIsoTime(existingItem.foundAt) ? existingItem.foundAt
			: group.latestMtime ? new Date(group.latestMtime).toISOString()
			: new Date().toISOString(),
		sources: Array.from(group.sources).sort((left, right) => left.localeCompare(right)),
		savedFiles: group.savedFiles.slice(),
	};
}

async function writeNewCrdsState(state) {
	await ensureDerivedDir();
	await fs.writeFile(newCrdsDashboardPath, JSON.stringify(state, null, 2), 'utf-8');
}

async function loadNewCrdsState(savedSummary = null, options = {}) {
	const summary = savedSummary || (await collectSavedCrdGroups());
	const defaultState = createEmptyNewCrdsState(summary.maxes);
	try {
		const parsed = JSON.parse(await fs.readFile(newCrdsDashboardPath, 'utf-8'));
		const state = {
			initializedAt: parseIsoTime(parsed?.initializedAt) ? new Date(parsed.initializedAt).toISOString() : defaultState.initializedAt,
			lastCheckedAt: parseIsoTime(parsed?.lastCheckedAt) ? new Date(parsed.lastCheckedAt).toISOString() : null,
			nextCheckAt: parseIsoTime(parsed?.nextCheckAt) ? new Date(parsed.nextCheckAt).toISOString() : null,
			lastRecordedMaxes: {
				individual: sanitizePositiveInt(parsed?.lastRecordedMaxes?.individual),
				firm: sanitizePositiveInt(parsed?.lastRecordedMaxes?.firm),
			},
			items: Array.isArray(parsed?.items) ? parsed.items.map(normalizeNewCrdItem).filter(Boolean).sort(compareNewCrdItems) : [],
			lastRun: {
				status: ['idle', 'running', 'complete', 'error', 'interrupted'].includes(parsed?.lastRun?.status) ? parsed.lastRun.status : 'idle',
				startedAt: parseIsoTime(parsed?.lastRun?.startedAt) ? new Date(parsed.lastRun.startedAt).toISOString() : null,
				completedAt: parseIsoTime(parsed?.lastRun?.completedAt) ? new Date(parsed.lastRun.completedAt).toISOString() : null,
				exitCode: Number.isInteger(parsed?.lastRun?.exitCode) ? parsed.lastRun.exitCode : null,
				message: typeof parsed?.lastRun?.message === 'string' && parsed.lastRun.message ? parsed.lastRun.message : defaultState.lastRun.message,
				logTail:
					Array.isArray(parsed?.lastRun?.logTail) ?
						parsed.lastRun.logTail
							.map((line) => String(line || ''))
							.filter(Boolean)
							.slice(-newCrdsLogTailLimit)
					:	[],
			},
			manualCooldownUntil: parseIsoTime(parsed?.manualCooldownUntil) ? new Date(parsed.manualCooldownUntil).toISOString() : null,
		};
		if (!options.preserveRunning && !newCrdScanProcess && state.lastRun.status === 'running') {
			state.lastRun.status = 'interrupted';
			state.lastRun.completedAt = new Date().toISOString();
			state.lastRun.message = 'The previous high-water CRD check was interrupted before completion.';
		}
		return state;
	} catch (error) {
		if (error?.code === 'ENOENT') {
			await writeNewCrdsState(defaultState);
			return defaultState;
		}
		throw error;
	}
}

async function reconcileAndSaveNewCrdsState(state, savedSummary = null) {
	const summary = savedSummary || (await collectSavedCrdGroups());
	const nextState = {
		...state,
		lastRecordedMaxes: {
			individual: sanitizePositiveInt(state?.lastRecordedMaxes?.individual),
			firm: sanitizePositiveInt(state?.lastRecordedMaxes?.firm),
		},
		items: Array.isArray(state?.items) ? state.items.map(normalizeNewCrdItem).filter(Boolean) : [],
	};
	const previousMaxes = {
		individual: nextState.lastRecordedMaxes.individual,
		firm: nextState.lastRecordedMaxes.firm,
	};
	const itemsById = new Map(nextState.items.map((item) => [item.id, item]));
	for (const group of summary.groups) {
		const existingItem = itemsById.get(group.id) || null;
		const crdValue = sanitizePositiveInt(group.crd);
		const isNewAboveTrackedMax = crdValue > (previousMaxes[group.type] || 0);
		if (!existingItem && !isNewAboveTrackedMax) continue;
		itemsById.set(group.id, buildNewCrdItemFromGroup(group, existingItem));
	}
	nextState.items = await Promise.all(
		Array.from(itemsById.values())
			.sort(compareNewCrdItems)
			.map(async (item) => ({
				...item,
				sourceDates: await resolveNewCrdSourceDates(item.savedFiles, item.type),
			})),
	);
	nextState.lastRecordedMaxes = {
		individual: Math.max(previousMaxes.individual, sanitizePositiveInt(summary.maxes.individual)),
		firm: Math.max(previousMaxes.firm, sanitizePositiveInt(summary.maxes.firm)),
	};
	await writeNewCrdsState(nextState);
	return nextState;
}

async function loadHighWaterFrontierSummary() {
	try {
		const parsed = JSON.parse(await fs.readFile(highWaterFrontierPath, 'utf-8'));
		const summary = {};
		for (const type of ['individual', 'firm']) {
			const frontier = parsed?.frontiers?.[type];
			if (!frontier || typeof frontier !== 'object') continue;
			const baselineMaxCrd = sanitizePositiveInt(frontier.baselineMaxCrd);
			const nextCrd = sanitizePositiveInt(frontier.nextCrd);
			summary[type] = {
				baselineMaxCrd,
				nextCrd,
				missCount: frontier.misses && typeof frontier.misses === 'object' ? Object.keys(frontier.misses).length : 0,
			};
		}
		return summary;
	} catch (error) {
		if (error?.code === 'ENOENT') return {};
		throw error;
	}
}

async function loadHighWaterReportSummary() {
	try {
		const parsed = JSON.parse(await fs.readFile(highWaterReportPath, 'utf-8'));
		return {
			startedAt: parseIsoTime(parsed?.startedAt) ? new Date(parsed.startedAt).toISOString() : null,
			completedAt: parseIsoTime(parsed?.completedAt) ? new Date(parsed.completedAt).toISOString() : null,
			processedCrds: sanitizePositiveInt(parsed?.processedCrds),
			lastProcessed:
				parsed?.lastProcessed && typeof parsed.lastProcessed === 'object' ?
					{
						type:
							parsed.lastProcessed.type === 'firm' ? 'firm'
							: parsed.lastProcessed.type === 'individual' ? 'individual'
							: null,
						crd: /^\d+$/.test(String(parsed.lastProcessed.crd || '')) ? String(parsed.lastProcessed.crd) : null,
						outcome: typeof parsed.lastProcessed.outcome === 'string' ? parsed.lastProcessed.outcome : null,
						at: parseIsoTime(parsed.lastProcessed.at) ? new Date(parsed.lastProcessed.at).toISOString() : null,
					}
				:	null,
		};
	} catch (error) {
		if (error?.code === 'ENOENT') return null;
		throw error;
	}
}

function pushNewCrdLogLines(lines, chunk) {
	const entries = String(chunk || '')
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	for (const entry of entries) {
		lines.push(entry);
	}
	while (lines.length > newCrdsLogTailLimit) {
		lines.shift();
	}
}

async function startNewCrdBackgroundScan(reason = 'scheduled') {
	if (newCrdScanProcess) return false;
	const savedSummary = await collectSavedCrdGroups();
	const state = await loadNewCrdsState(savedSummary, { preserveRunning: true });
	const startedAt = new Date().toISOString();
	state.lastRun = {
		status: 'running',
		startedAt,
		completedAt: null,
		exitCode: null,
		message: reason === 'manual' ? 'Manual high-water CRD check started.' : 'Daily high-water CRD check started.',
		logTail: [],
	};
	if (reason === 'manual') {
		state.manualCooldownUntil = new Date(Date.now() + newCrdsManualCooldownMs).toISOString();
	}
	await writeNewCrdsState(state);

	const tsxBinary = path.resolve(process.cwd(), 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
	const child = spawn(tsxBinary, ['scripts/query-high-water-crds.ts'], {
		cwd: process.cwd(),
		env: process.env,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	newCrdScanProcess = child;
	const logTail = [];
	let finalized = false;

	const finalize = async (status, exitCode, messageOverride = '') => {
		if (finalized) return;
		finalized = true;
		const finishedAt = new Date().toISOString();
		const finalSummary = await collectSavedCrdGroups();
		let nextState = await loadNewCrdsState(finalSummary, { preserveRunning: true });
		nextState = await reconcileAndSaveNewCrdsState(nextState, finalSummary);
		nextState.lastCheckedAt = finishedAt;
		nextState.nextCheckAt = new Date(Date.now() + newCrdsCheckIntervalMs).toISOString();
		nextState.lastRun = {
			status,
			startedAt: nextState.lastRun?.startedAt || startedAt,
			completedAt: finishedAt,
			exitCode: Number.isInteger(exitCode) ? exitCode : null,
			message: messageOverride || (status === 'complete' ? 'High-water CRD check complete.' : 'High-water CRD check failed.'),
			logTail: logTail.slice(-newCrdsLogTailLimit),
		};
		await writeNewCrdsState(nextState);
		newCrdScanProcess = null;
	};

	child.stdout.on('data', (chunk) => {
		pushNewCrdLogLines(logTail, chunk);
	});
	child.stderr.on('data', (chunk) => {
		pushNewCrdLogLines(logTail, chunk);
	});
	child.on('error', async (error) => {
		await finalize('error', null, error?.message || 'Failed to start the high-water CRD check.');
	});
	child.on('close', async (code) => {
		await finalize(code === 0 ? 'complete' : 'error', code, code === 0 ? '' : `High-water CRD check exited with code ${code}.`);
	});
	return true;
}

// Delete saved JSON files that are empty search envelopes like { hits: { total:0, hits:[] } }
async function cleanupEmptySearchFiles() {
	await ensureLocalRawDir();
	const entries = await fs.readdir(localRawDir);
	const deleted = [];
	for (const entry of entries) {
		if (!entry.endsWith('.json')) continue;
		const p = path.join(localRawDir, entry);
		try {
			const content = await fs.readFile(p, 'utf-8');
			const payload = JSON.parse(content);
			if (payload && payload.hits) {
				const total = payload.hits.total;
				const totalValue =
					typeof total === 'number' ? total
					: total && total.value != null ? Number(total.value)
					: null;
				const hitsArr = Array.isArray(payload.hits.hits) ? payload.hits.hits : null;
				if (totalValue === 0 || (hitsArr && hitsArr.length === 0)) {
					await fs.unlink(p);
					deleted.push(entry);
				}
			}
		} catch (e) {
			// ignore parse errors or unlink failures
			continue;
		}
	}
	return deleted;
}

router.get('/keys', async (req, res) => {
	try {
		const infos = await listSavedKeysWithStats();
		return res.json({ keys: infos });
	} catch (error) {
		return res.status(500).json({ error: error.message });
	}
});

router.get('/new-crds', async (req, res) => {
	try {
		const redisHighWater = await collectRedisHighWaterSummary();
		const now = new Date().toISOString();

		return res.json({
			initializedAt: now,
			lastCheckedAt: redisHighWater.checkedAt,
			nextCheckAt: null,
			lastRecordedMaxes: {
				individual: 0,
				firm: 0,
			},
			items: [],
			lastRun: {
				status: 'idle',
				startedAt: null,
				completedAt: null,
				exitCode: null,
				message: redisHighWater.message,
				logTail: [],
			},
			manualCooldownUntil: null,
		const rawKeys = await scanRedisKeysByPatterns(['finra:individual:*', 'finra:firm:*', 'sec:individual:*', 'sec:firm:*']);
		const entries = [];
		for (const rawKey of rawKeys) {
			const parsed = parseRedisSavedKey(rawKey);
			if (!parsed) continue;
			try {
				const payloadRaw = await getCacheValue(rawKey);
				const payload = payloadRaw ? JSON.parse(payloadRaw) : null;
				entries.push({
					key: rawKey,
					type: parsed.type,
					crd: parsed.crd,
					source: parsed.source,
					mtime: Date.now(),
					displayName: extractDisplayNameFromPayload(payload, parsed.type),
				});
			} catch {
				entries.push({
					key: rawKey,
					type: parsed.type,
					crd: parsed.crd,
					source: parsed.source,
					mtime: Date.now(),
					displayName: null,
				});
			}
		}
		await writeRawKeyIndexCacheFile(entries);
		const sections = buildHighWaterSections(entries, checkedAt);
		const unique = new Set(entries.map((entry) => `${entry.type}:${entry.crd}`));

		return {
			configured,
			mode,
			checkedAt,
			totalSavedCrds: unique.size,
			sections,
			message: unique.size > 0 ? 'Showing the highest CRD numbers currently saved in Redis, split by person and firm.' : 'No CRDs are currently saved in Redis.',
		};
	if (!key) {
		return res.status(400).json({ error: 'Missing key name' });
	}
	try {
		const payload = await loadSavedPayload(key);
		return res.json({ payload });
	} catch (error) {
		return res.status(500).json({ error: error.message });
	}
});

// Check whether a CRD has been saved in any of the expected filename formats
// returns object with keys like "finra:firm:3107080": true/false
router.get('/crd-status', async (req, res) => {
	const crd = String(req.query.crd || '').trim();
	if (!/^[0-9]+$/.test(crd)) {
		return res.status(400).json({ error: 'crd must be a numeric value' });
	}
	try {
		const keys = await listSavedKeys();
		const formats = [
			{ source: 'finra', type: 'firm' },
			{ source: 'finra', type: 'individual' },
			{ source: 'sec', type: 'firm' },
			{ source: 'sec', type: 'individual' },
		];
		const status = {};
		for (const f of formats) {
			const filename = detailFilenameForSource(f.source, f.type, crd);
			status[`${f.source}:${f.type}:${crd}`] = keys.includes(filename);
		}
		return res.json({ crd, status });
	} catch (error) {
		return res.status(500).json({ error: error.message });
	}
});

router.post('/cleanup-empty', async (req, res) => {
	try {
		const deleted = await cleanupEmptySearchFiles();
		return res.json({ deleted, count: deleted.length });
	} catch (error) {
		return res.status(500).json({ error: error.message });
	}
});

function isEmptyPayload(payload) {
	if (payload == null) return true;
	// arrays with no items are empty
	if (Array.isArray(payload)) return payload.length === 0;
	if (typeof payload === 'object') {
		// Elasticsearch/solr-like responses: { hits: { total: 0, hits: [] } }
		try {
			if (payload.hits) {
				const total = payload.hits.total;
				// total can be a number or an object { value: N }
				const totalValue =
					typeof total === 'number' ? total
					: total && total.value != null ? Number(total.value)
					: null;
				if (totalValue === 0) return true;
				if (Array.isArray(payload.hits.hits) && payload.hits.hits.length === 0) return true;
			}
		} catch (e) {
			// ignore and fall through to generic check
		}

		// generic object emptiness
		return Object.keys(payload).length === 0;
	}
	return false;
}

function detailFilenameForSource(source, type, crd) {
	if (source === 'finra') return `${source}:${type}:${crd}`;
	if (source === 'sec') return `${source}:${type}:${crd}`;
	return `unknown:${type}:${crd}`;
}

function isSecIndividualBrokerOnlyStub(payload) {
	const normalizedPayload = normalizeRawPayload(payload);
	if (!normalizedPayload || typeof normalizedPayload !== 'object' || Array.isArray(normalizedPayload)) return false;
	const basicInformation =
		normalizedPayload.basicInformation && typeof normalizedPayload.basicInformation === 'object' && !Array.isArray(normalizedPayload.basicInformation) ?
			normalizedPayload.basicInformation
		:	null;
	const iaScope = String(basicInformation?.iaScope || '')
		.trim()
		.toLowerCase();
	const currentIAEmployments = Array.isArray(normalizedPayload.currentIAEmployments) ? normalizedPayload.currentIAEmployments : [];
	const previousIAEmployments = Array.isArray(normalizedPayload.previousIAEmployments) ? normalizedPayload.previousIAEmployments : [];
	return iaScope === 'notinscope' && currentIAEmployments.length === 0 && previousIAEmployments.length === 0;
}

function isFinraFirmAdviserOnlyStub(payload) {
	const normalizedPayload = normalizeRawPayload(payload);
	if (!normalizedPayload || typeof normalizedPayload !== 'object' || Array.isArray(normalizedPayload)) return false;
	const basicInformation =
		normalizedPayload.basicInformation && typeof normalizedPayload.basicInformation === 'object' && !Array.isArray(normalizedPayload.basicInformation) ?
			normalizedPayload.basicInformation
		:	null;
	if (!basicInformation) return false;
	const hasBrokercheckScope = typeof basicInformation.bcScope === 'string' && basicInformation.bcScope.trim() !== '';
	const hasAdviserOnlyMarkers = [
		basicInformation.iaScope,
		basicInformation.isIAFirm,
		basicInformation.iaSECNumber,
		normalizedPayload.iaDisclosureFlag,
		normalizedPayload.iaFirmAddressDetails,
	].some((value) => value != null && String(value).trim() !== '');
	return !hasBrokercheckScope && hasAdviserOnlyMarkers;
}

function isNonActionableSavedDetail(filename, payload) {
	const rawKey = filenameToRawKey(rawKeyToFilename(filename));
	return (/^sec:individual:\d+$/i.test(rawKey) && isSecIndividualBrokerOnlyStub(payload)) || (/^finra:firm:\d+$/i.test(rawKey) && isFinraFirmAdviserOnlyStub(payload));
}

function isCrdKey(key) {
	if (!key) return false;
	const normalized = key.toLowerCase();
	if (
		normalized.includes('date') ||
		normalized.includes('year') ||
		normalized.includes('count') ||
		normalized.includes('amount') ||
		normalized.includes('percent') ||
		normalized.includes('duration')
	) {
		return false;
	}
	return normalized.includes('id') || normalized.includes('number') || normalized.includes('crd');
}

function discoverCrdsFromPayload(payload) {
	const seen = new Set();

	function addCrd(value, key) {
		if (value == null) return;
		const text = String(value);
		const candidates = text.match(/\b\d{4,7}\b/g) || [];
		for (const candidate of candidates) {
			const normalized = candidate.replace(/^0+/, '') || '0';
			if (normalized.length >= 4 && normalized.length <= 7 && isCrdKey(key)) {
				seen.add(normalized);
			}
		}
	}

	function traverse(node, key) {
		if (node && typeof node === 'object') {
			if (Array.isArray(node)) {
				for (const item of node) traverse(item, key);
			} else {
				for (const [childKey, childValue] of Object.entries(node)) {
					if (typeof childValue === 'string' && childKey.toLowerCase() === 'content') {
						try {
							const parsed = JSON.parse(childValue);
							traverse(parsed, childKey);
							continue;
						} catch {
							// keep falling through to normal handling
						}
					}
					if (typeof childValue === 'object') {
						traverse(childValue, childKey);
					} else {
						addCrd(childValue, childKey);
					}
				}
			}
		}
	}

	traverse(payload, '');
	return Array.from(seen);
}

function discoverFirmIdsFromPayload(payload) {
	const seen = new Set();

	function checkNode(node) {
		if (!node || typeof node !== 'object') return;
		if (Array.isArray(node)) {
			for (const item of node) checkNode(item);
			return;
		}
		// If this object contains a firm id and ia_only === 'Y' (or true), collect it
		const keys = Object.keys(node).map((k) => k.toLowerCase());
		const hasFirmId = keys.includes('firm_id') || keys.includes('firmid') || keys.includes('firm_id');
		const iaOnlyKey = keys.find((k) => k === 'ia_only' || k === 'iaonly');
		if (hasFirmId) {
			const firmKey = Object.keys(node).find((k) => k.toLowerCase() === 'firm_id' || k.toLowerCase() === 'firmid');
			const firmVal = firmKey ? node[firmKey] : null;
			const iaOnlyVal = iaOnlyKey ? node[iaOnlyKey] : null;
			const isIaOnly = iaOnlyVal === 'Y' || iaOnlyVal === 'y' || iaOnlyVal === true;
			if (isIaOnly && firmVal != null) {
				const text = String(firmVal).replace(/^0+/, '');
				if (/^\d{4,7}$/.test(text)) seen.add(text);
			}
		}

		// Recurse into child properties
		for (const val of Object.values(node)) {
			if (val && typeof val === 'object') checkNode(val);
		}
	}

	checkNode(payload);
	return Array.from(seen);
}

function isIaOnlyFromPayload(payload) {
	let found = false;
	function checkNode(node) {
		if (!node || typeof node !== 'object') return;
		if (Array.isArray(node)) {
			for (const item of node) checkNode(item);
			return;
		}
		for (const [k, v] of Object.entries(node)) {
			const key = k.toLowerCase();
			if (key === 'ia_only' || key === 'iaonly') {
				if (v === 'Y' || v === 'y' || v === true) {
					found = true;
					return;
				}
			}
			if (typeof v === 'object') checkNode(v);
		}
	}
	checkNode(payload);
	return found;
}

// Search by query or CRD across FINRA and SEC search endpoints and then crawl discovered CRDs.
router.post('/search-and-crawl', async (req, res) => {
	let query = String(req.body.query || '').trim();
	let startCrd = String(req.body.crd || '').trim();
	if (/^[0-9]+$/.test(query) && (!startCrd || startCrd === query)) {
		startCrd = query;
		query = '';
	}
	const maxDepth = Number(req.body.maxDepth || 1);
	const maxVisits = Number(req.body.maxVisits || 100);

	if (!query && !startCrd) {
		return res.status(400).json({ error: 'Provide query or crd to search' });
	}

	const logs = [];
	const errors = [];
	const savedFiles = [];
	const savedBySeed = {}; // seed -> [filenames]
	const discoveredSet = new Set();

	// helper to search a source
	async function searchSource(source, q) {
		if (!q) return null;
		let url = null;
		if (source === 'finra') {
			url = `https://api.brokercheck.finra.org/search/individual?query=${encodeURIComponent(q)}&hl=true&includePrevious=true&nrows=50&wt=json`;
		} else if (source === 'sec') {
			url = `https://api.adviserinfo.sec.gov/search/individual?query=${encodeURIComponent(q)}&hl=true&includePrevious=true&nrows=50&wt=json`;
		}
		if (!url) return null;
		logs.push(`Searching ${source.toUpperCase()} for "${q}"`);
		try {
			const data = await fetchWithCache(url, {
				onRateLimit: ({ url: rateLimitedUrl, waitMs }) => {
					logs.push(`Rate limited (429) fetching ${rateLimitedUrl}; waiting ${formatWaitMs(waitMs)} before retrying.`);
				},
			});
			const crds = discoverCrdsFromPayload(data || {});
			logs.push(`Found ${crds.length} CRDs from ${source.toUpperCase()} search`);
			for (const c of crds) discoveredSet.add(c);
			return data;
		} catch (e) {
			const msg = e?.message || String(e);
			logs.push(`ERROR searching ${source.toUpperCase()}: ${msg}`);
			errors.push({ source, message: msg });
			return null;
		}
	}

	// perform searches (both sources) if query provided
	if (query) {
		await searchSource('finra', query);
		await searchSource('sec', query);
	}
	// if startCrd provided, seed it
	if (startCrd) discoveredSet.add(startCrd);

	const seeds = Array.from(discoveredSet).slice(0, maxVisits);
	logs.push(`Seeding crawl with ${seeds.length} CRD(s)`);

	// Now for each seed, decide whether to fetch SEC only or both based on ia_only in FINRA detail
	for (const crd of seeds) {
		if (savedFiles.length + logs.length > maxVisits * 1000) {
			// safety
		}
		try {
			logs.push(`\n=== Handling seed CRD ${crd} ===`);
			// fetch FINRA detail to inspect ia_only
			const finraUrl = buildEndpoint({ source: 'finra', type: 'individual', crd });
			let finraData = null;
			if (finraUrl) {
				try {
					finraData = await fetchWithCache(finraUrl, {
						onRateLimit: ({ url: rateLimitedUrl, waitMs }) => {
							logs.push(`Rate limited (429) fetching ${rateLimitedUrl}; waiting ${formatWaitMs(waitMs)} before retrying.`);
						},
					});
				} catch (e) {
					const msg = e?.message || String(e);
					logs.push(`ERROR fetching FINRA detail for ${crd}: ${msg}`);
					errors.push({ crd, source: 'finra', message: msg });
				}
			}
			const iaOnly = isIaOnlyFromPayload(finraData || {});
			logs.push(`ia_only for CRD ${crd}: ${iaOnly ? 'Y' : 'N/missing'}`);

			if (iaOnly) {
				// only fetch SEC detail and save
				try {
					const result = await fetchAndSaveSourceDetail('sec', 'individual', crd, logs, savedFiles);
					if (result && result.saved) {
						savedBySeed[crd] = savedBySeed[crd] || [];
						savedBySeed[crd].push(result.saved);
						sendEvent('log', `Saved ${result.saved}`);
						sendEvent('saved', { filename: result.saved, seed: crd, source: 'sec', type: 'individual' });
					}
				} catch (e) {
					sendEvent('log', `ERROR fetching/saving SEC for ${crd}: ${e.message || e}`);
				}
			} else {
				// fetch and save FINRA (if non-empty) and SEC
				try {
					const finResult = await fetchAndSaveSourceDetail('finra', 'individual', crd, logs, savedFiles);
					if (finResult && finResult.saved) {
						sendEvent('log', `Saved ${finResult.saved}`);
						sendEvent('saved', { filename: finResult.saved, seed: crd, source: 'finra', type: 'individual' });
					}
				} catch (e) {
					sendEvent('log', `ERROR fetching/saving FINRA for ${crd}: ${e.message || e}`);
				}
				try {
					const secResult = await fetchAndSaveSourceDetail('sec', 'individual', crd, logs, savedFiles);
					if (secResult && secResult.saved) {
						savedBySeed[crd] = savedBySeed[crd] || [];
						savedBySeed[crd].push(secResult.saved);
						sendEvent('log', `Saved ${secResult.saved}`);
						sendEvent('saved', { filename: secResult.saved, seed: crd, source: 'sec', type: 'individual' });
					}
				} catch (e) {
					const msg = e?.message || String(e);
					sendEvent('log', `ERROR fetching/saving SEC for ${crd}: ${msg}`);
					sendEvent('error', { crd, source: 'sec', message: msg });
				}
			}
		} catch (e) {
			const msg = e?.message || String(e);
			logs.push(`ERROR handling seed ${crd}: ${msg}`);
			errors.push({ crd, message: msg });
		}
	}

	logs.push('\nSearch-and-crawl complete');
	return res.json({ seeds, savedFiles, savedBySeed, errors, logs });
});

// Server-Sent Events (SSE) version of search-and-crawl for streaming logs to the client
router.get('/search-and-crawl-stream', async (req, res) => {
	let query = String(req.query.query || '').trim();
	let startCrd = String(req.query.crd || '').trim();
	if (/^[0-9]+$/.test(query) && (!startCrd || startCrd === query)) {
		startCrd = query;
		query = '';
	}
	const maxDepth = Number(req.query.maxDepth || 1);
	const maxVisits = Number(req.query.maxVisits || 100);

	if (!query && !startCrd) {
		res.status(400).json({ error: 'Provide query or crd to search' });
		return;
	}

	// SSE headers
	res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
	res.setHeader('Cache-Control', 'no-cache');
	res.setHeader('Connection', 'keep-alive');
	res.flushHeaders && res.flushHeaders();

	function sendEvent(event, data) {
		try {
			const payload = typeof data === 'string' ? data : JSON.stringify(data);
			res.write(`event: ${event}\n`);
			// send data lines (escape newlines)
			const lines = String(payload).split('\n');
			for (const line of lines) res.write(`data: ${line}\n`);
			res.write('\n');
		} catch (e) {
			// ignore write errors
		}
	}

	// replicate the non-streaming logic but emit logs as events
	const discoveredSet = new Set();

	async function searchSourceStream(source, q) {
		if (!q) return null;
		let url = null;
		if (source === 'finra') {
			url = `https://api.brokercheck.finra.org/search/individual?query=${encodeURIComponent(q)}&hl=true&includePrevious=true&nrows=50&wt=json`;
		} else if (source === 'sec') {
			url = `https://api.adviserinfo.sec.gov/search/individual?query=${encodeURIComponent(q)}&hl=true&includePrevious=true&nrows=50&wt=json`;
		}
		if (!url) return null;
		sendEvent('log', `Searching ${source.toUpperCase()} for "${q}"`);
		try {
			const data = await fetchWithCache(url, {
				onRateLimit: ({ url: rateLimitedUrl, waitMs }) => {
					sendEvent('log', `Rate limited (429) fetching ${rateLimitedUrl}; waiting ${formatWaitMs(waitMs)} before retrying.`);
				},
			});
			const crds = discoverCrdsFromPayload(data || {});
			sendEvent('log', `Found ${crds.length} CRDs from ${source.toUpperCase()} search`);
			for (const c of crds) discoveredSet.add(c);
			return data;
		} catch (e) {
			const msg = e?.message || String(e);
			sendEvent('log', `ERROR searching ${source.toUpperCase()}: ${msg}`);
			sendEvent('error', { source, message: msg });
			return null;
		}
	}

	try {
		if (query) {
			await searchSourceStream('finra', query);
			await searchSourceStream('sec', query);
		}
		if (startCrd) discoveredSet.add(startCrd);

		const seeds = Array.from(discoveredSet).slice(0, maxVisits);
		sendEvent('log', `Seeding crawl with ${seeds.length} CRD(s)`);

		for (const crd of seeds) {
			sendEvent('log', `\n=== Handling seed CRD ${crd} ===`);
			// fetch FINRA detail to inspect ia_only
			let finraData = null;
			try {
				const finraUrl = buildEndpoint({ source: 'finra', type: 'individual', crd });
				if (finraUrl) {
					finraData = await fetchWithCache(finraUrl, {
						onRateLimit: ({ url: rateLimitedUrl, waitMs }) => {
							sendEvent('log', `Rate limited (429) fetching ${rateLimitedUrl}; waiting ${formatWaitMs(waitMs)} before retrying.`);
						},
					});
				}
			} catch (e) {
				sendEvent('log', `ERROR fetching FINRA detail for ${crd}: ${e?.message || e}`);
			}
			const iaOnly = isIaOnlyFromPayload(finraData || {});
			sendEvent('log', `ia_only for CRD ${crd}: ${iaOnly ? 'Y' : 'N/missing'}`);

			if (iaOnly) {
				try {
					const { saved } = await fetchAndSaveSourceDetail('sec', 'individual', crd, [], [], {
						onRateLimit: ({ url: rateLimitedUrl, waitMs }) => {
							sendEvent('log', `Rate limited (429) fetching ${rateLimitedUrl}; waiting ${formatWaitMs(waitMs)} before retrying.`);
						},
					});
					if (saved) sendEvent('log', `Saved ${saved}`);
				} catch (e) {
					sendEvent('log', `ERROR fetching/saving SEC for ${crd}: ${e?.message || e}`);
				}
			} else {
				try {
					await fetchAndSaveSourceDetail('finra', 'individual', crd, [], [], {
						onRateLimit: ({ url: rateLimitedUrl, waitMs }) => {
							sendEvent('log', `Rate limited (429) fetching ${rateLimitedUrl}; waiting ${formatWaitMs(waitMs)} before retrying.`);
						},
					});
				} catch (e) {
					sendEvent('log', `ERROR fetching/saving FINRA for ${crd}: ${e?.message || e}`);
				}
				try {
					const { saved: s } = await fetchAndSaveSourceDetail('sec', 'individual', crd, [], [], {
						onRateLimit: ({ url: rateLimitedUrl, waitMs }) => {
							sendEvent('log', `Rate limited (429) fetching ${rateLimitedUrl}; waiting ${formatWaitMs(waitMs)} before retrying.`);
						},
					});
					if (s) sendEvent('log', `Saved ${s}`);
				} catch (e) {
					sendEvent('log', `ERROR fetching/saving SEC for ${crd}: ${e?.message || e}`);
				}
			}
		}

		// finished
		sendEvent('log', '\nSearch-and-crawl complete');
		// send a final 'done' event; include a basic summary so client can refresh keys
		sendEvent('done', { seeds: Array.from(discoveredSet).slice(0, maxVisits) });
		// close the stream
		res.end();
	} catch (e) {
		sendEvent('log', `ERROR during stream: ${e?.message || e}`);
		sendEvent('error', { message: e?.message || String(e) });
		try {
			res.end();
		} catch (_) {}
	}
});

async function fetchAndSaveSourceDetail(source, type, crd, logs, savedFiles, options = {}) {
	const onRateLimit = typeof options.onRateLimit === 'function' ? options.onRateLimit : null;
	const url = buildEndpoint({ source, type, crd });
	if (!url) throw new Error(`Unsupported source detail URL for ${source}`);
	// ensure the URL actually contains the CRD to avoid saving generic/blocked responses
	if (!String(url).includes(String(crd))) {
		logs.push(`Skipping save: built URL does not include CRD ${crd} -> ${url}`);
		// still attempt to fetch for decision-making, but don't save unless URL correct
	}
	logs.push(`Fetching ${source.toUpperCase()} ${type} detail for CRD ${crd}`);
	const data = await fetchWithCache(url, {
		onRateLimit: ({ url: rateLimitedUrl, waitMs }) => {
			if (onRateLimit) onRateLimit({ url: rateLimitedUrl, waitMs });
			logs.push(`Rate limited (429) fetching ${rateLimitedUrl}; waiting ${formatWaitMs(waitMs)} before retrying.`);
		},
	});
	if (isEmptyPayload(data)) {
		logs.push(`Skipping save for empty response from ${source.toUpperCase()} ${crd}`);
		return { saved: null, payload: data };
	}
	try {
		const asText = JSON.stringify(data).toLowerCase();
		if (asText.includes('too many requests') || asText.includes('rate limit') || asText.includes('access denied') || asText.includes('captcha') || asText.includes('blocked')) {
			logs.push(`Detected blocking/upstream limitation message from ${source.toUpperCase()} ${crd}; skipping save`);
			return { saved: null, payload: data };
		}
	} catch (e) {
		// if stringify fails, fall back to not saving
		logs.push(`Warning: failed to inspect payload for blocking indicators for ${source} ${crd}: ${e.message}`);
		return { saved: null, payload: data };
	}

	const filename = detailFilenameForSource(source, type, crd);
	if (isNonActionableSavedDetail(filename, data)) {
		await removeSavedPayload(filename);
		logs.push(`Skipping non-actionable SEC adviser shell for ${source.toUpperCase()} ${type} ${crd}`);
		return { saved: null, payload: data };
	}
	const savedPath = await saveRawFile(filename, data);
	const savedName = path.basename(savedPath);
	savedFiles.push(savedName);
	logs.push(`Saved ${savedPath}`);
	return { saved: savedName, payload: data };
}

router.post('/crawl-crd', async (req, res) => {
	const startCrd = String(req.body.startCrd || '').trim();
	const maxDepth = Number(req.body.maxDepth || 2);
	const maxVisits = Number(req.body.maxVisits || 100);

	if (!/^[0-9]+$/.test(startCrd)) {
		return res.status(400).json({ error: 'startCrd must be a numeric CRD' });
	}
	if (!Number.isFinite(maxDepth) || maxDepth < 1) {
		return res.status(400).json({ error: 'maxDepth must be a positive number' });
	}
	if (!Number.isFinite(maxVisits) || maxVisits < 1) {
		return res.status(400).json({ error: 'maxVisits must be a positive number' });
	}

	const logs = [];
	const errors = [];
	const savedFiles = [];
	const savedBySeed = {}; // crd -> [filenames]
	// queue items: { crd, depth, type }
	// start by attempting both individual and firm for the start CRD so we don't miss firm-only records
	const queue = [
		{ crd: startCrd, depth: 0, type: 'individual' },
		{ crd: startCrd, depth: 0, type: 'firm' },
	];
	// visited/pending track "type:crd" to avoid cross-type collisions
	const visited = new Set();
	const pending = new Set([`individual:${startCrd}`, `firm:${startCrd}`]);

	logs.push(`Starting crawl from CRD ${startCrd}`);
	await cleanupLegacyRawFiles();

	while (queue.length > 0 && visited.size < maxVisits) {
		const { crd, depth, type } = queue.shift();
		pending.delete(`${type}:${crd}`);
		if (visited.has(`${type}:${crd}`)) continue;
		visited.add(`${type}:${crd}`);
		logs.push(`\n=== Crawling ${type.toUpperCase()} ${crd} (depth ${depth}) ===`);

		for (const source of ['finra', 'sec']) {
			try {
				const { saved, payload } = await fetchAndSaveSourceDetail(source, type, crd, logs, savedFiles);
				if (saved) {
					savedBySeed[crd] = savedBySeed[crd] || [];
					savedBySeed[crd].push(saved);
				}

				// discover new individual CRDs
				const discovered = discoverCrdsFromPayload(payload || {});
				logs.push(`Discovered ${discovered.length} CRDs from ${source.toUpperCase()} ${type} ${crd}`);
				if (depth + 1 <= maxDepth) {
					for (const discoveredCrd of discovered) {
						const key = `individual:${discoveredCrd}`;
						if (!visited.has(key) && !pending.has(key)) {
							if (visited.size + pending.size < maxVisits) {
								queue.push({ crd: discoveredCrd, depth: depth + 1, type: 'individual' });
								pending.add(key);
							}
						}
					}
				}

				// discover firm ids (e.g., from current employments) and enqueue firm crawls
				const firmIds = discoverFirmIdsFromPayload(payload || {});
				logs.push(`Discovered ${firmIds.length} firm IDs from ${source.toUpperCase()} ${type} ${crd}`);
				if (depth + 1 <= maxDepth) {
					for (const firmId of firmIds) {
						const key = `firm:${firmId}`;
						if (!visited.has(key) && !pending.has(key)) {
							if (visited.size + pending.size < maxVisits) {
								queue.push({ crd: firmId, depth: depth + 1, type: 'firm' });
								pending.add(key);
							}
						}
					}
				}
			} catch (error) {
				const message = error?.message || String(error);
				errors.push({ crd, source, message });
				logs.push(`ERROR ${source.toUpperCase()} ${type} ${crd}: ${message}`);
			}
		}
	}

	logs.push(`\nCrawl complete. Visited ${visited.size} CRD(s).`);
	if (savedFiles.length) {
		logs.push(`Saved ${savedFiles.length} local file(s).`);
	}
	if (errors.length) {
		logs.push(`Encountered ${errors.length} error(s).`);
	}

	return res.json({ startCrd, visited: Array.from(visited), queue: queue.map((item) => item.crd), savedFiles, savedBySeed, errors, logs });
});

// Crawl endpoint: fetches raw JSON from any URL or a CRD range built from a base domain and path
router.post('/crawl', async (req, res) => {
	const { url, baseDomain, path, start, end } = req.body;
	if (url) {
		try {
			const data = await fetchWithCache(url);
			return res.json({ url, data });
		} catch (e) {
			return res.status(500).json({ error: e.message, url });
		}
	}
	if (!baseDomain || !path || start == null) {
		return res.status(400).json({ error: 'Missing url or baseDomain/path/start' });
	}

	const startNum = Number(start);
	const endNum = end != null ? Number(end) : startNum;
	if (!Number.isFinite(startNum) || !Number.isFinite(endNum)) {
		return res.status(400).json({ error: 'CRD start and end must be valid numbers' });
	}
	if (endNum < startNum) {
		return res.status(400).json({ error: 'CRD end must be greater than or equal to start' });
	}
	if (endNum - startNum > 50) {
		return res.status(400).json({ error: 'CRD range is too large; limit to 50 values' });
	}

	const requests = [];
	for (let crd = startNum; crd <= endNum; crd += 1) {
		const targetUrl = buildUrlFromPath({ baseDomain, path, crd });
		requests.push(
			fetchWithCache(targetUrl, {
				onRateLimit: ({ url: rateLimitedUrl, waitMs }) => {
					// no live stream here; still include a useful response log via the result payload
					console.warn(`Rate limited (429) fetching ${rateLimitedUrl}; waiting ${formatWaitMs(waitMs)} before retrying.`);
				},
			})
				.then((data) => ({ url: targetUrl, status: 200, data }))
				.catch((error) => ({ url: targetUrl, error: error.message })),
		);
	}

	try {
		const results = await Promise.all(requests);
		return res.json({ baseDomain, path, start: startNum, end: endNum, results });
	} catch (e) {
		return res.status(500).json({ error: e.message });
	}
});

export default router;
