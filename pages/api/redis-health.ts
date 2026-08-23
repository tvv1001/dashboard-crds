import type { NextApiRequest, NextApiResponse } from 'next';
import { checkRedisHealth } from './_lib';

type RedisHealthResponse = {
	ok: boolean;
	configured: boolean;
	mode: 'upstash-rest' | 'redis-url' | 'local-redis' | 'none';
	latencyMs: number | null;
	message: string;
	error?: string;
	timestamp: string;
};

export default async function handler(req: NextApiRequest, res: NextApiResponse<RedisHealthResponse | { error: string }>) {
	if (req.method !== 'GET') {
		res.setHeader('Allow', 'GET');
		return res.status(405).json({ error: 'Method Not Allowed' });
	}

	const status = await checkRedisHealth();
	const httpStatus =
		!status.configured ? 200
		: status.ok ? 200
		: 503;

	return res.status(httpStatus).json({
		...status,
		timestamp: new Date().toISOString(),
	});
}
