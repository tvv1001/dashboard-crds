import re

with open('pages/api/_graphIndex.ts', 'r') as f:
    content = f.read()

# Replace buildFirmEmployeeIndex and state
old_emp = """let cachedSignature = '';
let cachedIndex: Map<string, EmploymentEdge[]> | null = null;
let cachedIndexPromise: Promise<Map<string, EmploymentEdge[]>> | null = null;

async function getEmploymentIndexSignature() {
	const stats = await listSavedKeysWithStats({ limit: 0, type: 'individual', sort: 'date-desc' });
	const newest = stats.keys[0];
	return `${stats.totalCount}:${newest?.key || ''}:${Math.round(Number(newest?.mtime || 0))}`;
}

async function buildFirmEmployeeIndex(): Promise<Map<string, EmploymentEdge[]>> {
	const { keys } = await listSavedKeysWithStats({ limit: 0, type: 'individual', sort: 'date-desc' });
	const byCrd = new Map<string, SavedKeyStat[]>();
	for (const entry of keys) {
		const list = byCrd.get(entry.crd) || [];
		list.push(entry);
		byCrd.set(entry.crd, list);
	}

	const index = new Map<string, EmploymentEdge[]>();
	const seenPersonFirm = new Set<string>();

	await Promise.all(
		Array.from(byCrd.entries()).map(async ([crd, entries]) => {
			for (const entry of entries) {
				try {
					const payload = await loadSavedPayload(entry.key);
					const normalized = normalizeRawPayload(payload) as Record<string, unknown>;
					const rows = extractConnectionRows(normalized);
					if (!rows.length) continue;
					const { current, previous } = bucketConnectionRows(rows);
					const personName = personDisplayName(normalized, crd);

					const addEdge = (row: Record<string, unknown>, isCurrent: boolean) => {
						const firmCrd = extractFirmCrd(row);
						if (!firmCrd) return;
						const dedupeKey = `${firmCrd}:${crd}:${isCurrent}`;
						if (seenPersonFirm.has(dedupeKey)) return;
						seenPersonFirm.add(dedupeKey);
						const list = index.get(firmCrd) || [];
						const { city, state } = extractRowCityState(row);
						const firmName = String(row.firmName || row.organizationName || row.name || '').trim();
						list.push({ personCrd: crd, personName, isCurrent, city, state, firmName });
						index.set(firmCrd, list);
					};

					for (const row of current) addEdge(row, true);
					for (const row of previous) addEdge(row, false);
				} catch {
					continue;
				}
			}
		}),
	);

	return index;
}

async function getFirmEmployeeIndex(): Promise<Map<string, EmploymentEdge[]>> {
	const signature = await getEmploymentIndexSignature();
	if (cachedIndex && cachedSignature === signature) return cachedIndex;
	if (cachedIndexPromise && cachedSignature === signature) return cachedIndexPromise;

	cachedSignature = signature;
	cachedIndexPromise = buildFirmEmployeeIndex()
		.then((index) => {
			cachedIndex = index;
			return index;
		})
		.finally(() => {
			cachedIndexPromise = null;
		});

	return cachedIndexPromise;
}"""

