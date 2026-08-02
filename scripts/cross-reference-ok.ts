import { promises as fs } from 'fs';
import path from 'path';

const statesDir = path.resolve(process.cwd(), 'data', 'states');
const rawDir = path.resolve(process.cwd(), 'data', 'raw');

async function crossReference() {
    console.log('Building local name index...');
    const files = (await fs.readdir(rawDir)).filter(f => f.endsWith('.json'));
    const namesToIndex = new Map<string, string[]>(); // name -> crds[]

    for (const file of files) {
        try {
            const raw = await fs.readFile(path.join(rawDir, file), 'utf-8');
            const payload = JSON.parse(raw);
            const content = payload.content || payload; // Some might not have 'content' wrapper if they were normalized
            const bi = content.basicInformation || {};
            const names = new Set<string>();
            
            const first = bi.firstName || '';
            const middle = bi.middleName || '';
            const last = bi.lastName || '';
            const full = [first, middle, last].filter(Boolean).join(' ').toLowerCase();
            if (full) names.add(full);

            if (bi.individualName) names.add(bi.individualName.toLowerCase());
            if (bi.fullName) names.add(bi.fullName.toLowerCase());
            if (bi.firmName) names.add(bi.firmName.toLowerCase());
            if (Array.isArray(bi.otherNames)) {
                bi.otherNames.forEach((n: string) => names.add(n.toLowerCase()));
            }

            const match = file.match(/^(finra|sec):(individual|firm):(\d+)\.json$/i);
            const crd = match ? match[3] : 'unknown';

            for (const name of names) {
                if (name.length < 5) continue; 
                const existing = namesToIndex.get(name) || [];
                if (!existing.includes(crd)) existing.push(crd);
                namesToIndex.set(name, existing);
            }
        } catch (e) {
            continue;
        }
    }

    console.log(`Indexed ${namesToIndex.size} unique names from local cache.`);

    const okProcessedDir = path.join(statesDir, 'oklahoma', 'processed');
    const okFiles = (await fs.readdir(okProcessedDir)).filter(f => f.endsWith('.json'));

    const allMatches = [];

    for (const okFile of okFiles) {
        console.log(`Checking ${okFile}...`);
        const data = JSON.parse(await fs.readFile(path.join(okProcessedDir, okFile), 'utf-8'));
        const text = (data.text || '').toLowerCase();

        for (const [name, crds] of namesToIndex.entries()) {
            // Very simple check: is the name in the text?
            // To be more precise, we could check for word boundaries
            if (text.includes(name)) {
                allMatches.push({
                    name,
                    crds,
                    source: okFile
                });
            }
        }
    }

    console.log(`\n--- Found ${allMatches.length} potential matches in Oklahoma Unclaimed Property lists ---`);
    allMatches.slice(0, 50).forEach(m => {
        console.log(`Match: "${m.name}" (CRDs: ${m.crds.join(', ')}) in ${m.source}`);
    });

    if (allMatches.length > 50) {
        console.log(`... and ${allMatches.length - 50} more.`);
    }

    await fs.writeFile(
        path.join(statesDir, 'oklahoma', 'matches.json'),
        JSON.stringify(allMatches, null, 2)
    );
}

crossReference();
