import type { NextApiRequest, NextApiResponse } from 'next';
import { promises as fs } from 'fs';
import path from 'path';
import { formatErrorMessage, getCacheValue, getRedisConnectionMode } from './_lib';

const layoutPath = path.resolve(process.cwd(), 'data', 'derived', 'global-graph-layout.json');
const layoutRedisKey = 'dashboard:global-graph-layout';
const layoutRedisMetaKey = 'dashboard:global-graph-layout:meta';
const layoutRedisChunkPrefix = 'dashboard:global-graph-layout:chunk:';

type CacheEntry = {
	sourceKey: string;
	body: string;
	stats: Record<string, unknown> | null;
	generatedAt?: string;
	params?: unknown;
};

let cache: CacheEntry | null = null;

function parseLayoutMeta(body: string) {
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
	return { stats, generatedAt, params };
}

async function readLayoutFromDisk(): Promise<string | null> {
	try {
		return await fs.readFile(layoutPath, 'utf-8');
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err?.code === 'ENOENT') return null;
		throw error;
	}
}

async function readLayoutFromRedis(): Promise<{ body: string; source: string } | null> {
	if (getRedisConnectionMode() === 'none') return null;

	// Preferred: single-key full JSON (or gzip base64 wrapper).
	try {
		const direct = await getCacheValue(layoutRedisKey);
		if (direct && direct.length > 2) {
			if (direct.trimStart().startsWith('{')) {
				return { body: direct, source: `redis:${layoutRedisKey}` };
			}
			// gzip:base64:<payload>
			if (direct.startsWith('gzip:base64:')) {
				const { gunzipSync } = await import('zlib');
				const raw = Buffer.from(direct.slice('gzip:base64:'.length), 'base64');
				return { body: gunzipSync(raw).toString('utf-8'), source: `redis:${layoutRedisKey}:gzip` };
			}
		}
	} catch (error) {
		console.warn('global-graph: redis direct read failed', formatErrorMessage(error));
	}

	// Chunked upload: meta { chunks, encoding?, bytes? } + chunk:0..n-1
	try {
		const metaRaw = await getCacheValue(layoutRedisMetaKey);
		if (!metaRaw) return null;
		const meta = JSON.parse(metaRaw) as { chunks?: number; encoding?: string };
		const chunkCount = Number(meta.chunks || 0);
		if (!Number.isFinite(chunkCount) || chunkCount <= 0) return null;
		const parts: string[] = [];
		for (let i = 0; i < chunkCount; i++) {
			const part = await getCacheValue(`${layoutRedisChunkPrefix}${i}`);
			if (!part) {
				console.warn(`global-graph: missing redis chunk ${i}/${chunkCount}`);
				return null;
			}
			parts.push(part);
		}
		const joined = parts.join('');
		if (meta.encoding === 'gzip-base64' || joined.startsWith('H4sI') || !joined.trimStart().startsWith('{')) {
			const { gunzipSync } = await import('zlib');
			const body = gunzipSync(Buffer.from(joined, 'base64')).toString('utf-8');
			return { body, source: `redis:${layoutRedisMetaKey}:gzip-chunks` };
		}
		return { body: joined, source: `redis:${layoutRedisMetaKey}:chunks` };
	} catch (error) {
		console.warn('global-graph: redis chunked read failed', formatErrorMessage(error));
		return null;
	}
}

async function loadLayout(metaOnly: boolean) {
	// Memory cache first
	if (cache) {
		if (metaOnly) {
			return {
				ok: true as const,
				payload: {
					ok: true,
					metaOnly: true,
					generatedAt: cache.generatedAt,
					stats: cache.stats,
					params: cache.params,
					path: cache.sourceKey,
					bytes: Buffer.byteLength(cache.body, 'utf-8'),
				},
				body: null as string | null,
			};
		}
		return { ok: true as const, payload: null, body: cache.body };
	}

	// Disk (local dev / non-serverless with checked-in or generated artifact)
	const fromDisk = await readLayoutFromDisk();
	if (fromDisk) {
		const meta = parseLayoutMeta(fromDisk);
		cache = {
			sourceKey: 'data/derived/global-graph-layout.json',
			body: fromDisk,
			stats: meta.stats,
			generatedAt: meta.generatedAt,
			params: meta.params,
		};
	} else {
		// Redis (Vercel / shared Upstash)
		const fromRedis = await readLayoutFromRedis();
		if (!fromRedis) {
			const err = new Error('Global layout not built yet') as NodeJS.ErrnoException;
			err.code = 'ENOENT';
			throw err;
		}
		const meta = parseLayoutMeta(fromRedis.body);
		cache = {
			sourceKey: fromRedis.source,
			body: fromRedis.body,
			stats: meta.stats,
			generatedAt: meta.generatedAt,
			params: meta.params,
		};
	}

	if (metaOnly) {
		return {
			ok: true as const,
			payload: {
				ok: true,
				metaOnly: true,
				generatedAt: cache.generatedAt,
				stats: cache.stats,
				params: cache.params,
				path: cache.sourceKey,
				bytes: Buffer.byteLength(cache.body, 'utf-8'),
			},
			body: null as string | null,
		};
	}
	return { ok: true as const, payload: null, body: cache.body };
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
				hint: 'Run locally: pnpm run build-global-graph-layout && pnpm run publish-global-graph-layout',
				path: 'data/derived/global-graph-layout.json or Redis key dashboard:global-graph-layout',
			});
		}
		console.error('global-graph API failed', error);
		return res.status(500).json({ ok: false, error: 'Failed to load global graph layout', detail: formatErrorMessage(error) });
	}
}
