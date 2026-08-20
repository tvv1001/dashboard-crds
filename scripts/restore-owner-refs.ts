require('dotenv').config({ path: '.env.local' });
import { getOwnerReferenceIndex } from '../pages/api/_graphIndex';
const { createClient } = require('redis');

async function run() {
    const client = createClient({ url: 'redis://127.0.0.1:6379' });
    await client.connect();

    console.log("Loading owner reference index in memory (this scans all firm files)...");
    const index = await getOwnerReferenceIndex();
    console.log(`Found ${index.size} total owner references in the firm payloads.`);

    let restored = 0;
    for (const [crd, ref] of index.entries()) {
        const key = `owner-ref:individual:${crd}`;
        await client.set(key, JSON.stringify(ref));
        restored++;
    }
    
    console.log(`Restored ${restored} ghost/orphan individual records into Redis!`);
    await client.quit();
}

run().catch(console.error);
