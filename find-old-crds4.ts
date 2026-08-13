import { listSavedKeysWithStats, loadSavedPayload, normalizeRawPayload } from './pages/api/_lib';

async function main() {
    const { keys } = await listSavedKeysWithStats({ limit: 0, sort: 'date-desc' });
    const oldestCrds: { crd: string, year: number }[] = [];

    for (let i = 0; i < keys.length; i++) {
        const entry = keys[i];
        if (entry.type !== 'firm') continue;
        try {
            const raw = await loadSavedPayload(entry.key);
            const normalized = normalizeRawPayload(raw) as any;
            if (!normalized) continue;

            const formedDate = normalized.formedDate || normalized.basicInformation?.formedDate;
            if (formedDate) {
                const match = String(formedDate).match(/\b(18|19|20)\d{2}\b/);
                if (match) {
                    const year = parseInt(match[0], 10);
                    oldestCrds.push({ crd: entry.crd, year });
                }
            }
        } catch (e) {
            // skip
        }
    }

    oldestCrds.sort((a, b) => a.year - b.year);
    const top10 = oldestCrds.slice(0, 10);

    console.log("Top 10 oldest Firm CRDs:");
    for (const item of top10) {
        console.log(`- Firm CRD #${item.crd} - Year: ${item.year}`);
    }
}
main();
