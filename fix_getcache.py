import re

with open('pages/api/_lib.ts', 'r') as f:
    content = f.read()

old_get = """export async function getCacheValue(key: string) {
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
}"""

new_get = """export async function getCacheValue(key: string) {
	if (upstashRedisClient && upstashRedisClient2) {
		const p1 = upstashRedisClient.get(key).then(v => {
			if (v == null) throw new Error("not found");
			return typeof v === 'string' ? v : JSON.stringify(v);
		});
		const p2 = upstashRedisClient2.get(key).then(v => {
			if (v == null) throw new Error("not found");
			return typeof v === 'string' ? v : JSON.stringify(v);
		});
		
		try {
			const rawValue = await Promise.any([p1, p2]);
			return decompressPayload(rawValue);
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
}"""

content = content.replace(old_get, new_get)

with open('pages/api/_lib.ts', 'w') as f:
    f.write(content)
