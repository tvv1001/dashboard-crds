import type { NextApiRequest, NextApiResponse } from 'next';
import { getCachedCrdCounts } from './_lib';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
	if (req.method !== 'GET') {
		res.setHeader('Allow', 'GET');
		return res.status(405).json({ error: 'Method Not Allowed' });
	}

	try {
		const counts = await getCachedCrdCounts();
		return res.status(200).json({
			counts,
			timestamp: new Date().toISOString(),
		});
	} catch (e) {
		return res.status(500).json({ error: String(e) });
	}
}
