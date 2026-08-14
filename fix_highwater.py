import re

with open('pages/api/new-crds.ts', 'r') as f:
    content = f.read()

old_water = """	const { keys } = await listSavedKeysWithStats({ limit: 0, sort: 'crd-desc' });
	const uniqueTotalCrds = await getRedisDbSize();
	const grouped = new Map<string, NewCrdItem>();
	for (const entry of keys) {
		const crd = sanitizePositiveInt(entry.crd);
		if (!crd) continue;
		const id = `${entry.type}:${entry.crd}`;
		const foundAt = entry.mtime ? new Date(entry.mtime).toISOString() : checkedAt;
		const existing = grouped.get(id);
		if (existing) {
			const existingSources = new Set(existing.sources);
			if (entry.source && !existingSources.has(entry.source)) {
				existing.sources.push(entry.source);
				existing.savedFiles.push(entry.key);
				if (new Date(foundAt) > new Date(existing.foundAt)) existing.foundAt = foundAt;
			}
		} else {
			grouped.set(id, {
				id,
				type: entry.type as 'firm' | 'individual',
				crd: String(crd),
				name: entry.displayName || (entry.type === 'firm' ? 'Unknown Firm' : 'Unknown Individual'),
				foundAt,
				sources: entry.source ? [entry.source] : [],
				savedFiles: [entry.key],
			});
		}
	}"""

new_water = """	let keys: any[] = [];
	try {
		const rawKeys = await import('./_lib').then(m => m.listRawKeysFromRedis());
		const parse = await import('./_lib').then(m => m.parseSavedRawKey);
		
		for (const rk of rawKeys) {
			const p = parse(rk);
			if (p) keys.push({
				key: rk,
				crd: p.crd,
				type: p.type,
				source: p.source,
				mtime: 0,
				displayName: ''
			});
		}
	} catch (e) {
		const stats = await listSavedKeysWithStats({ limit: 0, sort: 'crd-desc' });
		keys = stats.keys;
	}

	const uniqueTotalCrds = keys.length;
	const grouped = new Map<string, NewCrdItem>();
	for (const entry of keys) {
		const crd = sanitizePositiveInt(entry.crd);
		if (!crd) continue;
		const id = `${entry.type}:${entry.crd}`;
		const foundAt = entry.mtime ? new Date(entry.mtime).toISOString() : checkedAt;
		const existing = grouped.get(id);
		if (existing) {
			const existingSources = new Set(existing.sources);
			if (entry.source && !existingSources.has(entry.source)) {
				existing.sources.push(entry.source);
				existing.savedFiles.push(entry.key);
				if (new Date(foundAt) > new Date(existing.foundAt)) existing.foundAt = foundAt;
			}
		} else {
			grouped.set(id, {
				id,
				type: entry.type as 'firm' | 'individual',
				crd: String(crd),
				name: entry.displayName || (entry.type === 'firm' ? 'Unknown Firm' : 'Unknown Individual'),
				foundAt,
				sources: entry.source ? [entry.source] : [],
				savedFiles: [entry.key],
			});
		}
	}"""

content = content.replace(old_water, new_water)

with open('pages/api/new-crds.ts', 'w') as f:
    f.write(content)
