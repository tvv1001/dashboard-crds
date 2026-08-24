import zlib from 'zlib';
import { createClient } from 'redis';

async function run() {
  const crd = '2614915';
  const bundle = {
    requestedKey: `finra:individual:${crd}`,
    resolvedKey: `finra:individual:${crd}`,
    crd,
    type: 'individual',
    orphan: {
      parentType: 'firm',
      parentCrd: '3487',
      name: 'KILLIAN, JOHN JOSEPH',
      position: 'DIRECTOR'
    },
    sources: {
      finra: {
        key: `finra:individual:${crd}`,
        found: false,
        rawPayload: null,
        payload: null,
        error: 'no live CRD — scraped reference only',
        origin: null,
      },
      sec: {
        key: `sec:individual:${crd}`,
        found: false,
        rawPayload: null,
        payload: null,
        error: 'no live CRD — scraped reference only',
        origin: null,
      },
    },
  };

  const rawKey = `finra:individual:${crd}`;
  const serializedPayload = JSON.stringify(bundle, null, 2);
  const compressed = zlib.brotliCompressSync(Buffer.from(serializedPayload, 'utf-8')).toString('base64');

  const client = createClient({ url: 'redis://127.0.0.1:6379' });
  await client.connect();
  await client.set(rawKey, compressed);
  await client.set(`owner-ref:individual:${crd}`, compressed);

  console.log(`Saved ${rawKey} manually!`);
  await client.disconnect();
}

run().catch(console.error);
