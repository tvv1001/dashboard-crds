function toArray(value: unknown): any[] {
	return Array.isArray(value) ? value : [];
}

function toText(value: unknown): string {
	if (value == null) return '';
	if (typeof value === 'string') return value.trim();
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	return '';
}

function pickFirstNonEmpty(...values: unknown[]): string {
	for (const value of values) {
		const text = toText(value);
		if (text) return text;
	}
	return '';
}

type ConnectionBucket = 'current' | 'previous' | 'owner';

export function extractConnectionRows(body: Record<string, any>): any[] {
	const directRows = [
		body.currentConnections,
		body.previousConnections,
		body.current_connections,
		body.previous_connections,
		body.currentEmployments,
		body.previousEmployments,
		body.currentIAEmployments,
		body.previousIAEmployments,
		body.ind_current_employments,
		body.ind_previous_employments,
		body.ind_ia_current_employments,
		body.ind_ia_previous_employments,
		body.directOwners,
		body.owners,
	].flatMap((list) => toArray(list));

	const nestedRows = toArray(body.connections).flatMap((entry: any) => toArray(entry?.rows));
	const fallbackRows = toArray(body.relationships).flatMap((entry: any) => toArray(entry?.rows));
	return [...directRows, ...nestedRows, ...fallbackRows];
}

export function isOwnerLikeRelationship(row: any): boolean {
	const haystack = [
		row?.position,
		row?.title,
		row?.role,
		row?.relationshipType,
		row?.employmentStatus,
		row?.status,
		row?.control,
		row?.description,
		row?.ownerType,
		row?.ownershipType,
	]
		.map((value) => toText(value))
		.join(' ');

	return (
		/(direct owner|executive officer|managing member|president|chief financial officer|chief executive officer|owner|officer)/i.test(haystack) ||
		row?.isOwner === true ||
		row?.owner === true ||
		row?.isExecutive === true ||
		row?.executive === true
	);
}

export function isCurrentConnectionRow(row: any): boolean {
	if (isOwnerLikeRelationship(row)) return true;
	const status = pickFirstNonEmpty(row?.employmentStatus, row?.status, row?.position, row?.currentRegistration, row?.control);
	return row?.isCurrent === true || row?.current === true || status.toLowerCase().includes('active') || !pickFirstNonEmpty(row?.endDate, row?.registrationEndDate);
}

export function bucketConnectionRows(rows: any[]) {
	const current: any[] = [];
	const previous: any[] = [];
	const owner: any[] = [];

	for (const row of toArray(rows)) {
		if (!row || typeof row !== 'object') continue;
		if (isOwnerLikeRelationship(row)) {
			owner.push(row);
			if (isCurrentConnectionRow(row)) current.push(row);
			else previous.push(row);
			continue;
		}
		if (isCurrentConnectionRow(row)) current.push(row);
		else previous.push(row);
	}

	return { current, previous, owner };
}
