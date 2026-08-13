import { listSavedKeysWithStats, loadSavedPayload, normalizeRawPayload } from './pages/api/_lib';
import { extractConnectionRows } from './src/components/panel/connectionData';

async function main() {
    const { keys } = await listSavedKeysWithStats({ limit: 0, sort: 'date-desc' });
    const oldCrds: string[] = [];

    for (let i = 0; i < keys.length; i++) {
        const entry = keys[i];
        if (entry.type !== 'individual') continue;
        try {
            const raw = await loadSavedPayload(entry.key);
            const normalized = normalizeRawPayload(raw) as any;
            if (!normalized) continue;

            let earliestYear = 9999;
            const rows = extractConnectionRows(normalized);
            for (const row of rows) {
                const dateText = String(row.registrationBeginDate || row.startDate || row.effectiveDate || row.start || '');
                const match = dateText.match(/\b(18|19|20)\d{2}\b/);
                if (match) {
                    const year = parseInt(match[0], 10);
                    if (year < earliestYear) earliestYear = year;
                }
            }

            if (earliestYear <= 1975) {
                oldCrds.push(`- Individual CRD #${entry.crd} - Earliest year: ${earliestYear}`);
                if (oldCrds.length >= 10) break;
            }
        } catch (e) {
            // skip
        }
    }

    console.log("Found CRDs:");
    console.log(oldCrds.length ? oldCrds.join('\n') : "None found.");
}
main();
