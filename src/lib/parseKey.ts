import type { ParsedKey, SavedPayload, RequestedSelection } from '../types';

export function parseKey(item: SavedPayload | string): string {
	if (typeof item === 'string') return item;
	if (item && item.key) return item.key;
	return String(item);
}

export function parseCrdKey(key: string): ParsedKey | null {
	const value = String(key || '').trim();
	const match = value.match(/^(finra|sec):([a-z]+):(\d+)(?:\.json)?$/i);
	if (!match) return null;
	return {
		source: match[1].toLowerCase() as 'finra' | 'sec',
		type: match[2].toLowerCase() as 'individual' | 'firm',
		crd: match[3],
	};
}

function getQueryParamInsensitive(url: URL, names: string[]): string {
	const wanted = new Set((names || []).map((n) => String(n).toLowerCase()));
	for (const [key, value] of url.searchParams.entries()) {
		if (wanted.has(String(key).toLowerCase())) return String(value || '').trim();
	}
	return '';
}

function parseRequestedSelectionFromPathname(pathname: string): RequestedSelection | null {
	const parts = String(pathname || '')
		.split('/')
		.map((segment) => segment.trim())
		.filter(Boolean);
	if (parts.length < 2) return null;
	const [typeRaw, crdRaw] = parts;
	const type = typeRaw.toLowerCase();
	if ((type !== 'individual' && type !== 'firm') || !/^[0-9]+$/.test(crdRaw)) return null;
	return {
		crd: crdRaw,
		type,
		preferredSources: ['sec', 'finra'],
	};
}

export function parseRequestedSelectionFromUrl(rawUrl: string | URL): RequestedSelection | null {
	const url = rawUrl instanceof URL ? rawUrl : new URL(String(rawUrl || ''), window.location.origin);
	const fromPath = parseRequestedSelectionFromPathname(url.pathname);
	if (fromPath) return fromPath;
	const individualCrd = getQueryParamInsensitive(url, ['CRD_individual']);
	const firmCrd = getQueryParamInsensitive(url, ['CRD_firm']);
	const type =
		/^[0-9]+$/.test(individualCrd) ? 'individual'
		: /^[0-9]+$/.test(firmCrd) ? 'firm'
		: '';
	const crd =
		type === 'individual' ? individualCrd
		: type === 'firm' ? firmCrd
		: '';
	if (!type || !/^[0-9]+$/.test(crd)) return null;
	const sourceParam = getQueryParamInsensitive(url, ['source']).toLowerCase();
	const wantsSec = /^(1|true|yes)$/i.test(getQueryParamInsensitive(url, ['sec']));
	const wantsFinra = /^(1|true|yes)$/i.test(getQueryParamInsensitive(url, ['finra']));
	const preferredSources: string[] = [];
	if (sourceParam === 'sec' || sourceParam === 'finra') preferredSources.push(sourceParam);
	if (wantsSec && !preferredSources.includes('sec')) preferredSources.push('sec');
	if (wantsFinra && !preferredSources.includes('finra')) preferredSources.push('finra');
	if (!preferredSources.includes('sec')) preferredSources.push('sec');
	if (!preferredSources.includes('finra')) preferredSources.push('finra');
	return { crd, type, preferredSources };
}

export function splitSearchTerms(raw: string): string[] {
	return Array.from(
		new Set(
			String(raw || '')
				.split(/[\n,;]+/)
				.map((term) => term.trim())
				.filter(Boolean),
		),
	);
}
