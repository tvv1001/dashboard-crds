import { listSavedKeysWithStats, loadSavedPayload, normalizeRawPayload } from './pages/api/_lib';

async function main() {
    const { keys } = await listSavedKeysWithStats({ limit: 0, sort: 'date-desc' });
    const oldCrds: string[] = [];

    for (const entry of keys) {
        try {
            const raw = await loadSavedPayload(entry.key);
            const normalized = normalizeRawPayload(raw) as any;
            if (!normalized) continue;

            let earliestYear = 9999;

            if (entry.type === 'firm') {
                const formedDate = normalized.formedDate || normalized.basicInformation?.formedDate;
                if (formedDate) {
                    const match = String(formedDate).match(/\b(18|19|20)\d{2}\b/);
                    if (match) {
                        const year = parseInt(match[0], 10);
                        if (year < earliestYear) earliestYear = year;
                    }
                }
            } else if (entry.type === 'individual') {
                const employments = [
                    ...(normalized.previousEmployments || []),
                    ...(normalized.currentEmployments || []),
                    ...(normalized.previousIAEmployments || []),
                    ...(normalized.currentIAEmployments || [])
                ];
                for (const emp of employments) {
                    const beginDate = emp.registrationBeginDate || emp.startDate || emp.effectiveDate;
                    if (beginDate) {
                        const match = String(beginDate).match(/\b(18|19|20)\d{2}\b/);
                        if (match) {
                            const year = parseInt(match[0], 10);
                            if (year < earliestYear) earliestYear = year;
                        }
                    }
                }
            }

            if (earliestYear <= 1975) {
                oldCrds.push(`- CRD #${entry.crd} (${entry.type}) - Earliest year found: ${earliestYear}`);
            }
        } catch (e) {
            // skip
        }
    }

    console.log("Found CRDs:");
    console.log(oldCrds.length ? oldCrds.join('\n') : "None found.");
}
main();
