import type { NextApiRequest, NextApiResponse } from 'next';
import { formatErrorMessage } from '../../../_lib';
import { getFirmConnections } from '../../../_firmConnections';

// Read-only firm current/previous people list from Redis cache only.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
	if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

	const id = String(Array.isArray(req.query.id) ? req.query.id[0] : req.query.id || '').trim();
	if (!/^\d{1,10}$/.test(id)) {
		return res.status(400).json({ error: 'id must be a firm CRD number' });
	}

	try {
		const { currentConnections, previousConnections, source } = await getFirmConnections(id);
		const found = currentConnections.length > 0 || previousConnections.length > 0;
		// Do not CDN-cache empty/partial enrichment responses — names fill in over time
		// from Redis + live BrokerCheck lookups into a local person-meta cache.
		res.setHeader('Cache-Control', found ? 'private, max-age=30' : 'no-store');
		return res.status(200).json({
			firmId: id,
			found,
			currentConnections,
			previousConnections,
			source,
		});
	} catch (error) {
		return res.status(500).json({ error: formatErrorMessage(error) });
	}
}
