import type { NextApiRequest, NextApiResponse } from 'next';
import { cleanupEmptySearchFiles } from './_lib';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
	if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
	try {
		const deleted = await cleanupEmptySearchFiles();
		return res.json({ deleted, count: deleted.length });
	} catch (e: any) {
		return res.status(500).json({ error: e.message });
	}
}
