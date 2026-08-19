import zlib from 'zlib';
import { promises as fs } from 'fs';
import path from 'path';
import { createClient } from 'redis';
import { getReadOnlyRedisClientInstance } from '../../src/lib/redisClient';
import { toProperCaseName } from '../../src/lib/format';

const isDev = process.env.NODE_ENV === 'development';
const redisUrl = isDev ? process.env.REDIS_URL : undefined;
const redisPassword = isDev ? process.env.REDIS_PASSWORD : undefined;
// Prefer canonical env names: UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_URL_MIRROR
const upstashRedisRestUrl = isDev ? undefined : process.env.UPSTASH_REDIS_REST_URL || process.env.UPSTASH_REDIS_REST_URL_3 || process.env.CRD_UPSTASH_URL_1;
const upstashRedisRestToken = isDev ? undefined : process.env.UPSTASH_REDIS_REST_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN_3 || process.env.CRD_UPSTASH_TOKEN_1;
const upstashRedisRestUrl2 =
	isDev ? undefined : process.env.UPSTASH_REDIS_REST_URL_MIRROR || process.env.UPSTASH_REDIS_REST_URL_4 || process.env.CRD_UPSTASH_URL_2 || process.env.UPSTASH_REDIS_REST_URL_2;
const upstashRedisRestToken2 =
	isDev ? undefined : (
		process.env.UPSTASH_REDIS_REST_TOKEN_MIRROR || process.env.UPSTASH_REDIS_REST_TOKEN_4 || process.env.CRD_UPSTASH_TOKEN_2 || process.env.UPSTASH_REDIS_REST_TOKEN_2
	);
const cacheTtlSeconds = Number(process.env.CACHE_TTL_SECONDS) || 3600;
// The local `data/raw` disk cache/fallback has been removed entirely (deleted
// from disk) — Redis is now the single source of truth for saved payloads.
// Do not reintroduce disk-based reads/writes/fallbacks for individual/firm
// payload storage.
const isServerlessRuntime = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
// Vercel deploy FS under /var/task is read-only; keep local index cache in /tmp there.
const localDerivedDir = isServerlessRuntime ? path.join('/tmp', 'dashboard-crds', 'data', 'derived') : path.resolve(process.cwd(), 'data', 'derived');
const rawKeysIndexPath = path.join(localDerivedDir, 'raw-keys-index.json');
const rawFileSuffix = '.json';
const redisClient = redisUrl ? createClient({ url: redisUrl, password: redisPassword }) : null;
// read-only Upstash client (may proxy to mirror/local as configured)
// typed as `any` so existing call-sites that optionally use a secondary
// client continue to compile when a mirror is not configured.
const upstashRedisClient: any = getReadOnlyRedisClientInstance();
const upstashRedisClient2: any = null;
// Allow enabling writes via env when you want this app to perform writes again.
const ALLOW_REDIS_WRITES = Boolean(process.env.ALLOW_REDIS_WRITES && String(process.env.ALLOW_REDIS_WRITES) !== '0');
// writable Upstash clients (only created when writes are allowed)
let writableUpstashClient: any = null;
let writableUpstashClient2: any = null;
if (ALLOW_REDIS_WRITES) {
	try {
		// Lazy require to avoid bundling conflicts in serverless
		const { Redis: UpstashWritable } = require('@upstash/redis');
		if (upstashRedisRestUrl && upstashRedisRestToken) writableUpstashClient = new UpstashWritable({ url: upstashRedisRestUrl, token: upstashRedisRestToken });
		if (upstashRedisRestUrl2 && upstashRedisRestToken2) writableUpstashClient2 = new UpstashWritable({ url: upstashRedisRestUrl2, token: upstashRedisRestToken2 });
	} catch (e) {
		// ignore
	}
}
const rawKeysIndexBatchSize = 100;

type SavedKeyType = 'individual' | 'firm';
type SavedKeySource = 'finra' | 'sec';
export type { SavedKeyType, SavedKeySource };

export interface SavedKeyStat {
	key: string;
	mtime: number;
	industryDate: string | null;
	isActive: boolean;
	source: SavedKeySource;
	type: SavedKeyType;
	crd: string;
	displayName?: string | null;
}

export interface ListSavedKeysOptions {
	filter?: string;
	type?: 'all' | SavedKeyType;
	sort?: 'date-desc' | 'crd-asc' | 'crd-desc';
	limit?: number;
	includeCrds?: string[];
}

let rawKeysIndexCache: SavedKeyStat[] | null = null;
let rawKeysIndexCacheExpiresAt = 0;
let rawKeysIndexLoadPromise: Promise<SavedKeyStat[]> | null = null;
let rawKeysIndexRefreshPromise: Promise<SavedKeyStat[]> | null = null;
let rawKeysIndexWritePromise: Promise<void> = Promise.resolve();
const rawKeysIndexCacheTtlMs = Number(process.env.RAW_KEYS_INDEX_CACHE_TTL_MS) || 5 * 60 * 1000;

export type RedisConnectionMode = 'upstash-rest' | 'redis-url' | 'none';

export interface RedisHealthStatus {
	ok: boolean;
	configured: boolean;
	mode: RedisConnectionMode;
	latencyMs: number | null;
	message: string;
	error?: string;
}

export function formatErrorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

export function getRedisConnectionMode(): RedisConnectionMode {
	if (upstashRedisClient2 || upstashRedisClient) return 'upstash-rest';
	if (redisClient) return 'redis-url';
	return 'none';
}

export async function checkRedisHealth(): Promise<RedisHealthStatus> {
	const mode = getRedisConnectionMode();
	if (mode === 'none') {
		return {
			ok: false,
			configured: false,
			mode,
			latencyMs: null,
			message: 'Redis is not configured. Set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (recommended) or REDIS_URL.',
		};
	}

	const startedAt = Date.now();
	// Read-only health check: attempt a harmless read (DBSIZE or GET) instead
	try {
		// Prefer DB size/read operations which are read-only
		if (upstashRedisClient || upstashRedisClient2) {
			let okRead = false;
			for (const client of [upstashRedisClient, upstashRedisClient2]) {
				if (!client) continue;
				try {
					// dbsize is read-only and inexpensive for our purposes
					await client.dbsize();
					okRead = true;
					break;
				} catch (err) {
					// try next
				}
			}
			if (!okRead) throw new Error('All upstash read attempts failed');
		} else {
			const client = await getRedisClient();
			if (!client) throw new Error('Native redis client not available');
			await client.dbSize();
		}

		return {
			ok: true,
			configured: true,
			mode,
			latencyMs: Date.now() - startedAt,
			message: 'Redis read-only connection is healthy.',
		};
	} catch (error) {
		return {
			ok: false,
			configured: true,
			mode,
			latencyMs: Date.now() - startedAt,
			message: 'Redis read-only connection failed during health probe.',
			error: formatErrorMessage(error),
		};
	}
}

function randBetween(min: number, max: number) {
	const lo = Number(min) || 0;
	const hi = Number(max) || 0;
	if (hi <= lo) return lo;
	return Math.round(lo + Math.random() * (hi - lo));
}

function sleep(ms: number) {
	return new Promise((r) => setTimeout(r, ms));
}

async function getRedisClient() {
	if (!redisClient) return null;
	if (!redisClient.isOpen) {
		await redisClient.connect();
	}
	return redisClient;
}

function compressPayload(value: string): string {
	try {
		// Only compress if the value is reasonably large to avoid overhead
		if (value.length > 512) {
			return 'br:' + zlib.brotliCompressSync(Buffer.from(value)).toString('base64');
		}
	} catch {
		// fallback
	}
	return value;
}

function decompressPayload(value: string): string {
	if (typeof value === 'string' && value.startsWith('br:')) {
		try {
			return zlib.brotliDecompressSync(Buffer.from(value.slice(3), 'base64')).toString('utf-8');
		} catch {
			return value;
		}
	}
	return value;
}

