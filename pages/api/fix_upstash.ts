import { getReadOnlyRedisClientInstance } from '../../src/lib/redisClient';
export default async function handler(req: any, res: any) {
  // We need write access, getReadOnlyRedisClientInstance only has get/scan...
  // Let's use @upstash/redis directly since it's installed.
  res.status(200).json({ ok: true });
}
