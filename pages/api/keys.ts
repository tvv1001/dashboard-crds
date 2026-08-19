import type { NextApiRequest, NextApiResponse } from 'next';
import { formatErrorMessage, listSavedKeysWithStats, refreshSavedKeyIndexFromRedis } from './_lib';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
	try {
		const rawType = String(req.query.type || 'all')
			.trim()
			.toLowerCase();
		const type = rawType === 'individual' || rawType === 'firm' ? rawType : 'all';
		const rawSort = String(req.query.sort || 'date-desc')
			.trim()
			.toLowerCase();
		const sort = rawSort === 'crd-asc' || rawSort === 'crd-desc' ? rawSort : 'date-desc';
		const rawIncludeCrds = Array.isArray(req.query.includeCrds) ? req.query.includeCrds.join(',') : String(req.query.includeCrds || '');
		const includeCrds = rawIncludeCrds
			.split(',')
			.map((value) => value.trim())
			.filter(Boolean);
		const limit = Number(req.query.limit);
		// Optional ?refresh=1 forces a rebuild of the saved-key index from Redis
		// (useful when the cached index is stale and counts like uniqueTotalCrds
		// appear incorrect). This calls the existing refreshSavedKeyIndexFromRedis()
		// helper which scans Redis and rebuilds the index cache.
		if (String(req.query.refresh || '').trim() === '1') {
			try {
				await refreshSavedKeyIndexFromRedis();
			} catch (e) {
				// ignore refresh errors and proceed to list keys normally
			}
		}

		const result = await listSavedKeysWithStats({
			filter: String(req.query.filter || ''),
			type,
			sort,
			limit: Number.isFinite(limit) ? limit : undefined,
			includeCrds,
		});
		return res.json(result);
	} catch (e) {
		return res.status(500).json({ error: formatErrorMessage(e) });
	}
}
