import type { NextApiRequest, NextApiResponse } from 'next';
import { detailFilenameForSource, listSavedKeys } from './_lib';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
	const crd = String(req.query.crd || '').trim();
	if (!/^[0-9]+$/.test(crd)) return res.status(400).json({ error: 'crd must be a numeric value' });
	try {
		const keys = await listSavedKeys();
		const formats = [
			{ source: 'finra', type: 'firm' },
			{ source: 'finra', type: 'individual' },
			{ source: 'sec', type: 'firm' },
			{ source: 'sec', type: 'individual' },
		];
		const status: Record<string, boolean> = {};
		for (const f of formats) {
			const filename = detailFilenameForSource(f.source, f.type, crd);
			status[`${f.source}:${f.type}:${crd}`] = keys.includes(filename);
		}
		return res.json({ crd, status });
	} catch (e: any) {
		return res.status(500).json({ error: e.message });
	}
}
