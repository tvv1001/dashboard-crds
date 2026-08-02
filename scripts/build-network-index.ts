import { promises as fs } from 'fs';
import path from 'path';

const rawDir = path.resolve(process.cwd(), 'data', 'raw');
const outPath = path.resolve(process.cwd(), 'data', 'derived', 'network-index.json');

type Connection = {
    to: string; // CRD or FirmID
    type: 'employment' | 'ownership' | 'location' | 'succession';
    detail: string;
    weight: number;
};

async function buildNetworkIndex() {
    console.log('Building network connection index...');
    const files = (await fs.readdir(rawDir)).filter(f => f.endsWith('.json'));
    
    // Map of CRD -> Connections[]
    const graph: Record<string, Connection[]> = {};
    const metadata: Record<string, { name: string; type: string }> = {};

    let processed = 0;

    for (const file of files) {
        try {
            const raw = await fs.readFile(path.join(rawDir, file), 'utf-8');
            const payload = JSON.parse(raw);
            const content = payload.finraBrokerCheck || payload.secInvestmentAdvisor || payload.content || payload.iacontent || payload;
            const bi = content.basicInformation || {};
            
            const match = file.match(/^(finra|sec):(individual|firm):(\d+)\.json$/i);
            if (!match) continue;
            const [, source, entityType, crd] = match;

            const name = entityType === 'individual' 
                ? bi.individualName || bi.fullName || `${bi.firstName} ${bi.lastName}`
                : bi.firmName || bi.orgName;
            
            metadata[crd] = { name, type: entityType };
            if (!graph[crd]) graph[crd] = [];

            // 1. Individual -> Firm Employments
            if (entityType === 'individual') {
                const emps = [
                    ...(content.currentEmployments || []),
                    ...(content.previousEmployments || []),
                    ...(content.currentIAEmployments || []),
                    ...(content.previousIAEmployments || [])
                ];

                for (const emp of emps) {
                    if (emp.firmId) {
                        const firmId = String(emp.firmId);
                        graph[crd].push({
                            to: firmId,
                            type: 'employment',
                            detail: `${emp.firmName || 'Firm'} (${emp.registrationBeginDate || '?'} - ${emp.registrationEndDate || 'Present'})`,
                            weight: 1.0
                        });
                        
                        // Backlink: Firm -> Individual
                        if (!graph[firmId]) graph[firmId] = [];
                        graph[firmId].push({
                            to: crd,
                            type: 'employment',
                            detail: `${name} (Employee)`,
                            weight: 0.8
                        });
                    }
                }
            }

            // 2. Firm -> Ownership (if available)
            // Note: SEC firm data often contains direct/indirect owners
            if (entityType === 'firm') {
                const owners = [
                    ...(content.directOwners || []),
                    ...(content.indirectOwners || [])
                ];
                for (const owner of owners) {
                    const ownerCrd = owner.crdNumber || owner.ownerCrd || owner.ownerCrdNumber;
                    if (ownerCrd) {
                        const toCrd = String(ownerCrd);
                        graph[crd].push({
                            to: toCrd,
                            type: 'ownership',
                            detail: `${owner.legalName || owner.ownerName} (${owner.ownershipPercentage || 'Unknown %'})`,
                            weight: 2.0
                        });

                        // Backlink
                        if (!graph[toCrd]) graph[toCrd] = [];
                        graph[toCrd].push({
                            to: crd,
                            type: 'ownership',
                            detail: `Owner of ${name}`,
                            weight: 1.5
                        });
                    }
                }
            }

            processed++;
            if (processed % 5000 === 0) console.log(`Processed ${processed} files...`);

        } catch (e) {
            continue;
        }
    }

    console.log(`Index complete. Saving ${Object.keys(graph).length} nodes to ${outPath}...`);
    
    // We'll save a minified version to keep it small
    await fs.writeFile(outPath, JSON.stringify({ metadata, graph }));
}

buildNetworkIndex();
