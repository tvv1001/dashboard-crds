import { Redis as UpstashRedis } from '@upstash/redis';
require('dotenv').config({ path: '.env.local' });

async function run() {
  const upstashUrl = process.env.UPSTASH_REDIS_REST_URL;
  const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const client = new UpstashRedis({ url: upstashUrl, token: upstashToken });

  const keys = await client.keys("dashboard:*");
  const used = ["dashboard:highest-crds:firm", "dashboard:highest-crds:individual", "dashboard:new-crds-state", "dashboard:cached-crd-count"];
  const unused = keys.filter(k => !used.includes(k) && !k.includes("global-graph") && !k.includes("crd-name-snapshot"));
  
  if (unused.length > 0) {
    console.log("Unused on Upstash:", unused);
    await client.del(...unused);
  } else {
    console.log("No unused found.");
  }
}
run().catch(console.error);