new_emp = """let cachedSignature = '';
let cachedIndex: Map<string, EmploymentEdge[]> | null = null;
let cachedSeenPersonFirm: Set<string> | null = null;
let cachedLastMtime = 0;
let cachedIndexPromise: Promise<Map<string, EmploymentEdge[]>> | null = null;

async function getEmploymentIndexSignature() {
	const stats = await listSavedKeysWithStats({ limit: 0, type: 'individual', sort: 'date-desc' });
	const newest = stats.keys[0];
	return {
		signature: `${stats.totalCount}:${newest?.key || ''}:${Math.round(Number(newest?.mtime || 0))}`,
		keys: stats.keys,
	};
}

async function buildFirmEmployeeIndex(keys: SavedKeyStat[]): Promise<Map<string, EmploymentEdge[]>> {
	const index = cachedIndex || new Map<string, EmploymentEdge[]>();
	const seenPersonFirm = cachedSeenPersonFirm || new Set<string>();
	
	const newKeys = keys.filter(k => k.mtime > cachedLastMtime);
	if (newKeys.length === 0 && cachedIndex) return index;

	const byCrd = new Map<string, SavedKeyStat[]>();
	for (const entry of newKeys) {
		const list = byCrd.get(entry.crd) || [];
		list.push(entry);
		byCrd.set(entry.crd, list);
	}

	const entriesArray = Array.from(byCrd.entries());
	const batchSize = 100;
	
	for (let i = 0; i < entriesArray.length; i += batchSize) {
		const batch = entriesArray.slice(i, i + batchSize);
		await Promise.all(batch.map(async ([crd, entries]) => {
			for (const entry of entries) {
				try {
					const payload = await loadSavedPayload(entry.key);
					const normalized = normalizeRawPayload(payload) as Record<string, unknown>;
					const rows = extractConnectionRows(normalized);
					if (!rows.length) continue;
					const { current, previous } = bucketConnectionRows(rows);
					const personName = personDisplayName(normalized, crd);

					const addEdge = (row: Record<string, unknown>, isCurrent: boolean) => {
						const firmCrd = extractFirmCrd(row);
						if (!firmCrd) return;
						const dedupeKey = `${firmCrd}:${crd}:${isCurrent}`;
						if (seenPersonFirm.has(dedupeKey)) return;
						seenPersonFirm.add(dedupeKey);
						const list = index.get(firmCrd) || [];
						const { city, state } = extractRowCityState(row);
						const firmName = String(row.firmName || row.organizationName || row.name || '').trim();
						list.push({ personCrd: crd, personName, isCurrent, city, state, firmName });
						index.set(firmCrd, list);
					};

					for (const row of current) addEdge(row, true);
					for (const row of previous) addEdge(row, false);
				} catch {
					continue;
				}
			}
		}));
	}

	let maxMtime = cachedLastMtime;
	for (const k of newKeys) {
		if (k.mtime > maxMtime) maxMtime = k.mtime;
	}
	cachedLastMtime = maxMtime;
	cachedSeenPersonFirm = seenPersonFirm;

	return index;
}

async function getFirmEmployeeIndex(): Promise<Map<string, EmploymentEdge[]>> {
	const { signature, keys } = await getEmploymentIndexSignature();
	if (cachedIndex && cachedSignature === signature) return cachedIndex;
	if (cachedIndexPromise && cachedSignature === signature) return cachedIndexPromise;

	cachedSignature = signature;
	cachedIndexPromise = buildFirmEmployeeIndex(keys)
		.then((index) => {
			cachedIndex = index;
			return index;
		})
		.finally(() => {
			cachedIndexPromise = null;
		});

	return cachedIndexPromise;
}"""

content = content.replace(old_emp, new_emp)

# Replace buildOwnerReferenceIndex and state
old_owner = """let cachedOwnerSignature = '';
let cachedOwnerIndex: Map<string, OwnerReference> | null = null;
let cachedOwnerIndexPromise: Promise<Map<string, OwnerReference>> | null = null;

async function getOwnerReferenceIndexSignature() {
	const stats = await listSavedKeysWithStats({ limit: 0, type: 'firm', sort: 'date-desc' });
	const newest = stats.keys[0];
	let nationalFileCount = 0;
	try {
		const fileNames = await fs.readdir(path.resolve(process.cwd(), 'data', 'national'));
		nationalFileCount = fileNames.length;
	} catch {
		// data/national may not exist in every environment; treat as empty
	}
	return `${stats.totalCount}:${newest?.key || ''}:${Math.round(Number(newest?.mtime || 0))}:national${nationalFileCount}`;
}"""

