import { createClient } from 'redis';
async function run() {
  const client = createClient({ url: 'redis://127.0.0.1:6379' });
  await client.connect();
  const keys = await client.keys('*4349172*');
  console.log('Keys:', keys);
  process.exit(0);
}
run();
