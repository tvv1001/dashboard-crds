import type { NextApiRequest, NextApiResponse } from 'next';
import { formatErrorMessage } from '../../_lib';
import { decodeNodeId, expandNodes, normalizeHopsParam, parseNodeId } from '../../_graphIndex';

// Read-only graph expansion endpoint. Data is sourced entirely from the
// existing Redis-backed saved-payload store (see _graphIndex.ts) and this
// route never writes to Redis.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
	if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

	const nodeId = decodeNodeId(req.query.nodeId);
	if (!nodeId || !parseNodeId(nodeId)) {
		return res.status(400).json({ error: 'nodeId must look like individual:<CRD> or firm:<CRD>' });
	}

	const hops = normalizeHopsParam(typeof req.query.hops === 'string' ? req.query.hops : null);

	const extraIds = (typeof req.query.ids === 'string' ? req.query.ids.split(',') : [])
		.map((id) => decodeNodeId(id))
		.filter(Boolean);
	const allIds = Array.from(new Set([nodeId, ...extraIds]));

	try {
		const result = await expandNodes(allIds, hops);
		res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=86400');
		return res.status(200).json(result);
	} catch (error) {
		return res.status(500).json({ error: formatErrorMessage(error) });
	}
}
