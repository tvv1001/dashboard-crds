// Read-only firm → employee connections from Redis cache only (plus live
// BrokerCheck/IAPD lookups when an individual payload is missing, so previous
// people still get names / address / current employer).
//
// Primary keys (shared Redis writer):
//   finra|sec:firm:{firmId}_brokers:connected   → current people CRDs
//   finra|sec:firm:{firmId}_brokers:previous    → previous people CRDs
// Optional legacy named caches (used only if broker lists are missing):
//   graph:firm-connections:v10|v9:{firmId}
//   graph:firm-emp-adj:v1:{firmId}
//
// Never writes Redis firm/broker structure. Never falls back to files or scans.

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { buildEndpoint, getCacheValue, loadSavedPayload } from './_lib';
import { toProperCaseName } from '../../src/lib/format';
import { resolveIndividualNamesFromLocalIndex } from '../../src/lib/localSearch';

export type FirmConnectionEntry = {
	individualId: string;
	name: string;
	relationship: string;
	isCurrent: boolean;
	startDate?: string;
	endDate?: string;
	bcScope?: string;
	iaScope?: string;
	address?: string;
	yearsWorked?: string | number;
	/** Present employer for previous registrants (card still opens this person). */
	currentEmployer?: string;
};

export type FirmConnectionsPayload = {
	currentConnections: FirmConnectionEntry[];
	previousConnections: FirmConnectionEntry[];
	source: 'redis' | 'empty';
};

const REDIS_CACHE_KEYS = (firmId: string) => [
	`graph:firm-connections:v10:${firmId}`,
	`graph:firm-connections:v9:${firmId}`,
	`graph:firm-emp-adj:v1:${firmId}`,
];

const LIVE_FETCH_CONCURRENCY = 4;
const LIVE_FETCH_TIMEOUT_MS = 8_000;
const LIVE_FETCH_GAP_MS = 120;
const PERSON_META_CACHE_FILE = path.join(os.tmpdir(), 'dashboard-crds-person-meta-v1.json');
const personMetaCache = new Map<string, PersonMeta>();
let personMetaCacheLoaded: Promise<void> | null = null;
let personMetaCacheDirty = false;
let personMetaCacheWriteTimer: ReturnType<typeof setTimeout> | null = null;
let liveFetchRateLimitedUntil = 0;
let liveFetchChain: Promise<void> = Promise.resolve();

function toArray(value: unknown): any[] {
	return Array.isArray(value) ? value : [];
}

function firstNonEmpty(...values: unknown[]): string {
	for (const value of values) {
		const text = String(value ?? '').trim();
		if (text) return text;
	}
	return '';
}

