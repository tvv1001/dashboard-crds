const { createClient } = require('redis');

const UPSTASH_URL = "https://awake-dodo-113930.upstash.io";
const UPSTASH_TOKEN = "gQAAAAAAAb0KAAIgcDJhZGVhMTc2OTYxYzc0ZWEzYmZlYzBjZGJmOTM1ZGE0OA";

async function upstashReq(cmd, ...args) {
    const res = await fetch(`${UPSTASH_URL}/${cmd}/${args.map(a => encodeURIComponent(a)).join('/')}`, {
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
    });
    if (!res.ok) throw new Error(`Upstash error: ${res.status} ${res.statusText}`);
    const data = await res.json();
    return data.result;
}

async function run() {
    const localClient = createClient({ url: 'redis://127.0.0.1:6379' });
    await localClient.connect();

    console.log("Fetching keys from prod Upstash...");
    const keys = await upstashReq('keys', 'owner-ref:individual:*');
    console.log(`Found ${keys.length} keys in prod.`);

    let restored = 0;
    for (const key of keys) {
        const val = await upstashReq('get', key);
        if (val) {
            await localClient.set(key, typeof val === 'string' ? val : JSON.stringify(val));
            restored++;
        }
    }

    console.log(`Successfully migrated ${restored} ghost/orphan individual keys to local Redis!`);
    await localClient.quit();
}

run().catch(console.error);
