import type { NextApiRequest, NextApiResponse } from 'next';
import { formatErrorMessage, readSeenKeys, writeSeenKeys } from './_lib';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
	try {
		if (req.method === 'GET') {
			const keys = await readSeenKeys();
			return res.json({ keys });
		}
		if (req.method === 'POST') {
			const body = req.body || {};
			const existing = await readSeenKeys();
			if (body.key) existing[body.key] = true;
			if (body.keys && typeof body.keys === 'object') {
				for (const [k, v] of Object.entries(body.keys)) existing[k] = v;
			}
			await writeSeenKeys(existing);
			return res.json({ keys: existing });
		}
		if (req.method === 'DELETE') {
			await writeSeenKeys({});
			return res.json({ cleared: true });
		}
		return res.status(405).json({ error: 'Method not allowed' });
	} catch (e) {
		return res.status(500).json({ error: formatErrorMessage(e) });
	}
}
