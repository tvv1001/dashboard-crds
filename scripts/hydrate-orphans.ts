import { createClient } from 'redis';

async function run() {
  const client = createClient({ url: 'redis://127.0.0.1:6379' });
  await client.connect();
  const keys = await client.keys('sec:firm*');
  
  const baseKeys = new Set(keys.filter(k => /^sec:firm:\d+$/.test(k)));
  const previousKeys = keys.filter(k => k.endsWith('_brokers:previous'));
  
  const orphanedCrds = [];
  for (const pk of previousKeys) {
    const match = pk.match(/^sec:firm:(\d+)_brokers:previous$/);
    if (match) {
      const crd = match[1];
      if (!baseKeys.has(`sec:firm:${crd}`)) {
        orphanedCrds.push(crd);
      }
    }
  }
  
  console.log(`Found ${orphanedCrds.length} orphaned SEC firm CRDs. Starting hydration...`);
  
  let successCount = 0;
  let failCount = 0;
  
  const CONCURRENCY = 10;
  for (let i = 0; i < orphanedCrds.length; i += CONCURRENCY) {
    const batch = orphanedCrds.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (crd) => {
      try {
        const res = await fetch(`https://api.adviserinfo.sec.gov/search/firm/${crd}?wt=json`);
        if (!res.ok) {
          failCount++;
          return;
        }
        const data = await res.json();
        const payload = JSON.stringify(data);
        await client.set(`sec:firm:${crd}`, payload);
        successCount++;
      } catch (e) {
        failCount++;
      }
    }));
    if ((i + CONCURRENCY) % 100 === 0) {
      console.log(`Processed ${i + CONCURRENCY}/${orphanedCrds.length}... (Success: ${successCount}, Fail: ${failCount})`);
    }
  }
  
  console.log(`Finished hydration. Success: ${successCount}, Fail: ${failCount}`);
  await client.disconnect();
}
run();
