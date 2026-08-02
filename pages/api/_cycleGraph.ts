// Read-only, in-memory full graph builder used to find the largest cycle
// (or longest path) of connected CRDs starting from a given individual/firm.
//
// This scans EVERY saved Redis key once (via listSavedKeysWithStats +
// loadSavedPayload — Redis reads only, no upstream network calls) and builds
// an adjacency map covering the whole dataset. The result is cached
// in-memory with the same signature-based invalidation pattern already used
// by pages/api/_graphIndex.ts and pages/api/local-name-search.ts, so repeat
// requests are effectively instant and DFS/BFS never touches the network.
import { listSavedKeysWithStats, loadSavedPayload, normalizeRawPayload, type SavedKeyStat } from './_lib';

export type CycleNodeType = 'individual' | 'firm';

export interface CycleGraphNode {
	crd: string;
	type: CycleNodeType;
	name: string;
	otherNames: string;
	city: string;
	state: string;
	status: string;
	secNumber: string;
	terminationDetail: string;
	disclosures: string;
	dateActive: string;
	dateInactive: string;
}

export interface CycleGraphEdge {
	to: string; // `${type}:${crd}`
	isCurrent: boolean;
}

export interface CycleGraph {
	nodes: Map<string, CycleGraphNode>;
	adj: Map<string, CycleGraphEdge[]>;
}

export function nodeKey(type: string, crd: string) {
	return `${type}:${crd}`;
}

