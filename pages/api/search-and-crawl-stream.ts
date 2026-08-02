import type { NextApiRequest, NextApiResponse } from 'next';
import { buildEndpoint, fetchWithCache, hasBlockingIndicators, inspectSavedPayload, isNonActionableSavedDetail, removeSavedPayload, syncSavedPayload } from './_lib';

// Minimal serverless-friendly SSE implementation that replicates the core
// behavior of the original Express route: search FINRA/SEC for a query and
// crawl discovered CRDs, emitting events to the client.

function setSseHeaders(res: NextApiResponse) {
	res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
	res.setHeader('Cache-Control', 'no-cache');
	res.setHeader('Connection', 'keep-alive');
	// @ts-ignore
	res.flushHeaders && res.flushHeaders();
}

function sendEvent(res: NextApiResponse, event: string, data: any) {
	try {
		const payload = typeof data === 'string' ? data : JSON.stringify(data);
		res.write(`event: ${event}\n`);
		const lines = String(payload).split('\n');
		for (const line of lines) res.write(`data: ${line}\n`);
		res.write('\n');
	} catch (e) {
		// ignore
	}
}

function discoverCrdsFromPayload(payload: any) {
	const seen = new Set<string>();

	function isCrdKey(key: string) {
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

	function addCrd(value: any, key: string) {
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

	function traverse(node: any, key = '') {
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
						} catch {}
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

function isIaOnlyFromPayload(payload: any) {
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

function detailFilenameForSource(source: string, type: string, crd: string) {
	if (source === 'finra') return `${source}:${type}:${crd}`;
	if (source === 'sec') return `${source}:${type}:${crd}`;
	return `unknown:${type}:${crd}`;
}

function isEmptyPayload(payload: any) {
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

async function fetchAndSaveSourceDetail(
	source: 'finra' | 'sec',
	type: 'individual' | 'firm',
	crd: string,
	onRateLimit?: (info: { url: string; attempt: number; waitMs: number }) => void | Promise<void>,
) {
	const url = buildEndpoint({ source, type, crd });
	if (!url) throw new Error(`Unsupported source detail URL for ${source}`);
	// ensure URL contains CRD to avoid saving generic responses
	if (!String(url).includes(String(crd))) {
		return { saved: null, payload: null };
	}
	const filename = detailFilenameForSource(source, type, crd);
	const existing = await inspectSavedPayload(filename);
	const data = await fetchJson(url, onRateLimit, existing.exists);
	if (isEmptyPayload(data)) return { saved: null, payload: data };
	if (hasBlockingIndicators(data)) {
		return { saved: null, payload: data };
	}
	if (isNonActionableSavedDetail(filename, data)) {
		await removeSavedPayload(filename);
		return { saved: null, payload: data };
	}
	const sync = await syncSavedPayload(filename, data);
	return { saved: sync.changed ? filename : null, payload: data, sync };
}

async function fetchJson(url: string, onRateLimit?: (info: { url: string; attempt: number; waitMs: number }) => void | Promise<void>, forceRefresh = false) {
	return fetchWithCache(url, { onRateLimit, forceRefresh });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
	const query = String((req.query.query as string) || '').trim();
	const startCrd = String((req.query.crd as string) || '').trim();
	const maxDepth = Number(req.query.maxDepth || 1);
	const maxVisits = Number(req.query.maxVisits || 100);

	if (!query && !startCrd) {
		res.status(400).json({ error: 'Provide query or crd to search' });
		return;
	}

	setSseHeaders(res);

	const discoveredSet = new Set<string>();
	const syncSummary: Record<'downloaded' | 'updated' | 'repaired' | 'unchanged', string[]> = {
		downloaded: [],
		updated: [],
		repaired: [],
		unchanged: [],
	};

	async function searchSourceStream(source: 'finra' | 'sec', q: string) {
		if (!q) return null;
		let url: string | null = null;
		if (source === 'finra') {
			url = `https://api.brokercheck.finra.org/search/individual?query=${encodeURIComponent(q)}&hl=true&includePrevious=true&nrows=50&wt=json`;
		} else if (source === 'sec') {
			url = `https://api.adviserinfo.sec.gov/search/individual?query=${encodeURIComponent(q)}&hl=true&includePrevious=true&nrows=50&wt=json`;
		}
		if (!url) return null;
		sendEvent(res, 'log', `Searching ${source.toUpperCase()} for "${q}"`);
		try {
			const data = await fetchJson(url, async ({ url: rateLimitedUrl, attempt, waitMs }) => {
				sendEvent(res, 'log', `Rate limited (429) fetching ${rateLimitedUrl}.`);
				sendEvent(res, 'rate-limit', { url: rateLimitedUrl, attempt, waitMs, message: 'rate limited (429)' });
			});
			const crds = discoverCrdsFromPayload(data || {});
			sendEvent(res, 'matches', { source, count: crds.length, crds, query: q || null });
			sendEvent(res, 'log', `Found ${crds.length} CRDs from ${source.toUpperCase()} search`);
			for (const c of crds) discoveredSet.add(c);
			return data;
		} catch (e: any) {
			const msg = e?.message || String(e);
			sendEvent(res, 'log', `ERROR searching ${source.toUpperCase()}: ${msg}`);
			sendEvent(res, 'error', { source, message: msg });
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
		sendEvent(res, 'matches', { source: startCrd ? 'seed' : 'search', count: seeds.length, crds: seeds, query: query || null, startCrd: startCrd || null });
		sendEvent(res, 'log', `Seeding crawl with ${seeds.length} CRD(s)`);

		for (const crd of seeds) {
			sendEvent(res, 'log', `\n=== Handling seed CRD ${crd} ===`);
			// fetch FINRA detail to inspect ia_only
			let finraData = null;
			try {
				const finraUrl = `https://api.brokercheck.finra.org/search/individual/${crd}?includePrevious=true`;
				const finraFilename = detailFilenameForSource('finra', 'individual', crd);
				const finraExisting = await inspectSavedPayload(finraFilename);
				finraData = await fetchJson(
					finraUrl,
					async ({ url: rateLimitedUrl }) => {
						sendEvent(res, 'log', `Rate limited (429) fetching ${rateLimitedUrl}.`);
						sendEvent(res, 'rate-limit', { url: rateLimitedUrl, message: 'rate limited (429)' });
					},
					finraExisting.exists,
				);
			} catch (e: any) {
				sendEvent(res, 'log', `ERROR fetching FINRA detail for ${crd}: ${e?.message || e}`);
			}
			const iaOnly = isIaOnlyFromPayload(finraData || {});
			sendEvent(res, 'log', `ia_only for CRD ${crd}: ${iaOnly ? 'Y' : 'N/missing'}`);

			if (iaOnly) {
				try {
					const { saved, sync } = await fetchAndSaveSourceDetail('sec', 'individual', crd, async ({ url: rateLimitedUrl }) => {
						sendEvent(res, 'log', `Rate limited (429) fetching ${rateLimitedUrl}.`);
						sendEvent(res, 'rate-limit', { url: rateLimitedUrl, message: 'rate limited (429)' });
					});
					if (sync) {
						syncSummary[sync.status as keyof typeof syncSummary].push(sync.filename);
						sendEvent(res, 'sync-status', {
							filename: sync.filename,
							status: sync.status,
							seed: crd,
							source:
								iaOnly ? 'sec'
								: sync.filename.startsWith('finra') ? 'finra'
								: 'sec',
							type: 'individual',
						});
						if (sync.stats) sendEvent(res, 'aggregate-stats', sync.stats);
					}
					if (saved) {
						sendEvent(res, 'log', `Saved ${saved}`);
						sendEvent(res, 'saved', { filename: saved, seed: crd, source: 'sec', type: 'individual' });
					} else {
						sendEvent(res, 'log', sync?.status === 'unchanged' ? `Local file already current: ${sync.filename}` : `No save for SEC ${crd}`);
					}
				} catch (e: any) {
					sendEvent(res, 'log', `ERROR fetching/saving SEC for ${crd}: ${e?.message || e}`);
					sendEvent(res, 'error', { crd, source: 'sec', message: e?.message || String(e) });
				}
			} else {
				try {
					const { saved, sync } = await fetchAndSaveSourceDetail('finra', 'individual', crd, async ({ url: rateLimitedUrl }) => {
						sendEvent(res, 'log', `Rate limited (429) fetching ${rateLimitedUrl}.`);
						sendEvent(res, 'rate-limit', { url: rateLimitedUrl, message: 'rate limited (429)' });
					});
					if (sync) {
						syncSummary[sync.status as keyof typeof syncSummary].push(sync.filename);
						sendEvent(res, 'sync-status', { filename: sync.filename, status: sync.status, seed: crd, source: 'finra', type: 'individual' });
						if (sync.stats) sendEvent(res, 'aggregate-stats', sync.stats);
					}
					if (saved) {
						sendEvent(res, 'log', `Saved ${saved}`);
						sendEvent(res, 'saved', { filename: saved, seed: crd, source: 'finra', type: 'individual' });
					} else {
						sendEvent(res, 'log', sync?.status === 'unchanged' ? `Local file already current: ${sync.filename}` : `No save for FINRA ${crd}`);
					}
				} catch (e: any) {
					sendEvent(res, 'log', `ERROR fetching/saving FINRA for ${crd}: ${e?.message || e}`);
					sendEvent(res, 'error', { crd, source: 'finra', message: e?.message || String(e) });
				}
				try {
					const { saved: s, sync } = await fetchAndSaveSourceDetail('sec', 'individual', crd, async ({ url: rateLimitedUrl }) => {
						sendEvent(res, 'log', `Rate limited (429) fetching ${rateLimitedUrl}.`);
						sendEvent(res, 'rate-limit', { url: rateLimitedUrl, message: 'rate limited (429)' });
					});
					if (sync) {
						syncSummary[sync.status as keyof typeof syncSummary].push(sync.filename);
						sendEvent(res, 'sync-status', {
							filename: sync.filename,
							status: sync.status,
							seed: crd,
							source:
								iaOnly ? 'sec'
								: sync.filename.startsWith('finra') ? 'finra'
								: 'sec',
							type: 'individual',
						});
						if (sync.stats) sendEvent(res, 'aggregate-stats', sync.stats);
					}
					if (s) {
						sendEvent(res, 'log', `Saved ${s}`);
						sendEvent(res, 'saved', { filename: s, seed: crd, source: 'sec', type: 'individual' });
					} else {
						sendEvent(res, 'log', sync?.status === 'unchanged' ? `Local file already current: ${sync.filename}` : `No save for SEC ${crd}`);
					}
				} catch (e: any) {
					sendEvent(res, 'log', `ERROR fetching/saving SEC for ${crd}: ${e?.message || e}`);
					sendEvent(res, 'error', { crd, source: 'sec', message: e?.message || String(e) });
				}
			}
		}

		sendEvent(res, 'log', '\nSearch-and-crawl complete');
		sendEvent(res, 'done', { seeds: Array.from(discoveredSet).slice(0, maxVisits), syncSummary });
		try {
			res.end();
		} catch (_) {}
	} catch (e: any) {
		sendEvent(res, 'log', `ERROR during stream: ${e?.message || e}`);
		sendEvent(res, 'error', { message: e?.message || String(e) });
		try {
			res.end();
		} catch (_) {}
	}
}
