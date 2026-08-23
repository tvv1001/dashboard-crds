import { createClient } from 'redis';
import fs from 'fs';
import path from 'path';

// Define minimal required structures
interface LocalSearchEntry {
	crd: string;
	type: 'individual' | 'firm';
	name: string;
	aliases: string[];
	source: 'finra' | 'sec' | 'finra,sec';
	secNumber: string;
	currentAddress: string;
	searchableNames: string[];
	searchableValues: string[];
	searchableNameTokens: string[];
	searchText: string;
	currentFirm: string;
	currentCity: string;
	currentState: string;
}

// Re-use logic to parse
function getObject(obj: unknown) {
	return typeof obj === 'object' && obj !== null && !Array.isArray(obj) ? (obj as Record<string, unknown>) : null;
}
function getString(obj: unknown) {
	return typeof obj === 'string' ? obj.trim() : '';
}
function normalizeWhitespace(text: string) {
	return text.replace(/\s+/g, ' ').trim();
}
function normalizeForSearch(text: string | null | undefined) {
	if (!text) return '';
	return text
		.toLowerCase()
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^a-z0-9 ]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function buildIndividualName(basicInfo: any) {
    if (!basicInfo) return '';
    const first = getString(basicInfo.firstName);
    const middle = getString(basicInfo.middleName);
    const last = getString(basicInfo.lastName);
    const suffix = getString(basicInfo.suffix);
    return [first, middle, last, suffix].filter(Boolean).join(' ');
}

function extractNamesFromPayload(payload: any, type: string) {
    const root = getObject(payload);
    const basicInfo = getObject(root?.basicInformation);
    const names = new Set<string>();
    
    if (type === 'individual') {
        const built = buildIndividualName(basicInfo);
        if (built) names.add(built);
        if (basicInfo?.individualName) names.add(getString(basicInfo.individualName));
        if (basicInfo?.fullName) names.add(getString(basicInfo.fullName));
        const otherNames = Array.isArray(basicInfo?.otherNames) ? basicInfo.otherNames : [];
        for (const n of otherNames) {
            names.add(getString(n));
        }
    } else {
        if (root?.businessName) names.add(getString(root.businessName));
        if (basicInfo?.firmName) names.add(getString(basicInfo.firmName));
        if (basicInfo?.businessName) names.add(getString(basicInfo.businessName));
        const otherNames = Array.isArray(basicInfo?.otherNames) ? basicInfo.otherNames : [];
        for (const n of otherNames) {
            names.add(getString(n));
        }
    }
    return Array.from(names).filter(Boolean);
}

function collectSearchableValues(node: any, target: string[], seenValues: Set<string>, seenNodes = new Set<any>()) {
    if (node == null) return;
    if (typeof node === 'string') {
        if (!seenValues.has(node)) {
            seenValues.add(node);
            target.push(node);
        }
        return;
    }
    if (typeof node === 'number') {
        const s = String(node);
        if (!seenValues.has(s)) {
            seenValues.add(s);
            target.push(s);
        }
        return;
    }
    if (typeof node !== 'object' || seenNodes.has(node)) return;
    seenNodes.add(node);

    if (Array.isArray(node)) {
        for (const item of node) collectSearchableValues(item, target, seenValues, seenNodes);
        return;
    }

    for (const value of Object.values(node)) {
        collectSearchableValues(value, target, seenValues, seenNodes);
    }
}

