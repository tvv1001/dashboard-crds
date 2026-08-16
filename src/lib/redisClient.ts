import { Redis as UpstashRedis } from '@upstash/redis';
import { createClient as createNodeRedisClient } from 'redis';

type ReadOnlyClient = {
	get(key: string): Promise<string | null>;
	scan(cursor: string, opts?: { match?: string; count?: number }): Promise<[string, string[]]>;
	dbsize(): Promise<number>;
	// Any attempted write should throw
	set?: (..._args: any[]) => Promise<never>;
	del?: (..._args: any[]) => Promise<never>;
	sadd?: (..._args: any[]) => Promise<never>;
};

let rrCounter = 0;

function makeWriteRejecter(name: string) {
	return async function () {
		throw new Error(`Read-only Redis client: ${name} is disabled`);
	};
}

export function getReadOnlyRedisClientInstance(): ReadOnlyClient | null {
	const useLocal = Boolean(process.env.USE_LOCAL_REDIS && String(process.env.USE_LOCAL_REDIS) !== '0');

	const upstashUrl = process.env.UPSTASH_REDIS_REST_URL;
	const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;
	const upstashMirrorUrl = process.env.UPSTASH_REDIS_REST_URL_MIRROR || process.env.UPSTASH_REDIS_REST_URL_2;
	const upstashMirrorToken = process.env.UPSTASH_REDIS_REST_TOKEN_MIRROR || process.env.UPSTASH_REDIS_REST_TOKEN_2;
	const disableMirror = Boolean(process.env.UPSTASH_REDIS_DISABLE_MIRROR && String(process.env.UPSTASH_REDIS_DISABLE_MIRROR) !== '0');

	// Local redis proxy (optional)
	if (useLocal) {
		const redisUrl = process.env.REDIS_URL;
		const redisPassword = process.env.REDIS_PASSWORD;
		if (!redisUrl) return null;
		const client = createNodeRedisClient({ url: redisUrl, password: redisPassword });
		// connect lazily
		let connected = false;
		async function ensure() {
			if (connected) return;
			await client.connect();
			connected = true;
		}
		return {
			get: async (key: string) => {
				await ensure();
				const v = await client.get(key);
				return v == null ? null : v;
			},
			scan: async (cursor: string, opts?: { match?: string; count?: number }) => {
				await ensure();
				const match = opts?.match || undefined;
				const count = opts?.count || undefined;
				// node-redis v4 scan signature: scan(cursor, { MATCH, COUNT })
				// but some environments may differ; try-catch for robustness
				// @ts-ignore
				const res = await client.scan(cursor, { MATCH: match, COUNT: count });
				// res is [nextCursor, keys]
				return res as [string, string[]];
			},
			dbsize: async () => {
				await ensure();
				// @ts-ignore
				const n = await client.dbSize();
				return Number(n || 0);
			},
			set: makeWriteRejecter('set'),
			del: makeWriteRejecter('del'),
			sadd: makeWriteRejecter('sadd'),
		};
	}

	if (!upstashUrl || !upstashToken) return null;

	const primary = new UpstashRedis({ url: upstashUrl, token: upstashToken });
	const hasMirror = !!upstashMirrorUrl && !!upstashMirrorToken && !disableMirror;
	const mirror = hasMirror ? new UpstashRedis({ url: upstashMirrorUrl as string, token: upstashMirrorToken as string }) : null;

	const pick = () => {
		if (!mirror) return primary;
		// simple round-robin
		const pickPrimary = rrCounter++ % 2 === 0;
		return pickPrimary ? primary : mirror!;
	};

	return {
		get: async (key: string) => {
			const c = pick();
			try {
				const v = await c.get(key);
				return (
					v == null ? null
					: typeof v === 'string' ? v
					: JSON.stringify(v)
				);
			} catch (err) {
				// try fallback
				if (mirror && c === primary) {
					try {
						const v2 = await mirror.get(key);
						return (
							v2 == null ? null
							: typeof v2 === 'string' ? v2
							: JSON.stringify(v2)
						);
					} catch (_) {}
				}
				return null;
			}
		},
		scan: async (cursor: string, opts?: { match?: string; count?: number }) => {
			const c = pick();
			try {
				// Upstash scan(cursor, { match, count }) returns [nextCursor, batch]
				// @ts-ignore
				const res = await c.scan(cursor, { match: opts?.match, count: opts?.count });
				return res as [string, string[]];
			} catch (err) {
				if (mirror && c === primary) {
					try {
						// @ts-ignore
						const res2 = await mirror.scan(cursor, { match: opts?.match, count: opts?.count });
						return res2 as [string, string[]];
					} catch (_) {}
				}
				throw err;
			}
		},
		dbsize: async () => {
			try {
				const n = await primary.dbsize();
				return Number(n || 0);
			} catch (err) {
				if (mirror) {
					try {
						const n2 = await mirror.dbsize();
						return Number(n2 || 0);
					} catch (_) {}
				}
				throw err;
			}
		},
		set: makeWriteRejecter('set'),
		del: makeWriteRejecter('del'),
		sadd: makeWriteRejecter('sadd'),
	};
}

export default getReadOnlyRedisClientInstance;
