/** Persist the last CRD the user opened so Global Map / Node Graph can deep-link it. */

export type LastCrdSelection = {
	type: 'individual' | 'firm';
	crd: string;
	/** Optional full Redis key, e.g. finra:individual:123 */
	key?: string;
	updatedAt: number;
};

export const LAST_CRD_SELECTION_STORAGE_KEY = 'dashboard-crds:last-crd-selection';

export function readLastCrdSelection(): LastCrdSelection | null {
	if (typeof window === 'undefined') return null;
	try {
		const raw = window.localStorage.getItem(LAST_CRD_SELECTION_STORAGE_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as Partial<LastCrdSelection>;
		const type =
			parsed.type === 'firm' ? 'firm'
			: parsed.type === 'individual' ? 'individual'
			: null;
		const crd = String(parsed.crd || '').trim();
		if (!type || !/^\d+$/.test(crd)) return null;
		return {
			type,
			crd,
			key: typeof parsed.key === 'string' ? parsed.key : undefined,
			updatedAt: Number(parsed.updatedAt) || Date.now(),
		};
	} catch {
		return null;
	}
}

export function writeLastCrdSelection(selection: { type: 'individual' | 'firm'; crd: string; key?: string } | null) {
	if (typeof window === 'undefined') return;
	try {
		if (!selection) {
			window.localStorage.removeItem(LAST_CRD_SELECTION_STORAGE_KEY);
			return;
		}
		const type = selection.type === 'firm' ? 'firm' : 'individual';
		const crd = String(selection.crd || '').trim();
		if (!/^\d+$/.test(crd)) return;
		const payload: LastCrdSelection = {
			type,
			crd,
			key: selection.key,
			updatedAt: Date.now(),
		};
		window.localStorage.setItem(LAST_CRD_SELECTION_STORAGE_KEY, JSON.stringify(payload));
	} catch {
		// ignore quota / private mode
	}
}
