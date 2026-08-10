import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import * as d3 from 'd3';
import { useSharedGraphState } from '../../src/hooks/useSharedGraphState';
import { parseCrdKey } from '../../src/lib/parseKey';
import { extractNamesFromPayload, getContentBlock } from '../../src/lib/extractNames';
import { toProperCaseName } from '../../src/lib/format';
import { PanelHeader } from '../../src/components/panel/PanelHeader';
import { StatusBox } from '../../src/components/panel/StatusBox';

function stringValue(value: unknown): string | undefined {
	if (typeof value === 'string' && value.trim()) return value.trim();
	return undefined;
}

// Like stringValue but also accepts numeric IDs (firmId/crdNumber are often
// stored as numbers in FINRA/SEC payloads).
function idValue(value: unknown): string | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) return String(value);
	return stringValue(value);
}

function toArray(value: unknown): any[] {
	return Array.isArray(value) ? value : [];
}

function readSnapshotPayload(detailJson: string | null) {
	if (!detailJson) return null;
	try {
		const parsed = JSON.parse(detailJson);
		if (parsed && typeof parsed === 'object' && typeof (parsed as Record<string, unknown>).rawPayload === 'string') {
			try {
				return JSON.parse((parsed as Record<string, unknown>).rawPayload as string);
			} catch {
				return parsed;
			}
		}
		return parsed;
	} catch {
		return null;
	}
}

type GraphEntityType = 'individual' | 'firm';

type GraphNode = {
	id: string;
	label: string;
	kind: 'primary' | 'relation';
	/** Person vs firm — drives node fill color (blue vs orange). */
	entityType?: GraphEntityType;
	subLabel?: string;
	loadKey?: string;
	/** Business / branch location used to cluster nodes geographically. */
	city?: string;
	state?: string;
};

function normalizeLocationPart(value: unknown): string | undefined {
	const raw = stringValue(value);
	return raw ? raw.toLowerCase().replace(/\s+/g, ' ') : undefined;
}

// Soft US-region location grouping — ported from finra-data-chart-next-02
// (`src/lib/finra-graph.ts` LOCATION_REGION_ANCHORS / STATE_REGION_MAP).
const STATE_NAME_TO_CODE: Record<string, string> = {
	'alabama': 'AL',
	'alaska': 'AK',
	'arizona': 'AZ',
	'arkansas': 'AR',
	'california': 'CA',
	'colorado': 'CO',
	'connecticut': 'CT',
	'delaware': 'DE',
	'district of columbia': 'DC',
	'florida': 'FL',
	'georgia': 'GA',
	'hawaii': 'HI',
	'idaho': 'ID',
	'illinois': 'IL',
	'indiana': 'IN',
	'iowa': 'IA',
	'kansas': 'KS',
	'kentucky': 'KY',
	'louisiana': 'LA',
	'maine': 'ME',
	'maryland': 'MD',
	'massachusetts': 'MA',
	'michigan': 'MI',
	'minnesota': 'MN',
	'mississippi': 'MS',
	'missouri': 'MO',
	'montana': 'MT',
	'nebraska': 'NE',
	'nevada': 'NV',
	'new hampshire': 'NH',
	'new jersey': 'NJ',
	'new mexico': 'NM',
	'new york': 'NY',
	'north carolina': 'NC',
	'north dakota': 'ND',
	'ohio': 'OH',
	'oklahoma': 'OK',
	'oregon': 'OR',
	'pennsylvania': 'PA',
	'rhode island': 'RI',
	'south carolina': 'SC',
	'south dakota': 'SD',
	'tennessee': 'TN',
	'texas': 'TX',
	'utah': 'UT',
	'vermont': 'VT',
	'virginia': 'VA',
	'washington': 'WA',
	'west virginia': 'WV',
	'wisconsin': 'WI',
	'wyoming': 'WY',
	'puerto rico': 'PR',
	'virgin islands': 'VI',
	'guam': 'GU',
	'american samoa': 'AS',
	'northern mariana islands': 'MP',
};

const STATE_CODES = new Set(Object.values(STATE_NAME_TO_CODE));

const LOCATION_REGION_ANCHORS: Record<string, { x: number; y: number }> = {
	west: { x: 0.19, y: 0.43 },
	midwest: { x: 0.45, y: 0.34 },
	northeast: { x: 0.73, y: 0.25 },
	southeast: { x: 0.72, y: 0.66 },
	southwest: { x: 0.42, y: 0.72 },
	territory: { x: 0.56, y: 0.82 },
};

const STATE_REGION_MAP: Record<string, string> = {
	WA: 'west',
	OR: 'west',
	CA: 'west',
	NV: 'west',
	ID: 'west',
	UT: 'west',
	AZ: 'west',
	AK: 'west',
	HI: 'west',
	MT: 'west',
	WY: 'west',
	CO: 'west',
	NM: 'southwest',
	TX: 'southwest',
	OK: 'southwest',
	KS: 'midwest',
	NE: 'midwest',
	SD: 'midwest',
	ND: 'midwest',
	MN: 'midwest',
	IA: 'midwest',
	MO: 'midwest',
	WI: 'midwest',
	IL: 'midwest',
	IN: 'midwest',
	MI: 'midwest',
	OH: 'midwest',
	KY: 'southeast',
	TN: 'southeast',
	AR: 'southeast',
	LA: 'southeast',
	MS: 'southeast',
	AL: 'southeast',
	GA: 'southeast',
	FL: 'southeast',
	SC: 'southeast',
	NC: 'southeast',
	VA: 'southeast',
	WV: 'southeast',
	MD: 'northeast',
	DE: 'northeast',
	PA: 'northeast',
	NJ: 'northeast',
	NY: 'northeast',
	CT: 'northeast',
	RI: 'northeast',
	MA: 'northeast',
	VT: 'northeast',
	NH: 'northeast',
	ME: 'northeast',
	DC: 'northeast',
	PR: 'territory',
	VI: 'territory',
	GU: 'territory',
	AS: 'territory',
	MP: 'territory',
};

function normalizeStateCode(value?: string): string {
	const text = String(value || '')
		.replace(/\./g, '')
		.replace(/\s+/g, ' ')
		.trim();
	if (!text) return '';
	const upper = text.toUpperCase();
	if (STATE_CODES.has(upper)) return upper;
	return STATE_NAME_TO_CODE[text.toLowerCase()] || '';
}

function hashString(value: string): number {
	let hash = 0;
	for (let i = 0; i < value.length; i++) {
		hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
	}
	return hash;
}

function locationKeyFromParts(city?: string, state?: string): string | undefined {
	const c = normalizeLocationPart(city);
	const s = normalizeLocationPart(state);
	if (c && s) return `${c}|${s}`;
	if (s) return `state|${s}`;
	if (c) return `city|${c}`;
	return undefined;
}

function extractItemCityState(item: Record<string, unknown>): { city?: string; state?: string } {
	const locations = Array.isArray(item.branchOfficeLocations) ? (item.branchOfficeLocations as Record<string, unknown>[]) : [];
	const primaryLoc = locations.find((loc) => loc?.locatedAtFlag === 'Y') || locations[0];
	if (primaryLoc) {
		const city = stringValue(primaryLoc.city);
		const state = stringValue(primaryLoc.state);
		if (city || state) return { city, state };
	}
	const office = getRecordValue(item.officeAddress) || getRecordValue(item.address) || getRecordValue(item.mainAddress) || getRecordValue(item.firmAddress) || null;
	const city = stringValue(item.city) || stringValue(office?.city) || stringValue(item.branchCity) || stringValue(item.officeCity);
	const state = stringValue(item.state) || stringValue(office?.state) || stringValue(item.branchState) || stringValue(item.officeState);
	return { city, state };
}

/** Soft region anchor from finra-data-chart-next-02 (state → US region). */
function locationRegionTarget(
	city: string | undefined,
	state: string | undefined,
	width: number,
	height: number,
	nodeCount: number,
	entityType?: GraphEntityType,
): { x: number; y: number; strength: number } | null {
	const code = normalizeStateCode(state);
	const region = code ? STATE_REGION_MAP[code] : '';
	if (!region) return null;
	const anchor = LOCATION_REGION_ANCHORS[region];
	if (!anchor) return null;
	const jitterSeed = code || city || region;
	const jitterHash = hashString(jitterSeed);
	const jitterX = ((jitterHash % 1000) / 999 - 0.5) * width * 0.08;
	const jitterY = ((((jitterHash / 1000) | 0) % 1000) / 999 - 0.5) * height * 0.12;
	const baseStrength =
		nodeCount > 1000 ? 0.013
		: nodeCount > 300 ? 0.015
		: 0.018;
	// city+state slightly stronger than state-only (mirrors office vs basic_state).
	const sourceStrength = city && state ? 0.88 : 0.62;
	const firmWeight = entityType === 'firm' ? 0.92 : 1;
	return {
		x: width * anchor.x + jitterX,
		y: height * anchor.y + jitterY,
		strength: baseStrength * sourceStrength * firmWeight,
	};
}

/** Degree-based scatter used by reference link distance + collision padding. */
function nodeScatterBoost(degree: number, nodeCount: number): number {
	if (!degree) return 0;
	const multiplier =
		nodeCount > 1000 ? 10.5
		: nodeCount > 600 ? 9.2
		: nodeCount > 300 ? 8.0
		: 6.5;
	const cap =
		nodeCount > 1000 ? 250
		: nodeCount > 600 ? 210
		: nodeCount > 300 ? 180
		: 140;
	return Math.min(cap, Math.sqrt(degree) * multiplier);
}

function entityTypeFromLoadKey(loadKey?: string): GraphEntityType | undefined {
	if (!loadKey) return undefined;
	const parts = loadKey.split(':');
	// Supports "finra:firm:123", "firm:123", "individual:456"
	const typeToken = parts.length >= 3 ? parts[1] : parts[0];
	if (typeToken === 'firm') return 'firm';
	if (typeToken === 'individual') return 'individual';
	return undefined;
}

function resolveNodeEntityType(node: GraphNode, hubEntityType?: GraphEntityType): GraphEntityType {
	if (node.entityType === 'firm' || node.entityType === 'individual') return node.entityType;
	if (node.id === 'primary' && (hubEntityType === 'firm' || hubEntityType === 'individual')) return hubEntityType;
	const fromKey = entityTypeFromLoadKey(node.loadKey);
	if (fromKey) return fromKey;
	if (node.id.startsWith('relation-firm-') || node.id.startsWith('search-firm-') || node.id.startsWith('firm:')) return 'firm';
	if (node.id.startsWith('relation-individual-') || node.id.startsWith('search-individual-') || node.id.startsWith('individual:')) return 'individual';
	// Default unknown nodes to person (blue).
	return 'individual';
}

type GraphLink = {
	source: string;
	target: string;
	label: string;
};

