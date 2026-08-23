import { createClient } from 'redis';
async function run() {
  const client = createClient({ url: 'redis://127.0.0.1:6379' });
  await client.connect();
  const val = await client.get('finra:firm:10111');
  if (val) console.log('finra val prefix:', val.slice(0, 150));
  await client.disconnect();
}
run();
