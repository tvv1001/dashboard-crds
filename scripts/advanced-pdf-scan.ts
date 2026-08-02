import { promises as fs } from 'fs';
import path from 'path';

const rawDir = path.resolve(process.cwd(), 'data', 'raw');
const okProcessedDir = path.resolve(process.cwd(), 'data', 'states', 'oklahoma', 'processed');

async function advancedScan() {
    console.log('Identifying individuals with disclosures in local cache...');
    const files = (await fs.readdir(rawDir)).filter(f => f.endsWith('.json'));
    const flaggedCrdToNames = new Map<string, string[]>();

    for (const file of files) {
        try {
            const raw = await fs.readFile(path.join(rawDir, file), 'utf-8');
            const payload = JSON.parse(raw);
            const content = payload.finraBrokerCheck || payload.secInvestmentAdvisor || payload.content || payload.iacontent || payload;
            const bi = content.basicInformation || {};

            // Check for disclosures
            const hasDisclosures = content.disclosureFlag === 'Y' || content.iaDisclosureFlag === 'Y' || (content.disclosures && content.disclosures.length > 0);
            
            if (hasDisclosures) {
                const names = new Set<string>();
                const first = bi.firstName || '';
                const last = bi.lastName || '';
                const full = [first, last].filter(Boolean).join(' ').toLowerCase();
                if (full.length > 5) names.add(full);
                if (bi.individualName) names.add(bi.individualName.toLowerCase());

                const match = file.match(/^(finra|sec):(individual|firm):(\d+)\.json$/i);
                const crd = match ? match[3] : 'unknown';
                
                if (names.size > 0) {
                    flaggedCrdToNames.set(crd, Array.from(names));
                }
            }
        } catch (e) {
            continue;
        }
    }

    console.log(`Found ${flaggedCrdToNames.size} individuals with disclosures.`);

    const okFiles = (await fs.readdir(okProcessedDir)).filter(f => f.endsWith('.json'));
    const highValueMatches = [];

    for (const okFile of okFiles) {
        console.log(`Scanning ${okFile} for flagged individuals...`);
        const data = JSON.parse(await fs.readFile(path.join(okProcessedDir, okFile), 'utf-8'));
        const text = (data.text || '').toLowerCase();

        for (const [crd, names] of flaggedCrdToNames.entries()) {
            for (const name of names) {
                if (text.includes(name)) {
                    highValueMatches.push({
                        crd,
                        name,
                        source: okFile,
                        type: 'Disclosed Individual'
                    });
                    break; // Found one name for this CRD in this file
                }
            }
        }
    }

    console.log(`\n--- Advanced Scan Result: ${highValueMatches.length} High-Value Matches Found ---`);
    highValueMatches.forEach(m => {
        console.log(`[ALERT] Disclosed Professional Match: "${m.name}" (CRD: ${m.crd}) in ${m.source}`);
    });

    await fs.writeFile(
        path.resolve(process.cwd(), 'data', 'states', 'oklahoma', 'high_value_matches.json'),
        JSON.stringify(highValueMatches, null, 2)
    );
}

advancedScan();
