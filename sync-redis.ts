import { createClient } from 'redis';
import { Redis as UpstashRedis } from '@upstash/redis';
import fs from 'fs/promises';
import path from 'path';

const upstashClient = new UpstashRedis({ 
    url: "https://awake-dodo-113930.upstash.io", 
    token: "gQAAAAAAAb0KAAIgcDJhZGVhMTc2OTYxYzc0ZWEzYmZlYzBjZGJmOTM1ZGE0OA" 
});
const localClient = createClient({ url: 'redis://127.0.0.1:6379' });

async function main() {
    await localClient.connect();
    
    // Read keys from index
    const indexPath = path.resolve(process.cwd(), 'data', 'derived', 'raw-keys-index.json');
    const indexContent = await fs.readFile(indexPath, 'utf-8');
    const index = JSON.parse(indexContent);
    const entries = index.entries || [];
    
    console.log(`Found ${entries.length} keys in disk index to sync...`);
    
    let synced = 0;
    const batchSize = 100;
    for (let i = 0; i < entries.length; i += batchSize) {
        const batch = entries.slice(i, i + batchSize).map((e: any) => e.key);
        
        try {
            // MGET from Upstash
            const values = await upstashClient.mget(...batch);
            
            // MSET to local
            const msetArgs: string[] = [];
            for (let j = 0; j < batch.length; j++) {
                let val = values[j];
                if (val != null) {
                    // Upstash returns objects if they are valid JSON, but mset expects strings
                    const strVal = typeof val === 'string' ? val : JSON.stringify(val);
                    msetArgs.push(batch[j]);
                    msetArgs.push(strVal);
                }
            }
            
            if (msetArgs.length > 0) {
                await localClient.mSet(msetArgs);
                synced += (msetArgs.length / 2);
            }
            
            if (i % 1000 === 0) {
                console.log(`Progress: Synced ${synced} out of ${i + batch.length}...`);
            }
        } catch (e: any) {
            console.error(`Error in batch ${i}: ${e.message}`);
        }
    }
    
    console.log(`\nSync complete! Synced ${synced} keys to local Redis.`);
    await localClient.quit();
}
main().catch(console.error);
