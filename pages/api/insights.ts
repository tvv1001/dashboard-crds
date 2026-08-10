import type { NextApiRequest, NextApiResponse } from 'next';
import { formatErrorMessage, hydrateFromUpstream, listSavedKeysWithStats, loadSavedPayload, normalizeRawPayload } from './_lib';
import { buildNodeId, expandNodes, findOwnerReference, type OwnerReference } from './_graphIndex';
import { deriveStatusBadge, deriveTerminatedBadge } from '../../src/lib/statusBadge';

type NodeInfo = {
	crd: string;
	name: string;
	type: 'individual' | 'firm';
	source: string;
	location?: string;
	status?: string;
	// Full mailing/office address (firm) or branch office address
	// (individual's current employment), for the main node card.
	address?: string;
	// Firm formation date ("Established: <date>"), matching StatusBox.tsx's
	// dashboard convention.
	established?: string;
	// Per-source status tags (FINRA/SEC), matching the dashboard top
	// banner's `banner-context-status-tags` pills.
	statusBadges?: { source: 'FINRA' | 'SEC'; status: 'Active' | 'Inactive' | 'Terminated' }[];
};

type Connection = {
	targetCrd: string;
	targetName: string;
	type: string;
	role?: string;
	dates?: string;
	// Which upstream source this specific relationship came from — a person
	// can have FINRA broker employments and SEC investment-adviser
	// employments simultaneously, so this is tracked per connection rather
	// than assumed from the analyzed node's own source.
	source?: 'FINRA' | 'SEC';
	// The target's own live status (from its own saved payload), matching
	// the same "Active" / "Inactive" / "Terminated" pill shown on that
	// entity's own record banner — independent of whether the relationship
	// itself is current or previous.
	status?: 'Active' | 'Inactive' | 'Terminated';
};

