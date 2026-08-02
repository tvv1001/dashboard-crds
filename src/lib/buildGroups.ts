import type { SavedPayload, GroupEntry, SortOrder } from '../types';
import { parseKey, parseCrdKey } from './parseKey';

export function buildGroups(payloads: SavedPayload[], sortOrder: SortOrder, typeFilter: string): GroupEntry[] {
	const map = new Map<string, GroupEntry>();

	for (const payload of payloads) {
		const key = parseKey(payload);
		const parsed = parseCrdKey(key);
		if (!parsed) continue;
		const { source, type, crd } = parsed;
		const groupKey = `${type}:${crd}`;

		if (!map.has(groupKey)) {
			map.set(groupKey, {
				groupKey,
				type,
				crd,
				keys: [],
				displayType: type === 'individual' ? 'Individual' : 'Firm',
				latest: 0,
				industryDate: null,
				finraActive: false,
				secActive: false,
				hasFinra: false,
				hasSec: false,
				hasWarning: false,
				warningText: '',
				sortLabel: crd,
			});
		}

		const entry = map.get(groupKey)!;
		if (!entry.keys.includes(key)) entry.keys.push(key);

		const mtime = payload.mtime || 0;
		if (mtime > entry.latest) entry.latest = mtime;

		if (source === 'finra') {
			entry.hasFinra = true;
			if (payload.isActive) entry.finraActive = true;
		}
		if (source === 'sec') {
			entry.hasSec = true;
			if (payload.isActive) entry.secActive = true;
		}

		if (payload.industryDate && !entry.industryDate) {
			entry.industryDate = payload.industryDate;
		}
	}

	let result = Array.from(map.values());

	if (typeFilter === 'individuals') result = result.filter((g) => g.type === 'individual');
	else if (typeFilter === 'firms') result = result.filter((g) => g.type === 'firm');

	if (sortOrder === 'date-desc') result.sort((a, b) => b.latest - a.latest);
	else if (sortOrder === 'crd-asc') result.sort((a, b) => parseInt(a.crd, 10) - parseInt(b.crd, 10));
	else if (sortOrder === 'crd-desc') result.sort((a, b) => parseInt(b.crd, 10) - parseInt(a.crd, 10));

	return result;
}

export function filterGroups(groups: GroupEntry[], filter: string): GroupEntry[] {
	const f = filter.trim().toLowerCase();
	if (!f) return groups;
	return groups.filter((g) => {
		if (g.crd.includes(f)) return true;
		if (g.sortLabel.toLowerCase().includes(f)) return true;
		if (g.keys.some((k) => k.toLowerCase().includes(f))) return true;
		return false;
	});
}
