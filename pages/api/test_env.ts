// Returns only hostnames (never tokens/values) to diagnose which Upstash
// database each env var name currently resolves to, without leaking secrets.
function hostOnly(url: string | undefined) {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return 'unparseable';
  }
}

export default function handler(req: any, res: any) {
  res.status(200).json({
    useLocal: process.env.USE_LOCAL_REDIS,
    redisUrl: process.env.REDIS_URL,
    upstash: {
      URL: hostOnly(process.env.UPSTASH_REDIS_REST_URL),
      URL_MIRROR: hostOnly(process.env.UPSTASH_REDIS_REST_URL_MIRROR),
      URL_2: hostOnly(process.env.UPSTASH_REDIS_REST_URL_2),
      URL_3: hostOnly(process.env.UPSTASH_REDIS_REST_URL_3),
      URL_4: hostOnly(process.env.UPSTASH_REDIS_REST_URL_4),
      CRD_UPSTASH_URL_1: hostOnly(process.env.CRD_UPSTASH_URL_1),
      CRD_UPSTASH_URL_2: hostOnly(process.env.CRD_UPSTASH_URL_2),
    },
  });
}
