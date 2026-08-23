import { Redis as UpstashRedis } from '@upstash/redis';
import IORedis from 'ioredis';

let localIoRedis: IORedis | null = null;
// Cache Upstash client instances to avoid recreating HTTP clients on every
// invocation which adds latency and extra resource usage.
const upstashClientCache = new Map<string, UpstashRedis>();

async function executeLocalRequest(req: any): Promise<any> {
	if (!localIoRedis) {
		localIoRedis = new IORedis('redis://127.0.0.1:6379');
		console.log('Other local applications can now connect to your shared local cache at redis://127.0.0.1:6379!');
	}

	let body = req.body || [];
	if (typeof body === 'string') {
		body = JSON.parse(body);
	}

	if (Array.isArray(body) && Array.isArray(body[0])) {
		// pipeline
		const pipeline = localIoRedis.pipeline();
		body.forEach((cmd: any) => {
			// @ts-ignore
			pipeline.sendCommand(new IORedis.Command(cmd[0], cmd.slice(1)));
		});
		const res = await pipeline.exec();
		return res?.map((r) => (r[0] ? { error: r[0].message } : { result: r[1] }));
	} else if (Array.isArray(body)) {
		try {
			const res = await localIoRedis.sendCommand(new IORedis.Command(body[0], body.slice(1)));
			return { result: res };
		} catch (e: any) {
			return { error: e.message };
		}
	} else {
		return { error: 'Invalid payload' };
	}
}

