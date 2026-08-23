const fs = require('fs');
let code = fs.readFileSync('pages/api/_lib.ts', 'utf8');

// Replace upstashRedisClient2 with nothing, we only need upstashRedisClient
code = code.replace(/const upstashRedisClient2: any = null;/g, '');
code = code.replace(/let writableUpstashClient2: any = null;/g, '');
code = code.replace(/if \(upstashRedisRestUrl2 && upstashRedisRestToken2\) writableUpstashClient2 = new UpstashWritable\(\{ url: upstashRedisRestUrl2, token: upstashRedisRestToken2 \}\);/g, '');

code = code.replace(/upstashRedisClient2 \|\| upstashRedisClient/g, 'upstashRedisClient');
code = code.replace(/upstashRedisClient \|\| upstashRedisClient2/g, 'upstashRedisClient');

// Replace the manual fallback in getCacheValue
const getCacheValueOld = `export async function getCacheValue(key: string) {
	if (upstashRedisClient && upstashRedisClient2) {
		const p1 = upstashRedisClient.get(key).then((v: unknown) => {
			if (v == null) throw new Error('not found');
			return typeof v === 'string' ? v : JSON.stringify(v);
		});
		const p2 = upstashRedisClient2.get(key).then((v: unknown) => {
			if (v == null) throw new Error('not found');
			return typeof v === 'string' ? v : JSON.stringify(v);
		});

		try {
			const rawValue = await new Promise((resolve, reject) => {
				let rejectedCount = 0;
				const handleReject = () => {
					rejectedCount++;
					if (rejectedCount === 2) reject(new Error('both failed'));
				};
				p1.then(resolve).catch(handleReject);
				p2.then(resolve).catch(handleReject);
			});
			return decompressPayload(rawValue as string);
		} catch (e) {
			return null;
		}
	}

	let rawValue: any = null;
	if (upstashRedisClient) {
		try {
			const value = await upstashRedisClient.get(key);
			if (value != null) {
				rawValue = typeof value === 'string' ? value : JSON.stringify(value);
			}
		} catch (e) {
			console.warn('Primary redis read failed', formatErrorMessage(e));
		}
	} else if (!upstashRedisClient2) {
		const client = await getRedisClient();
		if (client) {
			try {
				rawValue = await client.get(key);
			} catch (e) {
				console.warn('Native redis read failed', formatErrorMessage(e));
			}
		}
	}

	if (rawValue == null && upstashRedisClient2) {
		try {
			const value = await upstashRedisClient2.get(key);
			if (value != null) {
				rawValue = typeof value === 'string' ? value : JSON.stringify(value);
			}
		} catch (e) {
			console.warn('Secondary redis read failed', formatErrorMessage(e));
		}
	}

	if (rawValue == null) return null;
	return decompressPayload(rawValue);
}`;

const getCacheValueNew = `export async function getCacheValue(key: string) {
	let rawValue: any = null;
	if (upstashRedisClient) {
		try {
			const value = await upstashRedisClient.get(key);
			if (value != null) {
				rawValue = typeof value === 'string' ? value : JSON.stringify(value);
			}
		} catch (e) {
			console.warn('Redis read failed', formatErrorMessage(e));
		}
	} else {
		const client = await getRedisClient();
		if (client) {
			try {
				rawValue = await client.get(key);
			} catch (e) {
				console.warn('Native redis read failed', formatErrorMessage(e));
			}
		}
	}

	if (rawValue == null) return null;
	return decompressPayload(rawValue);
}`;

code = code.replace(getCacheValueOld, getCacheValueNew);

// Find and replace loop that iterates through clients
code = code.replace(/for \(const client of \[upstashRedisClient, upstashRedisClient2\]\) \{/g, 'for (const client of [upstashRedisClient]) {');

// Remove other references to upstashRedisClient2
code = code.replace(/else if \(\!upstashRedisClient2\)/g, 'else');
code = code.replace(/if \(\!\(upstashRedisClient \|\| upstashRedisClient2 \|\| redisClient\)\)/g, 'if (!(upstashRedisClient || redisClient))');
code = code.replace(/if \(redisClient \|\| upstashRedisClient \|\| upstashRedisClient2\)/g, 'if (redisClient || upstashRedisClient)');

// Ensure writableUpstashClient uses getRedisClientInstance
code = code.replace(/import \{ getReadOnlyRedisClientInstance \} from '\.\.\/\.\.\/src\/lib\/redisClient';/g, 'import { getReadOnlyRedisClientInstance, getRedisClientInstance } from \'../../src/lib/redisClient\';');

const setCacheValueOld = `export async function setCacheValue(key: string, value: string, ttlSeconds?: number) {
	if (!ALLOW_REDIS_WRITES) {
		console.warn('setCacheValue called but writes are disabled');
		return;
	}
	let successCount = 0;
	if (writableUpstashClient || writableUpstashClient2) {
		for (const client of [writableUpstashClient, writableUpstashClient2]) {
			if (!client) continue;
			try {
				if (ttlSeconds) {
					await client.setex(key, ttlSeconds, value);
				} else {
					await client.set(key, value);
				}
				successCount++;
			} catch (e) {
				console.warn('Redis write failed', formatErrorMessage(e));
			}
		}
		if (successCount > 0) return;
	}`;

const setCacheValueNew = `export async function setCacheValue(key: string, value: string, ttlSeconds?: number) {
	if (!ALLOW_REDIS_WRITES) {
		console.warn('setCacheValue called but writes are disabled');
		return;
	}
	
	// Use the unified getRedisClientInstance for dual-write load balancing
	const client = getRedisClientInstance();
	if (client) {
		try {
			if (ttlSeconds) {
				await client.setex(key, ttlSeconds, value);
			} else {
				await client.set(key, value);
			}
			return;
		} catch (e) {
			console.warn('Redis write failed', formatErrorMessage(e));
		}
	}`;

code = code.replace(setCacheValueOld, setCacheValueNew);

fs.writeFileSync('pages/api/_lib.ts', code);