function getObj(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

// Same field-name fallbacks confirmed against the live upstream firm detail
// payload (see pages/api/_graphIndex.ts's extractFirmCrd/extractOwnerCrd) —
// `firmId` is the real employer-firm field on employment rows, `crdNumber`
// is the real owner-CRD field on directOwners/indirectOwners rows.
function extractFirmCrd(row: Record<string, unknown>): string {
	const raw = row.firmId ?? row.firmCrd ?? row.firmCRDNb ?? row.firmCrdNumber;
	const text = String(raw ?? '').trim();
	return /^\d+$/.test(text) ? text.replace(/^0+(?=\d)/, '') : '';
}

function extractOwnerCrd(row: Record<string, unknown>): string {
	const raw = row.crdNumber ?? row.ownerCrd ?? row.ownerCrdNumber ?? row.ownerCRDNb;
	const text = String(raw ?? '').trim();
	return /^\d+$/.test(text) ? text.replace(/^0+(?=\d)/, '') : '';
}

function buildNodeFromPayload(type: CycleNodeType, crd: string, payload: Record<string, unknown>): CycleGraphNode {
	const bi = getObj(payload.basicInformation);
	let name = '';
	let otherNames = '';
	let city = '';
	let state = '';
	let status = '';
	let secNumber = '';
	let terminationDetail = '';
	let disclosureDetail = '';
	let activeDate = '';
	let inactiveDate = '';

	if (type === 'individual') {
		name = [bi.firstName, bi.middleName, bi.lastName, bi.suffix]
			.map((p) => String(p || '').trim())
			.filter(Boolean)
			.join(' ');
		if (Array.isArray(payload.otherNames)) {
			otherNames = (payload.otherNames as Record<string, unknown>[])
				.map((nm) => [nm.firstName, nm.lastName].filter(Boolean).join(' '))
				.join(', ');
		}
		const emps = Array.isArray(payload.currentEmployments) ? (payload.currentEmployments as Record<string, unknown>[]) : [];
		const branch = getObj(emps[0]?.branchLocation);
		city = String(branch.city || '');
		state = String(branch.state || '');

		const prevEmps = Array.isArray(payload.previousEmployments) ? (payload.previousEmployments as Record<string, unknown>[]) : [];
		if (prevEmps.length > 0) inactiveDate = String(prevEmps[0].endDate || '');

		if (Array.isArray(payload.registeredStates) && payload.registeredStates.length > 0) {
			activeDate = String((payload.registeredStates as Record<string, unknown>[])[0]?.approvalDate || '');
		}

		status = String(bi.activeStatus || 'UNKNOWN');

		const disc = Array.isArray(payload.disclosures) ? (payload.disclosures as Record<string, unknown>[]) : [];
		const terms = disc.filter((d) => d.disclosureType === 'Termination' || d.DisclosureType === 'Termination');
		if (terms.length > 0) {
			terminationDetail = terms
				.map((t) => getObj(t.disclosureDetail).allegations || getObj(t.DisclosureDetail).Allegations || 'Terminated')
				.join('; ');
		}
		disclosureDetail = disc.length > 0 ? `Has ${disc.length} disclosures` : 'None';
	} else {
		name = String(bi.firmName || bi.orgName || bi.organizationName || '');
		if (Array.isArray(payload.otherNames)) {
			otherNames = (payload.otherNames as Record<string, unknown>[])
				.map((nm) => nm.firmName || nm.orgName)
				.filter(Boolean)
				.join(', ');
		}
		const addr = getObj(payload.firmAddressDetails) && Object.keys(getObj(payload.firmAddressDetails)).length ? getObj(payload.firmAddressDetails) : getObj(payload.mainAddress);
		city = String(addr.city || '');
		state = String(addr.state || '');
		status = String(bi.status || 'UNKNOWN');
		// bdSECNumber (broker-dealer) is the value the user's example is keyed
		// on; fall back to iaSECNumber (investment-adviser) when a firm only
		// has an IA registration.
		secNumber = String(bi.bdSECNumber || bi.iaSECNumber || '').trim();

		const disc = Array.isArray(payload.disclosures) ? (payload.disclosures as Record<string, unknown>[]) : [];
		disclosureDetail = disc.length > 0 ? `Has ${disc.length} disclosures` : 'None';
	}

	return { crd, type, name, otherNames, city, state, status, secNumber, terminationDetail, disclosures: disclosureDetail, dateActive: activeDate, dateInactive: inactiveDate };
}

// Edges are directed: individual -> firm (employment) and firm ->
// individual (ownership). Making these symmetric (e.g. firm -> every one of
// its employees) would let traversal fan out through every employee of any
// large employer, exploding the branching factor and burying the small,
// meaningful ownership/employment loops (like the user's James Dale Price
// example) inside enormous, practically meaningless "longest cycles".
function buildEdgesFromPayload(type: CycleNodeType, crd: string, payload: Record<string, unknown>): { from: string; to: string; isCurrent: boolean }[] {
	const selfKey = nodeKey(type, crd);
	const edges: { from: string; to: string; isCurrent: boolean }[] = [];

	if (type === 'individual') {
		const rowSets: [unknown, boolean][] = [
			[payload.currentEmployments, true],
			[payload.currentIAEmployments, true],
			[payload.previousEmployments, false],
			[payload.previousIAEmployments, false],
		];
		for (const [rows, isCurrent] of rowSets) {
			if (!Array.isArray(rows)) continue;
			for (const row of rows as Record<string, unknown>[]) {
				const firmCrd = extractFirmCrd(row);
				if (firmCrd) edges.push({ from: selfKey, to: nodeKey('firm', firmCrd), isCurrent });
			}
		}
	} else {
		const owners = [
			...(Array.isArray(payload.directOwners) ? (payload.directOwners as Record<string, unknown>[]) : []),
			...(Array.isArray(payload.indirectOwners) ? (payload.indirectOwners as Record<string, unknown>[]) : []),
		];
		for (const owner of owners) {
			const ownerCrd = extractOwnerCrd(owner);
			if (ownerCrd) edges.push({ from: selfKey, to: nodeKey('individual', ownerCrd), isCurrent: true });
		}
	}

	return edges;
}

function addDirectedEdge(adj: Map<string, CycleGraphEdge[]>, from: string, to: string, isCurrent: boolean) {
	const forward = adj.get(from) || [];
	forward.push({ to, isCurrent });
	adj.set(from, forward);
}

let cachedSignature = '';
let cachedGraph: CycleGraph | null = null;
let cachedGraphPromise: Promise<CycleGraph> | null = null;

async function getSignature() {
	const stats = await listSavedKeysWithStats({ limit: 0 });
	const newest = stats.keys[0];
	return `${stats.totalCount}:${newest?.key || ''}:${Math.round(Number(newest?.mtime || 0))}`;
}

async function buildGraph(): Promise<CycleGraph> {
	const { keys } = await listSavedKeysWithStats({ limit: 0 });

	// One entity ("type:crd") can have both a finra: and sec: saved key —
	// only load one payload per entity, preferring finra since it's the more
	// complete/authoritative source for employment + ownership rows.
	const byEntity = new Map<string, SavedKeyStat>();
	for (const entry of keys) {
		const id = nodeKey(entry.type, entry.crd);
		const existing = byEntity.get(id);
		if (!existing || (existing.source !== 'finra' && entry.source === 'finra')) {
			byEntity.set(id, entry);
		}
	}

	const nodes = new Map<string, CycleGraphNode>();
	const adj = new Map<string, CycleGraphEdge[]>();
	const entries = Array.from(byEntity.values());
	const CONCURRENCY = 40;
	let cursor = 0;

	async function worker() {
		while (cursor < entries.length) {
			const entry = entries[cursor++];
			try {
				const raw = await loadSavedPayload(entry.key);
				const payload = normalizeRawPayload(raw) as Record<string, unknown>;
				const id = nodeKey(entry.type, entry.crd);
				nodes.set(id, buildNodeFromPayload(entry.type, entry.crd, payload));
				for (const edge of buildEdgesFromPayload(entry.type, entry.crd, payload)) {
					addDirectedEdge(adj, edge.from, edge.to, edge.isCurrent);
				}
			} catch {
				// Skip unreadable/malformed entries — they simply won't
				// contribute nodes or edges to the graph.
			}
		}
	}

	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, entries.length) || 1 }, () => worker()));

	return { nodes, adj };
}

