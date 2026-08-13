import { listSavedKeysWithStats, loadSavedPayload } from './pages/api/_lib';

async function main() {
    console.log("Fetching keys...");
    const { keys } = await listSavedKeysWithStats({ limit: 0, sort: 'date-desc' });
    console.log(`Found ${keys.length} keys in Redis. Scanning for ANY year <= 1975...`);
    
    let count = 0;
    for (const entry of keys) {
        try {
            const raw = await loadSavedPayload(entry.key);
            if (!raw) continue;
            
            const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
            
            // Match any 4 digit year between 1800 and 1975
            // e.g. "1975" or "1960"
            const regex = /\b(18\d{2}|19[0-6]\d|197[0-5])\b/g;
            
            let match;
            let found = false;
            let years = new Set<string>();
            while ((match = regex.exec(text)) !== null) {
                years.add(match[1]);
            }
            
            if (years.size > 0) {
                console.log(`- [${entry.type.toUpperCase()}] CRD #${entry.crd} has years: ${Array.from(years).join(', ')}`);
                count++;
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
