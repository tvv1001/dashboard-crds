// Suffixes/credentials that should keep a fixed casing instead of being
// lower-cased-then-capitalized like a normal word (e.g. FINRA/SEC records
// mix ALL CAPS, Title Case, and lowercase across individual name fields).
const NAME_WORD_EXCEPTIONS: Record<string, string> = {
	jr: 'Jr.',
	'jr.': 'Jr.',
	sr: 'Sr.',
	'sr.': 'Sr.',
	ii: 'II',
	iii: 'III',
	iv: 'IV',
	v: 'V',
	esq: 'Esq.',
	'esq.': 'Esq.',
	md: 'MD',
	phd: 'PhD',
	cfa: 'CFA',
	cpa: 'CPA',
	cfp: 'CFP',
	cdfa: 'CDFA',
	chfc: 'ChFC',
	clu: 'CLU',
};

function capitalizeSegment(segment: string): string {
	if (!segment) return segment;
	return segment.charAt(0).toUpperCase() + segment.slice(1).toLowerCase();
}

function toProperCaseWord(word: string): string {
	if (!word) return word;
	const lower = word.toLowerCase();
	const bareWord = lower.replace(/[.,]/g, '');
	if (NAME_WORD_EXCEPTIONS[bareWord]) return NAME_WORD_EXCEPTIONS[bareWord];

	if (word.includes('-')) {
		return word
			.split('-')
			.map((part) => toProperCaseWord(part))
			.join('-');
	}

	const apostropheMatch = word.match(/^([A-Za-z]+)'([A-Za-z]+)$/);
	if (apostropheMatch) {
		return `${capitalizeSegment(apostropheMatch[1])}'${capitalizeSegment(apostropheMatch[2])}`;
	}

	// Dotted initials, e.g. middle-name fields stored as "K.K." or "J.R."
	const dottedInitialsMatch = word.match(/^([A-Za-z])\.([A-Za-z])\.?$/);
	if (dottedInitialsMatch) {
		return `${dottedInitialsMatch[1].toUpperCase()}.${dottedInitialsMatch[2].toUpperCase()}.`;
	}

	const mcMatch = lower.match(/^mc([a-z]+)$/);
	if (mcMatch && lower.length > 3) {
		return `Mc${capitalizeSegment(mcMatch[1])}`;
	}
	const macMatch = lower.match(/^mac([a-z]{2,})$/);
	if (macMatch && lower.length > 5) {
		return `Mac${capitalizeSegment(macMatch[1])}`;
	}

	return capitalizeSegment(word);
}

// Normalizes a person's name to consistent Title Case regardless of how the
// upstream source stored it (FINRA/SEC records mix ALL CAPS, lowercase, and
// Title Case across firstName/middleName/lastName/suffix fields).
export function toProperCaseName(value: unknown): string {
	const text = String(value ?? '').trim();
	if (!text) return '';
	return text
		.replace(/\s+/g, ' ')
		.split(' ')
		.map((word) => toProperCaseWord(word))
		.join(' ');
}

export function formatConsoleElapsed(startedAt: number): string {
	if (!startedAt) return '0s';
	const totalSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

export function formatConsoleTime(ts: number): string {
	if (!ts) return '—';
	return new Date(ts).toLocaleTimeString();
}

export function formatDateTime(ts: string | number | undefined | null): string {
	if (!ts) return '—';
	const parsed = typeof ts === 'number' ? ts : Date.parse(String(ts));
	if (!Number.isFinite(parsed) || parsed <= 0) return '—';
	return new Date(parsed).toLocaleString();
}

export function formatDateOnly(value: unknown): string {
	const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (!match) return '—';
	const [, y, m, d] = match;
	return `${parseInt(m, 10)}/${parseInt(d, 10)}/${y}`;
}

export function formatRelativeTime(ts: string | undefined | null): string {
	if (!ts) return '—';
	const parsed = Date.parse(String(ts));
	if (!Number.isFinite(parsed) || parsed <= 0) return '—';
	const diffMs = Date.now() - parsed;
	const minutes = Math.max(0, Math.floor(diffMs / 60000));
	if (minutes < 60) return minutes <= 1 ? 'just now' : `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}