function parseMaybeJson(raw: unknown): unknown {
	if (raw == null) return null;
	if (typeof raw !== 'string') return raw;
	const text = raw.trim();
	if (!text) return null;
	if (!(text.startsWith('{') || text.startsWith('['))) return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function mapConnectionEntry(entry: any, isCurrentDefault: boolean): FirmConnectionEntry | null {
	if (!entry || typeof entry !== 'object') return null;
	const individualId = firstNonEmpty(entry.individualId, entry.personCrd, entry.crd, entry.crdNumber);
	if (!individualId || !/^\d{1,10}$/.test(individualId)) return null;
	const isCurrent = entry.isCurrent != null ? Boolean(entry.isCurrent) : isCurrentDefault;
	const name = toProperCaseName(firstNonEmpty(entry.name, entry.personName, entry.individualName, entry.label, entry.fullName)) || individualId;
	const startDate = firstNonEmpty(entry.startDate, entry.registrationBeginDate, entry.fromDate, entry.effectiveDate) || undefined;
	const endDate = firstNonEmpty(entry.endDate, entry.registrationEndDate, entry.toDate) || undefined;
	return {
		individualId,
		name,
		relationship: firstNonEmpty(entry.relationship) || (isCurrent ? 'Current registration' : 'Previous registration'),
		isCurrent,
		startDate,
		endDate,
		bcScope: firstNonEmpty(entry.bcScope) || undefined,
		iaScope: firstNonEmpty(entry.iaScope) || undefined,
		address: firstNonEmpty(entry.address) || undefined,
		yearsWorked: entry.yearsWorked ?? entry.yearsExperience ?? undefined,
		currentEmployer: firstNonEmpty(entry.currentEmployer, entry.currentFirmName, entry.firmName) || undefined,
	};
}

export function parseFirmConnectionsPayload(raw: unknown): FirmConnectionsPayload | null {
	const data = parseMaybeJson(raw) ?? raw;
	if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
	const record = data as Record<string, unknown>;
	const hasCurrent = 'currentConnections' in record || 'current' in record;
	const hasPrevious = 'previousConnections' in record || 'previous' in record;
	if (!hasCurrent && !hasPrevious) return null;

	const current = toArray(record.currentConnections ?? record.current)
		.map((entry) => mapConnectionEntry(entry, true))
		.filter((entry): entry is FirmConnectionEntry => Boolean(entry));
	const previous = toArray(record.previousConnections ?? record.previous)
		.map((entry) => mapConnectionEntry(entry, false))
		.filter((entry): entry is FirmConnectionEntry => Boolean(entry));

	return { currentConnections: current, previousConnections: previous, source: 'redis' };
}

function collectBrokerIds(raw: unknown, into: Set<string>) {
	const parsed = parseMaybeJson(raw);
	for (const id of toArray(parsed)) {
		const text = String(id ?? '').trim();
		if (/^\d{1,10}$/.test(text)) into.add(text);
	}
}

type PersonMeta = {
	name?: string;
	address?: string;
	yearsWorked?: string | number;
	currentEmployer?: string;
};

async function ensurePersonMetaCacheLoaded() {
	if (!personMetaCacheLoaded) {
		personMetaCacheLoaded = (async () => {
			try {
				const raw = await fs.readFile(PERSON_META_CACHE_FILE, 'utf-8');
				const parsed = JSON.parse(raw);
				if (!parsed || typeof parsed !== 'object') return;
				for (const [crd, meta] of Object.entries(parsed as Record<string, PersonMeta>)) {
					if (!/^\d{1,10}$/.test(crd) || !meta || typeof meta !== 'object') continue;
					personMetaCache.set(crd, meta);
				}
			} catch {
				// missing/invalid cache is fine
			}
		})();
	}
	await personMetaCacheLoaded;
}

function schedulePersonMetaCacheWrite() {
	if (personMetaCacheWriteTimer) return;
	personMetaCacheWriteTimer = setTimeout(() => {
		personMetaCacheWriteTimer = null;
		if (!personMetaCacheDirty) return;
		personMetaCacheDirty = false;
		const payload = JSON.stringify(Object.fromEntries(personMetaCache.entries()));
		fs.writeFile(PERSON_META_CACHE_FILE, payload, 'utf-8').catch(() => {
			personMetaCacheDirty = true;
		});
	}, 750);
}

function cachePersonMeta(crd: string, meta: PersonMeta) {
	if (!meta.name && !meta.address && meta.yearsWorked == null && !meta.currentEmployer) return;
	const prev = personMetaCache.get(crd) || {};
	const merged = mergePersonMeta(prev, meta);
	const changed =
		merged.name !== prev.name ||
		merged.address !== prev.address ||
		merged.yearsWorked !== prev.yearsWorked ||
		merged.currentEmployer !== prev.currentEmployer;
	personMetaCache.set(crd, merged);
	if (changed) {
		personMetaCacheDirty = true;
		schedulePersonMetaCacheWrite();
	}
}

function queueLiveFetch<T>(work: () => Promise<T>): Promise<T> {
	const run = liveFetchChain.then(async () => {
		if (Date.now() < liveFetchRateLimitedUntil) return work();
		await new Promise((r) => setTimeout(r, LIVE_FETCH_GAP_MS));
		return work();
	});
	liveFetchChain = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

function unwrapIndividualContent(payload: any): Record<string, unknown> | null {
	if (!payload || typeof payload !== 'object') return null;
	let next: any = payload;
	if (next.finraBrokerCheck && typeof next.finraBrokerCheck === 'object') next = next.finraBrokerCheck;
	else if (next.secInvestmentAdvisor && typeof next.secInvestmentAdvisor === 'object') next = next.secInvestmentAdvisor;
	if (next.hits?.hits?.[0]?._source) next = next.hits.hits[0]._source;
	for (const key of ['content', 'iacontent', 'bccontent'] as const) {
		if (typeof next[key] === 'string') {
			const inner = parseMaybeJson(next[key]);
			if (inner && typeof inner === 'object') next = inner;
		} else if (next[key] && typeof next[key] === 'object') {
			next = next[key];
		}
	}
	return next && typeof next === 'object' && !Array.isArray(next) ? (next as Record<string, unknown>) : null;
}

function yearsFromIndustryStart(dateStr: unknown): number | undefined {
	const text = String(dateStr ?? '').trim();
	if (!text) return undefined;
	const started = new Date(text);
	if (Number.isNaN(started.getTime())) return undefined;
	const years = (Date.now() - started.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
	if (!Number.isFinite(years) || years < 0) return undefined;
	return Math.floor(years);
}

function extractPersonMeta(rawPayload: unknown): PersonMeta {
	const root = typeof rawPayload === 'string' ? parseMaybeJson(rawPayload) : rawPayload;
	const content = unwrapIndividualContent(root);
	if (!content) return {};

	const basic = content.basicInformation && typeof content.basicInformation === 'object' ? (content.basicInformation as Record<string, unknown>) : {};
	const name = [basic.firstName, basic.middleName, basic.lastName, basic.suffix].filter(Boolean).join(' ').trim();
	const yearsWorked =
		(basic.yearsExperience as string | number | undefined) ??
		(basic.yearsInIndustry as string | number | undefined) ??
		yearsFromIndustryStart(basic.daysInIndustryCalculatedDate) ??
		yearsFromIndustryStart(basic.daysInIndustryCalculatedDateIAPD);

	const currentEmployments = [
		...toArray(content.currentEmployments),
		...toArray(content.currentIAEmployments),
		...toArray(content.ind_current_employments),
		...toArray(content.ind_ia_current_employments),
	];
	const previousEmployments = [
		...toArray(content.previousEmployments),
		...toArray(content.previousIAEmployments),
		...toArray(content.ind_previous_employments),
		...toArray(content.ind_ia_previous_employments),
	];

	const currentEmp = currentEmployments.find((e: any) => firstNonEmpty(e?.firmName, e?.firm_name, e?.name)) || currentEmployments[0];
	const addressEmp =
		currentEmployments.find((e: any) => e?.city && e?.state) ||
		previousEmployments.find((e: any) => e?.city && e?.state) ||
		currentEmp;
	const city = firstNonEmpty(addressEmp?.city);
	const state = firstNonEmpty(addressEmp?.state);
	const address = city && state ? `${toProperCaseName(city)}, ${state.toUpperCase()}` : '';
	const currentEmployer = toProperCaseName(firstNonEmpty(currentEmp?.firmName, currentEmp?.firm_name, currentEmp?.name)) || undefined;

	return {
		name: name ? toProperCaseName(name) : undefined,
		address: address || undefined,
		yearsWorked,
		currentEmployer,
	};
}

function mergePersonMeta(base: PersonMeta, extra: PersonMeta): PersonMeta {
	return {
		name: extra.name || base.name,
		address: extra.address || base.address,
		yearsWorked: extra.yearsWorked ?? base.yearsWorked,
		currentEmployer: extra.currentEmployer || base.currentEmployer,
	};
}

async function fetchIndividualLive(crd: string): Promise<PersonMeta> {
	if (Date.now() < liveFetchRateLimitedUntil) return personMetaCache.get(crd) || {};

	return queueLiveFetch(async () => {
		if (Date.now() < liveFetchRateLimitedUntil) return personMetaCache.get(crd) || {};

		let meta: PersonMeta = personMetaCache.get(crd) || {};
		for (const source of ['finra', 'sec'] as const) {
			const url = buildEndpoint({ source, type: 'individual', crd });
			if (!url) continue;
			try {
				const cacheKey = `finra-sec:cache:${encodeURIComponent(url)}`;
				const cached = await getCacheValue(cacheKey);
				if (cached) {
					meta = mergePersonMeta(meta, extractPersonMeta(cached));
					if (meta.name) {
						cachePersonMeta(crd, meta);
						return meta;
					}
				}
			} catch {
				// ignore cache errors
			}
			try {
				const resp = await fetch(url, { signal: AbortSignal.timeout(LIVE_FETCH_TIMEOUT_MS) });
				if (resp.status === 429) {
					liveFetchRateLimitedUntil = Date.now() + 90_000;
					return meta;
				}
				if (!resp.ok) continue;
				const data = await resp.json();
				meta = mergePersonMeta(meta, extractPersonMeta(data));
				if (meta.name && source === 'finra') {
					cachePersonMeta(crd, meta);
					return meta;
				}
			} catch {
				// timeout / network — try next source
			}
		}
		cachePersonMeta(crd, meta);
		return meta;
	});
}

async function mapPool<T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	async function run() {
		while (true) {
			const index = next++;
			if (index >= items.length) return;
			results[index] = await worker(items[index], index);
		}
	}
	const runners = Array.from({ length: Math.min(concurrency, Math.max(items.length, 1)) }, () => run());
	await Promise.all(runners);
	return results;
}

function applyPersonMeta(entry: FirmConnectionEntry, meta: PersonMeta): FirmConnectionEntry {
	return {
		...entry,
		name: meta.name || entry.name,
		address: meta.address || entry.address,
		yearsWorked: meta.yearsWorked ?? entry.yearsWorked,
		// Only surface "now at" on previous people — current people are already at this firm.
		currentEmployer: entry.isCurrent ? undefined : meta.currentEmployer || entry.currentEmployer,
	};
}

function hasRealPersonName(entry: FirmConnectionEntry): boolean {
	return Boolean(entry.name && !/^crd\s+\d+$/i.test(entry.name));
}

async function readSavedIndividualMeta(crd: string): Promise<PersonMeta> {
	let meta: PersonMeta = {};
	for (const source of ['finra', 'sec'] as const) {
		try {
			// loadSavedPayload uses the shared brotli-base64 decode path (raw brotli
			// and `br:`), same as /api/key — do not use getCacheValue here.
			const payload = await loadSavedPayload(`${source}:individual:${crd}`);
			meta = mergePersonMeta(meta, extractPersonMeta(payload));
			if (meta.name && (meta.address || meta.yearsWorked != null || meta.currentEmployer)) break;
		} catch {
			// missing source key
		}
	}
	return meta;
}

async function enrichFromRedisAndDisk(entry: FirmConnectionEntry): Promise<FirmConnectionEntry> {
	try {
		let meta: PersonMeta = personMetaCache.get(entry.individualId) || {};
		meta = mergePersonMeta(meta, await readSavedIndividualMeta(entry.individualId));
		if (meta.name || meta.address || meta.yearsWorked != null || meta.currentEmployer) {
			cachePersonMeta(entry.individualId, meta);
		}
		return applyPersonMeta(entry, meta);
	} catch {
		return entry;
	}
}

async function liveEnrichMissing(entries: FirmConnectionEntry[], budgetMs: number): Promise<FirmConnectionEntry[]> {
	const out = entries.slice();
	const started = Date.now();
	for (let i = 0; i < out.length; i++) {
		if (Date.now() - started > budgetMs) break;
		if (hasRealPersonName(out[i])) continue;
		if (Date.now() < liveFetchRateLimitedUntil) break;
		const meta = await fetchIndividualLive(out[i].individualId);
		out[i] = applyPersonMeta(out[i], meta);
	}
	return out;
}

function continueLiveEnrichmentInBackground(entries: FirmConnectionEntry[]) {
	const missing = entries.filter((entry) => !hasRealPersonName(entry)).map((entry) => entry.individualId);
	if (!missing.length) return;
	void (async () => {
		for (const crd of missing) {
			if (Date.now() < liveFetchRateLimitedUntil) break;
			if (personMetaCache.get(crd)?.name) continue;
			await fetchIndividualLive(crd);
		}
	})();
}

async function enrichFromSearchSidecar(entries: FirmConnectionEntry[]): Promise<FirmConnectionEntry[]> {
	const missing = entries.filter((entry) => !hasRealPersonName(entry)).map((entry) => entry.individualId);
	if (!missing.length) return entries;
	try {
		const names = await resolveIndividualNamesFromLocalIndex(missing);
		if (!names.size) return entries;
		return entries.map((entry) => {
			if (hasRealPersonName(entry)) return entry;
			const label = names.get(entry.individualId);
			if (!label) return entry;
			const meta: PersonMeta = { name: toProperCaseName(label) };
			cachePersonMeta(entry.individualId, meta);
			return applyPersonMeta(entry, meta);
		});
	} catch {
		return entries;
	}
}

async function enrichEntries(entries: FirmConnectionEntry[]): Promise<FirmConnectionEntry[]> {
	if (!entries.length) return entries;
	await ensurePersonMetaCacheLoaded();

	// 1) Fast local pass (Redis payloads + on-disk name cache).
	let out = await mapPool(entries, LIVE_FETCH_CONCURRENCY, enrichFromRedisAndDisk);

	// 2) Local search-index sidecar (public/search-indexes/*.gz) for any remaining CRD-only labels.
	out = await enrichFromSearchSidecar(out);

	// 3) Spend a bounded budget on live BrokerCheck/IAPD lookups for missing names.
	out = await liveEnrichMissing(out, 20_000);

	// 4) Keep filling the disk cache after the response so later page loads improve.
	continueLiveEnrichmentInBackground(out);

	return out;
}

export async function getFirmConnections(firmId: string): Promise<FirmConnectionsPayload> {
	const normalized = String(firmId || '').trim();
	const empty: FirmConnectionsPayload = { currentConnections: [], previousConnections: [], source: 'empty' };
	if (!normalized || !/^\d{1,10}$/.test(normalized)) return empty;

	try {
		async function readBrokerList(key: string) {
			// Local Redis can briefly refuse reads while the client reconnects.
			for (let attempt = 0; attempt < 4; attempt++) {
				const value = await getCacheValue(key);
				if (value != null) return value;
				await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
			}
			return null;
		}

		// 1) Primary: shared broker ID lists (finra/sec …_brokers:connected|previous).
		const [finraConn, secConn, finraPrev, secPrev] = await Promise.all([
			readBrokerList(`finra:firm:${normalized}_brokers:connected`),
			readBrokerList(`sec:firm:${normalized}_brokers:connected`),
			readBrokerList(`finra:firm:${normalized}_brokers:previous`),
			readBrokerList(`sec:firm:${normalized}_brokers:previous`),
		]);

		const connectedSet = new Set<string>();
		const previousSet = new Set<string>();
		collectBrokerIds(finraConn, connectedSet);
		collectBrokerIds(secConn, connectedSet);
		collectBrokerIds(finraPrev, previousSet);
		collectBrokerIds(secPrev, previousSet);

		// Prefer "current" when an ID appears in both lists.
		for (const id of connectedSet) previousSet.delete(id);

		if (connectedSet.size || previousSet.size) {
			let currentConnections: FirmConnectionEntry[] = Array.from(connectedSet).map((id) => ({
				individualId: id,
				name: `CRD ${id}`,
				relationship: 'Current registration',
				isCurrent: true,
			}));
			let previousConnections: FirmConnectionEntry[] = Array.from(previousSet).map((id) => ({
				individualId: id,
				name: `CRD ${id}`,
				relationship: 'Previous registration',
				isCurrent: false,
			}));

			// Enrich current first (usually Redis-local), then previous (often needs live FINRA).
			currentConnections = await enrichEntries(currentConnections);
			previousConnections = await enrichEntries(previousConnections);

			return { currentConnections, previousConnections, source: 'redis' };
		}

		// 2) Legacy named caches only when broker lists are absent.
		for (const key of REDIS_CACHE_KEYS(normalized)) {
			const raw = await getCacheValue(key);
			const parsed = parseFirmConnectionsPayload(raw);
			if (parsed && (parsed.currentConnections.length > 0 || parsed.previousConnections.length > 0)) {
				const [currentConnections, previousConnections] = await Promise.all([
					enrichEntries(parsed.currentConnections),
					enrichEntries(parsed.previousConnections),
				]);
				return { currentConnections, previousConnections, source: 'redis' };
			}
		}

		return empty;
	} catch {
		return empty;
	}
}
