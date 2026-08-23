import { createClient } from 'redis';
async function run() {
  const client = createClient({ url: 'redis://127.0.0.1:6379' });
  await client.connect();
  const keys = await client.keys('sec:firm*');
  
  const baseKeys = new Set(keys.filter(k => /^sec:firm:\d+$/.test(k)));
  const previousKeys = keys.filter(k => k.endsWith('_brokers:previous'));
  
  const orphaned = [];
  for (const pk of previousKeys) {
    const match = pk.match(/^sec:firm:(\d+)_brokers:previous$/);
    if (match) {
      const crd = match[1];
      if (!baseKeys.has(`sec:firm:${crd}`)) {
        orphaned.push(pk);
      }
    }
  }
  
  console.log('Total previous keys:', previousKeys.length);
  console.log('Total base keys:', baseKeys.size);
  console.log('Orphaned previous keys (missing base key):', orphaned.length);
  if (orphaned.length > 0) {
    console.log('Sample orphans:', orphaned.slice(0, 10));
  }
  
  await client.disconnect();
}
run();
