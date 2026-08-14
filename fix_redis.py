import re

with open('pages/api/_lib.ts', 'r') as f:
    content = f.read()

# Fix setCacheValue
old_set = """export async function setCacheValue(key: string, value: string, ttlSeconds?: number) {
	const finalValue = compressPayload(value);
	const activeUpstash = upstashRedisClient2 || upstashRedisClient;
	if (activeUpstash) {
		if (ttlSeconds && ttlSeconds > 0) {
			await activeUpstash.set(key, finalValue, { ex: Math.floor(ttlSeconds) });
			return;
		}
		await activeUpstash.set(key, finalValue);
		return;
	}"""
new_set = """export async function setCacheValue(key: string, value: string, ttlSeconds?: number) {
	const finalValue = compressPayload(value);
	let handled = false;
	
	if (upstashRedisClient) {
		try {
			if (ttlSeconds && ttlSeconds > 0) {
				await upstashRedisClient.set(key, finalValue, { ex: Math.floor(ttlSeconds) });
			} else {
				await upstashRedisClient.set(key, finalValue);
			}
			handled = true;
		} catch (e) {
			console.warn('Primary redis write failed', formatErrorMessage(e));
		}
	}
	
	if (upstashRedisClient2) {
		try {
			if (ttlSeconds && ttlSeconds > 0) {
				await upstashRedisClient2.set(key, finalValue, { ex: Math.floor(ttlSeconds) });
			} else {
				await upstashRedisClient2.set(key, finalValue);
			}
			handled = true;
		} catch (e) {
			console.warn('Secondary redis write failed', formatErrorMessage(e));
		}
	}
	
	if (handled) return;
"""
content = content.replace(old_set, new_set)

# Fix trackFirmConnections
old_track = """export async function trackFirmConnections(firmIds: string[]) {
	if (!firmIds || firmIds.length === 0) return;
	const key = 'dashboard:collected_firms';
	const activeUpstash = upstashRedisClient2 || upstashRedisClient;
	if (activeUpstash) {
		await activeUpstash.sadd(key, ...(firmIds as [string, ...string[]]));
		return;
	}"""
new_track = """export async function trackFirmConnections(firmIds: string[]) {
	if (!firmIds || firmIds.length === 0) return;
	const key = 'dashboard:collected_firms';
	let handled = false;
	
	if (upstashRedisClient) {
		try {
			await upstashRedisClient.sadd(key, ...(firmIds as [string, ...string[]]));
			handled = true;
		} catch(e) {}
	}
	if (upstashRedisClient2) {
		try {
			await upstashRedisClient2.sadd(key, ...(firmIds as [string, ...string[]]));
			handled = true;
		} catch(e) {}
	}
	
	if (handled) return;"""
content = content.replace(old_track, new_track)

with open('pages/api/_lib.ts', 'w') as f:
    f.write(content)

