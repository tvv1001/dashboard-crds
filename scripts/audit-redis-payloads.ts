#!/usr/bin/env node
import { createClient } from 'redis';
import { Redis as UpstashRedis } from '@upstash/redis';
import { buildEndpoint, hasBlockingIndicators, isEmptyPayload, isNonActionableSavedDetail, normalizeRawPayload, removeSavedPayload } from '../pages/api/_lib';

const redisUrl = process.env.REDIS_URL;
const redisPassword = process.env.REDIS_PASSWORD;
const upstashRedisRestUrl = process.env.UPSTASH_REDIS_REST_URL;
const upstashRedisRestToken = process.env.UPSTASH_REDIS_REST_TOKEN;
const upstashRedisClient = upstashRedisRestUrl && upstashRedisRestToken ? new UpstashRedis({ url: upstashRedisRestUrl, token: upstashRedisRestToken }) : null;
const redisClient = redisUrl ? createClient({ url: redisUrl, password: redisPassword }) : null;

async function getRedisClient() {
	if (!redisClient) return null;
	if (!redisClient.isOpen) {
		await redisClient.connect();
	}
	return redisClient;
}

async function getCacheValue(key: string) {
	if (upstashRedisClient) {
		const value = await upstashRedisClient.get(key);
		return (
			value == null ? null
			: typeof value === 'string' ? value
			: JSON.stringify(value)
		);
	}
	const client = await getRedisClient();
	return client ? client.get(key) : null;
}

async function scanKeysByPatterns(patterns: string[]) {
	const normalizedPatterns = Array.from(new Set(patterns.filter(Boolean)));
	const keys = new Set<string>();
	if (upstashRedisClient) {
		for (const pattern of normalizedPatterns) {
			let cursor = '0';
			do {
				const [nextCursor, batch] = await upstashRedisClient.scan(cursor, { match: pattern, count: 1000 });
				for (const key of batch || []) keys.add(String(key));
				cursor = String(nextCursor || '0');
			} while (cursor !== '0');
		}
		return Array.from(keys);
	}
	const client = await getRedisClient();
	if (!client) return [];
	for (const pattern of normalizedPatterns) {
		for await (const key of client.scanIterator({ MATCH: pattern, COUNT: 1000 })) {
			keys.add(String(key));
		}
	}
	return Array.from(keys);
}

function parseSavedRawKey(rawKey: string) {
	const match = String(rawKey || '')
		.trim()
		.match(/^(finra|sec):(individual|firm):(\d+)$/i);
	if (!match) return null;
	return { source: match[1].toLowerCase(), type: match[2].toLowerCase(), crd: match[3] };
}

function classifyPayload(payload: unknown, parsed: ReturnType<typeof parseSavedRawKey> | null) {
	if (payload == null) return 'empty';
	if (typeof payload === 'string') {
		const trimmed = payload.trim();
		if (!trimmed) return 'empty-string';
		return 'string';
	}
	if (Array.isArray(payload)) return 'array';
	if (typeof payload !== 'object') return 'primitive';
	if (isEmptyPayload(payload)) return 'empty-object';
	if (hasBlockingIndicators(payload)) return 'blocked';

	const normalized = normalizeRawPayload(payload);
	if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) {
		return 'non-object';
	}
	if (parsed) {
		const endpoint = buildEndpoint({ source: parsed.source, type: parsed.type, crd: parsed.crd });
		if (!endpoint) return 'invalid-endpoint';
	}
	if (isNonActionableSavedDetail(`$${parsed?.source || 'unknown'}:${parsed?.type || 'unknown'}:${parsed?.crd || '0'}`, normalized)) {
		return 'non-actionable-stub';
	}
	const keys = Object.keys(normalized as Record<string, unknown>).map((key) => key.toLowerCase());
	const hasDetailSignals = keys.some(
		(key) => key.includes('basic') || key.includes('employment') || key.includes('registration') || key.includes('firm') || key.includes('individual'),
	);
	if (!hasDetailSignals) return 'unknown-shape';
	return 'valid';
}

async function main() {
	const cleanup = process.argv.includes('--cleanup');
	const keys = await scanKeysByPatterns(['finra:individual:*', 'finra:firm:*', 'sec:individual:*', 'sec:firm:*']);
	const parsedKeys = keys.map((key) => ({ key, parsed: parseSavedRawKey(key) })).filter((item) => item.parsed);
	const summary = { total: parsedKeys.length, valid: 0, invalid: 0, byClass: {} as Record<string, number> };
	const invalidKeys: string[] = [];

	for (const item of parsedKeys) {
		const rawValue = await getCacheValue(item.key);
		if (rawValue == null) {
			summary.invalid += 1;
			invalidKeys.push(`${item.key} => missing-value`);
			continue;
		}
		let payload: unknown = rawValue;
		try {
			payload = JSON.parse(rawValue);
		} catch {
			payload = rawValue;
		}
		const classification = classifyPayload(payload, item.parsed);
		summary.byClass[classification] = (summary.byClass[classification] || 0) + 1;
		if (classification !== 'valid') {
			summary.invalid += 1;
			invalidKeys.push(`${item.key} => ${classification}`);
			if (cleanup) {
				try {
					await removeSavedPayload(item.key);
				} catch (error) {
					console.warn(`Failed to remove ${item.key}:`, error);
				}
			}
		} else {
			summary.valid += 1;
		}
	}

	console.log(JSON.stringify({ cleanup, summary, invalidKeys: invalidKeys.slice(0, 200) }, null, 2));
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
