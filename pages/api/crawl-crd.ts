import type { NextApiRequest, NextApiResponse } from 'next';
import {
	buildEndpoint,
	cleanupLegacyRawFiles,
	detailFilenameForSource,
	discoverCrdsFromPayload,
	discoverFirmIdsFromPayload,
	fetchWithCache,
	formatErrorMessage,
	hasBlockingIndicators,
	isEmptyPayload,
	syncSavedPayload,
} from './_lib';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
	if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
	const startCrd = String(req.body.startCrd || '').trim();
	const maxDepth = Number(req.body.maxDepth || 2);
	const maxVisits = Number(req.body.maxVisits || 100);

	if (!/^[0-9]+$/.test(startCrd)) return res.status(400).json({ error: 'startCrd must be a numeric CRD' });
	if (!Number.isFinite(maxDepth) || maxDepth < 1) return res.status(400).json({ error: 'maxDepth must be a positive number' });
	if (!Number.isFinite(maxVisits) || maxVisits < 1) return res.status(400).json({ error: 'maxVisits must be a positive number' });

	const logs: string[] = [];
	const errors: any[] = [];
	const savedFiles: string[] = [];
	const savedBySeed: Record<string, string[]> = {};

	const queue: Array<{ crd: string; depth: number; type: 'individual' | 'firm' }> = [
		{ crd: startCrd, depth: 0, type: 'individual' },
		{ crd: startCrd, depth: 0, type: 'firm' },
	];
	const visited = new Set<string>();
	const pending = new Set([`individual:${startCrd}`, `firm:${startCrd}`]);

	logs.push(`Starting crawl from CRD ${startCrd}`);
	await cleanupLegacyRawFiles();

	async function fetchAndSaveSourceDetail(source: string, type: 'individual' | 'firm', crd: string) {
		const url = buildEndpoint({ source, type, crd });
		if (!url) throw new Error(`Unsupported source detail URL for ${source}`);
		logs.push(`Fetching ${source.toUpperCase()} ${type} detail for CRD ${crd}`);
		const filename = detailFilenameForSource(source, type, crd);
		const { inspectSavedPayload, loadSavedPayload } = await import('./_lib');
		const existing = await inspectSavedPayload(filename);
		
		let data: any = null;
		if (existing.exists) {
			logs.push(`Skipping external detail fetch; already cached locally: ${filename}`);
			const raw = await loadSavedPayload(filename);
			try { data = JSON.parse(raw || '{}'); } catch { data = {}; }
			return { saved: null, payload: data };
		}
		
		data = await fetchWithCache(url, { forceRefresh: false });
		if (isEmptyPayload(data)) {
			logs.push(`Skipping save for empty response from ${source.toUpperCase()} ${crd}`);
			return { saved: null, payload: data };
		}
		if (hasBlockingIndicators(data)) {
			logs.push(`Detected blocking/upstream limitation message from ${source.toUpperCase()} ${crd}; skipping save`);
			return { saved: null, payload: data };
		}

		const sync = await syncSavedPayload(filename, data);
		if (sync.changed) {
			savedFiles.push(filename);
		} else if (!sync.existed) {
			logs.push(`Skipping non-actionable detail payload for ${source.toUpperCase()} ${type} ${crd}`);
		}
		return { saved: sync.changed ? filename : null, payload: data };
	}

	while (queue.length > 0 && visited.size < maxVisits) {
		const { crd, depth, type } = queue.shift() as any;
		pending.delete(`${type}:${crd}`);
		if (visited.has(`${type}:${crd}`)) continue;
		visited.add(`${type}:${crd}`);
		logs.push(`\n=== Crawling ${type.toUpperCase()} ${crd} (depth ${depth}) ===`);

		for (const source of ['finra', 'sec']) {
			try {
				const { saved, payload } = await fetchAndSaveSourceDetail(source, type, crd);
				if (saved) {
					savedBySeed[crd] = savedBySeed[crd] || [];
					savedBySeed[crd].push(saved);
				}
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
			} catch (error: any) {
				const message = error?.message || String(error);
				errors.push({ crd, source, message });
				logs.push(`ERROR ${source.toUpperCase()} ${type} ${crd}: ${message}`);
			}
		}
	}

	logs.push(`\nCrawl complete. Visited ${visited.size} CRD(s).`);
	if (savedFiles.length) logs.push(`Saved ${savedFiles.length} local file(s).`);
	if (errors.length) logs.push(`Encountered ${errors.length} error(s).`);

	return res.json({ startCrd, visited: Array.from(visited), queue: queue.map((i) => i.crd), savedFiles, savedBySeed, errors, logs });
}
