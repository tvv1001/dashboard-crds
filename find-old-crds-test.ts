import { listSavedKeysWithStats, loadSavedPayload } from './pages/api/_lib';

async function main() {
    const { keys } = await listSavedKeysWithStats({ limit: 0, sort: 'date-desc' });
    let years = [];

    for (let i = 0; i < keys.length; i++) {
        const entry = keys[i];
        try {
            const raw = await loadSavedPayload(entry.key);
            if (!raw) continue;
            
            const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
            const regex = /\b(19\d{2}|20\d{2})\b/g;
            let match;
            while ((match = regex.exec(text)) !== null) {
                years.push(parseInt(match[1], 10));
            }
            if (years.length > 50000) break; // enough samples
        } catch (e) {
            // ignore
        }
    }
    
    // Sort and get the smallest unique years
    const uniqueYears = Array.from(new Set(years)).sort((a, b) => a - b);
    console.log("Smallest years found:", uniqueYears.slice(0, 10).join(', '));
}

main().catch(console.error);
