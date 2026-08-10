import type { NextApiRequest, NextApiResponse } from 'next';
import { promises as fs } from 'fs';
import path from 'path';

const layoutPath = path.resolve(process.cwd(), 'data', 'derived', 'global-graph-layout.json');

type CacheEntry = {
	mtimeMs: number;
	body: string;
	stats: Record<string, unknown> | null;
};

let cache: CacheEntry | null = null;

async function loadLayout(metaOnly: boolean) {
	const stat = await fs.stat(layoutPath);
	if (cache && cache.mtimeMs === stat.mtimeMs) {
		if (metaOnly) {
			return {
				ok: true as const,
				payload: {
					ok: true,
					metaOnly: true,
					generatedAt: undefined as string | undefined,
					stats: cache.stats,
					params: undefined as unknown,
					path: 'data/derived/global-graph-layout.json',
					bytes: Buffer.byteLength(cache.body, 'utf-8'),
				},
				body: null as string | null,
			};
		}
		return { ok: true as const, payload: null, body: cache.body };
	}

	const body = await fs.readFile(layoutPath, 'utf-8');
	let stats: Record<string, unknown> | null = null;
	let generatedAt: string | undefined;
	let params: unknown;
	try {
		const parsed = JSON.parse(body) as {
			stats?: Record<string, unknown>;
			generatedAt?: string;
			params?: unknown;
		};
		stats = parsed.stats || null;
		generatedAt = parsed.generatedAt;
		params = parsed.params;
	} catch {
		stats = null;
	}
	cache = { mtimeMs: stat.mtimeMs, body, stats };

	if (metaOnly) {
		return {
			ok: true as const,
			payload: {
				ok: true,
				metaOnly: true,
				generatedAt,
				stats,
				params,
				path: 'data/derived/global-graph-layout.json',
				bytes: Buffer.byteLength(body, 'utf-8'),
			},
			body: null as string | null,
		};
	}
	return { ok: true as const, payload: null, body };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
	if (req.method !== 'GET') {
		res.setHeader('Allow', 'GET');
		return res.status(405).json({ ok: false, error: 'Method not allowed' });
	}

	const metaOnly = String(req.query.meta || '') === '1' || String(req.query.meta || '') === 'true';

	try {
		const result = await loadLayout(metaOnly);
		res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=600');
		if (metaOnly && result.payload) {
			return res.status(200).json(result.payload);
		}
		res.setHeader('Content-Type', 'application/json; charset=utf-8');
		return res.status(200).send(result.body || '{}');
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err?.code === 'ENOENT') {
			return res.status(404).json({
				ok: false,
				error: 'Global layout not built yet',
				hint: 'Run: pnpm run build-global-graph-layout',
				path: 'data/derived/global-graph-layout.json',
			});
		}
		console.error('global-graph API failed', error);
		return res.status(500).json({ ok: false, error: 'Failed to load global graph layout' });
	}
}
