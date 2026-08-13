import { listSavedKeysWithStats, loadSavedPayload } from './pages/api/_lib';
import fs from 'fs/promises';

function extractNameAndSec(payload: any, type: string) {
    let name = 'Unknown';
    let secNumber = '';

    const getProp = (obj: any, keys: string[]) => {
        if (!obj || typeof obj !== 'object') return null;
        for (const k of keys) {
            if (obj[k]) return obj[k];
        }
        return null;
    };

    if (payload && typeof payload === 'object') {
        const root = payload.finraBrokerCheck || payload.secInvestmentAdvisor || payload.bccontent || payload.iacontent || payload.content || payload;
        const basicInfo = root.basicInformation || {};
        
        if (type === 'firm') {
            name = getProp(basicInfo, ['firmName', 'legalName', 'name']) || name;
            secNumber = getProp(root, ['secNumber', 'sec_number']) || getProp(basicInfo, ['secNumber', 'sec_number']) || '';
        } else {
            const firstName = getProp(basicInfo, ['firstName']) || '';
            const middleName = getProp(basicInfo, ['middleName']) || '';
            const lastName = getProp(basicInfo, ['lastName']) || '';
            if (firstName || lastName) {
                name = `${firstName} ${middleName} ${lastName}`.replace(/\s+/g, ' ').trim();
            }
        }
    }
    
    // Clean up SEC number
    if (secNumber) {
        secNumber = String(secNumber).replace(/^0+/, ''); // strip leading zeros
    }

    return { name, secNumber };
}

async function main() {
    console.log("Fetching keys...");
    const { keys } = await listSavedKeysWithStats({ limit: 0, sort: 'crd-asc' });
    
    const results = {
        individuals: new Map<string, { years: Set<number>, name: string }>(),
        firms: new Map<string, { years: Set<number>, name: string, secNumber: string }>()
    };
    
    for (const entry of keys) {
        try {
            const raw = await loadSavedPayload(entry.key);
            if (!raw) continue;
            
            const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
            const regex = /\b(18\d{2}|19[0-6]\d|197[0-5])\b/g;
            
            let match;
            let years = new Set<number>();
            while ((match = regex.exec(text)) !== null) {
                years.add(parseInt(match[1], 10));
            }
            
            if (years.size > 0) {
                const parsedPayload = typeof raw === 'string' ? JSON.parse(raw) : raw;
                const { name, secNumber } = extractNameAndSec(parsedPayload, entry.type);
                
                // Fallback to displayName from index if extraction fails
                const finalName = (name === 'Unknown' && entry.displayName) ? entry.displayName : name;
                
                if (entry.type === 'individual') {
                    if (!results.individuals.has(entry.crd)) {
                        results.individuals.set(entry.crd, { years: new Set(), name: finalName });
                    }
                    years.forEach(y => results.individuals.get(entry.crd)!.years.add(y));
                    if (finalName !== 'Unknown') results.individuals.get(entry.crd)!.name = finalName;
                } else if (entry.type === 'firm') {
                    if (!results.firms.has(entry.crd)) {
                        results.firms.set(entry.crd, { years: new Set(), name: finalName, secNumber: '' });
                    }
                    years.forEach(y => results.firms.get(entry.crd)!.years.add(y));
                    if (finalName !== 'Unknown') results.firms.get(entry.crd)!.name = finalName;
                    if (secNumber) results.firms.get(entry.crd)!.secNumber = secNumber;
                }
            }
        } catch (e) {
            // ignore
        }
    }
    
    const sortByEarliest = (a: any, b: any) => Math.min(...Array.from(a[1].years as Set<number>)) - Math.min(...Array.from(b[1].years as Set<number>));
    
    const sortedFirms = Array.from(results.firms.entries()).sort(sortByEarliest);
    const sortedIndividuals = Array.from(results.individuals.entries()).sort(sortByEarliest);
    
    let markdown = `# CRDs Established or Registered in 1975 or Earlier (Formatted)\n\n`;
    
    for (const [crd, data] of sortedFirms) {
        const secStr = data.secNumber ? ` / SEC# ${data.secNumber}` : '';
        markdown += `${data.name.toUpperCase()} :: CRD# ${crd}${secStr}\n`;
    }
    
    for (const [crd, data] of sortedIndividuals) {
        // Individual names should be title cased or however they are, but the example has Title Case
        markdown += `${data.name} :: CRD# ${crd}\n`;
    }
    
    await fs.writeFile('old-crds-formatted.md', markdown);
    console.log("Wrote formatted report to old-crds-formatted.md");
}

main().catch(console.error);
