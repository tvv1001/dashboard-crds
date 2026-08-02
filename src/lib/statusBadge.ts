// Shared status/terminated badge derivation logic, used by both the record
// detail hero (StatusBox.tsx) and the top panel banner (PanelHeader.tsx) so
// both surfaces render identical "Terminated <date>" / "Active" / "Inactive"
// pills from the same underlying FINRA/SEC payload fields.

export type RecordStatusBadge = { label: string; className: string } | null;

function toText(value: unknown): string {
	if (value == null) return '';
	if (typeof value === 'string') return value.trim();
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	return '';
}

function normalizeStatusText(value: unknown): string {
	return toText(value)
		.toLowerCase()
		.replace(/[\s_-]+/g, ' ')
		.trim();
}

export function deriveStatusBadge(...values: unknown[]): RecordStatusBadge {
	const normalized = values.map((value) => normalizeStatusText(value)).filter(Boolean);
	if (!normalized.length) return null;
	const joined = normalized.join(' | ');
	if (/(terminated|cancelled|canceled|revoked|withdrawn|closed|ceased)/.test(joined)) {
		return { label: 'Terminated', className: 'record-pill--status-terminated' };
	}
	if (/(inactive|not in scope|notinscope|not inforce|not in force)/.test(joined)) {
		return { label: 'Inactive', className: 'record-pill--status-inactive' };
	}
	if (/(active|approved|current|open)/.test(joined)) {
		return { label: 'Active', className: 'record-pill--status-active' };
	}
	return null;
}

// A dedicated "Terminated <date>" pill, shown alongside (not instead of) the
// active/inactive scope pill — e.g. a firm can be both "Terminated 07/03/2017"
// (firmStatus) and "Inactive" (bcScope/iaScope) at the same time.
export function deriveTerminatedBadge(...pairs: Array<[unknown, unknown]>): RecordStatusBadge {
	for (const [status, dateValue] of pairs) {
		const normalized = normalizeStatusText(status);
		if (!normalized) continue;
		if (/(terminated|cancelled|canceled|revoked|withdrawn|closed|ceased)/.test(normalized)) {
			const date = toText(dateValue);
			return { label: date ? `Terminated ${date}` : 'Terminated', className: 'record-pill--status-terminated' };
		}
	}
	return null;
}
