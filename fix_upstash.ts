import { getRedisDbSize } from './pages/api/_lib.ts';
import { Redis as UpstashRedis } from '@upstash/redis';
require('dotenv').config({ path: '.env.local' });

async function run() {
  const upstashUrl = process.env.UPSTASH_REDIS_REST_URL;
  const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const client = new UpstashRedis({ url: upstashUrl, token: upstashToken });

  console.log("Backfilling upstash firm...");
  const firmCrds = ["343460", "343368", "342788", "342618", "330235", "325693", "323504", "316226", "307771", "299584", "283942", "282209", "281725", "175233", "173686", "172660", "169716", "168812", "164319", "149678"];
  for (const crd of firmCrds) {
    await client.zadd("dashboard:highest-crds:firm", { score: parseInt(crd, 10), member: crd });
  }

  console.log("Backfilling upstash individual...");
  const indCrds = ["8275841","8156507","7755272","7633992","7564095","7283951","7208494","7131448","7043156","6952689","6938578","6416388","6389152","6305869","6123600","5881078","5831752","5570690","5384169","5333502"];
  for (const crd of indCrds) {
    await client.zadd("dashboard:highest-crds:individual", { score: parseInt(crd, 10), member: crd });
  }
  
  // also remove 3102054
  await client.zrem("dashboard:highest-crds:firm", "3102054");
  console.log("Done.");
}
run().catch(console.error);
