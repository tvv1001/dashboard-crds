import { createClient } from 'redis';
import { saveRawFile } from '../pages/api/_lib.js';

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
  
  console.log(`Found ${orphanedCrds.length} orphaned sec:firm:*_brokers:previous keys missing their base record.`);
  
  // To avoid hammering the SEC API, we'll only do the first 5 as a test
  // If the user wants to run it for all, they can modify this script.
  const batch = orphanedCrds.slice(0, 5);
  
  for (const crd of batch) {
    console.log(`Hydrating missing base record for SEC firm CRD ${crd}...`);
    try {
      const res = await fetch(`https://api.adviserinfo.sec.gov/search/firm/${crd}?wt=json`);
      if (!res.ok) {
        console.error(`Failed to fetch SEC firm ${crd}: ${res.status}`);
        continue;
      }
      const data = await res.json();
      const hits = data?.hits?.hits;
      if (hits && hits.length > 0) {
        const payload = hits[0]._source;
        // The GEMINI.md says: Source JSON payloads must remain wrapped in their respective source-specific containers: { "secInvestmentAdvisor": { ... } }
        // But for SEC firm, is it secInvestmentAdvisor? 
        // Let's check how the base keys are wrapped.
      }
    } catch (e) {
      console.error(`Error fetching SEC firm ${crd}:`, e);
    }
  }
  
  await client.disconnect();
}
run();