export async function getCacheValue(key: string) {
	if (upstashRedisClient && upstashRedisClient2) {
		const p1 = upstashRedisClient.get(key).then((v: unknown) => {
			if (v == null) throw new Error('not found');
			return typeof v === 'string' ? v : JSON.stringify(v);
		});
		const p2 = upstashRedisClient2.get(key).then((v: unknown) => {
			if (v == null) throw new Error('not found');
			return typeof v === 'string' ? v : JSON.stringify(v);
		});

		try {
			const rawValue = await new Promise((resolve, reject) => {
				let rejectedCount = 0;
				const handleReject = () => {
					rejectedCount++;
					if (rejectedCount === 2) reject(new Error('both failed'));
				};
				p1.then(resolve).catch(handleReject);
				p2.then(resolve).catch(handleReject);
			});
			return decompressPayload(rawValue as string);
		} catch (e) {
			return null;
		}
	}

	let rawValue: any = null;
	if (upstashRedisClient) {
		try {
			const value = await upstashRedisClient.get(key);
			if (value != null) {
				rawValue = typeof value === 'string' ? value : JSON.stringify(value);
			}
		} catch (e) {
			console.warn('Primary redis read failed', formatErrorMessage(e));
		}
	} else if (!upstashRedisClient2) {
		const client = await getRedisClient();
		if (client) {
			try {
				rawValue = await client.get(key);
			} catch (e) {
				console.warn('Native redis read failed', formatErrorMessage(e));
			}
		}
	}

	if (rawValue == null && upstashRedisClient2) {
		try {
			const value = await upstashRedisClient2.get(key);
			if (value != null) {
				rawValue = typeof value === 'string' ? value : JSON.stringify(value);
			}
		} catch (e) {
			console.warn('Secondary redis read failed', formatErrorMessage(e));
		}
	}

	if (rawValue == null) return null;
	return decompressPayload(rawValue);
}

export async function setCacheValue(key: string, value: string, ttlSeconds?: number) {
	if (!ALLOW_REDIS_WRITES) {
		// Writes disabled in this deployment: this application is read-only for Redis.
		// Another app is responsible for updating the cache.
		return;
	}

	const finalValue = compressPayload(value);
	let handled = false;

	if (writableUpstashClient) {
		try {
			if (ttlSeconds && ttlSeconds > 0) {
				await writableUpstashClient.set(key, finalValue, { ex: Math.floor(ttlSeconds) });
			} else {
				await writableUpstashClient.set(key, finalValue);
			}
			handled = true;
		} catch (e) {
			console.warn('Primary redis write failed', formatErrorMessage(e));
		}
	}

	if (writableUpstashClient2) {
		try {
			if (ttlSeconds && ttlSeconds > 0) {
				await writableUpstashClient2.set(key, finalValue, { ex: Math.floor(ttlSeconds) });
			} else {
				await writableUpstashClient2.set(key, finalValue);
			}
			handled = true;
		} catch (e) {
			console.warn('Secondary redis write failed', formatErrorMessage(e));
		}
	}

	if (handled) return;

	const client = await getRedisClient();
	if (!client) return;
	if (ttlSeconds && ttlSeconds > 0) {
		await client.set(key, finalValue, { EX: Math.floor(ttlSeconds) });
		return;
	}
	await client.set(key, finalValue);
}

export async function getLocalRedisValue(key: string) {
	const client = await getRedisClient();
	if (!client) return null;
	try {
		const value = await client.get(key);
		if (value == null) return null;
		return decompressPayload(typeof value === 'string' ? value : JSON.stringify(value));
	} catch (error) {
		console.warn('Local graph redis read failed', formatErrorMessage(error));
		return null;
	}
}

/** Session-graph reads. Local Redis in dev, then the shared cache. */
export async function getGraphCacheValue(key: string) {
	const local = await getLocalRedisValue(key);
	if (local != null) return local;
	return getCacheValue(key);
}

/** Session-graph writes. Local Redis in dev; same write path as cache in prod. */
export async function setGraphCacheValue(key: string, value: string) {
	const client = await getRedisClient();
	if (client) {
		await client.set(key, value);
		return;
	}
	await setCacheValue(key, value);
}

export async function deleteGraphCacheKey(key: string) {
	const client = await getRedisClient();
	if (client) {
		await client.del(key);
		return;
	}
	await deleteCacheKey(key);
}

async function deleteCacheKey(key: string) {
	if (!ALLOW_REDIS_WRITES) return;
	for (const client of [writableUpstashClient, writableUpstashClient2]) {
		if (!client) continue;
		try {
			await client.del(key);
		} catch (e) {
			// ignore single client failure
		}
	}
	const client = await getRedisClient();
	if (!client) return;
	await client.del(key);
}

export async function trackFirmConnections(firmIds: string[]) {
	if (!firmIds || firmIds.length === 0) return;
	const key = 'dashboard:collected_firms';
	let handled = false;
	if (!ALLOW_REDIS_WRITES) return;

	if (writableUpstashClient) {
		try {
			await writableUpstashClient.sadd(key, ...(firmIds as [string, ...string[]]));
			handled = true;
		} catch (e) {}
	}
	if (writableUpstashClient2) {
		try {
			await writableUpstashClient2.sadd(key, ...(firmIds as [string, ...string[]]));
			handled = true;
		} catch (e) {}
	}

	if (handled) return;
	const client = await getRedisClient();
	if (!client) return;
	await client.sAdd(key, firmIds);
}

