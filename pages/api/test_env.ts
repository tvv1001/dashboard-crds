export default function handler(req: any, res: any) {
  res.status(200).json({ useLocal: process.env.USE_LOCAL_REDIS, redisUrl: process.env.REDIS_URL });
}
