/**
 * Publish data/derived/global-graph-layout.json to Upstash Redis so Vercel
 * /api/global-graph can serve the chart page without a local disk artifact.
 *
 * Stores brotli+base64 payload split into chunks under:
 *   dashboard:global-graph-layout:meta
 *   dashboard:global-graph-layout:chunk:0..n-1
 * and also attempts a single-key write when small enough.
 *
 * Usage:
 *   pnpm run publish-global-graph-layout
 *   pnpm exec tsx scripts/publish-global-graph-layout.ts --in path/to/layout.json
 */
import { promises as fs } from 'fs';
import path from 'path';
import { brotliCompressSync } from 'zlib';
import { config as loadEnv } from 'dotenv';
import { Redis } from '@upstash/redis';

loadEnv({ path: path.resolve(process.cwd(), '.env.local') });
loadEnv({ path: path.resolve(process.cwd(), '.env') });

const layoutRedisKey = 'dashboard:global-graph-layout';
const layoutRedisMetaKey = 'dashboard:global-graph-layout:meta';
const layoutRedisChunkPrefix = 'dashboard:global-graph-layout:chunk:';
// Stay under typical REST body limits; Upstash request bodies are capped.
const chunkChars = 350_000;

function parseArgs(argv: string[]) {
	let inPath = path.resolve(process.cwd(), 'data', 'derived', 'global-graph-layout.json');
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--in' && argv[i + 1]) {
			inPath = path.resolve(process.cwd(), argv[++i]);
		}
	}
	return { inPath };
}

async function main() {
	const { inPath } = parseArgs(process.argv.slice(2));
	const url = process.env.UPSTASH_REDIS_REST_URL || '';
	const token = process.env.UPSTASH_REDIS_REST_TOKEN || '';
	if (!url || !token) {
		throw new Error('Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (e.g. in .env.local)');
	}

	const raw = await fs.readFile(inPath);
	const parsed = JSON.parse(raw.toString('utf-8')) as { stats?: unknown; generatedAt?: string; version?: number };
	const compressed = brotliCompressSync(raw);
	const b64 = compressed.toString('base64');
	console.log(
		JSON.stringify(
			{
				inPath,
				rawBytes: raw.length,
				brBytes: compressed.length,
				base64Chars: b64.length,
				generatedAt: parsed.generatedAt,
				version: parsed.version,
				stats: parsed.stats,
			},
			null,
			2,
		),
	);

	const redis = new Redis({ url, token });

	// Chunked write (always) — reliable for ~0.5MB+ payloads.
	const chunks: string[] = [];
	for (let i = 0; i < b64.length; i += chunkChars) {
		chunks.push(b64.slice(i, i + chunkChars));
	}
	const meta = {
		chunks: chunks.length,
		encoding: 'br-base64',
		bytes: raw.length,
		brBytes: compressed.length,
		generatedAt: parsed.generatedAt || null,
		version: parsed.version || null,
		sourcePath: inPath,
		publishedAt: new Date().toISOString(),
	};

	await redis.set(layoutRedisMetaKey, JSON.stringify(meta));
	for (let i = 0; i < chunks.length; i++) {
		await redis.set(`${layoutRedisChunkPrefix}${i}`, chunks[i]);
		process.stdout.write(`wrote chunk ${i + 1}/${chunks.length}\n`);
	}

	// Also try single-key br wrapper for simpler reads when REST allows it.
	const single = `br:base64:${b64}`;
	try {
		await redis.set(layoutRedisKey, single);
		console.log(`also wrote single key ${layoutRedisKey} (${single.length} chars)`);
	} catch (error) {
		console.warn(`single-key write skipped/failed: ${error instanceof Error ? error.message : String(error)}`);
		// Clear stale single key so readers fall back to chunks.
		try {
			await redis.del(layoutRedisKey);
		} catch {
			/* ignore */
		}
	}

	// Drop any leftover higher-index chunks from a previous larger publish.
	for (let i = chunks.length; i < chunks.length + 20; i++) {
		await redis.del(`${layoutRedisChunkPrefix}${i}`);
	}

	console.log('publish complete', meta);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