export function getRedisClientInstance(config: { url: string; token: string }) {
	const isLocalhost = process.env.USE_LOCAL_REDIS === '1';

	if (isLocalhost) {
		return new UpstashRedis({
			request: executeLocalRequest,
		} as any);
	}

	const url1 = process.env.UPSTASH_REDIS_REST_URL;
	const token1 = process.env.UPSTASH_REDIS_REST_TOKEN;
	// prefer the MIRROR env var but fall back to legacy _2 env names for compatibility
	const url2 = process.env.UPSTASH_REDIS_REST_URL_MIRROR || process.env.UPSTASH_REDIS_REST_URL_2;
	const token2 = process.env.UPSTASH_REDIS_REST_TOKEN_MIRROR || process.env.UPSTASH_REDIS_REST_TOKEN_2 || process.env.UPSTASH_REDIS_REST_TOKEN__2;

	const hasDb1 = !!(url1 && token1);
	const hasDb2 = !!(url2 && token2);
	const disableDb2 = process.env.UPSTASH_REDIS_DISABLE_MIRROR === '1' || process.env.UPSTASH_REDIS_DISABLE_2 === '1';

	// If DB2 is explicitly disabled via env, prefer DB1 when available and avoid the dual-proxy.
	if (hasDb1 && hasDb2 && !disableDb2) {
		const cacheKey1 = `${url1}:${token1}`;
		const cacheKey2 = `${url2}:${token2}`;
		const client1 = upstashClientCache.get(cacheKey1) ?? new UpstashRedis({ url: url1, token: token1 });
		const client2 = upstashClientCache.get(cacheKey2) ?? new UpstashRedis({ url: url2, token: token2 });
		upstashClientCache.set(cacheKey1, client1);
		upstashClientCache.set(cacheKey2, client2);

		const readMethods = new Set(['get', 'mget', 'scan', 'zrange', 'smembers', 'hgetall', 'exists', 'dbsize', 'type', 'keys', 'hget', 'zrevrange']);
		const writeMethods = new Set(['set', 'mset', 'hset', 'zadd', 'sadd', 'del', 'incr', 'incrby', 'expire', 'flushall', 'flushdb']);

		let db1Maxxed = false;
		let db2Maxxed = false;

		const checkMaxxed = (err: any, dbIndex: 1 | 2) => {
			const msg = String(err?.message || '').toLowerCase();
			if (msg.includes('max') || msg.includes('limit') || msg.includes('exceeded') || msg.includes('daily')) {
				if (dbIndex === 1) db1Maxxed = true;
				else db2Maxxed = true;
				console.warn(`[Redis LB] DB${dbIndex} marked as maxxed out!`);
			}
		};

		return new Proxy(client2, {
			get(target, prop) {
				const val = (target as any)[prop];
				if (typeof val === 'function') {
					return function (...args: any[]) {
						const propStr = prop as string;
						if (readMethods.has(propStr)) {
							return (async () => {
								if (db1Maxxed && db2Maxxed) {
									if (propStr === 'scan') return ['0', []];
									if (propStr === 'mget' || propStr === 'zrange' || propStr === 'zrevrange' || propStr === 'smembers' || propStr === 'keys') return [];
									if (propStr === 'exists' || propStr === 'dbsize') return 0;
									if (propStr === 'hgetall') return {};
									return null;
								}

								let primary = client2;
								let secondary = client1;
								let primaryIndex: 1 | 2 = 2;
								let secondaryIndex: 1 | 2 = 1;

								if (!db1Maxxed && (db2Maxxed || Math.random() < 0.5)) {
									primary = client1;
									secondary = client2;
									primaryIndex = 1;
									secondaryIndex = 2;
								}

								try {
									let res = await (primary as any)[propStr](...args);
									
									// Fallback if null (helpful during partial migrations), only if other DB is healthy
									let needsFallback = res === null || res === undefined;
									if (Array.isArray(res) && res.length > 0 && res.some(item => item === null || item === undefined)) {
										needsFallback = true;
									}
									
									if (needsFallback && !db1Maxxed && !db2Maxxed) {
										res = await (secondary as any)[propStr](...args);
									}
									return res;
								} catch (err: any) {
									checkMaxxed(err, primaryIndex);
									if (db1Maxxed && db2Maxxed) {
										if (propStr === 'scan') return ['0', []];
										if (propStr === 'mget' || propStr === 'zrange' || propStr === 'zrevrange' || propStr === 'smembers' || propStr === 'keys') return [];
										if (propStr === 'exists' || propStr === 'dbsize') return 0;
										if (propStr === 'hgetall') return {};
										return null;
									}
									console.warn(`[Redis LB] Error on DB${primaryIndex} for ${propStr}, falling back to DB${secondaryIndex}... (${err.message})`);
									try {
										return await (secondary as any)[propStr](...args);
									} catch (err2: any) {
										checkMaxxed(err2, secondaryIndex);
										if (propStr === 'scan') return ['0', []];
										if (propStr === 'mget' || propStr === 'zrange' || propStr === 'zrevrange' || propStr === 'smembers' || propStr === 'keys') return [];
										if (propStr === 'exists' || propStr === 'dbsize') return 0;
										if (propStr === 'hgetall') return {};
										return null;
									}
								}
							})();
						} else if (writeMethods.has(propStr)) {
							return (async () => {
								// Perform writes to both DBs concurrently but return the fastest
								// successful response to minimize latency. The other write
								// continues in the background; failures are logged and may mark
								// the DB as maxxed.
								const wrapped = (p: Promise<any>, dbIndex: 1 | 2) =>
									p
										.then((res) => ({ ok: true, res, dbIndex }))
										.catch((e: any) => {
											checkMaxxed(e, dbIndex);
											console.error(`[Redis LB] Write error DB${dbIndex}:`, e?.message || e);
											return { ok: false, err: e, dbIndex };
										});

								const promises: Array<Promise<any>> = [];
								if (!db1Maxxed) promises.push(wrapped((client1 as any)[propStr](...args), 1));
								else promises.push(Promise.resolve({ ok: false, dbIndex: 1 }));
								
								if (!db2Maxxed) promises.push(wrapped((client2 as any)[propStr](...args), 2));
								else promises.push(Promise.resolve({ ok: false, dbIndex: 2 }));

								// Await both writes fully before returning. In Serverless/Edge 
								// environments like Vercel, if we use Promise.race and return early, 
								// the execution context freezes and the second write is silently dropped!
								try {
									const all = await Promise.all(promises);
									let successRes = undefined;
									for (const a of all) {
										if (a && a.ok) successRes = a.res;
									}
									return successRes;
								} catch (e) {
									// If race threw (shouldn't), await both settled and return best-effort
									const settled = await Promise.allSettled(promises);
									for (const s of settled) {
										if ((s as any).status === 'fulfilled' && (s as any).value && (s as any).value.ok) return (s as any).value.res;
									}
									return undefined;
								}
							})();
						}
						// Direct passthrough for other methods (like pipeline)
						return (db1Maxxed ? client2 : (client1 as any))[propStr](...args);
					};
				}
				return val;
			},
		});
	}

	// Single-instance behavior. Prefer DB1 when present; otherwise use DB2 or the provided config.
	if (hasDb1) {
		const cacheKey = `${url1}:${token1}`;
		const c = upstashClientCache.get(cacheKey) ?? new UpstashRedis({ url: url1, token: token1 });
		upstashClientCache.set(cacheKey, c);
		return c;
	}
	if (hasDb2) {
		const cacheKey = `${url2}:${token2}`;
		const c = upstashClientCache.get(cacheKey) ?? new UpstashRedis({ url: url2, token: token2 });
		upstashClientCache.set(cacheKey, c);
		return c;
	}

	const cfgKey = `${config.url}:${config.token}`;
	const c = upstashClientCache.get(cfgKey) ?? new UpstashRedis({ url: config.url, token: config.token });
	upstashClientCache.set(cfgKey, c);
	return c;
}

