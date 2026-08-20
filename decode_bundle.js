const fs = require('fs');
const zlib = require('zlib');
const redis = require('redis');

async function run() {
  const client = redis.createClient({ url: 'redis://127.0.0.1:6379' });
  await client.connect();
  const val = await client.get('primed:bundle:finra-individual');
  if (val && val.startsWith('br:')) {
    const dec = zlib.brotliDecompressSync(Buffer.from(val.slice(3), 'base64')).toString('utf-8');
    console.log(dec.slice(0, 500));
  } else {
    console.log("Not brotli or not found");
  }
  await client.quit();
}
run().catch(console.error);