async function scanKeysByPatterns(patterns: string[]) {
	const normalizedPatterns = Array.from(new Set(patterns.filter(Boolean)));
	const keys = new Set<string>();

	if (upstashRedisClient || upstashRedisClient2) {
		for (const client of [upstashRedisClient, upstashRedisClient2]) {
			if (!client) continue;
			try {
				for (const pattern of normalizedPatterns) {
					let cursor = '0';
					do {
						const [nextCursor, batch] = await client.scan(cursor, { match: pattern, count: 1000 });
						for (const key of batch || []) {
							keys.add(String(key));
						}
						cursor = String(nextCursor || '0');
					} while (cursor !== '0');
				}
			} catch (e) {
				console.warn('Scan failed on one of the clients', formatErrorMessage(e));
			}
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

export async function getRedisDbSize() {
	const CACHE_KEY = 'dashboard:cached-crd-count';

	// In development (localhost) prefer reading from local redis only.
	if (isDev && redisClient) {
		try {
			const client = await getRedisClient();
			if (client) {
				try {
					const v = await client.get(CACHE_KEY);
					if (v != null) return Number(decompressPayload(typeof v === 'string' ? v : JSON.stringify(v)));
				} catch (e) {
					// ignore and fall back to dbSize
				}
				try {
					return await client.dbSize();
				} catch (e) {
					// ignore
				}
			}
		} catch (e) {
			// ignore
		}
		return 0;
	}

	// In production-ish setups prefer explicit Upstash primary first (mirror may lag)
	try {
		const { Redis: UpstashRedis } = require('@upstash/redis');
		if (upstashRedisRestUrl && upstashRedisRestToken) {
			try {
				const primary = new UpstashRedis({ url: upstashRedisRestUrl, token: upstashRedisRestToken });
				const v = await primary.get(CACHE_KEY);
				if (v != null) return Number(decompressPayload(typeof v === 'string' ? v : JSON.stringify(v)));
			} catch (e) {
				// ignore primary read failure
			}
		}
		if (upstashRedisRestUrl2 && upstashRedisRestToken2) {
			try {
				const mirror = new UpstashRedis({ url: upstashRedisRestUrl2, token: upstashRedisRestToken2 });
				const v2 = await mirror.get(CACHE_KEY);
				if (v2 != null) return Number(decompressPayload(typeof v2 === 'string' ? v2 : JSON.stringify(v2)));
			} catch (e) {
				// ignore mirror read failure
			}
		}
	} catch (e) {
		// ignore if upstash client cannot be constructed
	}

	// Fallback to previous behavior: cached value via read-only client or dbsize
	if (redisClient || upstashRedisClient || upstashRedisClient2) {
		try {
			const cached = await getCacheValue(CACHE_KEY);
			if (cached != null) return Number(cached);
		} catch (e) {}

		let total = 0;
		let usingUpstash = false;
		for (const client of [upstashRedisClient, upstashRedisClient2]) {
			if (!client) continue;
			usingUpstash = true;
			try {
				total += await client.dbsize();
			} catch (e) {}
		}

		if (!usingUpstash) {
			try {
				const client = await getRedisClient();
				if (client) total = await client.dbSize();
			} catch (e) {}
		}

		// Read-only deployment: do not write cached DB size back to Redis.
		return total;
	}

	if (redisClient) {
		const client = await getRedisClient();
		if (client) {
			return await client.dbSize();
		}
	}
	return 0;
}

export async function getCachedCrdCounts() {
	const CACHE_KEY = 'dashboard:cached-crd-count';
	const result: { local: number | null; upstashPrimary: number | null; upstashMirror: number | null } = {
		local: null,
		upstashPrimary: null,
		upstashMirror: null,
	};

	// If running in development (localhost), prefer local redis only.
	if (isDev) {
		if (redisClient) {
			try {
				const client = await getRedisClient();
				if (client) {
					const v = await client.get(CACHE_KEY);
					if (v != null) {
						const dec = decompressPayload(typeof v === 'string' ? v : JSON.stringify(v));
						const n = Number(dec);
						result.local = Number.isFinite(n) ? n : null;
					}
				}
			} catch (e) {
				console.warn('Failed to read local redis cached count', formatErrorMessage(e));
			}
		}

		return result;
	}

	// Upstash primary
	// Read Upstash primary and mirror separately (mirror may lag)
	try {
		const { Redis: UpstashRedis } = require('@upstash/redis');
		if (upstashRedisRestUrl && upstashRedisRestToken) {
			try {
				const primary = new UpstashRedis({ url: upstashRedisRestUrl, token: upstashRedisRestToken });
				const v = await primary.get(CACHE_KEY);
				if (v != null) {
					const raw = typeof v === 'string' ? v : JSON.stringify(v);
					const dec = decompressPayload(raw);
					const n = Number(dec);
					result.upstashPrimary = Number.isFinite(n) ? n : null;
				}
			} catch (e) {
				console.warn('Failed to read primary upstash cached count', formatErrorMessage(e));
			}
		}

		if (upstashRedisRestUrl2 && upstashRedisRestToken2) {
			try {
				const mirror = new UpstashRedis({ url: upstashRedisRestUrl2, token: upstashRedisRestToken2 });
				const v2 = await mirror.get(CACHE_KEY);
				if (v2 != null) {
					const raw2 = typeof v2 === 'string' ? v2 : JSON.stringify(v2);
					const dec2 = decompressPayload(raw2);
					const n2 = Number(dec2);
					result.upstashMirror = Number.isFinite(n2) ? n2 : null;
				}
			} catch (e) {
				console.warn('Failed to read mirror upstash cached count', formatErrorMessage(e));
			}
		}
	} catch (e) {
		// upstash client require failed - ignore
	}

	// Local/native redis
	if (redisClient) {
		try {
			const client = await getRedisClient();
			if (client) {
				const v = await client.get(CACHE_KEY);
				if (v != null) {
					const dec = decompressPayload(typeof v === 'string' ? v : JSON.stringify(v));
					const n = Number(dec);
					result.local = Number.isFinite(n) ? n : null;
				}
			}
		} catch (e) {
			console.warn('Failed to read local redis cached count', formatErrorMessage(e));
		}
	}

	return result;
}

function cacheKeyForUrl(url: string) {
	return `finra-sec:cache:${encodeURIComponent(url)}`;
}

export async function fetchWithCache(
	url: string,
	options?: { onRateLimit?: (info: { url: string; attempt: number; waitMs: number }) => void | Promise<void>; forceRefresh?: boolean },
) {
	const cacheKey = cacheKeyForUrl(url);
	const onRateLimit = options?.onRateLimit;
	const forceRefresh = options?.forceRefresh === true;

	if (!forceRefresh) {
		try {
			const cached = await getCacheValue(cacheKey);
			if (cached) return JSON.parse(cached);
		} catch (e) {
			console.warn('Redis cache read failed', formatErrorMessage(e));
		}
	}

	// simple fetch with basic retries/backoff
	let attempt = 0;
	let lastErr: any = null;
	const crawlDelayMinMs = Number(process.env.CRAWL_DELAY_MS_MIN) || Number(process.env.CRAWL_DELAY_MS) || 8000;
	const crawlDelayMaxMs = Number(process.env.CRAWL_DELAY_MS_MAX) || Math.max(crawlDelayMinMs, 23000);
	const crawlInitialDelayMs = Number(process.env.CRAWL_INITIAL_DELAY_MS) || 0;
	const crawlMaxRetries = Number(process.env.CRAWL_MAX_RETRIES) || 4;
	const crawl429DelayMinMs = Number(process.env.CRAWL_429_DELAY_MS_MIN) || 5 * 60 * 1000;
	const crawl429DelayMaxMs = Number(process.env.CRAWL_429_DELAY_MS_MAX) || 7 * 60 * 1000;

	while (true) {
		attempt += 1;
		if (attempt > 1) {
			const base = crawlDelayMinMs * Math.pow(2, attempt - 2);
			const jittered = randBetween(Math.round(base * 0.6), Math.round(base * 1.4));
			await sleep(jittered);
		} else if (crawlInitialDelayMs > 0) {
			const initial = randBetween(0, crawlInitialDelayMs);
			await sleep(initial);
		}

		let resp: Response;
		try {
			resp = await fetch(url);
		} catch (err) {
			lastErr = err;
			if (attempt >= crawlMaxRetries) throw err;
			continue;
		}

		if (resp.status === 429) {
			lastErr = new Error('429 Too Many Requests');
			const retryAfterHeader = Number(resp.headers.get('retry-after'));
			const retryAfterMs = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0 ? Math.round(retryAfterHeader * 1000) : null;
			const waitMs = retryAfterMs ?? randBetween(Math.min(crawl429DelayMinMs, crawl429DelayMaxMs), Math.max(crawl429DelayMinMs, crawl429DelayMaxMs));
			if (onRateLimit) {
				try {
					await onRateLimit({ url, attempt, waitMs });
				} catch (e) {
					// ignore callback errors
				}
			}
			if (attempt >= crawlMaxRetries) {
				throw new Error(`Too Many Requests (429) for ${url}`);
			}
			await sleep(waitMs);
			continue;
		}

		if (resp.status >= 500 && resp.status < 600) {
			lastErr = new Error(`Upstream error ${resp.status}`);
			if (attempt >= crawlMaxRetries) {
				const text = await resp.text().catch(() => '');
				throw new Error(`Upstream error ${resp.status}: ${text}`);
			}
			const baseBackoff = crawlDelayMinMs * Math.pow(2, attempt - 1);
			const jitteredBackoff = randBetween(Math.round(baseBackoff * 0.6), Math.round(baseBackoff * 1.4));
			await sleep(jitteredBackoff);
			continue;
		}

		if (!resp.ok) {
			const text = await resp.text().catch(() => '');
			throw new Error(`HTTP ${resp.status} ${resp.statusText}${text ? ': ' + text : ''}`);
		}

		const data = await resp.json();
		if (redisClient || upstashRedisClient || upstashRedisClient2) {
			try {
				await setCacheValue(cacheKey, JSON.stringify(data), cacheTtlSeconds);
			} catch (e) {
				console.warn('Redis cache write failed', formatErrorMessage(e));
			}
		}
		return data;
	}
}

export function buildEndpoint({ source, type, crd }: { source: string; type: string; crd: string }) {
	if (source === 'finra') {
		if (type === 'individual') return `https://api.brokercheck.finra.org/search/individual/${crd}?includePrevious=true`;
		if (type === 'firm') return `https://api.brokercheck.finra.org/search/firm/${crd}`;
	}
	if (source === 'sec') {
		if (type === 'individual') return `https://api.adviserinfo.sec.gov/search/individual/${crd}?includePrevious=true`;
		if (type === 'firm') return `https://api.adviserinfo.sec.gov/search/firm/${crd}?wt=json`;
	}
	return null;
}

async function ensureLocalDerivedDir() {
	try {
		await fs.mkdir(localDerivedDir, { recursive: true });
		return true;
	} catch (error) {
		console.warn('Failed to ensure local derived dir', formatErrorMessage(error));
		return false;
	}
}

async function writeRawValueToRedis(rawKey: string, serializedPayload: string) {
	if (!ALLOW_REDIS_WRITES) return;
	if (!(writableUpstashClient || writableUpstashClient2 || redisClient)) return;
	const compressed = zlib.brotliCompressSync(Buffer.from(serializedPayload, 'utf-8')).toString('base64');
	await setCacheValue(rawKey, compressed);
}

async function readRawValueFromRedis(rawKey: string) {
	if (!(upstashRedisClient || upstashRedisClient2 || redisClient)) return null;
	// Local Redis first (dev), then the shared cache. Do not require the
	// saved-key index or on-disk raw files.
	const val = (await getLocalRedisValue(rawKey)) ?? (await getCacheValue(rawKey));
	if (!val) return null;

	const trimmed = val.trim();
	if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
		return trimmed;
	}

	try {
		return zlib.brotliDecompressSync(Buffer.from(trimmed, 'base64')).toString('utf-8');
	} catch {
		try {
			return zlib.gunzipSync(Buffer.from(trimmed, 'base64')).toString('utf-8');
		} catch (err) {
			console.warn(`Failed to decompress raw key ${rawKey}`, err);
			return null;
		}
	}
}

export async function listRawKeysFromRedis() {
	if (!(upstashRedisClient || upstashRedisClient2 || redisClient)) return [];
	const keys = await scanKeysByPatterns(['finra:individual:*', 'finra:firm:*', 'sec:individual:*', 'sec:firm:*']);
	return keys.map((key) => filenameToRawKey(String(key || ''))).filter((key) => /^(finra|sec):(individual|firm):\d+$/i.test(key));
}

export async function cleanupLegacyRawFiles() {
	// No-op: the local `data/raw` disk cache has been removed. Redis is the
	// only saved-payload store now, so there are no legacy on-disk files to
	// clean up.
	return;
}

export function rawKeyToFilename(key: string) {
	const normalized = String(key || '').trim();
	if (!normalized) throw new Error('Raw key cannot be empty');
	return normalized.toLowerCase().endsWith(rawFileSuffix) ? normalized : `${normalized}${rawFileSuffix}`;
}

export function filenameToRawKey(filename: string) {
	return String(filename || '')
		.trim()
		.replace(/\.json$/i, '');
}

export function parseSavedRawKey(rawKey: string) {
	const match = String(rawKey || '')
		.trim()
		.match(/^(finra|sec):(individual|firm):(\d+)$/i);
	if (!match) return null;
	return {
		source: match[1].toLowerCase() as SavedKeySource,
		type: match[2].toLowerCase() as SavedKeyType,
		crd: match[3],
	};
}

export async function saveRawFile(filename: string, payload: any) {
	const formattedPayload = formatRawPayloadForStorage(filename, payload);
	const serializedPayload = JSON.stringify(formattedPayload, null, 2);
	const normalizedFilename = rawKeyToFilename(filename);
	const rawKey = filenameToRawKey(normalizedFilename);
	const filePath = null;
	await writeRawValueToRedis(rawKey, serializedPayload);
	const stats = await upsertSavedKeyIndexEntry(normalizedFilename, formattedPayload, undefined, Date.now());
	return { filePath, stats };
}

export function hasBlockingIndicators(payload: any) {
	try {
		const asText = JSON.stringify(payload).toLowerCase();
		return asText.includes('too many requests') || asText.includes('rate limit') || asText.includes('access denied') || asText.includes('captcha') || asText.includes('blocked');
	} catch (e) {
		return true;
	}
}

// Rule 3 (Missing & Corrupt CRD Handling): if a CRD is missing or corrupt in
// Redis, query the upstream FINRA/SEC detail endpoints and, if a valid
// non-empty/non-blocked payload comes back, persist it to Redis in the exact
// wrapper shape (`finraBrokerCheck`/`secInvestmentAdvisor`) via saveRawFile.
// Shared by pages/api/key.ts and pages/api/insights.ts so both entry points
// hydrate missing CRDs the same way instead of failing outright.
export async function hydrateFromUpstream(type: SavedKeyType, crd: string) {
	let hydrated = false;
	for (const source of ['finra', 'sec'] as const) {
		const endpoint = buildEndpoint({ source, type, crd });
		if (!endpoint) continue;
		try {
			const resData = await fetchWithCache(endpoint);
			if (!resData || isEmptyPayload(resData) || hasBlockingIndicators(resData)) continue;
			let content = resData;
			if (Array.isArray(resData?.hits?.hits) && resData.hits.hits[0]?._source?.content) {
				try {
					content = JSON.parse(resData.hits.hits[0]._source.content);
				} catch {
					content = resData;
				}
			}
			if (content && !isEmptyPayload(content) && !hasBlockingIndicators(content)) {
				const wrapperKey = source === 'finra' ? 'finraBrokerCheck' : 'secInvestmentAdvisor';
				await saveRawFile(`${source}:${type}:${crd}`, { [wrapperKey]: content });
				hydrated = true;
			}
		} catch {
			// ignore single source network failures
		}
	}
	return hydrated;
}

function tryParseJsonString(value: string) {
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

export function normalizeRawPayload(payload: any): any {
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

	// 2. Legacy keys (for robustness)
	if (normalizedEntries.iacontent && typeof normalizedEntries.iacontent === 'object' && Object.keys(normalizedEntries).length === 1) {
		return normalizeRawPayload(normalizedEntries.iacontent);
	}
	if (normalizedEntries.bccontent && typeof normalizedEntries.bccontent === 'object' && Object.keys(normalizedEntries).length === 1) {
		return normalizeRawPayload(normalizedEntries.bccontent);
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

export function formatRawPayloadForStorage(filename: string, payload: any) {
	const normalizedPayload = normalizeRawPayload(payload);
	const rawKey = filenameToRawKey(rawKeyToFilename(filename));
	if (!/^(finra|sec):(individual|firm):\d+$/i.test(rawKey)) {
		return normalizedPayload;
	}
	if (!normalizedPayload || typeof normalizedPayload !== 'object' || Array.isArray(normalizedPayload)) {
		return normalizedPayload;
	}
	if (
		(normalizedPayload.finraBrokerCheck && typeof normalizedPayload.finraBrokerCheck === 'object' && Object.keys(normalizedPayload).length === 1) ||
		(normalizedPayload.secInvestmentAdvisor && typeof normalizedPayload.secInvestmentAdvisor === 'object' && Object.keys(normalizedPayload).length === 1) ||
		(normalizedPayload.iacontent && typeof normalizedPayload.iacontent === 'object' && Object.keys(normalizedPayload).length === 1) ||
		(normalizedPayload.bccontent && typeof normalizedPayload.bccontent === 'object' && Object.keys(normalizedPayload).length === 1) ||
		(normalizedPayload.content && typeof normalizedPayload.content === 'object' && Object.keys(normalizedPayload).length === 1)
	) {
		return normalizedPayload;
	}
	return rawKey.startsWith('finra:') ? { finraBrokerCheck: normalizedPayload } : { secInvestmentAdvisor: normalizedPayload };
}

export function isFinraIndividualAdviserOnlyStub(payload: any) {
	const normalizedPayload = normalizeRawPayload(payload);
	if (!normalizedPayload || typeof normalizedPayload !== 'object' || Array.isArray(normalizedPayload)) {
		return false;
	}

	const root = normalizedPayload as Record<string, any>;
	const basicInformation = root.basicInformation && typeof root.basicInformation === 'object' && !Array.isArray(root.basicInformation) ? root.basicInformation : null;

	// Check if this is a search hit or a detail payload
	const bcScope = String(basicInformation?.bcScope || root.ind_bc_scope || '')
		.trim()
		.toLowerCase();
	const iaScope = String(basicInformation?.iaScope || root.ind_ia_scope || '')
		.trim()
		.toLowerCase();

	// If BC is not in scope but IA is active, it's an IA stub inside FINRA
	if (bcScope === 'notinscope' && iaScope === 'active') return true;

	const currentEmployments = Array.isArray(root.currentEmployments || root.ind_current_employments) ? root.currentEmployments || root.ind_current_employments : [];
	const hasOnlyIAEmployments = currentEmployments.length > 0 && currentEmployments.every((e: any) => e.ia_only === 'Y' || e.iaOnly === 'Y');

	return bcScope === 'notinscope' && hasOnlyIAEmployments;
}

export function isSecIndividualBrokerOnlyStub(payload: any) {
	const normalizedPayload = normalizeRawPayload(payload);
	if (!normalizedPayload || typeof normalizedPayload !== 'object' || Array.isArray(normalizedPayload)) {
		return false;
	}

	const root = normalizedPayload as Record<string, any>;
	const basicInformation = root.basicInformation && typeof root.basicInformation === 'object' && !Array.isArray(root.basicInformation) ? root.basicInformation : null;

	const bcScope = String(basicInformation?.bcScope || root.ind_bc_scope || '')
		.trim()
		.toLowerCase();
	const iaScope = String(basicInformation?.iaScope || root.ind_ia_scope || '')
		.trim()
		.toLowerCase();

	// If IA is not in scope but BC is active, it's a BC stub inside SEC
	if (iaScope === 'notinscope' && bcScope === 'active') return true;

	const currentIAEmployments = Array.isArray(root.currentIAEmployments) ? root.currentIAEmployments : [];
	const previousIAEmployments = Array.isArray(root.previousIAEmployments) ? root.previousIAEmployments : [];

	return iaScope === 'notinscope' && currentIAEmployments.length === 0 && previousIAEmployments.length === 0;
}

export function isFinraFirmAdviserOnlyStub(payload: any) {
	const normalizedPayload = normalizeRawPayload(payload);
	if (!normalizedPayload || typeof normalizedPayload !== 'object' || Array.isArray(normalizedPayload)) {
		return false;
	}

	const root = normalizedPayload as Record<string, any>;
	const basicInformation = root.basicInformation && typeof root.basicInformation === 'object' && !Array.isArray(root.basicInformation) ? root.basicInformation : null;
	if (!basicInformation) return false;

	const bcScope = String(basicInformation.bcScope || root.bc_scope || '')
		.trim()
		.toLowerCase();
	const hasBrokercheckScope = bcScope !== '' && bcScope !== 'notinscope';

	const hasAdviserOnlyMarkers = [basicInformation.iaScope, basicInformation.isIAFirm, basicInformation.iaSECNumber, root.iaDisclosureFlag, root.iaFirmAddressDetails].some(
		(value) => value != null && String(value).trim() !== '' && String(value).trim().toLowerCase() !== 'notinscope',
	);

	return !hasBrokercheckScope && hasAdviserOnlyMarkers;
}

export function isSecFirmBrokerOnlyStub(payload: any) {
	const normalizedPayload = normalizeRawPayload(payload);
	if (!normalizedPayload || typeof normalizedPayload !== 'object' || Array.isArray(normalizedPayload)) {
		return false;
	}

	const root = normalizedPayload as Record<string, any>;
	const basicInformation = root.basicInformation && typeof root.basicInformation === 'object' && !Array.isArray(root.basicInformation) ? root.basicInformation : null;
	if (!basicInformation) return false;

	const iaScope = String(basicInformation.iaScope || root.ia_scope || '')
		.trim()
		.toLowerCase();
	const hasAdviserScope = iaScope !== '' && iaScope !== 'notinscope';

	const hasBrokerOnlyMarkers = [basicInformation.bcScope, root.firmAddressDetails, root.bdSECNumber, basicInformation.bdSECNumber].some(
		(value) => value != null && String(value).trim() !== '' && String(value).trim().toLowerCase() !== 'notinscope',
	);

	return !hasAdviserScope && hasBrokerOnlyMarkers;
}

export function isNonActionableSavedDetail(filename: string, payload: any) {
	const rawKey = filenameToRawKey(rawKeyToFilename(filename));
	return (
		(/^sec:individual:\d+$/i.test(rawKey) && isSecIndividualBrokerOnlyStub(payload)) ||
		(/^finra:individual:\d+$/i.test(rawKey) && isFinraIndividualAdviserOnlyStub(payload)) ||
		(/^finra:firm:\d+$/i.test(rawKey) && isFinraFirmAdviserOnlyStub(payload)) ||
		(/^sec:firm:\d+$/i.test(rawKey) && isSecFirmBrokerOnlyStub(payload))
	);
}

export async function listSavedKeys() {
	const redisKeys = await listRawKeysFromRedis();
	return redisKeys;
}

function sortSavedKeyStats(entries: SavedKeyStat[], sort: ListSavedKeysOptions['sort'] = 'date-desc') {
	if (sort === 'crd-asc') {
		return [...entries].sort((a, b) => Number(a.crd) - Number(b.crd) || b.mtime - a.mtime);
	}
	if (sort === 'crd-desc') {
		return [...entries].sort((a, b) => Number(b.crd) - Number(a.crd) || b.mtime - a.mtime);
	}
	return [...entries].sort((a, b) => b.mtime - a.mtime || Number(a.crd) - Number(b.crd));
}

function buildSavedKeyStat(filename: string, mtime: number, payload: unknown): SavedKeyStat | null {
	const rawKey = filenameToRawKey(filename);
	const parsedKey = parseSavedRawKey(rawKey);
	if (!parsedKey) return null;
	const industryDate = parsedKey.type === 'individual' ? extractIndustryDateFromContent(rawKey, payload) : null;
	const isActive = parsedKey.type === 'individual' ? extractIsActiveFromContent(rawKey, payload) : false;
	const content = getContentBlock(rawKey, payload);
	const displayName = extractDisplayNameFromContent(rawKey, content);
	return {
		key: rawKey,
		mtime,
		industryDate,
		isActive,
		source: parsedKey.source,
		type: parsedKey.type,
		crd: parsedKey.crd,
		displayName,
	};
}

function extractDisplayNameFromContent(filename: string, content: Record<string, unknown> | null): string | null {
	if (!content || typeof content !== 'object') return null;
	const bi = content.basicInformation && typeof content.basicInformation === 'object' ? (content.basicInformation as Record<string, unknown>) : {};
	const text = (...values: unknown[]) =>
		values
			.map((value) => String(value || '').trim())
			.filter(Boolean)
			.join(' ')
			.trim();
	const asName = (...values: unknown[]) => {
		const joined = text(...values);
		return joined || null;
	};
	if (/:(individual):/i.test(filename)) {
		const orphan = content.orphan && typeof content.orphan === 'object' ? (content.orphan as Record<string, unknown>) : null;
		const rawName =
			asName(bi.firstName, bi.middleName, bi.lastName, bi.suffix) ||
			asName(content.firstName, content.middleName, content.lastName, content.suffix) ||
			asName(bi.fullName, bi.individualName, content.fullName, content.individualName, content.name) ||
			// Orphan bundles (see buildOrphanBundle in key.ts) have no basicInformation —
			// their only name is the scraped owner reference at orphan.name.
			asName(orphan?.name);
		// Upstream FINRA/SEC records mix ALL CAPS, lowercase, and Title Case
		// across name fields, so normalize before displaying.
		return rawName ? toProperCaseName(rawName) : rawName;
	}
	return asName(bi.firmName, bi.orgName, bi.organizationName, bi.legalName) || asName(content.firmName, content.orgName, content.organizationName, content.legalName, content.name);
}

/** Parse first JSON value from a file that may have trailing garbage (e.g. concurrent writes). */
function parseJsonDocumentLenient(raw: string): unknown {
	const text = String(raw || '')
		.replace(/^\uFEFF/, '')
		.trim();
	if (!text) throw new SyntaxError('Empty JSON document');
	try {
		return JSON.parse(text);
	} catch (firstError) {
		// Concatenated / partially-appended documents: take the first complete value.
		let depth = 0;
		let inString = false;
		let escaped = false;
		let start = -1;
		for (let i = 0; i < text.length; i++) {
			const ch = text[i];
			if (inString) {
				if (escaped) {
					escaped = false;
					continue;
				}
				if (ch === '\\') {
					escaped = true;
					continue;
				}
				if (ch === '"') inString = false;
				continue;
			}
			if (ch === '"') {
				inString = true;
				continue;
			}
			if (ch === '{' || ch === '[') {
				if (depth === 0) start = i;
				depth += 1;
				continue;
			}
			if (ch === '}' || ch === ']') {
				depth -= 1;
				if (depth === 0 && start >= 0) {
					const slice = text.slice(start, i + 1);
					try {
						return JSON.parse(slice);
					} catch {
						// keep scanning for another complete value
						start = -1;
					}
				}
			}
		}
		throw firstError;
	}
}
async function readSavedKeyIndexFile() {
	try {
		const raw = await getCacheValue('finra-sec:cache:rawKeysIndex');
		if (!raw) return null;

		const parsed = parseJsonDocumentLenient(raw);
		const entriesSource =
			Array.isArray(parsed) ? parsed
			: parsed && typeof parsed === 'object' && Array.isArray((parsed as { entries?: unknown }).entries) ? (parsed as { entries: unknown[] }).entries
			: null;
		if (!entriesSource) return null;
		const entries = entriesSource.filter((entry: unknown): entry is SavedKeyStat => {
			if (!entry || typeof entry !== 'object') return false;
			const candidate = entry as SavedKeyStat;
			return (
				typeof candidate.key === 'string' &&
				typeof candidate.mtime === 'number' &&
				typeof candidate.crd === 'string' &&
				(candidate.type === 'individual' || candidate.type === 'firm') &&
				(candidate.source === 'finra' || candidate.source === 'sec')
			);
		});
		const generatedAt =
			parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof (parsed as { generatedAt?: unknown }).generatedAt === 'string' ?
				(parsed as { generatedAt: string }).generatedAt
			:	null;
		return { entries: sortSavedKeyStats(entries, 'date-desc'), generatedAt };
	} catch (error) {
		console.warn('Failed to read saved-key index from Redis cache', formatErrorMessage(error));
		return null;
	}
}

async function writeSavedKeyIndexFile(entries: SavedKeyStat[]) {
	const payload = JSON.stringify(
		{
			generatedAt: new Date().toISOString(),
			entries: sortSavedKeyStats(entries, 'date-desc'),
		},
		null,
		0,
	);
	try {
		// Cache the full index in Redis for 12 hours so Vercel cold starts don't rescan
		await setCacheValue('finra-sec:cache:rawKeysIndex', payload, 43200);
	} catch (error) {
		console.warn('Failed to write saved-key index to Redis', formatErrorMessage(error));
	}
}

async function buildSavedKeyIndexFromRedis() {
	const rawKeys = await listRawKeysFromRedis();
	if (rawKeys.length === 0) return [];
	const out: SavedKeyStat[] = [];
	for (let i = 0; i < rawKeys.length; i += rawKeysIndexBatchSize) {
		const batch = rawKeys.slice(i, i + rawKeysIndexBatchSize);
		const batchEntries = await Promise.all(
			batch.map(async (rawKey) => {
				try {
					const raw = await readRawValueFromRedis(rawKey);
					if (!raw) return null;
					const payload = JSON.parse(raw);
					return buildSavedKeyStat(rawKeyToFilename(rawKey), 0, payload);
				} catch {
					return null;
				}
			}),
		);
		for (const item of batchEntries) {
			if (item) out.push(item);
		}
	}
	const sorted = sortSavedKeyStats(out, 'date-desc');
	rawKeysIndexCache = sorted;
	rawKeysIndexCacheExpiresAt = Date.now() + rawKeysIndexCacheTtlMs;
	await writeSavedKeyIndexFile(sorted);
	return sorted;
}

export async function refreshSavedKeyIndexFromRedis() {
	if (rawKeysIndexRefreshPromise) return rawKeysIndexRefreshPromise;
	rawKeysIndexRefreshPromise = (async () => {
		const rebuilt = await buildSavedKeyIndexFromRedis();
		rawKeysIndexCache = rebuilt;
		rawKeysIndexCacheExpiresAt = Date.now() + rawKeysIndexCacheTtlMs;
		return rebuilt;
	})().finally(() => {
		rawKeysIndexRefreshPromise = null;
	});
	return rawKeysIndexRefreshPromise;
}

async function getSavedKeyIndex() {
	const now = Date.now();
	if (rawKeysIndexCache && now < rawKeysIndexCacheExpiresAt) return rawKeysIndexCache;
	if (!rawKeysIndexLoadPromise) {
		rawKeysIndexLoadPromise = (async () => {
			const redisConfigured = Boolean(upstashRedisClient || redisClient);
			const diskCache = await readSavedKeyIndexFile();
			if (diskCache && Array.isArray(diskCache.entries)) {
				const diskAgeMs = diskCache.generatedAt ? Math.max(0, now - Date.parse(diskCache.generatedAt)) : Number.POSITIVE_INFINITY;
				const diskFresh = Number.isFinite(diskAgeMs) && diskAgeMs <= rawKeysIndexCacheTtlMs;
				if (diskFresh || !redisConfigured) {
					rawKeysIndexCache = diskCache.entries;
					rawKeysIndexCacheExpiresAt = now + rawKeysIndexCacheTtlMs;
					return diskCache.entries;
				}
				rawKeysIndexCache = diskCache.entries;
				rawKeysIndexCacheExpiresAt = now + rawKeysIndexCacheTtlMs;
				void refreshSavedKeyIndexFromRedis().catch((error) => {
					console.warn('Failed to refresh saved-key index from Redis', formatErrorMessage(error));
				});
				return diskCache.entries;
			}
			if (redisConfigured) {
				const rebuiltFromRedis = await refreshSavedKeyIndexFromRedis();
				return rebuiltFromRedis;
			}
			if (diskCache && Array.isArray(diskCache.entries)) {
				rawKeysIndexCache = diskCache.entries;
				rawKeysIndexCacheExpiresAt = Date.now() + rawKeysIndexCacheTtlMs;
				return diskCache.entries;
			}
			rawKeysIndexCache = [];
			rawKeysIndexCacheExpiresAt = Date.now() + rawKeysIndexCacheTtlMs;
			return [];
		})().finally(() => {
			rawKeysIndexLoadPromise = null;
		});
	}
	return rawKeysIndexLoadPromise;
}

async function persistSavedKeyIndex(entries: SavedKeyStat[]) {
	const sorted = sortSavedKeyStats(entries, 'date-desc');
	rawKeysIndexCache = sorted;
	rawKeysIndexCacheExpiresAt = Date.now() + rawKeysIndexCacheTtlMs;
	await writeSavedKeyIndexFile(sorted);
	return sorted;
}

async function upsertSavedKeyIndexEntry(filename: string, payload: unknown, filePath?: string, mtimeOverride?: number) {
	const normalizedFilename = rawKeyToFilename(filename);
	const rawKey = filenameToRawKey(normalizedFilename);
	const parsedKey = parseSavedRawKey(rawKey);
	if (!parsedKey) return null;
	const mtime = typeof mtimeOverride === 'number' && Number.isFinite(mtimeOverride) ? mtimeOverride : Date.now();
	const nextEntry = buildSavedKeyStat(normalizedFilename, mtime, payload);
	if (!nextEntry) return null;
	const current = await getSavedKeyIndex();
	const remaining = current.filter((entry) => entry.key !== nextEntry.key);
	const updatedIndex = [nextEntry, ...remaining];
	await persistSavedKeyIndex(updatedIndex);

	return {
		uniqueIndividualCrds: new Set(updatedIndex.filter((e) => e.type === 'individual').map((e) => e.crd)).size,
		uniqueFirmCrds: new Set(updatedIndex.filter((e) => e.type === 'firm').map((e) => e.crd)).size,
		uniqueTotalCrds: new Set(updatedIndex.map((e) => `${e.type}:${e.crd}`)).size,
	};
}

async function removeSavedKeyIndexEntry(key: string) {
	const rawKey = filenameToRawKey(rawKeyToFilename(key));
	const current = await getSavedKeyIndex();
	if (!current.some((entry) => entry.key === rawKey)) return null;
	const updatedIndex = current.filter((entry) => entry.key !== rawKey);
	await persistSavedKeyIndex(updatedIndex);

	return {
		uniqueIndividualCrds: new Set(updatedIndex.filter((e) => e.type === 'individual').map((e) => e.crd)).size,
		uniqueFirmCrds: new Set(updatedIndex.filter((e) => e.type === 'firm').map((e) => e.crd)).size,
		uniqueTotalCrds: new Set(updatedIndex.map((e) => `${e.type}:${e.crd}`)).size,
	};
}

function getContentBlock(_filename: string, payload: unknown): Record<string, unknown> | null {
	if (!payload || typeof payload !== 'object') return null;
	// Delegate to normalizeRawPayload, which already fully unwraps every known
	// storage shape (finraBrokerCheck/secInvestmentAdvisor wrappers, legacy
	// content/iacontent/bccontent keys, and nested ES `hits.hits[0]._source.content`
	// payloads). The previous hand-rolled unwrapping here missed the ES-hits shape,
	// which left displayName/industryDate/isActive null for records still stored
	// in that legacy format.
	const normalized = normalizeRawPayload(payload);
	return normalized && typeof normalized === 'object' && !Array.isArray(normalized) ? (normalized as Record<string, unknown>) : null;
}

function parseDate(s: string): number {
	const d = new Date(s);
	return isNaN(d.getTime()) ? Infinity : d.getTime();
}

function extractIndustryDateFromContent(filename: string, payload: unknown): string | null {
	const isFinra = /^finra:individual:/i.test(filename);
	const content = getContentBlock(filename, payload);
	if (!content) return null;

	// Primary: daysInIndustryCalculated* in basicInformation
	const bi = content.basicInformation;
	if (bi && typeof bi === 'object') {
		const field = isFinra ? 'daysInIndustryCalculatedDate' : 'daysInIndustryCalculatedDateIAPD';
		const val = (bi as Record<string, unknown>)[field];
		if (typeof val === 'string' && val.trim()) return val.trim();
	}

	// Fallback: earliest examTakenDate across all exam category arrays
	const examArrays = ['stateExamCategory', 'principalExamCategory', 'productExamCategory'];
	let earliest: string | null = null;
	let earliestMs = Infinity;
	for (const key of examArrays) {
		const arr = content[key];
		if (!Array.isArray(arr)) continue;
		for (const item of arr) {
			const d = item?.examTakenDate;
			if (typeof d === 'string' && d.trim()) {
				const ms = parseDate(d.trim());
				if (ms < earliestMs) {
					earliestMs = ms;
					earliest = d.trim();
				}
			}
		}
	}
	return earliest;
}

function extractIsActiveFromContent(filename: string, payload: unknown): boolean {
	const content = getContentBlock(filename, payload);
	if (!content) return false;
	const hasCurrentEmp =
		(Array.isArray(content.currentEmployments) && content.currentEmployments.length > 0) ||
		(Array.isArray(content.currentIAEmployments) && content.currentIAEmployments.length > 0);
	if (hasCurrentEmp) return true;
	const sros = content.registeredSROs;
	if (Array.isArray(sros) && sros.some((s: any) => s?.status === 'APPROVED')) return true;
	const states = content.registeredStates;
	if (Array.isArray(states) && states.some((s: any) => s?.status === 'APPROVED')) return true;
	return false;
}

export async function listSavedKeysWithStats(options: ListSavedKeysOptions = {}) {
	const index = await getSavedKeyIndex();
	const filterText = String(options.filter || '')
		.trim()
		.toLowerCase();
	const includeCrds = new Set((options.includeCrds || []).map((value) => String(value || '').trim()).filter((value) => /^[0-9]+$/.test(value)));
	const typeFilter = options.type === 'individual' || options.type === 'firm' ? options.type : 'all';
	const sort = options.sort || 'date-desc';
	const limit =
		options.limit == null ? 1000
		: Number(options.limit) <= 0 ? Number.POSITIVE_INFINITY
		: Math.max(1, Math.min(Number(options.limit), 5000));
	const matchesType = (entry: SavedKeyStat) => typeFilter === 'all' || entry.type === typeFilter;
	const matchesFilter = (entry: SavedKeyStat) => {
		if (!filterText) return true;
		const nameMatch = entry.displayName ? entry.displayName.toLowerCase().includes(filterText) : false;
		return entry.key.toLowerCase().includes(filterText) || entry.crd.includes(filterText) || nameMatch;
	};
	const included = index.filter((entry) => includeCrds.has(entry.crd) && matchesType(entry));
	const filtered = sortSavedKeyStats(
		index.filter((entry) => matchesType(entry) && matchesFilter(entry)),
		sort,
	);
	const merged = sortSavedKeyStats(Array.from(new Map([...included, ...filtered.slice(0, limit)].map((entry) => [entry.key, entry])).values()), sort);
	const uniqueIndividualCrds = new Set(index.filter((e) => e.type === 'individual').map((e) => e.crd)).size;
	const uniqueFirmCrds = new Set(index.filter((e) => e.type === 'firm').map((e) => e.crd)).size;
	const uniqueTotalCrds = new Set(index.map((e) => `${e.type}:${e.crd}`)).size;

	return {
		keys: merged,
		totalCount: index.length,
		matchedCount: filtered.length,
		limit,
		truncated: filtered.length > limit,
		uniqueIndividualCrds,
		uniqueFirmCrds,
		uniqueTotalCrds,
	};
}

export async function loadSavedPayload(key: string) {
	const rawKey = filenameToRawKey(rawKeyToFilename(key));
	const redisRaw = await readRawValueFromRedis(rawKey);
	if (redisRaw) return JSON.parse(redisRaw);
	throw new Error(`Saved payload not found in Redis for key: ${rawKey}`);
}

export async function loadSavedPayloadRaw(key: string) {
	const rawKey = filenameToRawKey(rawKeyToFilename(key));
	const redisRaw = await readRawValueFromRedis(rawKey);
	if (redisRaw != null) return String(redisRaw);
	throw new Error(`Saved payload not found in Redis for key: ${rawKey}`);
}

export interface CombinedSavedPayloadSourceRecord {
	key: string;
	found: boolean;
	rawPayload: string | null;
	payload: unknown | null;
	error?: string | null;
	origin?: string | null;
}

export interface CombinedSavedPayloadBundle {
	requestedKey: string;
	resolvedKey: string;
	crd: string;
	type: SavedKeyType;
	sources: {
		finra: CombinedSavedPayloadSourceRecord;
		sec: CombinedSavedPayloadSourceRecord;
	};
}

export async function loadCombinedSavedPayloadBundle(key: string): Promise<CombinedSavedPayloadBundle> {
	const requestedKey = String(key || '').trim();
	const match = requestedKey.match(/^(finra|sec):(individual|firm):(\d+)(?:\.json)?$/i);
	if (!match) {
		throw new Error(`Invalid saved payload key: ${requestedKey}`);
	}
	const requestedSource = match[1].toLowerCase() as SavedKeySource;
	const type = match[2].toLowerCase() as SavedKeyType;
	const crd = match[3];
	const { keys } = await listSavedKeysWithStats({ includeCrds: [crd], type, limit: 100, sort: 'crd-desc' });
	const sourceKeyMap = new Map<SavedKeySource, string>();
	for (const entry of keys) {
		if (entry.crd === crd && entry.type === type) {
			sourceKeyMap.set(entry.source, entry.key);
		}
	}
	const resolvedKey = sourceKeyMap.get(requestedSource) || sourceKeyMap.get('finra') || sourceKeyMap.get('sec') || requestedKey;

	async function readSourceRecord(source: SavedKeySource): Promise<CombinedSavedPayloadSourceRecord> {
		const sourceKey = sourceKeyMap.get(source) || `${source}:${type}:${crd}`;
		try {
			const rawPayload = await loadSavedPayloadRaw(sourceKey);
			const parsedPayload = JSON.parse(rawPayload);
			// Self-heal: some records were saved before the non-actionable/stub
			// detection existed (e.g. a "sec" record for someone with no real IA
			// registration, mirroring their FINRA-only broker profile). Treat these
			// as broken data and remove them from Redis so they stop being surfaced
			// as an available source.
			if (isNonActionableSavedDetail(sourceKey, parsedPayload)) {
				await removeSavedPayload(sourceKey).catch(() => {});
				return {
					key: sourceKey,
					found: false,
					rawPayload: null,
					payload: null,
					error: 'removed: stub record (no genuine registration for this source)',
				};
			}
			return {
				key: sourceKey,
				found: true,
				rawPayload,
				payload: normalizeRawPayload(parsedPayload),
				error: null,
			};
		} catch (error) {
			return {
				key: sourceKey,
				found: false,
				rawPayload: null,
				payload: null,
				error: formatErrorMessage(error),
			};
		}
	}
	const bundle = {
		requestedKey,
		resolvedKey,
		crd,
		type,
		sources: {
			finra: await readSourceRecord('finra'),
			sec: await readSourceRecord('sec'),
		},
	};
	if (!bundle.sources.finra.found && !bundle.sources.sec.found) {
		// The local `data/raw` disk fallback has been removed — Redis is the
		// single source of truth for saved payloads now.
		throw new Error(`Saved payload not found in Redis for key: ${requestedKey}`);
	}
	return bundle;
}

export async function removeSavedPayload(key: string) {
	const filename = rawKeyToFilename(key);
	const rawKey = filenameToRawKey(filename);
	let removed = false;
	if (upstashRedisClient || redisClient) {
		try {
			await deleteCacheKey(rawKey);
			removed = true;
		} catch {
			// ignore delete failures and rely on index check below
		}
	}
	if (removed) {
		return await removeSavedKeyIndexEntry(filename);
	}
	return null;
}

export async function inspectSavedPayload(key: string) {
	const rawKey = filenameToRawKey(rawKeyToFilename(key));
	if (upstashRedisClient || redisClient) {
		try {
			const raw = await readRawValueFromRedis(rawKey);
			if (raw) {
				const payload = JSON.parse(raw);
				const invalid = isEmptyPayload(payload) || hasBlockingIndicators(payload);
				return { exists: true, payload, invalid };
			}
			return { exists: false, payload: null, invalid: false };
		} catch {
			return { exists: true, payload: null, invalid: true };
		}
	}
	return { exists: false, payload: null, invalid: false };
}

export function detailFilenameForSource(source: string, type: string, crd: string) {
	if (source === 'finra') return `${source}:${type}:${crd}`;
	if (source === 'sec') return `${source}:${type}:${crd}`;
	return `unknown:${type}:${crd}`;
}

export function isEmptyPayload(payload: any) {
	if (payload == null) return true;
	if (Array.isArray(payload)) return payload.length === 0;
	if (typeof payload === 'object') {
		try {
			if (payload.hits) {
				const total = payload.hits.total;
				const totalValue =
					typeof total === 'number' ? total
					: total && total.value != null ? Number(total.value)
					: null;
				if (totalValue === 0) return true;
				if (Array.isArray(payload.hits.hits) && payload.hits.hits.length === 0) return true;
			}
		} catch (e) {}
		return Object.keys(payload).length === 0;
	}
	return false;
}

export function isCrdKey(key: string) {
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

export function discoverCrdsFromPayload(payload: any) {
	const seen = new Set<string>();
	function addCrd(value: any, key: string) {
		if (value == null) return;
		const text = String(value);
		const candidates = text.match(/\b\d{4,7}\b/g) || [];
		for (const candidate of candidates) {
			const normalized = candidate.replace(/^0+/, '') || '0';
			if (normalized.length >= 4 && normalized.length <= 7 && isCrdKey(key)) seen.add(normalized);
		}
	}
	function traverse(node: any, key = '') {
		if (node && typeof node === 'object') {
			if (Array.isArray(node)) for (const item of node) traverse(item, key);
			else {
				for (const [childKey, childValue] of Object.entries(node)) {
					if (typeof childValue === 'string' && childKey.toLowerCase() === 'content') {
						try {
							traverse(JSON.parse(childValue), childKey);
							continue;
						} catch {}
					}
					if (typeof childValue === 'object') traverse(childValue, childKey);
					else addCrd(childValue, childKey);
				}
			}
		}
	}
	traverse(payload, '');
	return Array.from(seen);
}

export function discoverFirmIdsFromPayload(payload: any) {
	const seen = new Set<string>();
	function checkNode(node: any) {
		if (!node || typeof node !== 'object') return;
		if (Array.isArray(node)) {
			for (const item of node) checkNode(item);
			return;
		}
		const keys = Object.keys(node).map((k) => k.toLowerCase());
		const hasFirmId = keys.includes('firm_id') || keys.includes('firmid');
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
		for (const val of Object.values(node)) if (val && typeof val === 'object') checkNode(val);
	}
	checkNode(payload);
	return Array.from(seen);
}

export function isIaOnlyFromPayload(payload: any) {
	let found = false;
	function checkNode(node: any) {
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

export async function syncSavedPayload(key: string, payload: any) {
	const normalizedPayload = normalizeRawPayload(payload);
	const existing = await inspectSavedPayload(key);
	if (isNonActionableSavedDetail(key, normalizedPayload)) {
		let stats = null;
		if (existing.exists) stats = await removeSavedKeyIndexEntry(key);
		return { filename: key, status: 'unchanged', changed: false, existed: false, stats };
	}
	const nextSerialized = JSON.stringify(normalizedPayload, null, 2);
	if (!existing.exists) {
		const { stats } = await saveRawFile(key, normalizedPayload);
		return { filename: key, status: 'downloaded', changed: true, existed: false, stats };
	}
	if (existing.invalid) {
		const { stats } = await saveRawFile(key, normalizedPayload);
		return { filename: key, status: 'repaired', changed: true, existed: true, stats };
	}
	const currentSerialized = JSON.stringify(normalizeRawPayload(existing.payload), null, 2);
	if (currentSerialized === nextSerialized) {
		return { filename: key, status: 'unchanged', changed: false, existed: true };
	}
	const { stats } = await saveRawFile(key, normalizedPayload);
	return { filename: key, status: 'updated', changed: true, existed: true, stats };
}

export async function cleanupEmptySearchFiles() {
	// No-op: the local `data/raw` disk cache has been removed, so there are
	// no on-disk search-result files left to clean up. Redis-saved payloads
	// are never empty/generic search envelopes (see saveRawFile's stub checks).
	return [] as string[];
}

export const seenKeysFile = path.resolve(process.cwd(), 'data', 'seen-keys.json');

export async function readSeenKeys() {
	async function sanitizeSeenKeys(rawValue: any) {
		const input = rawValue && typeof rawValue === 'object' ? rawValue : {};
		const sanitized: Record<string, any> = {};
		for (const [key, value] of Object.entries(input)) {
			const filename = rawKeyToFilename(String(key || ''));
			const isDetailKey = /^(finra|sec):(individual|firm):\d+\.json$/i.test(filename);
			if (isDetailKey) {
				const saved = await inspectSavedPayload(filename);
				if (!saved.exists) continue;
				if (isNonActionableSavedDetail(filename, saved.payload)) continue;
			}
			sanitized[filename] = value;
		}
		return sanitized;
	}

	if (redisClient || upstashRedisClient || upstashRedisClient2) {
		try {
			const v = await getCacheValue('finra-sec:seenKeys');
			if (v) return await sanitizeSeenKeys(JSON.parse(v));
			return {};
		} catch (e) {
			console.warn('readSeenKeys redis failed', formatErrorMessage(e));
		}
	}
	return {};
}

export async function writeSeenKeys(obj: any) {
	const payload = JSON.stringify(await readSeenKeysMerged(obj || {}));
	if (redisClient || upstashRedisClient || upstashRedisClient2) {
		try {
			await setCacheValue('finra-sec:seenKeys', payload);
			return;
		} catch (e) {
			console.warn('writeSeenKeys redis failed', formatErrorMessage(e));
		}
	}
}

async function readSeenKeysMerged(obj: any) {
	const input = obj && typeof obj === 'object' ? obj : {};
	const sanitized: Record<string, any> = {};
	for (const [key, value] of Object.entries(input)) {
		const filename = rawKeyToFilename(String(key || ''));
		const isDetailKey = /^(finra|sec):(individual|firm):\d+\.json$/i.test(filename);
		if (isDetailKey) {
			const saved = await inspectSavedPayload(filename);
			if (!saved.exists) continue;
			if (isNonActionableSavedDetail(filename, saved.payload)) continue;
		}
		sanitized[filename] = value;
	}
	return sanitized;
}