async function main() {
    const client = createClient({ url: process.env.REDIS_URL || 'redis://127.0.0.1:6379' });
    await client.connect();

    console.log("Scanning keys...");
    const keys = [];
    for (const pattern of ['finra:*', 'sec:*']) {
        let cursor = '0';
        do {
            const res = await client.scan(cursor, { MATCH: pattern, COUNT: 1000 });
            cursor = String(res.cursor || '0');
            for (const key of res.keys || []) {
                if (/^(finra|sec):(individual|firm):\d+$/i.test(key)) {
                    keys.push(key);
                }
            }
        } while (cursor !== '0');
    }
    console.log(`Found ${keys.length} valid entity keys.`);

    // Group by CRD
    const groups = new Map();
    for (const key of keys) {
        const match = key.match(/^(finra|sec):(individual|firm):(\d+)$/i);
        if (!match) continue;
        const [, source, type, crd] = match;
        const groupKey = `${type}:${crd}`;
        if (!groups.has(groupKey)) {
            groups.set(groupKey, { type: type.toLowerCase(), crd, files: [], finra: false, sec: false });
        }
        const g = groups.get(groupKey);
        g.files.push(key);
        if (source.toLowerCase() === 'finra') g.finra = true;
        if (source.toLowerCase() === 'sec') g.sec = true;
    }

    const allGroups = Array.from(groups.values());
    console.log(`Grouped into ${allGroups.length} unique entities. Processing...`);

    const rows = [];
    const BATCH = 50;
    for (let i = 0; i < allGroups.length; i += BATCH) {
        const batch = allGroups.slice(i, i + BATCH);
        const batchResults = await Promise.all(batch.map(async (g) => {
            let currentFirm = '';
            let currentCity = '';
            let currentState = '';
            const names = new Set<string>();
            const addresses = new Set<string>();
            const secNumbers = new Set<string>();
            const searchableValues: string[] = [];
            const seenSearchableValues = new Set<string>();

            // Prioritize FINRA
            g.files.sort();
            
            for (const file of g.files) {
                try {
                    const raw = await client.get(file);
                    if (!raw) continue;
                    const parsed = JSON.parse(raw);
                    // normalize payload logic
                    let root = parsed;
                    if (parsed.finraBrokerCheck) root = parsed.finraBrokerCheck;
                    if (parsed.secInvestmentAdvisor) root = parsed.secInvestmentAdvisor;
                    if (parsed.content) root = parsed.content;

                    for (const n of extractNamesFromPayload(root, g.type)) names.add(n);
                    
                    const basic = getObject(root?.basicInformation);
                    if (basic?.bdSECNumber) secNumbers.add(getString(basic.bdSECNumber));
                    if (basic?.iaSECNumber) secNumbers.add(getString(basic.iaSECNumber));

                    collectSearchableValues(root, searchableValues, seenSearchableValues);

                    if (g.type === 'individual') {
                        const emps = [
                            ...(Array.isArray(root?.currentEmployments) ? root.currentEmployments : []),
                            ...(Array.isArray(root?.currentIAEmployments) ? root.currentIAEmployments : [])
                        ];
                        for (const emp of emps) {
                            const empObj = getObject(emp);
                            if (empObj && empObj.firmName) {
                                currentFirm = normalizeWhitespace(getString(empObj.firmName));
                                const locs = Array.isArray(empObj.branchOfficeLocations) ? empObj.branchOfficeLocations : [];
                                const loc = locs.find(l => getObject(l)?.locatedAtFlag === 'Y') || locs[0];
                                if (loc) {
                                    currentCity = getString(getObject(loc)?.city);
                                    currentState = getString(getObject(loc)?.state);
                                } else {
                                    currentCity = getString(empObj.city);
                                    currentState = getString(empObj.state);
                                }
                                break;
                            }
                        }
                    } else {
                        const addr = getObject(root?.mainOfficeAddress) || getObject(root?.mainAddress);
                        if (addr) {
                            currentCity = getString(addr.city);
                            currentState = getString(addr.state);
                            const lines = [addr.street1, addr.street2, addr.city, addr.state, addr.zipCode].map(getString).filter(Boolean);
                            addresses.add(lines.join(', '));
                        }
                        if (basic?.firmName) currentFirm = getString(basic.firmName);
                    }
                } catch (e) {
                    continue;
                }
            }

            const orderedNames = Array.from(names);
            const searchableNameTokens = Array.from(new Set(orderedNames.flatMap(n => normalizeForSearch(n).split(' '))));
            return {
                crd: g.crd,
                type: g.type,
                name: orderedNames[0] || `${g.type} ${g.crd}`,
                aliases: orderedNames.slice(1, 5),
                source: g.finra && g.sec ? 'finra,sec' : g.finra ? 'finra' : 'sec',
                secNumber: Array.from(secNumbers)[0] || '',
                currentAddress: Array.from(addresses)[0] || '',
                searchableNames: orderedNames,
                searchableValues,
                searchableNameTokens,
                searchText: searchableValues.map(normalizeForSearch).join('\n'),
                currentFirm,
                currentCity,
                currentState
            };
        }));
        for (const r of batchResults) rows.push(r);
        process.stdout.write(`\rProcessed ${i + batch.length} / ${allGroups.length}`);
    }
    console.log();

    rows.sort((a, b) => a.name.localeCompare(b.name) || Number(a.crd) - Number(b.crd));
    const outPath = path.join(process.cwd(), 'data', 'search-index.json');
    fs.mkdirSync(path.join(process.cwd(), 'data'), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(rows));
    console.log(`Saved ${rows.length} entries to ${outPath}`);
    await client.quit();
}
main().catch(console.error);
