// Read-only graph/expansion helpers.
//
// IMPORTANT: everything in this module only *reads* from Redis (via the
// existing _lib.ts helpers). Nothing here writes or mutates Redis state.
import { promises as fs } from 'fs';
import path from 'path';
import { bucketConnectionRows, extractConnectionRows } from '../../src/components/panel/connectionData';
import { toProperCaseName } from '../../src/lib/format';
import { deriveStatusBadge, deriveTerminatedBadge } from '../../src/lib/statusBadge';
import { listSavedKeysWithStats, loadSavedPayload, normalizeRawPayload, loadCombinedSavedPayloadBundle, type SavedKeyStat } from './_lib';

export type GraphEntityType = 'individual' | 'firm';

export interface GraphNode {
	id: string;
	label: string;
	group: GraphEntityType;
	crd: string;
	// Branch office location for the employment relationship this node was
	// discovered through (individual nodes reached via a firm's employee
	// index only — see buildFirmEmployeeIndex/getFirmNeighbors below).
	city?: string;
	state?: string;
	/** True when FINRA/SEC saved payloads show inactive/terminated and not active. */
	inactive?: boolean;
}

export interface GraphLink {
	source: string;
	target: string;
	relationship: 'employment' | 'ownership';
	isCurrent: boolean;
}

const MAX_HOPS = 5;

export function decodeNodeId(value: string | string[] | null | undefined): string {
	const raw = Array.isArray(value) ? value[0] : value;
	const trimmed = String(raw || '').trim();
	if (!trimmed) return '';
	try {
		return decodeURIComponent(trimmed);
	} catch {
		return trimmed;
	}
}

export function normalizeHopsParam(value: string | null | undefined): number | 'all' {
	if (typeof value === 'string' && value.trim().toLowerCase() === 'all') return 'all';
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 1) return 1;
	return Math.floor(parsed);
}

export function buildNodeId(type: GraphEntityType, crd: string) {
	return `${type}:${crd}`;
}

export function parseNodeId(value: string): { type: GraphEntityType; crd: string } | null {
	const match = String(value || '')
		.trim()
		.match(/^(individual|person|firm)\s*:\s*(\d+)$/i);
	if (!match) return null;
	const rawType = match[1].toLowerCase();
	const type: GraphEntityType = rawType === 'firm' ? 'firm' : 'individual';
	return { type, crd: match[2] };
}