function getObject(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

// Mirrors StatusBox.tsx's formatAddress helper so orphan cards render
// addresses the same way the dashboard does.
function toAddressText(value: unknown): string {
	if (value === null || value === undefined) return '';
	if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
	return '';
}

function formatAddress(value: unknown): string {
	if (!value) return '';
	if (typeof value === 'string') return value.trim();
	if (typeof value !== 'object' || Array.isArray(value)) return '';
	const address = value as Record<string, unknown>;
	const preferredKeys = ['address1', 'address2', 'address3', 'street1', 'street2', 'city', 'state', 'postalCode', 'zipCode', 'zip', 'country'];
	const parts: string[] = [];
	for (const key of preferredKeys) {
		const text = toAddressText(address[key]);
		if (text) parts.push(text);
	}
	if (parts.length > 0) return parts.join(', ');
	return Object.values(address)
		.map((v) => toAddressText(v))
		.filter(Boolean)
		.join(', ');
}

// Loads the target's own saved payload for the given source and derives its
// live status the same way the record banner (PanelHeader.tsx) does, so
// connection cards show the entity's real current status rather than a
// guess based on the relationship type (current/previous).
const statusCache = new Map<string, Promise<'Active' | 'Inactive' | 'Terminated' | null>>();
async function deriveConnectionStatus(source: 'FINRA' | 'SEC', type: 'individual' | 'firm', crd: string): Promise<'Active' | 'Inactive' | 'Terminated' | null> {
	const cacheKey = `${source}:${type}:${crd}`;
	let promise = statusCache.get(cacheKey);
	if (!promise) {
		promise = (async () => {
			try {
				const key = `${source.toLowerCase()}:${type}:${crd}`;
				const rawData = await loadSavedPayload(key);
				if (!rawData) return null;
				const content = normalizeRawPayload(rawData) as Record<string, unknown>;
				const bi = getObject(content.basicInformation) || {};
				const terminatedBadge = deriveTerminatedBadge([bi.firmStatus, bi.firmStatusDate], [content.firmStatus, content.firmStatusDate]);
				if (terminatedBadge) return 'Terminated';
				const statusBadge = deriveStatusBadge(source === 'SEC' ? bi.iaScope : bi.bcScope, content.status, content.currentStatus);
				if (statusBadge?.label === 'Active') return 'Active';
				if (statusBadge?.label === 'Inactive') return 'Inactive';
				return null;
			} catch {
				return null;
			}
		})();
		statusCache.set(cacheKey, promise);
	}
	return promise;
}

// Resolves a connection's real status (and, when the source wasn't already
// known, which source it was found under) by checking FINRA first then SEC.
async function resolveConnectionStatus(targetType: 'individual' | 'firm', c: Connection): Promise<{ source?: 'FINRA' | 'SEC'; status?: 'Active' | 'Inactive' | 'Terminated' }> {
	if (c.source) {
		const status = await deriveConnectionStatus(c.source, targetType, c.targetCrd);
		return { source: c.source, status: status || undefined };
	}
	const finraStatus = await deriveConnectionStatus('FINRA', targetType, c.targetCrd);
	if (finraStatus) return { source: 'FINRA', status: finraStatus };
	const secStatus = await deriveConnectionStatus('SEC', targetType, c.targetCrd);
	if (secStatus) return { source: 'SEC', status: secStatus };
	return {};
}

// Same per-source status derivation used for connection cards, but checks
// BOTH FINRA and SEC (rather than stopping at the first hit) so the main
// node card can show every status tag the dashboard's top banner would show
// (e.g. "FINRA: Active" AND "SEC: Active" simultaneously).
async function deriveNodeStatusBadges(type: 'individual' | 'firm', crd: string): Promise<{ source: 'FINRA' | 'SEC'; status: 'Active' | 'Inactive' | 'Terminated' }[]> {
	const [finraStatus, secStatus] = await Promise.all([deriveConnectionStatus('FINRA', type, crd), deriveConnectionStatus('SEC', type, crd)]);
	const badges: { source: 'FINRA' | 'SEC'; status: 'Active' | 'Inactive' | 'Terminated' }[] = [];
	if (finraStatus) badges.push({ source: 'FINRA', status: finraStatus });
	if (secStatus) badges.push({ source: 'SEC', status: secStatus });
	return badges;
}

// Runs async work over a list with a bounded number of in-flight requests,
// so a node with hundreds of connections doesn't fire hundreds of
// simultaneous Redis reads at once.
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	async function worker() {
		while (true) {
			const i = next++;
			if (i >= items.length) return;
			results[i] = await fn(items[i]);
		}
	}
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

// FINRA directOwners/indirectOwners rows store `legalName` as
// "LAST, FIRST MIDDLE" in all caps — reformat to "First Middle Last" title
// case for display, matching how individual names read elsewhere in the app.
function formatOwnerName(raw: string): string {
	const trimmed = (raw || '').trim();
	if (!trimmed) return trimmed;
	const commaIdx = trimmed.indexOf(',');
	const rearranged = commaIdx !== -1 ? `${trimmed.slice(commaIdx + 1).trim()} ${trimmed.slice(0, commaIdx).trim()}` : trimmed;
	return rearranged
		.toLowerCase()
		.split(' ')
		.filter(Boolean)
		.map((word) =>
			word
				.split('-')
				.map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
				.join('-'),
		)
		.join(' ');
}

function buildIndividualName(bi: any) {
	if (!bi) return '';
	const parts = [bi.firstName, bi.middleName, bi.lastName, bi.suffix]
		.filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
		.map((part) => part.trim());

	if (parts.length > 0) return parts.join(' ');
	return bi.individualName || bi.fullName || bi.displayName || 'Unknown';
}

async function loadNodeFromMatch(crd: string, entry: { key: string; source: string; type: string }): Promise<{ info: NodeInfo; raw: any }> {
	const rawData = await loadSavedPayload(entry.key);
	const payload = normalizeRawPayload(rawData);
	const bi = getObject(payload.basicInformation) || {};
	const source = entry.source;
	const type = entry.type;

	const name = type === 'individual' ? buildIndividualName(bi) : bi.firmName || bi.orgName || bi.organizationName || 'Unknown';

	const city = bi.city || payload.currentEmployments?.[0]?.city || '';
	const state = bi.state || payload.currentEmployments?.[0]?.state || '';

	// Firms: full office/mailing address from firmAddressDetails, plus the
	// bcScope's formedDate as "Established". Individuals: fall back to the
	// branch office address of their current employment (no equivalent
	// "established" date exists for a person).
	const firmAddress = getObject(payload.firmAddressDetails) || {};
	const branchOffice = payload.currentEmployments?.[0]?.branchOfficeLocations?.[0];
	const address = type === 'firm' ? formatAddress(firmAddress.officeAddress) || formatAddress(firmAddress.mailingAddress) || undefined : formatAddress(branchOffice) || undefined;
	const established = type === 'firm' ? toAddressText(bi.formedDate) || undefined : undefined;

	return {
		info: {
			crd,
			name: String(name),
			type: type as 'individual' | 'firm',
			source,
			location: city && state ? `${city}, ${state}` : undefined,
			status: String(bi.bcScope || bi.firmStatus || '') || undefined,
			address,
			established,
		},
		raw: payload,
	};
}

type LoadNodeResult =
	| { kind: 'found'; info: NodeInfo; raw: any }
	| { kind: 'ambiguous'; options: { crd: string; type: 'individual' | 'firm'; name: string; source: string }[] }
	| { kind: 'orphan'; owner: OwnerReference }
	| { kind: 'not_found' };

// A CRD can exist only as a directOwners/indirectOwners reference scraped
// from a firm's own detail payload — no live individual record of its own
// (see findOwnerReference in _graphIndex.ts, the same lookup the dashboard's
// pages/api/key.ts uses to build its "orphan" fallback bundle).
async function tryOrphanReference(crd: string, requestedType?: string): Promise<LoadNodeResult | null> {
	if (requestedType === 'firm') return null;
	const owner = await findOwnerReference(crd).catch(() => null);
	return owner ? { kind: 'orphan', owner } : null;
}

async function loadNode(crd: string, requestedType?: string): Promise<LoadNodeResult> {
	// Redis-backed lookup: find any saved finra/sec individual/firm key for this
	// CRD (prefer finra, then individual) rather than reading local disk files.
	let { keys } = await listSavedKeysWithStats({ includeCrds: [crd], limit: 10, sort: 'date-desc' });
	let matches = keys.filter((entry) => entry.crd === crd);
	if (!matches.length) {
		// Rule 3 (Missing & Corrupt CRD Handling): the CRD isn't cached yet —
		// query upstream FINRA/SEC detail endpoints (for both entity types,
		// since a bare CRD doesn't tell us which one it is) and persist any
		// valid payload to Redis before giving up.
		await Promise.all([hydrateFromUpstream('firm', crd), hydrateFromUpstream('individual', crd)]);
		({ keys } = await listSavedKeysWithStats({ includeCrds: [crd], limit: 10, sort: 'date-desc' }));
		matches = keys.filter((entry) => entry.crd === crd);
	}
	if (!matches.length) {
		return (await tryOrphanReference(crd, requestedType)) || { kind: 'not_found' };
	}

	// A bare CRD number can independently coincide with both an individual
	// and a firm record (they're assigned from separate FINRA/SEC sequences).
	// If the caller told us which one they want (requestedType), honor it. If
	// not, and the cached/hydrated matches span more than one entity type,
	// don't silently guess — surface both options so the UI can ask the user.
	const distinctTypes = Array.from(new Set(matches.map((entry) => entry.type)));

	if (requestedType === 'individual' || requestedType === 'firm') {
		matches = matches.filter((entry) => entry.type === requestedType);
		if (!matches.length) {
			return (await tryOrphanReference(crd, requestedType)) || { kind: 'not_found' };
		}
	} else if (distinctTypes.length > 1) {
		const options = await Promise.all(
			distinctTypes.map(async (type) => {
				const preferred = matches
					.filter((entry) => entry.type === type)
					.sort((a, b) =>
						a.source === 'finra' ? -1
						: b.source === 'finra' ? 1
						: 0,
					)[0];
				const { info } = await loadNodeFromMatch(crd, preferred);
				return { crd, type: type as 'individual' | 'firm', name: info.name, source: info.source };
			}),
		);
		return { kind: 'ambiguous', options };
	}

	const preferred = matches.find((entry) => entry.source === 'finra') || matches[0];
	const { info, raw } = await loadNodeFromMatch(crd, preferred);
	return { kind: 'found', info, raw };
}

function generateAscii(node: NodeInfo, connections: Connection[]): string {
	const header = `[ ${node.type.toUpperCase()}: ${node.name} (CRD ${node.crd}) ]`;
	let lines = [header];

	if (connections.length === 0) {
		lines.push('       |');
		lines.push('       +-- (No known connections in cache)');
		return lines.join('\n');
	}

	connections.forEach((conn, i) => {
		const isLast = i === connections.length - 1;
		const prefix = '       |';
		const branch = isLast ? '       +--' : '       +--';

		let detail = `(${conn.type}${conn.role ? `: ${conn.role}` : ''})`;
		if (conn.dates) detail += ` [${conn.dates}]`;

		lines.push(prefix);
		lines.push(`${branch} ${detail} --> [ ${conn.targetName} (CRD ${conn.targetCrd}) ]`);
	});

	return lines.join('\n');
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
	const { crd, type: requestedType } = req.query;

	if (!crd || typeof crd !== 'string') {
		return res.json({ error: 'CRD parameter is required' });
	}

	try {
		const nodeData = await loadNode(crd, typeof requestedType === 'string' ? requestedType : undefined);
		if (nodeData.kind === 'not_found') {
			return res.status(404).json({ error: `CRD ${crd} not found in Redis or upstream FINRA/SEC records` });
		}
		if (nodeData.kind === 'ambiguous') {
			return res.json({ ambiguous: true, crd, options: nodeData.options });
		}
		if (nodeData.kind === 'orphan') {
			// Same generic "no live CRD" fallback the dashboard renders (see
			// buildOrphanBundle in pages/api/key.ts / StatusBox.tsx's orphan
			// card) — this person only exists as a directOwners/indirectOwners
			// reference scraped from the parent firm's own detail payload, so
			// build a synthetic node pointing back at that firm instead of a
			// dead-end "not found" error.
			const owner = nodeData.owner;
			const info: NodeInfo = {
				crd,
				name: owner.name || crd,
				type: 'individual',
				source: 'scraped',
				location: formatAddress(owner.officeAddress) || formatAddress(owner.mailingAddress) || undefined,
				status: 'No live CRD (scraped reference only)',
			};
			const connections: Connection[] = [
				{
					targetCrd: owner.parentCrd,
					targetName: owner.firmName || owner.parentCrd,
					type: 'OWNER/EXEC',
					role: owner.position || undefined,
				},
			];
			const resolved = await mapWithConcurrency(connections, 5, (c) => resolveConnectionStatus('firm', c));
			resolved.forEach((r, i) => {
				if (r.source) connections[i].source = r.source;
				if (r.status) connections[i].status = r.status;
			});
			const ascii = generateAscii(info, connections);
			return res.json({
				info,
				connections,
				ascii,
				analysis: `${info.name} (CRD ${crd}) has no live CRD of its own — it only appears as a directOwners/indirectOwners reference scraped from ${connections[0].targetName}'s own detail record${owner.position ? ` as "${owner.position}"` : ''}.`,
				orphan: owner,
			});
		}

		const { info, raw } = nodeData;
		info.statusBadges = await deriveNodeStatusBadges(info.type, crd);
		const connections: Connection[] = [];

		if (info.type === 'individual') {
			// Current Employments
			const cur: any[] = Array.isArray(raw.currentEmployments) ? raw.currentEmployments : [];
			const curIA: any[] = Array.isArray(raw.currentIAEmployments) ? raw.currentIAEmployments : [];

			cur.forEach((emp) => {
				const e = getObject(emp);
				if (e && e.firmId) {
					connections.push({
						targetCrd: String(e.firmId),
						targetName: String(e.firmName || 'Unknown Firm'),
						type: 'CURRENT',
						dates: e.registrationBeginDate ? `Since ${e.registrationBeginDate}` : undefined,
						source: 'FINRA',
					});
				}
			});
			curIA.forEach((emp) => {
				const e = getObject(emp);
				if (e && e.firmId) {
					connections.push({
						targetCrd: String(e.firmId),
						targetName: String(e.firmName || 'Unknown Firm'),
						type: 'CURRENT',
						dates: e.registrationBeginDate ? `Since ${e.registrationBeginDate}` : undefined,
						source: 'SEC',
					});
				}
			});

			// Previous Employments
			const prev: any[] = Array.isArray(raw.previousEmployments) ? raw.previousEmployments : [];
			const prevIA: any[] = Array.isArray(raw.previousIAEmployments) ? raw.previousIAEmployments : [];
			prev.forEach((emp) => {
				const e = getObject(emp);
				if (e && e.firmId) {
					connections.push({
						targetCrd: String(e.firmId),
						targetName: String(e.firmName || 'Unknown Firm'),
						type: 'PREVIOUS',
						dates: `${e.registrationBeginDate || '?'} - ${e.registrationEndDate || '?'}`,
						source: 'FINRA',
					});
				}
			});
			prevIA.forEach((emp) => {
				const e = getObject(emp);
				if (e && e.firmId) {
					connections.push({
						targetCrd: String(e.firmId),
						targetName: String(e.firmName || 'Unknown Firm'),
						type: 'PREVIOUS',
						dates: `${e.registrationBeginDate || '?'} - ${e.registrationEndDate || '?'}`,
						source: 'SEC',
					});
				}
			});
		} else {
			// Firm Owners/Executives
			const owners = Array.isArray(raw.directOwners) ? raw.directOwners : [];
			owners.forEach((owner: unknown) => {
				const o = getObject(owner);
				if (o && o.crdNumber) {
					connections.push({
						targetCrd: String(o.crdNumber),
						targetName: formatOwnerName(String(o.legalName || '')) || 'Unknown Person',
						type: 'OWNER/EXEC',
						role: String(o.position || ''),
						source: info.source.toUpperCase() === 'SEC' ? 'SEC' : 'FINRA',
					});
				}
			});

			// Current/Previous employee connections — firm payloads never include
			// a reverse list of their employees, so this mirrors the dashboard's
			// approach (see useFirmEmployeeConnections in StatusBox.tsx) of
			// scanning the employment graph index for individuals who list this
			// firm as a current or previous employer.
			try {
				const firmId = buildNodeId('firm', info.crd);
				const { nodes: neighborNodes, links: neighborLinks } = await expandNodes([firmId], 1);
				const nodeById = new Map(neighborNodes.map((n) => [n.id, n]));
				neighborLinks.forEach((link) => {
					if (link.relationship !== 'employment' || link.target !== firmId) return;
					const person = nodeById.get(link.source);
					if (!person) return;
					connections.push({
						targetCrd: person.crd,
						targetName: person.label,
						type: link.isCurrent ? 'CURRENT' : 'PREVIOUS',
						role: [person.city, person.state].filter(Boolean).join(', ') || undefined,
					});
				});
			} catch {
				// leave employee connections empty on index-build failure
			}
		}

		// Deduplicate connections by targetCrd, type and source (a person can
		// have both a FINRA broker employment and a SEC IA employment at the
		// same firm at once, so source must be part of the key)
		const seen = new Set();
		const uniqueConnections = connections.filter((c) => {
			const key = `${c.targetCrd}-${c.type}-${c.role}-${c.source || ''}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});

		// Attach each connection's own live status (Active/Inactive/Terminated)
		// and confirmed source, matching the entity's own record banner
		// instead of guessing from the current/previous relationship type.
		const targetType: 'individual' | 'firm' = info.type === 'individual' ? 'firm' : 'individual';
		const resolved = await mapWithConcurrency(uniqueConnections, 40, (c) => resolveConnectionStatus(targetType, c));
		resolved.forEach((r, i) => {
			if (r.source) uniqueConnections[i].source = r.source;
			if (r.status) uniqueConnections[i].status = r.status;
		});

		const ascii = generateAscii(info, uniqueConnections);

		return res.json({
			info,
			connections: uniqueConnections,
			ascii,
			analysis: `Node ${info.name} (CRD ${info.crd}) is a ${info.type} from ${info.source}. It has ${uniqueConnections.length} recorded connection(s) in Redis.`,
		});
	} catch (error) {
		return res.status(500).json({ error: formatErrorMessage(error) });
	}
}
