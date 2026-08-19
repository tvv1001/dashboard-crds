import type { NextApiRequest, NextApiResponse } from 'next';
import { formatErrorMessage } from '../_lib';
import { loadPersistedGraph, resetGraphSession, saveGraphSession, sessionFromFinraGraph, type GraphSessionPayload } from '../_graphSession';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
	if (req.method === 'GET') {
		try {
			const { graph, session } = await loadPersistedGraph();
			const restored = session && session.nodes?.length ? session : sessionFromFinraGraph(graph);
			res.setHeader('Cache-Control', 'no-store');
			return res.status(200).json({
				session: restored,
				graph,
			});
		} catch (error) {
			return res.status(500).json({ error: formatErrorMessage(error) });
		}
	}

	if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

	const action = String(req.body?.action || '').trim().toLowerCase();
	try {
		if (action === 'reset') {
			await resetGraphSession();
			res.setHeader('Cache-Control', 'no-store');
			return res.status(200).json({ ok: true, cleared: true, clearedAt: new Date().toISOString() });
		}
		if (action === 'save') {
			const session = req.body?.session as GraphSessionPayload | undefined;
			if (!session || typeof session !== 'object') {
				return res.status(400).json({ error: 'session payload required' });
			}
			const saved = await saveGraphSession(session);
			res.setHeader('Cache-Control', 'no-store');
			return res.status(200).json({ ok: true, savedAt: saved.updatedAt, nodeCount: saved.nodes.length, linkCount: saved.links.length });
		}
		return res.status(400).json({ error: 'action must be save or reset' });
	} catch (error) {
		return res.status(500).json({ error: formatErrorMessage(error) });
	}
}