function getObject(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function personDisplayName(content: Record<string, unknown> | null, crd: string): string {
	const bi = getObject(content?.basicInformation) || content || {};
	const name = [bi.firstName, bi.middleName, bi.lastName, bi.suffix]
		.map((part) => String(part || '').trim())
		.filter(Boolean)
		.join(' ');
	const orphan = getObject((content as any)?.orphan);
	const rawName =
		name ||
		(bi.individualName as string) ||
		(bi.fullName as string) ||
		(typeof orphan?.name === 'string' ? orphan.name : '') ||
		(content?.name as string) ||
		(content?.ownerName as string) ||
		(content?.legalName as string);
	// Upstream FINRA/SEC records mix ALL CAPS, lowercase, and Title Case
	// across name fields, so normalize before displaying.
	// Prefer bare CRD digits over generic "Individual/CRD …" labels.
	return rawName ? toProperCaseName(rawName) : crd;
}

function firmDisplayName(content: Record<string, unknown> | null, crd: string): string {
	const bi = getObject(content?.basicInformation) || content || {};
	return (bi.firmName as string) || (bi.orgName as string) || (bi.organizationName as string) || (bi.iaFirmName as string) || (content?.firmName as string) || crd;
}

function isGenericGraphLabel(label: string, type: GraphEntityType, crd: string): boolean {
	const trimmed = String(label || '')
		.replace(/\s+/g, ' ')
		.trim();
	if (!trimmed) return true;
	const lower = trimmed.toLowerCase();
	if (/^(individual|firm|person|crd)(\s+#?\d+)?$/i.test(trimmed)) return true;
	if (lower === `crd ${crd}`.toLowerCase() || lower === crd.toLowerCase()) return true;
	if (lower === `${type} ${crd}`.toLowerCase()) return true;
	return false;
}

async function getEntityLabel(type: GraphEntityType, crd: string): Promise<string> {
	const { keys } = await listSavedKeysWithStats({ includeCrds: [crd], type, limit: 10, sort: 'crd-desc' });
	const withName = keys.find((entry) => entry.crd === crd && entry.type === type && entry.displayName);
	if (withName?.displayName && !isGenericGraphLabel(withName.displayName, type, crd)) {
		return withName.displayName;
	}
	// Orphan individuals only exist as owner refs on a firm payload.
	if (type === 'individual') {
		const owner = await findOwnerReference(crd).catch(() => null);
		if (owner?.name && !isGenericGraphLabel(owner.name, type, crd)) {
			return toProperCaseName(owner.name);
		}
	}
	try {
		const bundle = await loadCombinedSavedPayloadBundle(`finra:${type}:${crd}`);
		for (const source of ['finra', 'sec'] as const) {
			const record = bundle.sources[source];
			if (!record?.found || !record.payload) continue;
			const content = record.payload as Record<string, unknown>;
			const label = type === 'individual' ? personDisplayName(content, crd) : firmDisplayName(content, crd);
			if (label && !isGenericGraphLabel(label, type, crd)) return label;
		}
		const orphan = (bundle as any)?.orphan;
		if (orphan && typeof orphan === 'object' && typeof orphan.name === 'string' && orphan.name.trim()) {
			return toProperCaseName(orphan.name);
		}
	} catch {
		// fall through
	}
	// Last resort: bare CRD — never "Individual/Firm <crd>".
	return crd;
}

// Same active/inactive policy as the graph UI (`isDetailPayloadInactive`): gray
// only when at least one source is inactive/terminated and none are active.
function evaluateContentActivity(content: Record<string, unknown> | null | undefined, source: 'finra' | 'sec'): 'active' | 'inactive' | null {
	if (!content || typeof content !== 'object') return null;
	const bi = getObject(content.basicInformation) || {};
	const terminated = deriveTerminatedBadge([bi.firmStatus, bi.firmStatusDate], [content.firmStatus, content.firmStatusDate]);
	const status = deriveStatusBadge(source === 'sec' ? bi.iaScope : bi.bcScope, content.status, content.currentStatus);
	const labels = [terminated?.label, status?.label].filter(Boolean).join(' ').toLowerCase();
	if (!labels) return null;
	if (/(^|\s)active(\s|$)/.test(labels) && !/inactive/.test(labels) && !/terminated/.test(labels)) return 'active';
	if (/inactive|terminated|not in scope|notinscope/.test(labels)) return 'inactive';
	return null;
}

const entityInactiveCache = new Map<string, Promise<boolean>>();

async function isEntityInactive(type: GraphEntityType, crd: string): Promise<boolean> {
	const cacheKey = `${type}:${crd}`;
	let promise = entityInactiveCache.get(cacheKey);
	if (!promise) {
		promise = (async () => {
			try {
				const bundle = await loadCombinedSavedPayloadBundle(`finra:${type}:${crd}`);
				const flags: Array<'active' | 'inactive'> = [];
				for (const source of ['finra', 'sec'] as const) {
					const record = bundle.sources[source];
					if (!record?.found || !record.payload) continue;
					const flag = evaluateContentActivity(record.payload as Record<string, unknown>, source);
					if (flag) flags.push(flag);
				}
				if (!flags.length) return false;
				return flags.every((f) => f === 'inactive');
			} catch {
				return false;
			}
		})();
		entityInactiveCache.set(cacheKey, promise);
	}
	return promise;
}

async function annotateNodeInactive(node: GraphNode): Promise<GraphNode> {
	if (typeof node.inactive === 'boolean') return node;
	const inactive = await isEntityInactive(node.group, node.crd);
	return inactive ? { ...node, inactive: true } : { ...node, inactive: false };
}

function extractFirmCrd(row: Record<string, unknown>): string {
	const raw = row.firmId ?? row.firmCrd ?? row.firmCRDNb ?? row.firmCrdNumber;
	const text = String(raw ?? '').trim();
	if (!text) return '';
	const normalized = text.replace(/^0+/, '') || '0';
	return /^\d+$/.test(normalized) ? normalized : '';
}

function extractOwnerCrd(row: Record<string, unknown>): string {
	const raw = row.crdNumber ?? row.ownerCrd ?? row.ownerCrdNumber ?? row.ownerCRDNb;
	const text = String(raw ?? '').trim();
	if (!text) return '';
	const normalized = text.replace(/^0+/, '') || '0';
	return /^\d+$/.test(normalized) ? normalized : '';
}

// currentEmployments/currentIAEmployments rows nest their office location in
// branchOfficeLocations (keyed by locatedAtFlag === 'Y'), while
// previousEmployments/previousIAEmployments rows carry flat city/state
// fields directly. Check both shapes so both current and previous
// connections resolve a location.
function extractRowCityState(row: Record<string, unknown>): { city: string; state: string } {
	const locations = Array.isArray(row.branchOfficeLocations) ? (row.branchOfficeLocations as Record<string, unknown>[]) : [];
	const primary = locations.find((loc) => loc?.locatedAtFlag === 'Y') || locations[0];
	if (primary) {
		const city = String(primary.city || '').trim();
		const state = String(primary.state || '').trim();
		if (city || state) return { city, state };
	}
	return { city: String(row.city || '').trim(), state: String(row.state || '').trim() };
}

// --- Reverse employment index (firm CRD -> employees) -----------------------
//
// Built by scanning saved individual payloads (Redis-backed via
// listSavedKeysWithStats / loadSavedPayload) and cached in-memory per
// server instance. Follows the same signature-based caching pattern already
// used by local-name-search.ts. This never writes to Redis.

type EmploymentEdge = { personCrd: string; personName: string; isCurrent: boolean; city: string; state: string; firmName?: string };

let cachedSignature = '';
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
}

export type EmploymentReference = {
	parentType: 'individual';
	parentCrd: string;
	name: string;
	firmName?: string;
	city?: string;
	state?: string;
};

export async function findEmploymentReference(crd: string): Promise<EmploymentReference | null> {
	const normalized = String(crd || '').trim();
	if (!normalized) return null;
	const index = await getFirmEmployeeIndex();
	const edges = index.get(normalized);
	if (!edges || !edges.length) return null;
	const edge = edges[0];
	return {
		parentType: 'individual',
		parentCrd: edge.personCrd,
		name: edge.personName,
		firmName: edge.firmName,
		city: edge.city,
		state: edge.state,
	};
}

// --- Owner-reference index (individual CRD -> parent firm) -------------------
//
// Some individuals only ever appear as a `directOwners`/`indirectOwners`
// entry scraped from a firm's own detail payload (typically with
// bcScope/iaScope "NotInScope") and never have an independent BrokerCheck/SEC
// record of their own. When a lookup for such a CRD 404s, this index lets
// pages/api/key.ts point the caller back at the parent firm instead of
// surfacing a dead-end "record not found" error. Built by scanning saved
// firm payloads (Redis-backed) and cached in-memory, same pattern as
// buildFirmEmployeeIndex above.

export type OwnerReference = {
	parentType: 'firm';
	parentCrd: string;
	name: string;
	position: string;
	firmName?: string;
	officeAddress?: unknown;
	mailingAddress?: unknown;
	phone?: string;
};

let cachedOwnerSignature = '';
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
}

// FINRA's directOwners/indirectOwners rows store legalName as "LAST, FIRST
// MIDDLE" (comma-separated), matching how firm/parent-company rows also
// (confusingly) reuse this field — see looksLikePersonalName in StatusBox.tsx.
// The rest of the app displays individuals as "First Middle Last" (built from
// firstName/middleName/lastName in extractNamesFromPayload), so reorder here
// to match that convention for the orphan-CRD display.
function toFirstMiddleLastOrder(properCaseName: string): string {
	const commaIndex = properCaseName.indexOf(',');
	if (commaIndex === -1) return properCaseName;
	const last = properCaseName.slice(0, commaIndex).trim();
	const rest = properCaseName.slice(commaIndex + 1).trim();
	if (!last || !rest) return properCaseName;
	return `${rest} ${last}`;
}

function indexOwnersFromFirmPayload(index: Map<string, OwnerReference>, parentCrd: string, normalized: Record<string, unknown>) {
	const owners = [
		...(Array.isArray(normalized.directOwners) ? (normalized.directOwners as Record<string, unknown>[]) : []),
		...(Array.isArray(normalized.indirectOwners) ? (normalized.indirectOwners as Record<string, unknown>[]) : []),
	];
	if (!owners.length) return;
	const basicInformation = normalized.basicInformation && typeof normalized.basicInformation === 'object' ? (normalized.basicInformation as Record<string, unknown>) : {};
	const firmAddressDetails = normalized.firmAddressDetails && typeof normalized.firmAddressDetails === 'object' ? (normalized.firmAddressDetails as Record<string, unknown>) : {};
	const iaFirmAddressDetails =
		normalized.iaFirmAddressDetails && typeof normalized.iaFirmAddressDetails === 'object' ? (normalized.iaFirmAddressDetails as Record<string, unknown>) : {};
	const firmName = String(basicInformation.iaFirmName || basicInformation.firmName || '').trim() || undefined;
	const officeAddress = firmAddressDetails.officeAddress || iaFirmAddressDetails.officeAddress || undefined;
	const mailingAddress = firmAddressDetails.mailingAddress || iaFirmAddressDetails.mailingAddress || undefined;
	const phone = String(firmAddressDetails.businessPhoneNumber || iaFirmAddressDetails.businessPhoneNumber || '').trim() || undefined;
	for (const owner of owners) {
		const ownerCrd = extractOwnerCrd(owner) || String(owner.crdNumber || '').trim();
		if (!ownerCrd || index.has(ownerCrd)) continue;
		const properCaseName = toProperCaseName(String(owner.legalName || owner.ownerName || ''));
		index.set(ownerCrd, {
			parentType: 'firm',
			parentCrd,
			name: toFirstMiddleLastOrder(properCaseName) || ownerCrd,
			position: String(owner.position || '').trim(),
			firmName,
			officeAddress,
			mailingAddress,
			phone,
		});
	}
}

// Some firms (e.g. those only ever fetched from the national BrokerCheck
// search-cache snapshot in data/national/) are never written to Redis, so
// listSavedKeysWithStats alone misses their directOwners/indirectOwners
// references. Scan the FINRA firm snapshot files on disk too so owners of
// those firms (like BENDL, JOHN WESLEY under firm 7452) still resolve.
const NATIONAL_DIR = path.resolve(process.cwd(), 'data', 'national');

async function indexOwnersFromNationalSnapshots(index: Map<string, OwnerReference>) {
	let fileNames: string[] = [];
	try {
		fileNames = await fs.readdir(NATIONAL_DIR);
	} catch {
		return;
	}

	const firmFiles = fileNames.filter((name) => /^api\.brokercheck\.finra\.org_search_firm_\d+\.json$/i.test(name));

	await Promise.all(
		firmFiles.map(async (fileName) => {
			const match = fileName.match(/_firm_(\d+)\.json$/i);
			const parentCrd = match?.[1];
			if (!parentCrd) return;
			try {
				const raw = await fs.readFile(path.join(NATIONAL_DIR, fileName), 'utf-8');
				const parsed = JSON.parse(raw);
				const normalized = normalizeRawPayload(parsed) as Record<string, unknown>;
				indexOwnersFromFirmPayload(index, parentCrd, normalized);
			} catch {
				// skip unreadable/malformed snapshot files
			}
		}),
	);
}

async function buildOwnerReferenceIndex(): Promise<Map<string, OwnerReference>> {
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
}

// Looks up whether `crd` only exists as a directOwners/indirectOwners
// reference inside some firm's saved payload (i.e. it has no live CRD of its
// own). Returns null when no such reference is found.
export async function findOwnerReference(crd: string): Promise<OwnerReference | null> {
	const normalized = String(crd || '').trim();
	if (!normalized) return null;
	const index = await getOwnerReferenceIndex();
	return index.get(normalized) || null;
}

// --- Per-node neighbor lookup -------------------------------------------------

async function getIndividualNeighbors(crd: string): Promise<{ nodes: GraphNode[]; links: GraphLink[] }> {
	const nodes = new Map<string, GraphNode>();
	const links: GraphLink[] = [];
	const personId = buildNodeId('individual', crd);

	let bundle;
	try {
		bundle = await loadCombinedSavedPayloadBundle(`finra:individual:${crd}`);
	} catch {
		return { nodes: [], links: [] };
	}

	for (const source of ['finra', 'sec'] as const) {
		const record = bundle.sources[source];
		if (!record.found || !record.payload) continue;
		const content = record.payload as Record<string, unknown>;
		const rows = extractConnectionRows(content);
		if (!rows.length) continue;
		const { current, previous } = bucketConnectionRows(rows);

		const addFirmEdge = async (row: Record<string, unknown>, isCurrent: boolean) => {
			const firmCrd = extractFirmCrd(row);
			if (!firmCrd) return;
			const firmId = buildNodeId('firm', firmCrd);
			if (!nodes.has(firmId)) {
				// Prefer the firm's own canonical saved-key display name over the
				// (sometimes inconsistently cased) name embedded in the employment row.
				const canonicalLabel = await getEntityLabel('firm', firmCrd);
				const embeddedName = String(row.firmName || '').trim();
				const label = canonicalLabel && !isGenericGraphLabel(canonicalLabel, 'firm', firmCrd) ? canonicalLabel : embeddedName || canonicalLabel || firmCrd;
				nodes.set(firmId, { id: firmId, label, group: 'firm', crd: firmCrd });
			}
			links.push({ source: personId, target: firmId, relationship: 'employment', isCurrent });
		};

		for (const row of current) await addFirmEdge(row, true);
		for (const row of previous) await addFirmEdge(row, false);
	}

	return { nodes: Array.from(nodes.values()), links };
}

async function getFirmNeighbors(crd: string): Promise<{ nodes: GraphNode[]; links: GraphLink[] }> {
	const nodes = new Map<string, GraphNode>();
	const links: GraphLink[] = [];
	const firmId = buildNodeId('firm', crd);

	let bundle;
	try {
		bundle = await loadCombinedSavedPayloadBundle(`finra:firm:${crd}`);
	} catch {
		bundle = null;
	}

	if (bundle) {
		for (const source of ['finra', 'sec'] as const) {
			const record = bundle.sources[source];
			if (!record.found || !record.payload) continue;
			const content = record.payload as Record<string, unknown>;
			const owners = [
				...(Array.isArray(content.directOwners) ? (content.directOwners as Record<string, unknown>[]) : []),
				...(Array.isArray(content.indirectOwners) ? (content.indirectOwners as Record<string, unknown>[]) : []),
			];
			for (const owner of owners) {
				const ownerCrd = extractOwnerCrd(owner);
				if (!ownerCrd) continue;
				const ownerId = buildNodeId('individual', ownerCrd);
				if (!nodes.has(ownerId)) {
					// Prefer the owner's own canonical saved-key display name (already
					// normalized to Title Case) over the raw embedded owner name, which
					// upstream sources store inconsistently (ALL CAPS, lowercase, etc).
					const canonicalLabel = await getEntityLabel('individual', ownerCrd);
					const embeddedName = toProperCaseName(owner.ownerName || owner.legalName || owner.name);
					const label = canonicalLabel && !isGenericGraphLabel(canonicalLabel, 'individual', ownerCrd) ? canonicalLabel : embeddedName || canonicalLabel || ownerCrd;
					nodes.set(ownerId, { id: ownerId, label, group: 'individual', crd: ownerCrd });
				}
				links.push({ source: ownerId, target: firmId, relationship: 'ownership', isCurrent: true });
			}
		}
	}

	try {
		const employeeIndex = await getFirmEmployeeIndex();
		const employees = employeeIndex.get(crd) || [];
		for (const employee of employees) {
			const personId = buildNodeId('individual', employee.personCrd);
			if (!nodes.has(personId)) {
				nodes.set(personId, {
					id: personId,
					label: employee.personName,
					group: 'individual',
					crd: employee.personCrd,
					city: employee.city || undefined,
					state: employee.state || undefined,
				});
			}
			links.push({ source: personId, target: firmId, relationship: 'employment', isCurrent: employee.isCurrent });
		}
	} catch {
		// leave employment neighbors empty on index-build failure
	}

	return { nodes: Array.from(nodes.values()), links };
}

async function getEntityNeighbors(type: GraphEntityType, crd: string) {
	return type === 'individual' ? getIndividualNeighbors(crd) : getFirmNeighbors(crd);
}

// --- BFS expansion -------------------------------------------------------------

export async function expandNodes(seedIds: string[], hops: number | 'all' = 1): Promise<{ nodes: GraphNode[]; links: GraphLink[] }> {
	const nodes = new Map<string, GraphNode>();
	const links: GraphLink[] = [];
	const linkKeySeen = new Set<string>();
	const visited = new Set<string>();
	const maxHops = hops === 'all' ? MAX_HOPS : Math.max(1, Math.min(Number(hops) || 1, MAX_HOPS));

	let frontier = new Set(seedIds.map((id) => id.trim()).filter(Boolean));

	for (const id of frontier) {
		const parsed = parseNodeId(id);
		if (!parsed) continue;
		const normalizedId = buildNodeId(parsed.type, parsed.crd);
		if (!nodes.has(normalizedId)) {
			nodes.set(normalizedId, { id: normalizedId, label: await getEntityLabel(parsed.type, parsed.crd), group: parsed.type, crd: parsed.crd });
		}
	}

	let hopCount = 0;
	while (frontier.size > 0 && hopCount < maxHops) {
		const nextFrontier = new Set<string>();
		for (const id of frontier) {
			const parsed = parseNodeId(id);
			if (!parsed) continue;
			const normalizedId = buildNodeId(parsed.type, parsed.crd);
			if (visited.has(normalizedId)) continue;
			visited.add(normalizedId);

			const neighbors = await getEntityNeighbors(parsed.type, parsed.crd);
			for (const node of neighbors.nodes) {
				if (!nodes.has(node.id)) nodes.set(node.id, node);
				if (!visited.has(node.id)) nextFrontier.add(node.id);
			}
			for (const link of neighbors.links) {
				const linkKey = `${link.source}->${link.target}:${link.relationship}:${link.isCurrent}`;
				if (!linkKeySeen.has(linkKey)) {
					linkKeySeen.add(linkKey);
					links.push(link);
				}
			}
		}
		frontier = nextFrontier;
		hopCount += 1;
	}

	// Resolve inactive flags for every returned node so the client can gray
	// them on first paint (before any click-to-load panel payload).
	const annotated = await Promise.all(Array.from(nodes.values()).map((node) => annotateNodeInactive(node)));
	return { nodes: annotated, links };
}