export async function getCycleGraph(): Promise<CycleGraph> {
	const signature = await getSignature();
	if (cachedGraph && cachedSignature === signature) return cachedGraph;
	if (cachedGraphPromise && cachedSignature === signature) return cachedGraphPromise;

	cachedSignature = signature;
	cachedGraphPromise = buildGraph()
		.then((graph) => {
			cachedGraph = graph;
			return graph;
		})
		.finally(() => {
			cachedGraphPromise = null;
		});

	return cachedGraphPromise;
}

// Adds a freshly-hydrated node (and its edges) directly into the shared
// cached graph in-memory, for the rare case where the requested start CRD
// hasn't been scanned into the graph yet (e.g. it was just hydrated from
// upstream for the first time). This mutates the existing cache rather than
// forcing a full rebuild; the next signature check will naturally rebuild
// from scratch once the saved-key count changes anyway.
export function mergeNodeIntoGraph(graph: CycleGraph, type: CycleNodeType, crd: string, payload: Record<string, unknown>) {
	const id = nodeKey(type, crd);
	if (!graph.nodes.has(id)) {
		graph.nodes.set(id, buildNodeFromPayload(type, crd, payload));
	}
	for (const edge of buildEdgesFromPayload(type, crd, payload)) {
		addDirectedEdge(graph.adj, edge.from, edge.to, edge.isCurrent);
	}
}

export function formatNodeLabel(node: CycleGraphNode | undefined, fallbackType: CycleNodeType, fallbackCrd: string): string {
	if (!node) return `CRD ${fallbackCrd}`;
	const name = node.name || (node.type === 'individual' ? `CRD ${node.crd}` : `Firm ${node.crd}`);
	if (node.type === 'firm' && node.secNumber) {
		return `${name} :: CRD# ${node.crd} / SEC# ${node.secNumber}`;
	}
	return `${name} :: CRD# ${node.crd}`;
}
