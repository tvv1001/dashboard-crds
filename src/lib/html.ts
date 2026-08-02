export function escapeHtml(str: unknown): string {
	if (str == null) return '';
	return String(str)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

export function escapeRegExp(str: string): string {
	return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function highlightTerms(text: unknown, terms: string[]): string {
	const value = String(text || '');
	const normalizedTerms = Array.from(
		new Set((terms || []).map((term) => String(term || '').trim()).filter(Boolean)),
	);
	if (!value || !normalizedTerms.length) return escapeHtml(value);
	const pattern = normalizedTerms
		.slice()
		.sort((a, b) => b.length - a.length)
		// A single-character term (e.g. a middle initial like "d") should
		// only highlight when it's a standalone word — otherwise it also
		// matches every occurrence of that letter buried inside unrelated
		// words (e.g. "DAVID", "EDWARD"), which is noisy and misleading.
		.map((term) => (term.length === 1 ? `\\b${escapeRegExp(term)}\\b` : escapeRegExp(term)))
		.join('|');
	if (!pattern) return escapeHtml(value);
	const regex = new RegExp(`(${pattern})`, 'ig');
	return escapeHtml(value).replace(regex, '<mark>$1</mark>');
}
