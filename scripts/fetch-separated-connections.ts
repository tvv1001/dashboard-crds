const { createClient } = require('redis');

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchWithRetry(url: string, retries = 3): Promise<any> {
    for (let i = 0; i < retries; i++) {
        try {
            const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
            if (!res.ok) {
                if (res.status === 429 || res.status === 403) {
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
        
        if (allHits.length >= (data.hits.total || 0) || allHits.length > 2000) break;
        await delay(500);
    }
    return allHits;
}

async function run() {
    const client = createClient({ url: 'redis://127.0.0.1:6379' });
    await client.connect();
    
    const crdsToProcess = ['10299', '10111'];
    console.log(`Processing sample CRDs: ${crdsToProcess.join(', ')}...`);
    
    for (const crd of crdsToProcess) {
        try {
            const finraHits = await fetchAllEmployees(crd, 'finra');
            if (finraHits.length > 0) {
                const finraKey = `finra:firm:${crd}:connections`;
                await client.set(finraKey, JSON.stringify(finraHits));
                console.log(`Saved ${finraHits.length} employees to ${finraKey}`);
            }

            const secHits = await fetchAllEmployees(crd, 'sec');
            if (secHits.length > 0) {
                const secKey = `sec:firm:${crd}:connections`;
                await client.set(secKey, JSON.stringify(secHits));
                console.log(`Saved ${secHits.length} employees to ${secKey}`);
            }
            await delay(1000);
        } catch (err) {
            console.error(`Error processing ${crd}:`, err);
        }
    }
    console.log("Finished generating separated connections.");
    process.exit(0);
}

run().catch(console.error);
