import { config } from 'dotenv';
config({ path: '.env.local' });
import { Redis } from '@upstash/redis';

async function run() {
    const redis = new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL || '',
        token: process.env.UPSTASH_REDIS_REST_TOKEN || ''
    });

    console.log("Scanning Upstash Redis keys...");
    const prefixCounts = new Map<string, number>();
    
    let cursor = '0';
    let totalScanned = 0;
    const MAX_SCANS = 50;
    let scanCount = 0;

    do {
        const [nextCursor, keys] = await redis.scan(cursor, { count: 1000 });
        cursor = nextCursor;
        
        for (const key of keys) {
            let prefix = key.split(':')[0];
            if (['finra', 'sec', 'graph', 'crd'].includes(prefix)) {
                const parts = key.split(':');
                if (parts.length > 2) {
                    prefix = `${parts[0]}:${parts[1]}`;
                    if (key.includes('_brokers:connected')) prefix += ':_brokers:connected';
                    else if (key.includes('_brokers:previous')) prefix += ':_brokers:previous';
                    else if (parts.length > 2 && ['v9', 'v10', 'v1', 'v2', 'v3'].includes(parts[2])) {
                        prefix = `${parts[0]}:${parts[1]}:${parts[2]}`;
                    }
                }
            }
            prefixCounts.set(prefix, (prefixCounts.get(prefix) || 0) + 1);
            totalScanned++;
        }
        
        scanCount++;
    } while (cursor !== '0' && scanCount < MAX_SCANS);

    console.log(`\nScanned ${totalScanned} keys. Unique prefix patterns:`);
    const sorted = Array.from(prefixCounts.entries()).sort((a, b) => b[1] - a[1]);
    for (const [prefix, count] of sorted) {
        console.log(`${prefix.padEnd(40)} : ${count}`);
    }
}
run();