// Shape returned by GET /api/finra/expand/[nodeId] (see pages/api/_graphIndex.ts).
// That endpoint reads directly from the Redis-backed saved-payload store and
// resolves BOTH current and previous employments (for individuals) and
// current owners/control persons plus current+previous employees (for
// firms) — i.e. exactly the "reveal connected nodes" data this page needs
// when a node is clicked, without re-deriving it from scratch here.
type ExpandApiNode = { id: string; label: string; group: 'individual' | 'firm'; crd: string; city?: string; state?: string };
type ExpandApiLink = { source: string; target: string; relationship: 'employment' | 'ownership'; isCurrent: boolean };

function expandedLinkLabel(relationship: ExpandApiLink['relationship'], isCurrent: boolean): string {
	if (relationship === 'ownership') return isCurrent ? 'Owner' : 'Former owner';
	return isCurrent ? 'Employment' : 'Previous employment';
}

function getRecordValue(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function normalizeName(value: unknown): string | undefined {
	if (typeof value === 'string' && value.trim()) return value.trim();
	return undefined;
}

function getNameFromItem(item: Record<string, unknown>): string | undefined {
	return (
		normalizeName(item.firmName) ||
		normalizeName(item.legalName) ||
		normalizeName(item.organizationName) ||
		normalizeName(item.orgName) ||
		normalizeName(item.name) ||
		normalizeName(item.displayName) ||
		normalizeName(item.fullName) ||
		normalizeName(item.individualName) ||
		normalizeName(item.firstName) ||
		normalizeName(item.lastName)
	);
}

// Builds the relationship graph directly from the resolved FINRA/SEC content
// blocks (not the raw /api/key bundle) — employments become firm nodes,
// direct/indirect owners become individual (or firm) nodes. Each relation
// node carries a `loadKey` (source:type:crd) when the underlying record has
// a resolvable CRD, so clicking it can drill into that entity's own record.
function buildGraphData(
	contents: Array<Record<string, any> | null | undefined>,
	fallbackTitle: string,
	hubEntityType: GraphEntityType = 'individual',
	hubLocation?: { city?: string; state?: string },
) {
	const nodes: GraphNode[] = [
		{
			id: 'primary',
			label: fallbackTitle,
			kind: 'primary',
			entityType: hubEntityType,
			city: hubLocation?.city,
			state: hubLocation?.state,
			subLabel: hubLocation?.city || hubLocation?.state ? [hubLocation.city, hubLocation.state].filter(Boolean).join(', ') : undefined,
		},
	];
	const links: GraphLink[] = [];
	const seenNodeIds = new Set<string>(['primary']);

	const addNode = (id: string, label: string, kind: 'primary' | 'relation', entityType: GraphEntityType, subLabel?: string, loadKey?: string, city?: string, state?: string) => {
		if (seenNodeIds.has(id)) return;
		seenNodeIds.add(id);
		nodes.push({ id, label, kind, entityType, subLabel, loadKey, city, state });
	};

	const relationArrays = [
		['currentEmployments', 'Employment', 'firm'],
		['currentIAEmployments', 'Adviser', 'firm'],
		['directOwners', 'Direct owner', 'individual'],
		['indirectOwners', 'Indirect owner', 'individual'],
	] as const;

	for (const content of contents) {
		if (!content) continue;
		for (const [key, fallbackLabel, relatedType] of relationArrays) {
			const items = toArray(content[key]);
			for (const [index, item] of items.entries()) {
				const itemRecord = getRecordValue(item);
				if (!itemRecord) continue;
				const nodeLabel = getNameFromItem(itemRecord) || `${fallbackLabel} ${index + 1}`;
				const crd = idValue(itemRecord.firmId) || idValue(itemRecord.crdNumber);
				// Dedupe firms/owners that show up on both the FINRA and SEC
				// content blocks for the same relationship.
				const nodeId = crd ? `relation-${relatedType}-${crd}` : `relation-${key}-${index}`;
				const loadKey = crd ? `finra:${relatedType}:${crd}` : undefined;
				const { city, state } = extractItemCityState(itemRecord);
				const placeLabel = city || state ? [city, state].filter(Boolean).join(', ') : undefined;
				addNode(nodeId, nodeLabel, 'relation', relatedType, placeLabel || stringValue(itemRecord.position) || fallbackLabel, loadKey, city, state);
				if (!links.some((l) => l.source === 'primary' && l.target === nodeId)) {
					links.push({ source: 'primary', target: nodeId, label: fallbackLabel });
				}
			}
		}
	}

	return { nodes, links };
}

export default function NodeGraphPage() {
	const router = useRouter();
	const { cache, setSnapshot, clear } = useSharedGraphState();

	// Parses the optional /graph/individual/8303401 (or /graph/firm/<crd>)
	// path segments this page is also mounted at (see the catch-all route
	// file). Absent when visited as a bare /graph or via the legacy
	// /node-graph route.
	const routeParams = useMemo(() => {
		const raw = (router.query as { params?: string | string[] }).params;
		const parts =
			Array.isArray(raw) ? raw
			: typeof raw === 'string' ? [raw]
			: [];
		const type =
			parts[0] === 'firm' ? 'firm'
			: parts[0] === 'individual' ? 'individual'
			: null;
		const crd = parts[1] && /^\d+$/.test(parts[1]) ? parts[1] : null;
		return type && crd ? { type: type as 'individual' | 'firm', crd } : null;
	}, [router.query]);

	const [searchInput, setSearchInput] = useState('');
	const [searchLoading, setSearchLoading] = useState(false);
	const [searchError, setSearchError] = useState('');
	const [detailTab, setDetailTab] = useState<'info' | 'log'>('info');
	const [traceMode, setTraceMode] = useState(false);
	const [clearNonConnected, setClearNonConnected] = useState(false);
	const [theme, setTheme] = useState<'dark' | 'light'>('dark');
	// Detail panel (PanelHeader/StatusBox) lives in a hamburger-triggered
	// drawer — closed by default, opened either via the hamburger button or
	// automatically whenever a node in the graph is selected/clicked.
	const [drawerOpen, setDrawerOpen] = useState(false);
	// Bottom-left toolbar dock (Refresh/Trace/Reset/Center/theme) can be
	// collapsed down to a small tab pinned to the left edge.
	const [toolbarMinimized, setToolbarMinimized] = useState(false);
	// Lightweight nodes added directly from a name/text search's full match
	// list (no per-match detail fetch — same as the reference site's
	// "build nodes from search hits" behavior). They render alongside
	// whatever hub entity is currently loaded, and only get fully hydrated
	// (via loadKey) when the user clicks one.
	const [searchResultNodes, setSearchResultNodes] = useState<GraphNode[]>([]);
	const [searchBanner, setSearchBanner] = useState<{ query: string; count: number } | null>(null);

	// Click-to-expand: when a node is clicked, its own connections (current
	// AND previous employments for individuals; owners/control persons plus
	// current+previous employees for firms) are fetched from
	// /api/finra/expand and merged into the graph in place — the existing
	// graph is never replaced. `expandedKeysRef` tracks which entities
	// (canonical "individual:<crd>" / "firm:<crd>") have already been
	// expanded so re-clicking a node doesn't refetch.
	const [expansionNodes, setExpansionNodes] = useState<GraphNode[]>([]);
	const [expansionLinks, setExpansionLinks] = useState<GraphLink[]>([]);
	const [expandingNodeId, setExpandingNodeId] = useState<string | null>(null);
	const expandedKeysRef = useRef<Set<string>>(new Set());

	const activeSnapshot = useMemo(() => {
		return Object.values(cache).sort((a, b) => b.fetchedAt - a.fetchedAt)[0] ?? null;
	}, [cache]);

	const parsedPayload = useMemo(() => readSnapshotPayload(activeSnapshot?.detailJson ?? null), [activeSnapshot]);

	const parsedKeyInfo = useMemo(() => parseCrdKey(activeSnapshot?.resolvedKey || activeSnapshot?.key || ''), [activeSnapshot]);
	const entityType: 'individual' | 'firm' = (parsedKeyInfo?.type as 'individual' | 'firm') || 'individual';

	const finraContent = useMemo(() => getContentBlock(parsedPayload, 'finra', entityType), [parsedPayload, entityType]);
	const secContent = useMemo(() => getContentBlock(parsedPayload, 'sec', entityType), [parsedPayload, entityType]);
	const primaryContent = (finraContent?.basicInformation ? finraContent : secContent) as Record<string, any> | null;

	const nameInfo = useMemo(() => extractNamesFromPayload(primaryContent, entityType), [primaryContent, entityType]);

	const entityTitle = useMemo(() => {
		if (entityType === 'individual' && nameInfo.primary) return toProperCaseName(nameInfo.primary);
		return nameInfo.primary || activeSnapshot?.resolvedKey || activeSnapshot?.key || 'Shared record';
	}, [nameInfo, entityType, activeSnapshot]);

	// Hub business location (firm office or individual's current branch) so
	// the primary node participates in location clustering with neighbors.
	const hubLocation = useMemo(() => {
		const content = (finraContent || secContent) as Record<string, any> | null;
		if (!content) return undefined as { city?: string; state?: string } | undefined;
		const basic = getRecordValue(content.basicInformation) || {};
		const firmAddress = getRecordValue(content.firmAddressDetails) || getRecordValue(content.iaFirmAddressDetails) || {};
		const office = getRecordValue(firmAddress.officeAddress) || getRecordValue(firmAddress.mailingAddress);
		let city = stringValue(office?.city) || stringValue(basic.city) || stringValue(content.city);
		let state = stringValue(office?.state) || stringValue(basic.state) || stringValue(content.state);
		if (!city && !state) {
			const employments = [...toArray(content.currentEmployments), ...toArray(content.currentIAEmployments)];
			for (const row of employments) {
				const rec = getRecordValue(row);
				if (!rec) continue;
				const loc = extractItemCityState(rec);
				if (loc.city || loc.state) {
					city = loc.city;
					state = loc.state;
					break;
				}
			}
		}
		return city || state ? { city, state } : undefined;
	}, [finraContent, secContent]);

	// Only used for the small "Investment Adviser" badge drawn on the primary
	// graph node — the rest of the record detail (stats, badges, employment,
	// disclosures, etc.) is now rendered by the shared PanelHeader/StatusBox
	// components, identical to the main dashboard.
	const roleRows = useMemo(() => {
		const rows: string[] = [];
		if (toArray(finraContent?.currentEmployments).length > 0) rows.push('Broker Regulated by FINRA');
		if (toArray(finraContent?.currentIAEmployments).length > 0 || toArray(secContent?.currentIAEmployments).length > 0) rows.push('Investment Adviser');
		return rows;
	}, [finraContent, secContent]);

	// Resolves any graph node to the canonical "individual:<crd>" /
	// "firm:<crd>" id that /api/finra/expand expects — the primary node
	// derives this from the loaded snapshot's own key, relation/search nodes
	// carry it embedded in their `loadKey` ("finra:<type>:<crd>").
	const canonicalIdForNode = useCallback(
		(node: GraphNode): string | null => {
			if (node.id === 'primary') {
				return parsedKeyInfo?.crd ? `${entityType}:${parsedKeyInfo.crd}` : null;
			}
			if (node.loadKey) {
				const parts = node.loadKey.split(':');
				if (parts.length === 3) return `${parts[1]}:${parts[2]}`;
			}
			return null;
		},
		[entityType, parsedKeyInfo],
	);

	// Fetches a node's own connections (current + previous employments for
	// individuals; owners/control persons + current+previous employees for
	// firms — see pages/api/_graphIndex.ts) and merges them into the graph
	// as new nodes/links, expanding in place rather than replacing the hub.
	const expandNode = useCallback(
		(node: GraphNode) => {
			const canonicalId = canonicalIdForNode(node);
			if (!canonicalId || expandedKeysRef.current.has(canonicalId)) return;
			expandedKeysRef.current.add(canonicalId);
			setExpandingNodeId(node.id);
			fetch(`/api/finra/expand/${encodeURIComponent(canonicalId)}?hops=1`)
				.then((r) => r.json())
				.then((data) => {
					const rawNodes: ExpandApiNode[] = Array.isArray(data?.nodes) ? data.nodes : [];
					const rawLinks: ExpandApiLink[] = Array.isArray(data?.links) ? data.links : [];

					setExpansionNodes((prev) => {
						const seen = new Set(prev.map((n) => n.id));
						const merged = prev.slice();
						for (const raw of rawNodes) {
							if (raw.id === canonicalId || seen.has(raw.id)) continue;
							seen.add(raw.id);
							const city = stringValue(raw.city);
							const state = stringValue(raw.state);
							merged.push({
								id: raw.id,
								label: raw.label,
								kind: 'relation',
								entityType: raw.group === 'firm' ? 'firm' : 'individual',
								city,
								state,
								subLabel:
									city || state ? [city, state].filter(Boolean).join(', ')
									: raw.group === 'firm' ? 'Firm'
									: 'Individual',
								loadKey: `finra:${raw.group}:${raw.crd}`,
							});
						}
						return merged;
					});

					setExpansionLinks((prev) => {
						const linkKey = (l: { source: string; target: string; label: string }) => `${l.source}->${l.target}:${l.label}`;
						const seen = new Set(prev.map(linkKey));
						const merged = prev.slice();
						for (const raw of rawLinks) {
							const label = expandedLinkLabel(raw.relationship, raw.isCurrent);
							const candidate = { source: raw.source, target: raw.target, label };
							if (seen.has(linkKey(candidate))) continue;
							seen.add(linkKey(candidate));
							merged.push(candidate);
						}
						return merged;
					});
				})
				.catch(() => {
					// Allow retrying on a future click if the fetch failed.
					expandedKeysRef.current.delete(canonicalId);
				})
				.finally(() => setExpandingNodeId((current) => (current === node.id ? null : current)));
		},
		[canonicalIdForNode],
	);

	// ── Search / load ─────────────────────────────────────────────────────────
	// Fetches a single explicit key (e.g. "finra:firm:10409") from /api/key and,
	// if found, stores it in the shared graph cache. Returns whether the
	// backend actually found FINRA or SEC data for that key (as opposed to an
	// empty/orphan placeholder), so callers can decide whether to try an
	// alternate guess (e.g. individual vs firm) before giving up.
	const fetchAndApplyKey = useCallback(
		(key: string, requestKey: string, options?: { force?: boolean }) => {
			return fetch(`/api/key?name=${encodeURIComponent(key)}${options?.force ? `&t=${Date.now()}` : ''}`)
				.then(async (r) => {
					const data = await r.json();
					if (!r.ok) throw new Error(String(data?.error || `HTTP ${r.status}`));
					return data;
				})
				.then((data) => {
					const found = Boolean(data?.bundle?.sources?.finra?.found || data?.bundle?.sources?.sec?.found);
					if (!found) return { found: false as const, data };
					const resolvedKey = typeof data?.resolvedKey === 'string' ? data.resolvedKey : key;
					const detailValue = typeof data?.rawPayload === 'string' ? data.rawPayload : JSON.stringify(data?.payload ?? data ?? null, null, 2);
					const snapshot = { key: requestKey, resolvedKey, detailJson: detailValue, fetchedAt: Date.now(), source: 'shared' as const };
					setSnapshot(requestKey, snapshot);
					if (resolvedKey !== requestKey) setSnapshot(resolvedKey, snapshot);
					return { found: true as const, data };
				});
		},
		[setSnapshot],
	);

	// Loads an explicit, unambiguous key (source:type:crd, or type:crd) — used
	// for Refresh and for clicking a relation node whose type is already known.
	const loadKey = useCallback(
		(key: string, options?: { force?: boolean }) => {
			if (!key) return;
			setSearchLoading(true);
			setSearchError('');
			fetchAndApplyKey(key, key, options)
				.then((result) => {
					if (!result.found) setSearchError(`No FINRA/SEC record found for ${key}`);
				})
				.catch((err: unknown) => {
					setSearchError(err instanceof Error ? err.message : `Could not load data for ${key}`);
				})
				.finally(() => setSearchLoading(false));
		},
		[fetchAndApplyKey],
	);

	// Deep-link support: when this page is reached via /graph/individual/<crd>
	// (or /graph/firm/<crd>), load that entity as the hub on mount and
	// whenever the URL's params actually change to a different entity —
	// `lastRouteKeyRef` guards against re-loading the entity we ourselves
	// just pushed into the URL below.
	const lastRouteKeyRef = useRef<string | null>(null);
	useEffect(() => {
		if (!routeParams) return;
		const key = `${routeParams.type}:${routeParams.crd}`;
		if (lastRouteKeyRef.current === key) return;
		lastRouteKeyRef.current = key;
		loadKey(key);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [routeParams]);

	// A bare CRD number typed into the top search box is ambiguous (could be
	// an individual or a firm) — the backend's plain-number lookup assumes
	// "individual", so retry as "firm" when that comes back empty.
	const loadCrdGuessingType = useCallback(
		(digits: string) => {
			setSearchLoading(true);
			setSearchError('');
			fetchAndApplyKey(digits, digits)
				.then((result) => {
					if (result.found) return result;
					return fetchAndApplyKey(`firm:${digits}`, digits);
				})
				.then((result) => {
					if (!result.found) setSearchError(`No FINRA/SEC record found for CRD ${digits}`);
				})
				.catch((err: unknown) => {
					setSearchError(err instanceof Error ? err.message : `Could not load data for ${digits}`);
				})
				.finally(() => setSearchLoading(false));
		},
		[fetchAndApplyKey],
	);

	const runSearch = useCallback(() => {
		const query = searchInput.trim();
		if (!query) return;
		if (/^\d+$/.test(query)) {
			loadCrdGuessingType(query);
			return;
		}
		setSearchLoading(true);
		setSearchError('');
		setSearchBanner(null);
		fetch(`/api/redis-search?q=${encodeURIComponent(query)}`)
			.then((r) => r.json())
			.then((json) => {
				const matches =
					Array.isArray(json?.matches) ? json.matches
					: Array.isArray(json?.results) ? json.results
					: [];
				if (!matches.length) {
					setSearchError(`No matches found for "${query}"`);
					setSearchLoading(false);
					return;
				}
				// A single unambiguous match — load it directly as the hub
				// entity, same as before.
				if (matches.length === 1) {
					const only = matches[0];
					const type =
						only.type === 'firm' ? 'firm'
						: only.type === 'individual' ? 'individual'
						: '';
					const key = only.key || (type && only.crd ? `${type}:${only.crd}` : String(only.crd));
					loadKey(key);
					return;
				}
				// Multiple matches — build a lightweight node for every hit
				// directly from the search-index metadata (no per-match detail
				// fetch), so the graph shows ALL matches at once. Each node
				// only gets fully hydrated when clicked (via its `loadKey`).
				const capped = matches.slice(0, 100);
				const newNodes: GraphNode[] = capped
					.map((match: any): GraphNode | null => {
						const type =
							match.type === 'firm' ? 'firm'
							: match.type === 'individual' ? 'individual'
							: '';
						const crd = idValue(match.crd);
						if (!type || !crd) return null;
						const id = `search-${type}-${crd}`;
						const label = stringValue(match.name) || `${type === 'firm' ? 'Firm' : 'Individual'} ${crd}`;
						return {
							id,
							label,
							kind: 'relation',
							entityType: type as GraphEntityType,
							subLabel: 'Search match',
							loadKey: match.key || `${type}:${crd}`,
						};
					})
					.filter((n: GraphNode | null): n is GraphNode => Boolean(n));
				setSearchResultNodes((prev) => {
					const seen = new Set(prev.map((n) => n.id));
					const merged = prev.slice();
					for (const node of newNodes) {
						if (seen.has(node.id)) continue;
						seen.add(node.id);
						merged.push(node);
					}
					return merged;
				});
				setSearchBanner({ query, count: newNodes.length });
				setSearchLoading(false);
			})
			.catch((err: unknown) => {
				setSearchError(err instanceof Error ? err.message : 'Search failed');
				setSearchLoading(false);
			});
	}, [searchInput, loadKey, loadCrdGuessingType]);

	const handleSearch = useCallback(
		(event: React.FormEvent) => {
			event.preventDefault();
			runSearch();
		},
		[runSearch],
	);

	const handleRefresh = useCallback(() => {
		const key = activeSnapshot?.resolvedKey || activeSnapshot?.key;
		if (key) loadKey(key, { force: true });
	}, [activeSnapshot, loadKey]);

	const handleResetSession = useCallback(() => {
		clear();
		setSearchInput('');
		setSearchError('');
		setTraceMode(false);
		setClearNonConnected(false);
		setDetailTab('info');
		setFocusedNodeId('primary');
		setDrawerOpen(false);
		setSearchResultNodes([]);
		setSearchBanner(null);
		setExpansionNodes([]);
		setExpansionLinks([]);
		setExpandingNodeId(null);
		setLabelModeById({});
		expandedKeysRef.current.clear();
		lastRouteKeyRef.current = null;
		router.replace('/graph', undefined, { shallow: true });
	}, [clear, router]);

	const [focusedNodeId, setFocusedNodeId] = useState('primary');
	// Per-node label preference: auto follows zoom; large/small stay visible
	// at that size even when zoomed out past the hide threshold.
	type LabelMode = 'auto' | 'small' | 'large';
	const [labelModeById, setLabelModeById] = useState<Record<string, LabelMode>>({});
	// Hide auto labels once zoomed out past ~halfway from default (k=1 → 0.5).
	const LABEL_HIDE_SCALE = 0.5;
	// Reset the focused/highlighted node whenever a new entity is loaded so
	// stale node ids from the previous graph don't linger.
	useEffect(() => {
		setFocusedNodeId('primary');
	}, [activeSnapshot?.resolvedKey]);

	// Auto-expand the primary node the moment its entity loads, so its full
	// current + previous connections are visible immediately instead of only
	// the "current" subset buildGraphData derives from the loaded snapshot.
	useEffect(() => {
		if (!activeSnapshot || !parsedKeyInfo?.crd) return;
		expandNode({ id: 'primary', label: entityTitle, kind: 'primary', entityType: entityType === 'firm' ? 'firm' : 'individual' });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [activeSnapshot?.resolvedKey, parsedKeyInfo?.crd]);

	const graphData = useMemo(() => {
		const hubEntityType: GraphEntityType = entityType === 'firm' ? 'firm' : 'individual';
		const hub = activeSnapshot ? buildGraphData([finraContent, secContent], entityTitle, hubEntityType, hubLocation) : { nodes: [] as GraphNode[], links: [] as GraphLink[] };

		// Maps canonical "individual:<crd>"/"firm:<crd>" ids to whatever id an
		// entity already uses in the graph (primary, a hub relation node, or a
		// search-result node), so expansion results attach to the existing
		// node instead of creating a duplicate.
		const canonicalToId = new Map<string, string>();
		const registerCanonical = (node: GraphNode) => {
			let canonical: string | null = null;
			if (node.id === 'primary') {
				canonical = parsedKeyInfo?.crd ? `${entityType}:${parsedKeyInfo.crd}` : null;
			} else if (node.loadKey) {
				const parts = node.loadKey.split(':');
				canonical = parts.length === 3 ? `${parts[1]}:${parts[2]}` : null;
			}
			if (canonical && !canonicalToId.has(canonical)) canonicalToId.set(canonical, node.id);
		};
		hub.nodes.forEach(registerCanonical);

		const hubIds = new Set(hub.nodes.map((n) => n.id));
		const extraSearchNodes = searchResultNodes.filter((n) => !hubIds.has(n.id));
		extraSearchNodes.forEach(registerCanonical);

		const nodes = [...hub.nodes, ...extraSearchNodes];
		const seenIds = new Set(nodes.map((n) => n.id));
		for (const expansionNode of expansionNodes) {
			if (canonicalToId.has(expansionNode.id) || seenIds.has(expansionNode.id)) continue;
			canonicalToId.set(expansionNode.id, expansionNode.id);
			seenIds.add(expansionNode.id);
			nodes.push(expansionNode);
		}

		const links = [...hub.links];
		const seenLinkKeys = new Set(links.map((l) => `${l.source}->${l.target}:${l.label}`));
		for (const expansionLink of expansionLinks) {
			const source = canonicalToId.get(expansionLink.source) ?? expansionLink.source;
			const target = canonicalToId.get(expansionLink.target) ?? expansionLink.target;
			if (source === target) continue;
			const key = `${source}->${target}:${expansionLink.label}`;
			const reverseKey = `${target}->${source}:${expansionLink.label}`;
			if (seenLinkKeys.has(key) || seenLinkKeys.has(reverseKey)) continue;
			seenLinkKeys.add(key);
			links.push({ source, target, label: expansionLink.label });
		}

		return { nodes, links };
	}, [activeSnapshot, finraContent, secContent, entityTitle, searchResultNodes, expansionNodes, expansionLinks, entityType, parsedKeyInfo, hubLocation]);

	// Undirected degree for each node — drives visual radius so hubs read larger.
	const connectionCountById = useMemo(() => {
		const counts: Record<string, number> = {};
		for (const node of graphData.nodes) counts[node.id] = 0;
		for (const link of graphData.links) {
			const sourceId = typeof link.source === 'string' ? link.source : String((link as any).source?.id ?? link.source);
			const targetId = typeof link.target === 'string' ? link.target : String((link as any).target?.id ?? link.target);
			if (sourceId in counts) counts[sourceId] += 1;
			if (targetId in counts) counts[targetId] += 1;
		}
		return counts;
	}, [graphData.nodes, graphData.links]);

	const nodeRadius = useCallback(
		(nodeId: string, kind?: GraphNode['kind']) => {
			const degree = connectionCountById[nodeId] ?? 0;
			// Larger baseline so nodes read clearly before click-to-expand
			// adds more edges; sqrt scale still grows hubs without runaway size.
			const scaled = 16 + Math.sqrt(degree) * 5.5;
			const base = kind === 'primary' ? Math.max(scaled, 22) : scaled;
			return Math.min(48, base);
		},
		[connectionCountById],
	);

	const focusedNode = useMemo(() => graphData.nodes.find((node) => node.id === focusedNodeId) ?? graphData.nodes[0], [graphData.nodes, focusedNodeId]);

	// Keeps the address bar in sync with whichever node is selected: clicking
	// any person or firm updates the URL to /graph/individual/<crd> or
	// /graph/firm/<crd> (shallow — the graph itself isn't reloaded/remounted).
	// `lastRouteKeyRef` (shared with the deep-link-load effect above) stops
	// this from firing a redundant replace right after that effect just
	// finished loading the same entity from the URL.
	useEffect(() => {
		if (!router.isReady || !focusedNode) return;
		const canonical = canonicalIdForNode(focusedNode);
		if (!canonical) return;
		const [type, crd] = canonical.split(':');
		if (lastRouteKeyRef.current === canonical) return;
		lastRouteKeyRef.current = canonical;
		const as = `/graph/${type}/${crd}`;
		router.replace({ pathname: '/graph/[[...params]]', query: { params: [type, crd] } }, as, { shallow: true });
	}, [focusedNode, canonicalIdForNode, router]);

	// Nodes/links kept visible when "Clear non-connected" is active: the
	// focused node plus anything directly linked to it.
	const connectedNodeIds = useMemo(() => {
		if (!clearNonConnected) return null;
		const ids = new Set<string>([focusedNodeId]);
		for (const link of graphData.links) {
			if (link.source === focusedNodeId) ids.add(link.target);
			if (link.target === focusedNodeId) ids.add(link.source);
		}
		return ids;
	}, [clearNonConnected, focusedNodeId, graphData.links]);

	const visibleNodes = useMemo(() => (connectedNodeIds ? graphData.nodes.filter((n) => connectedNodeIds.has(n.id)) : graphData.nodes), [connectedNodeIds, graphData.nodes]);
	const visibleLinks = useMemo(
		() => (connectedNodeIds ? graphData.links.filter((l) => connectedNodeIds.has(l.source) && connectedNodeIds.has(l.target)) : graphData.links),
		[connectedNodeIds, graphData.links],
	);

	// When Trace Mode is on, dim everything except the focused node and its
	// direct neighbors so the highlighted path stands out.
	const traceConnectedIds = useMemo(() => {
		if (!traceMode) return null;
		const ids = new Set<string>([focusedNodeId]);
		for (const link of graphData.links) {
			if (link.source === focusedNodeId) ids.add(link.target);
			if (link.target === focusedNodeId) ids.add(link.source);
		}
		return ids;
	}, [traceMode, focusedNodeId, graphData.links]);

	const svgRef = useRef<SVGSVGElement>(null);
	const zoomBehaviorRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
	const [transform, setTransform] = useState<d3.ZoomTransform>(d3.zoomIdentity);
	const [graphPositions, setGraphPositions] = useState<Record<string, { x: number; y: number }>>({});

	// Latest node positions, kept in sync so the force-simulation effect
	// below (which re-runs whenever graphData changes, e.g. after an
	// in-place expansion) can seed already-placed nodes at their current
	// spot instead of snapping the whole graph back to random positions
	// near the center — that full-graph reset was what made expanded
	// graphs look like nodes "disconnecting" from their links.
	const positionsRef = useRef<Record<string, { x: number; y: number }>>({});
	useEffect(() => {
		positionsRef.current = graphPositions;
	}, [graphPositions]);

	// Kept in sync with `transform` (React state) so drag handlers — which
	// run outside the render cycle via pointer event callbacks — can always
	// read the current zoom/pan without becoming stale closures.
	const transformRef = useRef(transform);
	useEffect(() => {
		transformRef.current = transform;
	}, [transform]);

	// The live simulation + its node objects (mutated in place by
	// d3-force each tick). Drag handlers read/write directly into these
	// refs rather than through React state, matching the standard
	// d3-force drag pattern (set fx/fy, reheat via alphaTarget).
	const simulationRef = useRef<d3.Simulation<any, any> | null>(null);
	const dragNodesRef = useRef<any[]>([]);
	const dragStateRef = useRef<{ id: string; offsetX: number; offsetY: number; startClientX: number; startClientY: number; moved: boolean } | null>(null);
	const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);

	// Converts a pointer's client (screen) coordinates into the graph's own
	// coordinate space, accounting for both the SVG's viewBox scaling and
	// the current d3-zoom pan/scale transform applied to the inner <g>.
	const clientPointToGraph = useCallback((clientX: number, clientY: number) => {
		const svg = svgRef.current;
		const ctm = svg?.getScreenCTM();
		if (!svg || !ctm) return { x: 0, y: 0 };
		const point = svg.createSVGPoint();
		point.x = clientX;
		point.y = clientY;
		const svgPoint = point.matrixTransform(ctm.inverse());
		const [x, y] = transformRef.current.invert([svgPoint.x, svgPoint.y]);
		return { x, y };
	}, []);

	const handleNodePointerDown = useCallback(
		(event: React.PointerEvent<SVGGElement>, nodeId: string) => {
			// fluidDrag from finra-data-chart-next-02/src/lib/finra-graph.ts
			event.stopPropagation();
			const node = dragNodesRef.current.find((n) => n.id === nodeId);
			if (!node) return;
			const graphPoint = clientPointToGraph(event.clientX, event.clientY);
			dragStateRef.current = {
				id: nodeId,
				offsetX: (node.x ?? graphPoint.x) - graphPoint.x,
				offsetY: (node.y ?? graphPoint.y) - graphPoint.y,
				startClientX: event.clientX,
				startClientY: event.clientY,
				moved: false,
			};
			node.fx = node.x;
			node.fy = node.y;
			// Unpin direct neighbors so charge/collision can push them aside.
			const neighborIds = new Set<string>();
			for (const link of graphData.links) {
				if (link.source === nodeId) neighborIds.add(link.target);
				if (link.target === nodeId) neighborIds.add(link.source);
			}
			for (const n of dragNodesRef.current) {
				if (neighborIds.has(n.id)) {
					n.fx = null;
					n.fy = null;
				}
			}
			setDraggingNodeId(nodeId);
			simulationRef.current?.alphaTarget(0.3).restart();
			(event.target as Element).setPointerCapture?.(event.pointerId);
		},
		[clientPointToGraph, graphData.links],
	);

	const handleNodePointerMove = useCallback(
		(event: React.PointerEvent<SVGGElement>) => {
			const drag = dragStateRef.current;
			if (!drag) return;
			const node = dragNodesRef.current.find((n) => n.id === drag.id);
			if (!node) return;
			if (!drag.moved && Math.hypot(event.clientX - drag.startClientX, event.clientY - drag.startClientY) > 4) {
				drag.moved = true;
			}
			const graphPoint = clientPointToGraph(event.clientX, event.clientY);
			const prevX = node.fx ?? node.x ?? 0;
			const prevY = node.fy ?? node.y ?? 0;
			const x = graphPoint.x + drag.offsetX;
			const y = graphPoint.y + drag.offsetY;
			const dx = x - prevX;
			const dy = y - prevY;
			node.fx = x;
			node.fy = y;
			node.x = x;
			node.y = y;

			// Move loose child nodes (outgoing edges) by the same delta.
			const nextPos: Record<string, { x: number; y: number }> = { [drag.id]: { x, y } };
			for (const link of graphData.links) {
				if (link.source !== drag.id) continue;
				const child = dragNodesRef.current.find((n) => n.id === link.target);
				if (!child || child.fx != null || child.fy != null) continue;
				child.x = (child.x ?? 0) + dx;
				child.y = (child.y ?? 0) + dy;
				nextPos[child.id] = { x: child.x, y: child.y };
			}

			setGraphPositions((prev) => {
				let changed = false;
				const out = { ...prev };
				for (const [id, p] of Object.entries(nextPos)) {
					const cur = out[id];
					if (!cur || cur.x !== p.x || cur.y !== p.y) {
						out[id] = p;
						changed = true;
					}
				}
				return changed ? out : prev;
			});
		},
		[clientPointToGraph, graphData.links],
	);

	const handleNodePointerUp = useCallback((event: React.PointerEvent<SVGGElement>) => {
		const drag = dragStateRef.current;
		if (!drag) return;
		const node = dragNodesRef.current.find((n) => n.id === drag.id);
		// Release pin so layout continues fluidly (reference fluidDrag end).
		if (node) {
			node.fx = null;
			node.fy = null;
		}
		dragStateRef.current = null;
		setDraggingNodeId(null);
		simulationRef.current?.alphaTarget(0);
	}, []);

	// Graph dimensions
	const width = 1200;
	const height = 800;

	// D3 Zoom Setup
	useEffect(() => {
		if (svgRef.current) {
			const zoom = d3
				.zoom<SVGSVGElement, unknown>()
				.scaleExtent([0.1, 4])
				.on('zoom', (event) => {
					setTransform(event.transform);
				});
			zoomBehaviorRef.current = zoom;
			d3.select(svgRef.current).call(zoom);
		}
	}, []);

	const handleCenter = useCallback(() => {
		if (svgRef.current && zoomBehaviorRef.current) {
			d3.select(svgRef.current).transition().duration(300).call(zoomBehaviorRef.current.transform, d3.zoomIdentity);
		} else {
			setTransform(d3.zoomIdentity);
		}
	}, []);

	// D3 Force Simulation — slow settle; pull connected nodes together and
	// cluster same city/state business locations into regional groups.
	useEffect(() => {
		if (graphData.nodes.length === 0) return;

		// New nodes (e.g. from an in-place expansion) start near whichever
		// already-placed neighbor they're linked to, so they visibly "grow
		// out of" that node instead of dropping in from the center —
		// existing nodes keep their current position instead of resetting.
		const neighborPosition = (nodeId: string): { x: number; y: number } | null => {
			for (const link of graphData.links) {
				if (link.source === nodeId && positionsRef.current[link.target]) return positionsRef.current[link.target];
				if (link.target === nodeId && positionsRef.current[link.source]) return positionsRef.current[link.source];
			}
			return null;
		};

		const prevById = new Map((dragNodesRef.current || []).map((n: any) => [n.id, n]));

		// Force profile from finra-data-chart-next-02/src/lib/finra-graph.ts
		const nCount = graphData.nodes.length;
		const dense = nCount > 1000; // isHuge
		const mid = !dense && nCount > 300; // isLarge

		// Pre-assign each leaf's highest-degree neighbor as a spawn hub so new
		// children start on staggered rings instead of stacking near the center.
		const degreeLookup = (id: string) => connectionCountById[id] || 0;
		const bestHubFor = (nodeId: string): string | null => {
			let best: string | null = null;
			let bestDeg = -1;
			for (const link of graphData.links) {
				const other =
					link.source === nodeId ? link.target
					: link.target === nodeId ? link.source
					: null;
				if (!other) continue;
				const d = degreeLookup(other);
				if (d > bestDeg) {
					bestDeg = d;
					best = other;
				}
			}
			return best;
		};
		const kidsByHubSeed = new Map<string, string[]>();
		for (const n of graphData.nodes) {
			const hub = bestHubFor(n.id);
			if (!hub || degreeLookup(hub) < 4) continue;
			if (degreeLookup(n.id) > 3) continue;
			const list = kidsByHubSeed.get(hub) || [];
			list.push(n.id);
			kidsByHubSeed.set(hub, list);
		}
		const seedRingOf = new Map<string, { hub: string; ring: number; angle: number }>();
		for (const [hub, kids] of kidsByHubSeed) {
			const unique = Array.from(new Set(kids)).sort((a, b) => a.localeCompare(b));
			unique.forEach((child, i) => {
				const ring = i % 4;
				const angle = (i / Math.max(unique.length, 1)) * Math.PI * 2 + (ring * Math.PI) / 8;
				seedRingOf.set(child, { hub, ring, angle });
			});
		}

		const d3Nodes = graphData.nodes.map((n) => {
			const prev = prevById.get(n.id);
			const existing = positionsRef.current[n.id];
			const radius = nodeRadius(n.id, n.kind);
			const locKey = locationKeyFromParts(n.city, n.state);
			const entityType = resolveNodeEntityType(n);
			const loc = locationRegionTarget(n.city, n.state, width, height, nCount, entityType);
			const base =
				existing ?
					{
						...n,
						x: existing.x,
						y: existing.y,
						radius,
						locKey,
						locX: loc?.x,
						locY: loc?.y,
						locStrength: loc?.strength ?? 0,
						entityType,
					}
				:	(() => {
						const seed = seedRingOf.get(n.id);
						const hubPos = seed ? positionsRef.current[seed.hub] || neighborPosition(n.id) : neighborPosition(n.id);
						if (seed && hubPos) {
							const hubDeg = degreeLookup(seed.hub);
							const orbitBase = 140 + Math.min(220, Math.sqrt(Math.max(hubDeg, 1)) * 28);
							const ringStep = 70 + Math.min(50, hubDeg * 0.35);
							const dist = orbitBase + seed.ring * ringStep;
							return {
								...n,
								x: hubPos.x + Math.cos(seed.angle) * dist,
								y: hubPos.y + Math.sin(seed.angle) * dist,
								radius,
								locKey,
								locX: loc?.x,
								locY: loc?.y,
								locStrength: loc?.strength ?? 0,
								entityType,
							};
						}
						const anchor =
							hubPos ||
							(loc ? { x: loc.x, y: loc.y } : null) || { x: width / 2, y: height / 2 };
						return {
							...n,
							x: anchor.x + (Math.random() - 0.5) * 120,
							y: anchor.y + (Math.random() - 0.5) * 120,
							radius,
							locKey,
							locX: loc?.x,
							locY: loc?.y,
							locStrength: loc?.strength ?? 0,
							entityType,
						};
					})();
			// Reference fluidDrag releases pins on end — don't re-pin across rebuilds.
			if (prev && typeof prev.vx === 'number') (base as any).vx = prev.vx * 0.7;
			if (prev && typeof prev.vy === 'number') (base as any).vy = prev.vy * 0.7;
			return base;
		});
		const d3Links = graphData.links.map((l) => ({ source: l.source, target: l.target, label: l.label }));

		const nodeById = new Map(d3Nodes.map((n) => [n.id, n]));

		// Spread-out layout for dense hubs (e.g. firm/7870): longer base links,
		// staggered child radii so spokes don't pile up, stronger charge/collide.
		const centerStrength =
			dense ? 0.002
			: mid ? 0.003
			: 0.006;
		const baseCharge =
			dense ? -1400
			: mid ? -1150
			: -900;
		const linkStrengthBase =
			dense ? 0.22
			: mid ? 0.28
			: 0.36;
		const linkDistBase =
			nCount > 1000 ? 420
			: nCount > 300 ? 360
			: nCount > 150 ? 320
			: nCount > 80 ? 380
			: 520;
		const collidePad =
			nCount > 1000 ? 28
			: nCount > 600 ? 34
			: nCount > 300 ? 40
			: nCount > 120 ? 48
			: nCount > 60 ? 62
			: 78;
		const labelPad =
			nCount > 1000 ? 28
			: nCount > 600 ? 26
			: nCount > 300 ? 24
			: 22;
		const restartAlpha =
			nCount <= 0 ? 0.22
			: nCount > 1000 ? 0.12
			: nCount > 300 ? 0.16
			: 0.2;

		const degreeOf = (d: any) => connectionCountById[d?.id] || 0;

		// For each hub, order neighbors and assign staggered ring distances so
		// child nodes sit on alternating radii (readable labels + associations).
		const childrenByHub = new Map<string, string[]>();
		for (const l of graphData.links) {
			const push = (hub: string, child: string) => {
				const list = childrenByHub.get(hub) || [];
				list.push(child);
				childrenByHub.set(hub, list);
			};
			// Prefer high-degree endpoint as hub for ring assignment.
			const sDeg = connectionCountById[l.source] || 0;
			const tDeg = connectionCountById[l.target] || 0;
			if (sDeg >= tDeg) push(l.source, l.target);
			else push(l.target, l.source);
		}
		const childRingIndex = new Map<string, number>(); // `${hub}|${child}` -> ring
		for (const [hub, kids] of childrenByHub) {
			const unique = Array.from(new Set(kids)).sort((a, b) => a.localeCompare(b));
			// 4 staggered rings; interleave by sort order so neighbors aren't same length.
			unique.forEach((child, i) => {
				childRingIndex.set(`${hub}|${child}`, i % 4);
			});
		}
		const staggeredChildDistance = (hubId: string, childId: string, hubDeg: number) => {
			const ring = childRingIndex.get(`${hubId}|${childId}`) ?? hashString(childId) % 4;
			// Base orbit grows with hub degree so large firms fan out farther.
			const orbitBase = 140 + Math.min(220, Math.sqrt(Math.max(hubDeg, 1)) * 28);
			const ringStep = 70 + Math.min(50, hubDeg * 0.35);
			// Small deterministic jitter so rings aren't perfectly circular.
			const jitter = ((hashString(`${hubId}:${childId}`) % 1000) / 999 - 0.5) * 36;
			return orbitBase + ring * ringStep + jitter;
		};

		const collisionRadius = (d: any) => {
			const deg = degreeOf(d);
			const scatterPad = Math.min(nCount > 1000 ? 72 : 64, nodeScatterBoost(deg, nCount) * 0.45);
			const labelLenPad = Math.min(28, Math.max(0, String(d?.label || '').length - 8) * 0.55);
			// Extra air around leaves so labels don't sit on top of each other.
			const leafBoost = deg <= 2 ? 18 : 0;
			return (d.radius ?? 10) + collidePad + labelPad + scatterPad + labelLenPad + leafBoost;
		};

		const simulation = d3
			.forceSimulation(d3Nodes as d3.SimulationNodeDatum[])
			.alpha(restartAlpha)
			.alphaMin(0.001)
			.alphaDecay(
				dense ? 0.045
				: mid ? 0.022
				: 0.01,
			)
			.velocityDecay(mid || dense ? 0.68 : 0.6)
			.force(
				'link',
				d3
					.forceLink(d3Links)
					.id((d: any) => d.id)
					.distance((d: any) => {
						const s = typeof d.source === 'object' ? d.source : nodeById.get(d.source);
						const t = typeof d.target === 'object' ? d.target : nodeById.get(d.target);
						const sId = s?.id ?? (typeof d.source === 'string' ? d.source : '');
						const tId = t?.id ?? (typeof d.target === 'string' ? d.target : '');
						const sDeg = degreeOf(s);
						const tDeg = degreeOf(t);
						const hubDeg = Math.max(sDeg, tDeg);
						const hubId = sDeg >= tDeg ? sId : tId;
						const childId = sDeg >= tDeg ? tId : sId;

						const degScale =
							hubDeg > 100 ? 1.55
							: hubDeg > 50 ? 1.4
							: hubDeg > 20 ? 1.25
							: 1.1;
						const scatter = Math.max(nodeScatterBoost(sDeg, nCount), nodeScatterBoost(tDeg, nCount));
						const label = String(d.label || '').toLowerCase();
						const former = label.includes('previous') || label.includes('former');
						const controls = label.includes('control') || label.includes('owner');

						// Stagger leaf spokes off hubs; keep hub–hub edges longer but uniform.
						const childIsLeaf = Math.min(sDeg, tDeg) <= 3;
						const stagger = childIsLeaf && hubDeg >= 4 ? staggeredChildDistance(hubId, childId, hubDeg) : 0;
						const base = stagger > 0 ? stagger : linkDistBase * degScale + scatter * 1.35;

						return (
							base +
							(controls ? 40
							: former ? 28
							: 0)
						);
					})
					// Softer springs on high-degree hubs so stagger distances can stick.
					.strength((d: any) => {
						const s = typeof d.source === 'object' ? d.source : nodeById.get(d.source);
						const t = typeof d.target === 'object' ? d.target : nodeById.get(d.target);
						const deg = Math.max(degreeOf(s), degreeOf(t));
						if (deg > 80) return linkStrengthBase * 0.55;
						if (deg > 20) return linkStrengthBase * 0.75;
						return linkStrengthBase;
					}),
			)
			.force(
				'charge',
				d3
					.forceManyBody()
					.strength((d: any) => {
						const deg = degreeOf(d);
						// Leaves repel a bit more so they don't clump on the same arc.
						const leaf = deg <= 2 ? 1.25 : 1;
						return (deg > 20 ? 1.75 * baseCharge : baseCharge) * leaf;
					})
					.distanceMax(900)
					.theta(mid || dense ? 0.88 : 0.78),
			)
			.force('x', d3.forceX(width / 2).strength(centerStrength))
			.force('y', d3.forceY(height / 2).strength(centerStrength))
			.force(
				'location-x',
				// Keep region bias mild so it doesn't crush the staggered rings.
				d3.forceX((d: any) => (typeof d.locX === 'number' ? d.locX : width / 2)).strength((d: any) => (d.locStrength || 0) * 0.55),
			)
			.force(
				'location-y',
				d3.forceY((d: any) => (typeof d.locY === 'number' ? d.locY : height / 2)).strength((d: any) => 0.85 * (d.locStrength || 0) * 0.55),
			)
			.force(
				'collision',
				d3
					.forceCollide()
					.radius((d: any) => collisionRadius(d))
					.strength(0.95)
					.iterations(2),
			);

		simulationRef.current = simulation;
		dragNodesRef.current = d3Nodes;

		// Reference draws via rAF and skips every other tick while alpha is high
		// (K.alpha()>.15 && C%2!=0). Mirror that cadence + light display lerp.
		const displayPos: Record<string, { x: number; y: number }> = { ...positionsRef.current };
		let rafId = 0;
		let pending = false;
		let tickCount = 0;
		const flushPositions = () => {
			pending = false;
			rafId = 0;
			const snapshot = { ...displayPos };
			setGraphPositions(snapshot);
			positionsRef.current = snapshot;
		};

		simulation.on('tick', () => {
			tickCount += 1;
			// While hot, only push every 2nd tick (reference cadence).
			if (simulation.alpha() > 0.15 && tickCount % 2 !== 0) return;

			// Slight ease keeps SVG React updates from feeling stepped.
			const ease = 0.28;
			d3Nodes.forEach((raw) => {
				const n = raw as any;
				if (!n.id) return;
				const tx = typeof n.fx === 'number' ? n.fx : (n.x ?? 0);
				const ty = typeof n.fy === 'number' ? n.fy : (n.y ?? 0);
				const prev = displayPos[n.id];
				if (typeof n.fx === 'number' && typeof n.fy === 'number') {
					displayPos[n.id] = { x: tx, y: ty };
				} else if (!prev) {
					displayPos[n.id] = { x: tx, y: ty };
				} else {
					displayPos[n.id] = {
						x: prev.x + (tx - prev.x) * ease,
						y: prev.y + (ty - prev.y) * ease,
					};
				}
			});
			if (!pending) {
				pending = true;
				rafId = requestAnimationFrame(flushPositions);
			}
		});

		// Auto-stop like the reference (f?2500:u?3500:5e3)
		const stopMs =
			dense ? 2500
			: mid ? 3500
			: 5000;
		const stopTimer = window.setTimeout(() => {
			try {
				simulation.stop();
			} catch {
				/* ignore */
			}
		}, stopMs);

		return () => {
			window.clearTimeout(stopTimer);
			simulation.stop();
			if (rafId) cancelAnimationFrame(rafId);
			if (simulationRef.current === simulation) simulationRef.current = null;
		};
	}, [graphData, nodeRadius, connectionCountById, width, height]);

	const selectNode = useCallback(
		(nodeId: string) => {
			setFocusedNodeId(nodeId);
			// Selecting any node (including the primary/hub node) reveals the
			// detail drawer, matching the reference site's "closed until a
			// node is picked" behavior.
			setDrawerOpen(true);
			const node = graphData.nodes.find((n) => n.id === nodeId);
			if (!node) return;

			// Search-result nodes aren't connected to the current hub yet, so
			// clicking one hydrates it into the new primary/hub entity (as
			// before) rather than merely expanding it in place.
			if (nodeId.startsWith('search-') && node.loadKey) {
				loadKey(node.loadKey);
				setSearchResultNodes((prev) => prev.filter((n) => n.id !== nodeId));
				return;
			}

			// Every other node — the primary hub node or any relation node —
			// reveals its own connections (current + previous employments for
			// a person; owners/control persons and current+previous employees
			// for a firm) merged into the existing graph, in place.
			expandNode(node);
		},
		[graphData.nodes, loadKey, expandNode],
	);

	// Wraps `selectNode` so that releasing a drag (which fires a trailing
	// click) doesn't also re-focus/select the node — only a genuine
	// click-without-movement should do that.
	const handleNodeClick = useCallback(
		(nodeId: string) => {
			if (dragStateRef.current?.moved) return;
			selectNode(nodeId);
		},
		[selectNode],
	);

	// Double-click a label to pin it large → small → auto (zoom-driven).
	const cycleLabelMode = useCallback((nodeId: string) => {
		setLabelModeById((prev) => {
			const current = prev[nodeId] ?? 'auto';
			const next: LabelMode =
				current === 'auto' ? 'large'
				: current === 'large' ? 'small'
				: 'auto';
			if (next === 'auto') {
				const { [nodeId]: _removed, ...rest } = prev;
				return rest;
			}
			return { ...prev, [nodeId]: next };
		});
	}, []);

	const handleLabelClick = useCallback(
		(event: React.MouseEvent, nodeId: string) => {
			event.stopPropagation();
			if (dragStateRef.current?.moved) return;
			handleNodeClick(nodeId);
		},
		[handleNodeClick],
	);

	const handleLabelDoubleClick = useCallback(
		(event: React.MouseEvent, nodeId: string) => {
			event.stopPropagation();
			event.preventDefault();
			cycleLabelMode(nodeId);
		},
		[cycleLabelMode],
	);

	const zoomScale = transform.k;

	return (
		<>
			<Head>
				<title>{entityTitle ? `${entityTitle} • Node Graph` : 'Node Graph'} • FINRA / SEC</title>
			</Head>

			<div
				className={`node-graph-page fullscreen-mode theme-${theme}`}
				data-theme={theme}>
				<header className='fg-header'>
					<div className='fg-header-bar'>
						<div className='fg-header-brand'>
							<span className='fg-logo'>FINRA</span>
						</div>
						<form
							className='fg-search-form'
							onSubmit={handleSearch}>
							<input
								className='fg-search-input'
								type='text'
								placeholder='firm, person, CRD/SEC#'
								value={searchInput}
								onChange={(e) => setSearchInput(e.target.value)}
							/>
							<button
								type='submit'
								className='fg-search-btn'
								disabled={searchLoading}>
								Search
							</button>
						</form>
						<div className='fg-header-actions'>
							<Link
								href='/'
								className='fg-btn'>
								Dashboard
							</Link>
							<button
								type='button'
								onClick={runSearch}
								className='fg-send-btn'
								aria-label='Search'
								disabled={searchLoading}>
								➤
							</button>
							{activeSnapshot && (
								<button
									type='button'
									onClick={() => setDrawerOpen((open) => !open)}
									className={`fg-hamburger-btn${drawerOpen ? ' active' : ''}`}
									aria-label='Toggle details panel'
									aria-expanded={drawerOpen}>
									☰
								</button>
							)}
						</div>
					</div>
					{searchError && <div className='fg-search-error'>{searchError}</div>}
					{searchBanner && (
						<div className='fg-search-banner'>
							<span>
								Added {searchBanner.count} node{searchBanner.count === 1 ? '' : 's'} for &quot;{searchBanner.query}&quot;
							</span>
							<button
								type='button'
								className='fg-search-banner-close'
								onClick={() => setSearchBanner(null)}
								aria-label='Dismiss'>
								✕
							</button>
						</div>
					)}
				</header>

				<main className='graph-main-canvas'>
					{searchLoading && (
						<div className='fg-loading-overlay'>
							<span>Loading…</span>
						</div>
					)}
					{!activeSnapshot && graphData.nodes.length === 0 && !searchLoading && (
						<div className='fg-empty-card'>
							<p className='fg-empty-eyebrow'>Search for a firm, person, or CRD/SEC# to begin.</p>
						</div>
					)}
					<svg
						ref={svgRef}
						className='graph-svg'
						viewBox={`0 0 ${width} ${height}`}
						preserveAspectRatio='xMidYMid meet'
						role='img'
						aria-label='Relationship graph'>
						<g transform={transform.toString()}>
							{visibleLinks.map((link) => {
								const sourceId = typeof link.source === 'string' ? link.source : String((link as any).source?.id ?? link.source);
								const targetId = typeof link.target === 'string' ? link.target : String((link as any).target?.id ?? link.target);
								const sourcePos = graphPositions[sourceId];
								const targetPos = graphPositions[targetId];
								if (!sourcePos || !targetPos) return null;
								const dimmed = traceConnectedIds ? !(traceConnectedIds.has(sourceId) && traceConnectedIds.has(targetId)) : false;
								return (
									<line
										key={`${sourceId}-${targetId}-${link.label}`}
										className={`graph-link-glow${dimmed ? ' dimmed' : ''}`}
										x1={sourcePos.x}
										y1={sourcePos.y}
										x2={targetPos.x}
										y2={targetPos.y}
									/>
								);
							})}
							{visibleNodes.map((node) => {
								const position = graphPositions[node.id];
								if (!position) return null;
								const isPrimary = node.kind === 'primary';
								const isActive = focusedNodeId === node.id;
								const dimmed = traceConnectedIds ? !traceConnectedIds.has(node.id) : false;
								const nodeEntityType = resolveNodeEntityType(node, entityType === 'firm' ? 'firm' : 'individual');
								const radius = nodeRadius(node.id, node.kind);
								const labelMode: LabelMode = labelModeById[node.id] ?? 'auto';
								// Auto labels hide when zoomed out halfway; pinned large/small stay.
								const showLabel = labelMode !== 'auto' || zoomScale >= LABEL_HIDE_SCALE;
								const labelSizeClass =
									labelMode === 'large' ? ' size-large'
									: labelMode === 'small' ? ' size-small'
									: ' size-auto';
								// Translate the group so circle/label stay locked to the
								// same origin as link endpoints (cx/cy stay fixed at 0).
								return (
									<g
										key={node.id}
										className={`graph-node-group${dimmed ? ' dimmed' : ''}${draggingNodeId === node.id ? ' dragging' : ''}${expandingNodeId === node.id ? ' expanding' : ''}`}
										transform={`translate(${position.x},${position.y})`}
										onClick={() => handleNodeClick(node.id)}
										onPointerDown={(event) => handleNodePointerDown(event, node.id)}
										onPointerMove={handleNodePointerMove}
										onPointerUp={handleNodePointerUp}
										onPointerCancel={handleNodePointerUp}>
										<title>
											{node.label}
											{connectionCountById[node.id] ? ` · ${connectionCountById[node.id]} connection${connectionCountById[node.id] === 1 ? '' : 's'}` : ''}
											{` · label: ${labelMode} (double-click label to cycle)`}
										</title>
										<circle
											className={`graph-node ${nodeEntityType}${isPrimary ? ' primary' : ''}${isActive ? ' active' : ''}`}
											cx={0}
											cy={0}
											r={radius}
										/>
										{isPrimary && roleRows.includes('Investment Adviser') && (
											<circle
												className='graph-node-adviser-badge'
												cx={radius * 0.72}
												cy={-radius * 0.55}
												r={Math.max(4, radius * 0.28)}
											/>
										)}
										{showLabel && (
											<text
												x={0}
												y={
													-(
														radius +
														(labelMode === 'large' ? 12
														: labelMode === 'small' ? 6
														: 8)
													)
												}
												className={`graph-label${labelSizeClass}${isActive ? ' active' : ''}${labelMode !== 'auto' ? ' pinned' : ''}`}
												onClick={(event) => handleLabelClick(event, node.id)}
												onDoubleClick={(event) => handleLabelDoubleClick(event, node.id)}>
												{node.label}
											</text>
										)}
									</g>
								);
							})}
						</g>
					</svg>
				</main>

				{(activeSnapshot || graphData.nodes.length > 0) && (
					<div className={`fg-toolbar-dock${toolbarMinimized ? ' minimized' : ''}`}>
						{toolbarMinimized ?
							<button
								type='button'
								className='fg-toolbar-expand-btn'
								onClick={() => setToolbarMinimized(false)}
								aria-label='Expand toolbar'>
								☰
							</button>
						:	<>
								<button
									type='button'
									className='fg-toolbar-minimize-btn'
									onClick={() => setToolbarMinimized(true)}
									aria-label='Minimize toolbar'>
									◀
								</button>
								<div className='fg-toolbar fg-toolbar-row'>
									<button
										className='fg-toolbar-btn'
										onClick={handleRefresh}>
										Refresh ⟳
									</button>
									<button
										className={`fg-toolbar-btn${traceMode ? ' active' : ''}`}
										onClick={() => setTraceMode((v) => !v)}>
										Trace Mode
									</button>
									<button
										className='fg-toolbar-btn danger'
										onClick={handleResetSession}>
										Reset Session
									</button>
									<button
										className={`fg-toolbar-btn${clearNonConnected ? ' active' : ''}`}
										onClick={() => setClearNonConnected((v) => !v)}>
										Clear non-connected
									</button>
									<button
										className='fg-toolbar-btn'
										onClick={() => {
											setClearNonConnected(false);
											setFocusedNodeId('primary');
										}}>
										Clear Highlight
									</button>
									<button
										className='fg-toolbar-btn fg-center-btn'
										onClick={handleCenter}>
										Center ✦
									</button>
									<button
										className='fg-theme-toggle'
										onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
										aria-label='Toggle theme'>
										{theme === 'dark' ? '☀️' : '🌙'}
									</button>
								</div>
							</>
						}
					</div>
				)}

				{activeSnapshot && (
					<aside className={`node-detail-drawer${drawerOpen ? ' open' : ''}`}>
						<div className='sidebar-header'>
							<button
								type='button'
								className='drawer-close-btn'
								onClick={() => setDrawerOpen(false)}
								aria-label='Close details panel'>
								✕
							</button>
							<h1>{entityTitle}</h1>
							{roleRows.length > 0 && (
								<div className='role-rows'>
									{roleRows.map((row) => (
										<div
											key={row}
											className='role-row'>
											<span className='role-dot' />
											{row}
										</div>
									))}
								</div>
							)}
						</div>

						<div className='sidebar-content'>
							{/* Reuse the exact same header + detail components as the main
							    dashboard so this panel shows identical content (name/status
							    badges, profile links, general info, registration,
							    disclosures, employment, exams, owners, etc.). */}
							<PanelHeader
								activeKey={activeSnapshot.resolvedKey || activeSnapshot.key}
								payloads={[]}
								detailJson={activeSnapshot.detailJson}
								onSelectKey={loadKey}
							/>
							<StatusBox
								statusMsg=''
								statusHtml=''
								detailJson={activeSnapshot.detailJson}
								panelLoading={searchLoading}
								activeKey={activeSnapshot.resolvedKey || activeSnapshot.key}
								fetchLog={[]}
								onClearLog={() => {}}
								onSelectKey={loadKey}
							/>
						</div>
					</aside>
				)}
			</div>

			<style
				jsx
				global>{`
				html,
				body,
				#__next,
				.app-shell,
				.app-page {
					height: 100%;
					margin: 0;
					padding: 0;
					overflow: hidden;
				}
				.node-graph-page.fullscreen-mode {
					display: flex;
					flex-direction: column;
					width: 100vw;
					height: 100vh;
					background: #040810;
					color: #ffffff;
					font-family: var(--font-sans, system-ui, -apple-system, sans-serif);
					position: absolute;
					top: 0;
					left: 0;
					z-index: 9999;
				}
				.node-graph-page.theme-light {
					background: #f3f4f6;
					color: #111827;
				}

				/* Top header bar */
				.fg-header {
					flex-shrink: 0;
					background: #000000;
					border-bottom: 1px solid rgba(255, 255, 255, 0.08);
				}
				.theme-light .fg-header {
					background: #ffffff;
					border-bottom-color: rgba(0, 0, 0, 0.08);
				}
				.fg-header-bar {
					display: flex;
					align-items: center;
					gap: 16px;
					padding: 10px 16px;
				}
				.fg-header-brand {
					flex-shrink: 0;
				}
				.fg-logo {
					font-weight: 800;
					letter-spacing: 0.05em;
					font-size: 1rem;
					color: #f97316;
				}
				.fg-search-form {
					flex: 1;
					display: flex;
					gap: 8px;
					max-width: 480px;
				}
				.fg-search-input {
					flex: 1;
					padding: 8px 12px;
					border-radius: 6px;
					border: 1px solid rgba(255, 255, 255, 0.15);
					background: rgba(255, 255, 255, 0.05);
					color: inherit;
					font-size: 0.85rem;
				}
				.theme-light .fg-search-input {
					background: #f3f4f6;
					border-color: rgba(0, 0, 0, 0.15);
				}
				.fg-search-btn {
					padding: 8px 14px;
					border-radius: 6px;
					border: 1px solid rgba(255, 255, 255, 0.2);
					background: transparent;
					color: inherit;
					font-weight: 600;
					font-size: 0.8rem;
					cursor: pointer;
				}
				.fg-header-actions {
					display: flex;
					align-items: center;
					gap: 8px;
					flex-shrink: 0;
				}
				.fg-btn {
					padding: 8px 14px;
					border-radius: 6px;
					border: 1px solid rgba(255, 255, 255, 0.2);
					background: transparent;
					color: inherit;
					font-weight: 600;
					font-size: 0.8rem;
					text-decoration: none;
					cursor: pointer;
				}
				.fg-send-btn {
					width: 34px;
					height: 34px;
					border-radius: 6px;
					border: none;
					background: #2563eb;
					color: white;
					cursor: pointer;
				}
				.fg-hamburger-btn {
					width: 34px;
					height: 34px;
					border-radius: 6px;
					border: 1px solid rgba(255, 255, 255, 0.2);
					background: transparent;
					color: inherit;
					font-size: 1rem;
					cursor: pointer;
				}
				.fg-hamburger-btn.active {
					background: #2563eb;
					border-color: #2563eb;
					color: #ffffff;
				}
				.theme-light .fg-hamburger-btn {
					border-color: rgba(0, 0, 0, 0.2);
				}
				.fg-search-error {
					padding: 4px 16px 8px;
					color: #f87171;
					font-size: 0.8rem;
				}
				.fg-search-banner {
					position: absolute;
					top: 66px;
					left: 16px;
					z-index: 11;
					display: flex;
					align-items: center;
					gap: 10px;
					padding: 8px 12px;
					border-radius: 6px;
					border: 1px solid rgba(96, 165, 250, 0.4);
					background: rgba(30, 58, 138, 0.35);
					color: #bfdbfe;
					font-size: 0.8rem;
				}
				.theme-light .fg-search-banner {
					border-color: rgba(37, 99, 235, 0.3);
					background: rgba(219, 234, 254, 0.9);
					color: #1e3a8a;
				}
				.fg-search-banner-close {
					border: none;
					background: transparent;
					color: inherit;
					cursor: pointer;
					font-size: 0.75rem;
					line-height: 1;
				}

				.graph-main-canvas {
					display: block;
					flex: 1;
					position: relative;
					overflow: hidden;
					background: radial-gradient(circle at center, #0a1122 0%, #020408 100%);
				}
				.theme-light .graph-main-canvas {
					background: radial-gradient(circle at center, #ffffff 0%, #e5e7eb 100%);
				}
				.fg-loading-overlay,
				.fg-empty-card {
					position: absolute;
					top: 50%;
					left: 50%;
					transform: translate(-50%, -50%);
					color: #9ca3af;
					font-size: 0.9rem;
					text-align: center;
					z-index: 5;
				}
				.fg-empty-eyebrow {
					margin: 0;
				}
				.graph-svg {
					width: 100%;
					height: 100%;
					cursor: grab;
				}
				.graph-svg:active {
					cursor: grabbing;
				}
				.graph-link-glow {
					stroke: rgba(6, 182, 212, 0.55);
					stroke-width: 1.75;
					stroke-linecap: round;
					/* No geometric transitions — edges must track node x/y every frame. */
					transition: opacity 150ms ease;
					pointer-events: none;
				}
				.graph-link-glow.dimmed {
					opacity: 0.12;
				}
				.graph-node-group {
					cursor: grab;
					/* Opacity only — never transition transform/position or links detach. */
					transition: opacity 150ms ease;
					touch-action: none;
				}
				.graph-node-group.dragging {
					cursor: grabbing;
				}
				.graph-node-group.expanding .graph-node {
					animation: node-expanding-pulse 2200ms ease-in-out infinite;
				}
				@keyframes node-expanding-pulse {
					0%,
					100% {
						opacity: 1;
					}
					50% {
						opacity: 0.7;
					}
				}
				.graph-node-group.dimmed {
					opacity: 0.25;
				}
				.graph-node {
					stroke: #ffffff;
					stroke-width: 1.5;
					/* Never use transition: all — animated cx/cy lags force ticks
					   and makes lines look disconnected from nodes. */
					transition:
						fill 150ms ease,
						stroke-width 150ms ease,
						filter 150ms ease;
				}
				/* People = blue, firms = orange (including the hub/primary node). */
				.graph-node.individual {
					fill: #2563eb;
					stroke: #93c5fd;
					filter: drop-shadow(0 0 8px rgba(37, 99, 235, 0.75));
				}
				.graph-node.firm {
					fill: #f97316;
					stroke: #fdba74;
					filter: drop-shadow(0 0 8px rgba(249, 115, 22, 0.7));
				}
				.graph-node.primary {
					stroke-width: 2.25;
					filter: drop-shadow(0 0 12px rgba(6, 182, 212, 0.55));
				}
				.graph-node.individual.primary {
					filter: drop-shadow(0 0 12px rgba(37, 99, 235, 0.9));
				}
				.graph-node.firm.primary {
					filter: drop-shadow(0 0 12px rgba(249, 115, 22, 0.9));
				}
				.graph-node-adviser-badge {
					fill: #22d3ee;
					stroke: #ffffff;
					stroke-width: 1;
				}
				.graph-node:hover {
					stroke-width: 3;
				}
				/* Selection ring only — keep firm/person fill colors. */
				.graph-node.active {
					stroke: #ffffff;
					stroke-width: 3;
				}
				.graph-node.individual.active {
					filter: drop-shadow(0 0 14px rgba(59, 130, 246, 0.95));
				}
				.graph-node.firm.active {
					filter: drop-shadow(0 0 14px rgba(251, 146, 60, 0.95));
				}
				.graph-label {
					fill: #d1d5db;
					font-size: 11px;
					text-anchor: middle;
					font-weight: 500;
					paint-order: stroke;
					stroke: #020408;
					stroke-width: 3px;
					/* Clickable — select node; double-click cycles large/small/auto. */
					pointer-events: auto;
					cursor: pointer;
					user-select: none;
				}
				.graph-label.size-auto {
					font-size: 11px;
				}
				.graph-label.size-small {
					font-size: 9px;
					stroke-width: 2.5px;
					opacity: 0.92;
				}
				.graph-label.size-large {
					font-size: 15px;
					font-weight: 700;
					stroke-width: 4px;
				}
				.graph-label.pinned {
					/* Subtle underline mark so pinned labels are recognizable. */
					text-decoration: underline;
					text-decoration-color: rgba(148, 163, 184, 0.55);
					text-underline-offset: 2px;
				}
				.theme-light .graph-label {
					fill: #111827;
					stroke: #ffffff;
				}
				.graph-label.active {
					fill: #ffffff;
					font-weight: 700;
				}
				.theme-light .graph-label.active {
					fill: #111827;
				}
				.graph-label:hover {
					fill: #f8fafc;
				}
				.theme-light .graph-label:hover {
					fill: #0f172a;
				}

				/* Persistent floating toolbar dock — always visible (independent of
				   the detail drawer's open/closed state) so graph controls stay
				   reachable regardless of whether a node is selected. Pinned to
				   the bottom-left corner, laid out as a single horizontal row. */
				.fg-toolbar-dock {
					background: #0d131f;
					border: 1px solid rgba(255, 255, 255, 0.08);
					border-radius: 10px;
					box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
					z-index: 12;
					position: absolute;
					left: 16px;
					bottom: 16px;
					display: flex;
					align-items: center;
				}
				.theme-light .fg-toolbar-dock {
					background: #ffffff;
					border-color: rgba(0, 0, 0, 0.08);
					box-shadow: 0 8px 24px rgba(0, 0, 0, 0.08);
				}
				.fg-toolbar-dock.minimized {
					background: transparent;
					border: none;
					box-shadow: none;
				}

				/* Detail panel drawer — hidden off-screen by default, slides in from
				   the right when opened via the hamburger button or by selecting a
				   node in the graph. */
				.node-detail-drawer {
					width: 340px;
					background: #0d131f;
					border-left: 1px solid rgba(255, 255, 255, 0.08);
					display: flex;
					flex-direction: column;
					box-shadow: -8px 0 24px rgba(0, 0, 0, 0.4);
					z-index: 10;
					position: absolute;
					right: 0;
					top: 0;
					bottom: 0;
					overflow-y: auto;
					transform: translateX(100%);
					transition: transform 220ms ease;
					visibility: hidden;
				}
				.node-detail-drawer.open {
					transform: translateX(0);
					visibility: visible;
				}
				.theme-light .node-detail-drawer {
					background: #ffffff;
					border-left-color: rgba(0, 0, 0, 0.08);
					box-shadow: -8px 0 24px rgba(0, 0, 0, 0.08);
				}

				.fg-toolbar-minimize-btn,
				.fg-toolbar-expand-btn {
					flex-shrink: 0;
					width: 30px;
					height: 34px;
					margin: 8px;
					border-radius: 6px;
					border: 1px solid rgba(255, 255, 255, 0.15);
					background: rgba(255, 255, 255, 0.04);
					color: inherit;
					cursor: pointer;
					font-size: 0.85rem;
				}
				.fg-toolbar-expand-btn {
					margin: 0;
					background: #0d131f;
					border: 1px solid rgba(255, 255, 255, 0.08);
					box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
				}
				.theme-light .fg-toolbar-expand-btn {
					background: #ffffff;
					border-color: rgba(0, 0, 0, 0.08);
					box-shadow: 0 8px 24px rgba(0, 0, 0, 0.08);
				}
				.theme-light .fg-toolbar-minimize-btn {
					border-color: rgba(0, 0, 0, 0.15);
				}

				.fg-toolbar-row {
					display: flex;
					gap: 8px;
					padding: 8px 12px 8px 0;
					flex-wrap: nowrap;
				}
				.fg-toolbar-btn {
					flex: none;
					white-space: nowrap;
					padding: 8px 12px;
					border-radius: 6px;
					border: 1px solid rgba(255, 255, 255, 0.15);
					background: rgba(255, 255, 255, 0.04);
					color: inherit;
					font-size: 0.75rem;
					font-weight: 600;
					cursor: pointer;
				}
				.fg-toolbar-btn.active {
					background: #2563eb;
					border-color: #2563eb;
					color: #ffffff;
				}
				.fg-toolbar-btn.danger {
					color: #f87171;
					border-color: rgba(248, 113, 113, 0.4);
				}
				.fg-theme-toggle {
					flex-shrink: 0;
					width: 34px;
					height: 34px;
					border-radius: 50%;
					border: 1px solid rgba(255, 255, 255, 0.15);
					background: rgba(255, 255, 255, 0.04);
					cursor: pointer;
					font-size: 0.9rem;
				}

				.sidebar-header {
					position: relative;
					padding: 16px;
					border-bottom: 1px solid rgba(255, 255, 255, 0.06);
				}
				.drawer-close-btn {
					position: absolute;
					top: 12px;
					right: 12px;
					width: 28px;
					height: 28px;
					border-radius: 6px;
					border: 1px solid rgba(255, 255, 255, 0.15);
					background: rgba(255, 255, 255, 0.04);
					color: inherit;
					cursor: pointer;
					font-size: 0.85rem;
				}
				.theme-light .drawer-close-btn {
					border-color: rgba(0, 0, 0, 0.15);
				}
				.sidebar-header h1 {
					margin: 0 24px 4px 0;
					font-size: 1.2rem;
					font-weight: 700;
					color: #f3f4f6;
				}
				.theme-light .sidebar-header h1 {
					color: #111827;
				}
				.role-rows {
					display: flex;
					flex-direction: column;
					gap: 4px;
					margin-bottom: 10px;
				}
				.role-row {
					display: flex;
					align-items: center;
					gap: 6px;
					font-size: 0.8rem;
					color: #d1d5db;
				}
				.theme-light .role-row {
					color: #374151;
				}
				.role-dot {
					width: 8px;
					height: 8px;
					border-radius: 50%;
					background: #06b6d4;
					flex-shrink: 0;
				}

				/* PanelHeader/StatusBox are the exact same dashboard components used
				   on the main "/" page, which only has a single dark palette (their
				   CSS relies on --text-primary etc. being near-white). Force this
				   area to always render on a dark background — even when the graph
				   canvas itself is switched to the light theme — so that reused
				   text stays legible instead of rendering near-white-on-white. */
				.sidebar-content {
					padding: 16px;
					overflow-y: auto;
					flex: 1;
					background: #0d131f;
					color: #f1f1ff;
				}
			`}</style>
		</>
	);
}
