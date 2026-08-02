import type { NextApiRequest, NextApiResponse } from 'next';
import { listSavedKeysWithStats, loadSavedPayload, normalizeRawPayload, formatErrorMessage } from './_lib';

export interface RecentFetchedItem {
	crd: string;
	type: 'individual' | 'firm';
	name: string;
	bcScope: string | null;
	iaScope: string | null;
	sources: string[];
	mtime: number;
}

function extractFromPayload(key: string, payload: unknown): { name: string; bcScope: string | null; iaScope: string | null } {
	// Delegate to normalizeRawPayload, which already unwraps every known storage
	// shape (finraBrokerCheck/secInvestmentAdvisor wrappers, legacy content/
	// iacontent/bccontent keys, and nested ES `hits.hits[0]._source.content`
	// payloads) — the previous hand-rolled unwrapping here missed the legacy
	// `hits` shape, leaving names blank for records still stored that way.
	const content = normalizeRawPayload(payload);
	if (!content || typeof content !== 'object') return { name: '', bcScope: null, iaScope: null };

	const bi = (content.basicInformation as Record<string, unknown>) ?? {};
	const isInd = /individual/.test(key);

	let name = '';
	if (isInd) {
		const parts = [bi.firstName, bi.middleName, bi.lastName]
			.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
		name = parts.join(' ').trim();
	} else {
		name = String(bi.firmName ?? bi.iaFirmName ?? '').trim();
	}

	return {
		name,
		bcScope: typeof bi.bcScope === 'string' ? bi.bcScope : null,
		iaScope: typeof bi.iaScope === 'string' ? bi.iaScope : null,
	};
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
	try {
		const limit = Math.min(Number(req.query.limit) || 30, 100);

		// Get the full index sorted by mtime desc
		const result = await listSavedKeysWithStats({ sort: 'date-desc', limit: 0 }); // limit:0 → all
		const allKeys = result.keys;

		// Group by CRD — track latest mtime and all sources
		const groupMap = new Map<string, {
			crd: string;
			type: 'individual' | 'firm';
			keys: string[];
			sources: string[];
			mtime: number;
		}>();

		for (const entry of allKeys) {
			const groupKey = `${entry.type}:${entry.crd}`;
			if (!groupMap.has(groupKey)) {
				groupMap.set(groupKey, {
					crd: entry.crd,
					type: entry.type as 'individual' | 'firm',
					keys: [],
					sources: [],
					mtime: 0,
				});
			}
			const g = groupMap.get(groupKey)!;
			if (!g.keys.includes(entry.key)) g.keys.push(entry.key);
			if (!g.sources.includes(entry.source)) g.sources.push(entry.source);
			if (entry.mtime > g.mtime) g.mtime = entry.mtime;
		}

		// Sort by latest mtime, take top N
		const topGroups = Array.from(groupMap.values())
			.sort((a, b) => b.mtime - a.mtime)
			.slice(0, limit);

		// Read payloads for the best key in each group (prefer finra:individual then sec:individual, etc.)
		const items: RecentFetchedItem[] = await Promise.all(
			topGroups.map(async (g) => {
				const preferredKey = g.keys.find((k) => k.startsWith('finra:')) ?? g.keys[0];
				let name = '';
				let bcScope: string | null = null;
				let iaScope: string | null = null;
				try {
					const payload = await loadSavedPayload(preferredKey);
					({ name, bcScope, iaScope } = extractFromPayload(preferredKey, payload));
				} catch {
					// fall back to CRD as name
				}
				return {
					crd: g.crd,
					type: g.type,
					name: name || `CRD ${g.crd}`,
					bcScope,
					iaScope,
					sources: g.sources.sort(),
					mtime: g.mtime,
				};
			}),
		);

		return res.status(200).json({ items });
	} catch (e) {
		return res.status(500).json({ error: formatErrorMessage(e) });
	}
}
