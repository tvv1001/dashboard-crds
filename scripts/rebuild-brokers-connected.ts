require('dotenv').config({ path: '.env.local' });
const { createClient } = require('redis');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchWithRetry(url, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
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
    
    console.log("Cleaning up old :connections folders and collecting CRDs...");
    
    // First, let's get all firm CRDs from the database just to be safe
    const firmCrds = new Set();
    const finraKeys = await client.keys('finra:firm:*');
    for (const rawKey of finraKeys) {
        const key = String(rawKey);
        if (!key.includes(':connections') && !key.includes('_brokers:')) {
            const crd = key.split(':')[2];
            if (crd) firmCrds.add(crd);
        }
    }
    const secKeys = await client.keys('sec:firm:*');
    for (const rawKey of secKeys) {
        const key = String(rawKey);
        if (!key.includes(':connections') && !key.includes('_brokers:')) {
            const crd = key.split(':')[2];
            if (crd) firmCrds.add(crd);
        }
    }
    
    const crds = Array.from(firmCrds);
    console.log(`Found ${crds.length} unique firm CRDs.`);
    
    let processed = 0;
    for (const crd of crds) {
        processed++;
        
        // Clean up old ones
        await client.del(`finra:firm:${crd}:connections`);
        await client.del(`sec:firm:${crd}:connections`);
        
        // Resumability check for new schema
        const hasFinraNew = await client.exists(`finra:firm:${crd}_brokers:connected`);
        const hasSecNew = await client.exists(`sec:firm:${crd}_brokers:connected`);
        
        if (hasFinraNew && hasSecNew) {
            continue;
        }

        try {
            if (!hasFinraNew) {
                const finraHits = await fetchAllEmployees(crd, 'finra');
                if (finraHits.length > 0) {
                    const connected = new Set();
                    const previous = new Set();
                    finraHits.forEach(hit => {
                        const source = hit._source;
                        if (!source) return;
                        const indCrd = source.ind_source_id;
                        if (!indCrd) return;
                        
                        const curEmps = source.ind_current_employments || [];
                        const isCurrentlyHere = curEmps.some(emp => String(emp.firm_id) === String(crd));
                        if (isCurrentlyHere) {
                            connected.add(String(indCrd));
                        } else {
                            previous.add(String(indCrd));
                        }
                    });
                    
                    if (connected.size > 0) await client.set(`finra:firm:${crd}_brokers:connected`, JSON.stringify(Array.from(connected)));
                    if (previous.size > 0) await client.set(`finra:firm:${crd}_brokers:previous`, JSON.stringify(Array.from(previous)));
                }
            }

            if (!hasSecNew) {
                const secHits = await fetchAllEmployees(crd, 'sec');
                if (secHits.length > 0) {
                    const connected = new Set();
                    const previous = new Set();
                    secHits.forEach(hit => {
                        const source = hit._source;
                        if (!source) return;
                        const indCrd = source.ind_source_id;
                        if (!indCrd) return;
                        
                        const curEmps = source.ind_current_employments || [];
                        const isCurrentlyHere = curEmps.some(emp => String(emp.firm_id) === String(crd));
                        if (isCurrentlyHere) {
                            connected.add(String(indCrd));
                        } else {
                            previous.add(String(indCrd));
                        }
                    });
                    
                    if (connected.size > 0) await client.set(`sec:firm:${crd}_brokers:connected`, JSON.stringify(Array.from(connected)));
                    if (previous.size > 0) await client.set(`sec:firm:${crd}_brokers:previous`, JSON.stringify(Array.from(previous)));
                }
            }
            
            console.log(`[${processed}/${crds.length}] Processed firm ${crd}`);
            await delay(1200);
        } catch (err) {
            console.error(`Error processing firm ${crd}:`, err.message);
        }
    }
    
    // Safety purge of any trailing connections keys just in case
    const badKeys = await client.keys('*:connections');
    if (badKeys.length > 0) {
        await client.del(badKeys);
    }
    
    console.log("Finished generating separated brokers connected/previous!");
    await client.quit();
    process.exit(0);
}

run().catch(console.error);