/**
 * Return a read-only Upstash client (or proxied client) that will only execute
 * read methods against DB1/DB2. Writes will be rejected to ensure the caller
 * cannot modify state. This is intended for applications that should only
 * read from the cache (e.g., analytics or reporting services).
 */
export function getReadOnlyRedisClientInstance(config?: { url?: string; token?: string }) {
	const isLocalhost = process.env.USE_LOCAL_REDIS === '1';
	if (isLocalhost) {
		// Local proxy still supports read-only usage via the normal Upstash wrapper
		return new UpstashRedis({ request: executeLocalRequest } as any);
	}

	const url1 = process.env.UPSTASH_REDIS_REST_URL || config?.url;
	const token1 = process.env.UPSTASH_REDIS_REST_TOKEN;
	const url2 = process.env.UPSTASH_REDIS_REST_URL_MIRROR || process.env.UPSTASH_REDIS_REST_URL_2 || config?.url;
	const token2 = process.env.UPSTASH_REDIS_REST_TOKEN_MIRROR || process.env.UPSTASH_REDIS_REST_TOKEN_2 || process.env.UPSTASH_REDIS_REST_TOKEN__2;

	const hasDb1 = !!(url1 && token1);
	const hasDb2 = !!(url2 && token2);
	const disableDb2 = process.env.UPSTASH_REDIS_DISABLE_MIRROR === '1' || process.env.UPSTASH_REDIS_DISABLE_2 === '1';

	const readMethods = new Set(['get', 'mget', 'scan', 'zrange', 'smembers', 'hgetall', 'exists', 'dbsize', 'type', 'keys', 'hget', 'zrevrange', 'zscore', 'zrank', 'zincrby']);

	const checkMaxxed = (err: any, dbIndex: 1 | 2) => {
		const msg = String(err?.message || '').toLowerCase();
		if (msg.includes('max') || msg.includes('limit') || msg.includes('exceeded') || msg.includes('daily')) {
			// noop for read-only: log only
			console.warn(`[Redis RO] DB${dbIndex} marked as maxxed out (read)!`);
		}
	};

	if (hasDb1 && hasDb2 && !disableDb2) {
		const client1 = new UpstashRedis({ url: url1, token: token1 });
		const client2 = new UpstashRedis({ url: url2, token: token2 });

		return new Proxy(client2, {
			get(target, prop) {
				const val = (target as any)[prop];
				if (typeof val === 'function') {
					return function (...args: any[]) {
						const propStr = prop as string;
						if (!readMethods.has(propStr)) {
							return Promise.reject(new Error('Redis client is read-only: write methods are not allowed'));
						}
						return (async () => {
							// choose between DB1/DB2 for reads (same strategy as main client)
							let primary = client2;
							let secondary = client1;
							if (Math.random() < 0.5) {
								primary = client1;
								secondary = client2;
							}
							try {
								let res = await (primary as any)[propStr](...args);
								if (res === null || res === undefined) {
									res = await (secondary as any)[propStr](...args);
								}
								return res;
							} catch (err: any) {
								checkMaxxed(err, 1);
								try {
									return await (secondary as any)[propStr](...args);
								} catch (err2: any) {
									checkMaxxed(err2, 2);
									return null;
								}
							}
						})();
					};
				}
				return val;
			},
		});
	}

	if (hasDb1) return new UpstashRedis({ url: url1, token: token1 });
	if (hasDb2) return new UpstashRedis({ url: url2, token: token2 });

	return new UpstashRedis({ url: config?.url || '', token: config?.token || '' });
}
