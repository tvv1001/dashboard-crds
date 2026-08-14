import type { NextApiRequest, NextApiResponse } from 'next';
import { buildEndpoint, fetchWithCache, hasBlockingIndicators, inspectSavedPayload, isNonActionableSavedDetail, removeSavedPayload, syncSavedPayload } from './_lib';

// This POST endpoint mirrors the non-streaming /search-and-crawl behavior used as a fallback
// by the UI when SSE isn't available. It performs search across FINRA and SEC, then
// crawls discovered CRDs and saves source JSON payload files using the same filenames.

function detailFilenameForSource(source: string, type: string, crd: string) {
	if (source === 'finra') return `${source}:${type}:${crd}`;
	if (source === 'sec') return `${source}:${type}:${crd}`;
	return `unknown:${type}:${crd}`;
}

async function fetchJson(url: string, forceRefresh = false) {
	return fetchWithCache(url, { forceRefresh });
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
		)
			return false;
		return normalized.includes('id') || normalized.includes('number') || normalized.includes('crd');
	}
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

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
	if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
	const body = req.body || {};
	const query = String(body.query || '').trim();
	const startCrd = String(body.crd || '').trim();
	const maxDepth = Number(body.maxDepth || 1);
	const maxVisits = Number(body.maxVisits || 100);
	if (!query && !startCrd) return res.status(400).json({ error: 'Provide query or crd to search' });

	const logs: string[] = [];
	const errors: any[] = [];
	const savedFiles: string[] = [];
	const savedBySeed: Record<string, string[]> = {};
	const matchSummary: Record<string, string[]> = {};
	const discoveredSet = new Set<string>();
	const syncSummary: Record<'downloaded' | 'updated' | 'repaired' | 'unchanged', string[]> = {
		downloaded: [],
		updated: [],
		repaired: [],
		unchanged: [],
	};

	async function searchSource(source: 'finra' | 'sec', q: string) {
		if (!q) return null;
		let url = null as string | null;
		if (source === 'finra') url = `https://api.brokercheck.finra.org/search/individual?query=${encodeURIComponent(q)}&hl=true&includePrevious=true&nrows=50&wt=json`;
		else url = `https://api.adviserinfo.sec.gov/search/individual?query=${encodeURIComponent(q)}&hl=true&includePrevious=true&nrows=50&wt=json`;
		logs.push(`Searching ${source.toUpperCase()} for "${q}"`);
		try {
			const data = await fetchJson(url);
			const crds = discoverCrdsFromPayload(data || {});
			matchSummary[source] = crds;
			logs.push(`Found ${crds.length} CRDs from ${source.toUpperCase()} search`);
			for (const c of crds) discoveredSet.add(c);
			return data;
		} catch (e: any) {
			const msg = e?.message || String(e);
			logs.push(`ERROR searching ${source.toUpperCase()}: ${msg}`);
			errors.push({ source, message: msg });
			return null;
		}
	}

	async function fetchAndSave(source: 'finra' | 'sec', type: 'individual' | 'firm', crd: string) {
		const url = buildEndpoint({ source, type, crd });
		if (!url) throw new Error(`Unsupported source detail URL for ${source}`);
		const filename = detailFilenameForSource(source, type, crd);
		const existing = await inspectSavedPayload(filename);
		
		let data: any = null;
		if (existing.exists) {
			logs.push(`Skipping external detail fetch; already cached locally: ${filename}`);
			const { loadSavedPayload } = await import('./_lib');
			const raw = await loadSavedPayload(filename);
			try { data = JSON.parse(raw || '{}'); } catch { data = {}; }
			syncSummary.unchanged.push(filename);
			return { filename, status: 'unchanged', payload: data };
		}
		
		data = await fetchJson(url, false);
		if (isEmptyPayload(data)) return null;
		if (hasBlockingIndicators(data)) {
			logs.push(`Detected blocking/upstream limitation message from ${source.toUpperCase()} ${crd}; skipping save`);
			return null;
		}
		if (isNonActionableSavedDetail(filename, data)) {
			await removeSavedPayload(filename);
			logs.push(`Skipping non-actionable SEC adviser shell for ${source.toUpperCase()} ${type} ${crd}`);
			return null;
		}
		const sync = await syncSavedPayload(filename, data);
		syncSummary[sync.status as keyof typeof syncSummary].push(filename);
		if (sync.changed) {
			savedFiles.push(filename);
			savedBySeed[crd] = savedBySeed[crd] || [];
			savedBySeed[crd].push(filename);
		}
		if (sync.status === 'unchanged') {
			logs.push(`Local file already current: ${filename}`);
		} else if (sync.status === 'repaired') {
			logs.push(`Repaired local file with upstream data: ${filename}`);
		} else if (sync.status === 'updated') {
			logs.push(`Updated local file with upstream changes: ${filename}`);
		} else {
			logs.push(`Saved new local file: ${filename}`);
		}
		return { filename, status: sync.status, payload: data };
	}

	try {
		if (query) {
			await searchSource('finra', query);
			await searchSource('sec', query);
		}
		if (startCrd) discoveredSet.add(startCrd);

		const seeds = Array.from(discoveredSet).slice(0, maxVisits);
		logs.push(`Seeding crawl with ${seeds.length} CRD(s)`);

		for (const crd of seeds) {
			logs.push(`\n=== Handling seed CRD ${crd} ===`);
			let finraData = null;
			const seedFilename = detailFilenameForSource('finra', 'individual', crd);
			const seedExisting = await inspectSavedPayload(seedFilename);
			try {
				if (seedExisting.exists) {
					const { loadSavedPayload } = await import('./_lib');
					const raw = await loadSavedPayload(seedFilename);
					finraData = JSON.parse(raw || '{}');
				} else {
					finraData = await fetchJson(`https://api.brokercheck.finra.org/search/individual/${crd}?includePrevious=true`, false);
				}
			} catch (e: any) {
				logs.push(`ERROR fetching FINRA detail for ${crd}: ${e?.message || e}`);
				errors.push({ crd, message: e?.message || String(e) });
			}
			const iaOnly = (function isIaOnlyFromPayload(payload: any) {
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
			})(finraData || {});
			logs.push(`ia_only for CRD ${crd}: ${iaOnly ? 'Y' : 'N/missing'}`);

			if (iaOnly) {
				try {
					const saved = await fetchAndSave('sec', 'individual', crd);
					if (saved) logs.push(`${saved.status}: ${saved.filename}`);
				} catch (e: any) {
					logs.push(`ERROR fetching/saving SEC for ${crd}: ${e?.message || e}`);
					errors.push({ crd, message: e?.message || String(e) });
				}
			} else {
				try {
					const s = await fetchAndSave('finra', 'individual', crd);
					if (s) logs.push(`${s.status}: ${s.filename}`);
				} catch (e: any) {
					logs.push(`ERROR fetching/saving FINRA for ${crd}: ${e?.message || e}`);
					errors.push({ crd, message: e?.message || String(e) });
				}
				try {
					const s2 = await fetchAndSave('sec', 'individual', crd);
					if (s2) logs.push(`${s2.status}: ${s2.filename}`);
				} catch (e: any) {
					logs.push(`ERROR fetching/saving SEC for ${crd}: ${e?.message || e}`);
					errors.push({ crd, message: e?.message || String(e) });
				}
			}
		}

		logs.push('\nSearch-and-crawl complete');
		return res.json({ seeds: Array.from(discoveredSet).slice(0, maxVisits), savedFiles, savedBySeed, errors, logs, matchSummary, syncSummary });
	} catch (e: any) {
		const message = e?.message || String(e);
		const statusCode = /429|too many requests/i.test(message) ? 429 : 500;
		return res.status(statusCode).json({ error: message });
	}
}
