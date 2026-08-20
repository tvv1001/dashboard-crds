import { promises as fs } from 'fs';
import { getRedisClient } from '../pages/api/_lib';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchWithRetry(url: string, retries = 3): Promise<any> {
    for (let i = 0; i < retries; i++) {
        try {
            const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
            if (!res.ok) {
                if (res.status === 429 || res.status === 403) {
                    console.log(`Rate limited on ${url}, waiting 10s...`);
                    await delay(10000);
                    continue;
                }
                throw new Error(`HTTP ${res.status}`);
            }
            return await res.json();
        } catch (err) {
            if (i === retries - 1) throw err;
            await delay(2000);
        }
    }
}

async function fetchAllEmployees(firmCrd: string, source: 'finra'|'sec') {
    let start = 0;
    const nrows = 50;
    const allHits: any[] = [];
    
    while (true) {
        const baseUrl = source === 'finra' 
            ? `https://api.brokercheck.finra.org/search/individual?firm=${firmCrd}&includePrevious=true&wt=json`
            : `https://api.adviserinfo.sec.gov/search/individual?firm=${firmCrd}&includePrevious=true&wt=json`;
        
        const url = `${baseUrl}&start=${start}&nrows=${nrows}`;
        const data = await fetchWithRetry(url).catch(() => null);
        
        if (!data?.hits?.hits || data.hits.hits.length === 0) break;
        
        allHits.push(...data.hits.hits);
        start += nrows;
        
        // If we fetched everything, or safety cap at 1000 to avoid infinite loops during backfill
        if (allHits.length >= (data.hits.total || 0) || allHits.length > 2000) break;
        await delay(500); // respect rate limits between pages
    }
    return allHits;
}

async function run() {
    const client = await getRedisClient();
    if (!client) throw new Error("No redis client");
    
    console.log("Fetching all firm CRDs...");
    const firmCrds = new Set<string>();
    for await (const key of client.scanIterator({ MATCH: 'finra:firm:*', COUNT: 1000 })) {
        firmCrds.add(String(key).split(':')[2]);
    }
    for await (const key of client.scanIterator({ MATCH: 'sec:firm:*', COUNT: 1000 })) {
        firmCrds.add(String(key).split(':')[2]);
    }
    
    const crds = Array.from(firmCrds);
    console.log(`Found ${crds.length} firm CRDs. Processing...`);
    
    for (let i = 0; i < crds.length; i++) {
        const crd = crds[i];
        try {
            const current: any[] = [];
            const finraHits = await fetchAllEmployees(crd, 'finra');
            const secHits = await fetchAllEmployees(crd, 'sec');
            
            const processedIds = new Set<string>();
            
            const processHit = (hit: any) => {
                const info = hit._source?.basicInformation || {};
                const id = info.individualId;
                if (!id || processedIds.has(String(id))) return;
                
                processedIds.add(String(id));
                const name = `${info.firstName || ''} ${info.lastName || ''}`.trim();
                current.push({
                    individualId: String(id),
                    name: name || String(id),
                    relationship: "Firm Employee",
                    isCurrent: true
                });
            };
            
            finraHits.forEach(processHit);
            secHits.forEach(processHit);
            
            if (current.length > 0) {
                const payload = { currentConnections: current, previousConnections: [] };
                await client.set(`graph:firm-connections:v10:${crd}`, JSON.stringify(payload));
                console.log(`[${i+1}/${crds.length}] Saved firm ${crd}: ${current.length} employees`);
            } else {
                console.log(`[${i+1}/${crds.length}] Firm ${crd} has no employees in search.`);
            }
            
            await delay(1000); // Wait 1 second between firms to prevent FINRA IP ban
        } catch (err) {
            console.error(`Error processing ${crd}:`, err);
        }
    }
    console.log("Finished all firms.");
    process.exit(0);
}

run().catch(console.error);
