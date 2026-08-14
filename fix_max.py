import re

with open('scripts/query-high-water-crds.ts', 'r') as f:
    content = f.read()

old_max = """async function collectSavedMaxes() {
	const maxes: Partial<Record<`${Source}:${EntityType}`, number>> = {};
	const stats = await listSavedKeysWithStats({ limit: 0 });

	for (const entry of stats.keys) {
		const source = entry.source as Source;
		const type = entry.type as EntityType;
		const crd = Number(entry.crd);
		if (!Number.isSafeInteger(crd) || crd <= 0) continue;
		const key = `${source}:${type}` as const;
		if (!maxes[key] || crd > (maxes[key] || 0)) {
			maxes[key] = crd;
		}
	}

	return maxes;
}"""

new_max = """import { listRawKeysFromRedis, parseSavedRawKey } from '../pages/api/_lib';
async function collectSavedMaxes() {
	const maxes: Partial<Record<`${Source}:${EntityType}`, number>> = {};
	
	try {
		const rawKeys = await listRawKeysFromRedis();
		for (const rawKey of rawKeys) {
			const parsed = parseSavedRawKey(rawKey);
			if (!parsed) continue;
			const source = parsed.source as Source;
			const type = parsed.type as EntityType;
			const crd = Number(parsed.crd);
			if (!Number.isSafeInteger(crd) || crd <= 0) continue;
			
			const key = `${source}:${type}` as const;
			if (!maxes[key] || crd > (maxes[key] || 0)) {
				maxes[key] = crd;
			}
		}
		if (Object.keys(maxes).length > 0) return maxes;
	} catch (e) {
		// Fallback
	}

	const stats = await listSavedKeysWithStats({ limit: 0 });
	for (const entry of stats.keys) {
		const source = entry.source as Source;
		const type = entry.type as EntityType;
		const crd = Number(entry.crd);
		if (!Number.isSafeInteger(crd) || crd <= 0) continue;
		const key = `${source}:${type}` as const;
		if (!maxes[key] || crd > (maxes[key] || 0)) {
			maxes[key] = crd;
		}
	}

	return maxes;
}"""

content = content.replace(old_max, new_max)

with open('scripts/query-high-water-crds.ts', 'w') as f:
    f.write(content)
