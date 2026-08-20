const zlib = require('zlib');
const redis = require('redis');

async function run() {
  const client = redis.createClient({ url: 'redis://127.0.0.1:6379' });
  await client.connect();
  const val = await client.get('primed:bundle:finra-individual');
  if (val) {
    const dec = zlib.gunzipSync(Buffer.from(val, 'base64')).toString('utf-8');
    console.log(dec.slice(0, 1000));
  }
  await client.quit();
}
run().catch(console.error);