new_owner = """let cachedOwnerSignature = '';
let cachedOwnerIndex: Map<string, OwnerReference> | null = null;
let cachedOwnerLastMtime = 0;
let cachedOwnerIndexPromise: Promise<Map<string, OwnerReference>> | null = null;

async function getOwnerReferenceIndexSignature() {
	const stats = await listSavedKeysWithStats({ limit: 0, type: 'firm', sort: 'date-desc' });
	const newest = stats.keys[0];
	let nationalFileCount = 0;
	try {
		const fileNames = await fs.readdir(path.resolve(process.cwd(), 'data', 'national'));
		nationalFileCount = fileNames.length;
	} catch {
		// data/national may not exist in every environment; treat as empty
	}
	return {
		signature: `${stats.totalCount}:${newest?.key || ''}:${Math.round(Number(newest?.mtime || 0))}:national${nationalFileCount}`,
		keys: stats.keys,
	};
}"""

content = content.replace(old_owner, new_owner)

old_owner_build = """async function buildOwnerReferenceIndex(): Promise<Map<string, OwnerReference>> {
	const { keys } = await listSavedKeysWithStats({ limit: 0, type: 'firm', sort: 'date-desc' });
	const index = new Map<string, OwnerReference>();

	await Promise.all(
		keys.map(async (entry) => {
			try {
				const payload = await loadSavedPayload(entry.key);
				const normalized = normalizeRawPayload(payload) as Record<string, unknown>;
				indexOwnersFromFirmPayload(index, entry.crd, normalized);
			} catch {
				// skip unreadable entries
			}
		}),
	);

	await indexOwnersFromNationalSnapshots(index);

	return index;
}

async function getOwnerReferenceIndex(): Promise<Map<string, OwnerReference>> {
	const signature = await getOwnerReferenceIndexSignature();
	if (cachedOwnerIndex && cachedOwnerSignature === signature) return cachedOwnerIndex;
	if (cachedOwnerIndexPromise && cachedOwnerSignature === signature) return cachedOwnerIndexPromise;

	cachedOwnerSignature = signature;
	cachedOwnerIndexPromise = buildOwnerReferenceIndex()
		.then((index) => {
			cachedOwnerIndex = index;
			return index;
		})
		.finally(() => {
			cachedOwnerIndexPromise = null;
		});

	return cachedOwnerIndexPromise;
}"""

new_owner_build = """async function buildOwnerReferenceIndex(keys: SavedKeyStat[]): Promise<Map<string, OwnerReference>> {
	const index = cachedOwnerIndex || new Map<string, OwnerReference>();
	const newKeys = keys.filter(k => k.mtime > cachedOwnerLastMtime);
	
	if (newKeys.length === 0 && cachedOwnerIndex) {
		return index;
	}

	const batchSize = 100;
	for (let i = 0; i < newKeys.length; i += batchSize) {
		const batch = newKeys.slice(i, i + batchSize);
		await Promise.all(batch.map(async (entry) => {
			try {
				const payload = await loadSavedPayload(entry.key);
				const normalized = normalizeRawPayload(payload) as Record<string, unknown>;
				indexOwnersFromFirmPayload(index, entry.crd, normalized);
			} catch {
				// skip unreadable entries
			}
		}));
	}

	if (!cachedOwnerIndex) {
		await indexOwnersFromNationalSnapshots(index);
	}

	let maxMtime = cachedOwnerLastMtime;
	for (const k of newKeys) {
		if (k.mtime > maxMtime) maxMtime = k.mtime;
	}
	cachedOwnerLastMtime = maxMtime;

	return index;
}

async function getOwnerReferenceIndex(): Promise<Map<string, OwnerReference>> {
	const { signature, keys } = await getOwnerReferenceIndexSignature();
	if (cachedOwnerIndex && cachedOwnerSignature === signature) return cachedOwnerIndex;
	if (cachedOwnerIndexPromise && cachedOwnerSignature === signature) return cachedOwnerIndexPromise;

	cachedOwnerSignature = signature;
	cachedOwnerIndexPromise = buildOwnerReferenceIndex(keys)
		.then((index) => {
			cachedOwnerIndex = index;
			return index;
		})
		.finally(() => {
			cachedOwnerIndexPromise = null;
		});

	return cachedOwnerIndexPromise;
}"""

content = content.replace(old_owner_build, new_owner_build)

with open('pages/api/_graphIndex.ts', 'w') as f:
    f.write(content)

