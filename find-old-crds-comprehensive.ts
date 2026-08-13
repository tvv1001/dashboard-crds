import { listSavedKeysWithStats, loadSavedPayload } from './pages/api/_lib';
import fs from 'fs/promises';

async function main() {
    console.log("Fetching keys...");
    const { keys } = await listSavedKeysWithStats({ limit: 0, sort: 'crd-asc' });
    console.log(`Found ${keys.length} keys in Redis. Scanning for ANY year <= 1975...`);
    
    const results = {
        individuals: new Map<string, Set<number>>(),
        firms: new Map<string, Set<number>>()
    };
    
    let processed = 0;
    
    for (const entry of keys) {
        try {
            const raw = await loadSavedPayload(entry.key);
            if (!raw) continue;
            
            const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
            
            // Match any 4 digit year between 1800 and 1975
            const regex = /\b(18\d{2}|19[0-6]\d|197[0-5])\b/g;
            
            let match;
            let years = new Set<number>();
            while ((match = regex.exec(text)) !== null) {
                years.add(parseInt(match[1], 10));
            }
            
            if (years.size > 0) {
                if (entry.type === 'individual') {
                    if (!results.individuals.has(entry.crd)) {
                        results.individuals.set(entry.crd, new Set());
                    }
                    years.forEach(y => results.individuals.get(entry.crd)!.add(y));
                } else if (entry.type === 'firm') {
                    if (!results.firms.has(entry.crd)) {
                        results.firms.set(entry.crd, new Set());
                    }
                    years.forEach(y => results.firms.get(entry.crd)!.add(y));
                }
            }
        } catch (e) {
            // ignore missing payloads
        }
        
        processed++;
        if (processed % 5000 === 0) {
            console.log(`Processed ${processed} keys...`);
        }
    }
    
    // Sort logic
    const sortByEarliest = (a: [string, Set<number>], b: [string, Set<number>]) => {
        const minA = Math.min(...Array.from(a[1]));
        const minB = Math.min(...Array.from(b[1]));
        return minA - minB;
    };
    
    const sortedFirms = Array.from(results.firms.entries()).sort(sortByEarliest);
    const sortedIndividuals = Array.from(results.individuals.entries()).sort(sortByEarliest);
    
    let markdown = `# CRDs Established or Registered in 1975 or Earlier\n\n`;
    
    markdown += `## Individual CRDs (Total: ${sortedIndividuals.length})\n\n`;
    for (const [crd, years] of sortedIndividuals) {
        markdown += `- **CRD #${crd}** — Earliest references: ${Array.from(years).sort().join(', ')}\n`;
    }
    
    markdown += `\n## Firm CRDs (Total: ${sortedFirms.length})\n\n`;
    for (const [crd, years] of sortedFirms) {
        markdown += `- **CRD #${crd}** — Earliest references: ${Array.from(years).sort().join(', ')}\n`;
    }
    
    // Write directly to the artifact directory. 
    // We'll extract this path dynamically or just print it and use the write_to_file tool later?
    // Let's just write to a local file, then the agent can view it or write it to an artifact.
    await fs.writeFile('old-crds-report.md', markdown);
    console.log("Wrote report to old-crds-report.md");
}

main().catch(console.error);
