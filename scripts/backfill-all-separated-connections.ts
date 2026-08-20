require('dotenv').config({ path: '.env.local' });
const { createClient } = require('redis');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchWithRetry(url, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
            if (!res.ok) {
                if (res.status === 429 || res.status === 403) {
                    console.log(`[Rate Limit] 429 on ${url}, sleeping 30s...`);
                    await delay(30000);
                    continue;
                }
                throw new Error(`HTTP ${res.status}`);
            }
            return await res.json();
        } catch (err) {
            if (i === retries - 1) throw err;
            await delay(5000);
        }
    }
}

async function fetchAllEmployees(firmCrd, source) {
    let start = 0;
    const nrows = 50;
    const allHits = [];
    
    while (true) {
        const baseUrl = source === 'finra' 
            ? `https://api.brokercheck.finra.org/search/individual?firm=${firmCrd}&includePrevious=true&wt=json`
            : `https://api.adviserinfo.sec.gov/search/individual?firm=${firmCrd}&includePrevious=true&wt=json`;
        
        const url = `${baseUrl}&start=${start}&nrows=${nrows}`;
        const data = await fetchWithRetry(url).catch(() => null);
        
        if (!data?.hits?.hits || data.hits.hits.length === 0) break;
        allHits.push(...data.hits.hits);
        start += nrows;
        
        if (allHits.length >= (data.hits.total || 0) || allHits.length >= 3000) break;
        await delay(300);
    }
    return allHits;
}

async function run() {
    const client = createClient({ url: 'redis://127.0.0.1:6379' });
    await client.connect();
    
    console.log("Discovering all firm CRDs in local database...");
    const firmCrds = new Set();
    
    const finraKeys = await client.keys('finra:firm:*');
    for (const rawKey of finraKeys) {
        const key = String(rawKey);
        if (!key.includes(':connections')) {
            const crd = key.split(':')[2];
            if (crd) firmCrds.add(crd);
        }
    }
    
    const secKeys = await client.keys('sec:firm:*');
    for (const rawKey of secKeys) {
        const key = String(rawKey);
        if (!key.includes(':connections')) {
            const crd = key.split(':')[2];
            if (crd) firmCrds.add(crd);
        }
    }
    
    const crds = Array.from(firmCrds);
    console.log(`Found ${crds.length} unique firm CRDs. Beginning extraction...`);
    
    let processed = 0;
    for (const crd of crds) {
        processed++;
        const finraKey = `finra:firm:${crd}:connections`;
        const secKey = `sec:firm:${crd}:connections`;
        
        try {
            const finraExists = await client.exists(finraKey);
            const secExists = await client.exists(secKey);
            
            if (finraExists && secExists) {
                continue;
            }

            if (!finraExists) {
                const finraHits = await fetchAllEmployees(crd, 'finra');
                if (finraHits.length > 0) {
                    await client.set(finraKey, JSON.stringify(finraHits));
                }
            }

            if (!secExists) {
                const secHits = await fetchAllEmployees(crd, 'sec');
                if (secHits.length > 0) {
                    await client.set(secKey, JSON.stringify(secHits));
                }
            }
            
            console.log(`[${processed}/${crds.length}] Processed connections for Firm ${crd}`);
            await delay(1200);
        } catch (err) {
            console.error(`Error processing firm ${crd}:`, err.message);
        }
    }
    
    console.log("Finished generating all separated connections!");
    await client.quit();
    process.exit(0);
}

run().catch(console.error);
