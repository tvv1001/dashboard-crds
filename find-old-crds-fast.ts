import { listSavedKeysWithStats, loadSavedPayload } from './pages/api/_lib';

async function main() {
    console.log("Fetching keys...");
    const { keys } = await listSavedKeysWithStats({ limit: 0, sort: 'date-desc' });
    console.log(`Found ${keys.length} keys in Redis. Scanning for dates <= 1975...`);
    
    let count = 0;
    for (const entry of keys) {
        try {
            const raw = await loadSavedPayload(entry.key);
            if (!raw) continue;
            
            const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
            
            // Match any Date field containing a year between 1800 and 1975
            // e.g. "registrationBeginDate": "3/24/1975"
            // We use a global match to find all occurrences
            const regex = /"([^"]*Date[^"]*)"\s*:\s*"([^"]*?(18\d{2}|19[0-6]\d|197[0-5])[^"]*?)"/gi;
            
            let match;
            let found = false;
            while ((match = regex.exec(text)) !== null) {
                if (!found) {
                    console.log(`\n- [${entry.type.toUpperCase()}] CRD #${entry.crd}`);
                    found = true;
                    count++;
                }
                console.log(`  -> ${match[1]}: ${match[2]}`);
            }
            
            if (count >= 25) {
                console.log("\nStopping after finding 25 CRDs.");
                break;
            }
        } catch (e) {
            // ignore
        }
    }
    
    if (count === 0) {
        console.log("\nNo CRDs found matching the criteria in Redis.");
    }
}

main().catch(console.error);
