import Head from 'next/head';
import { useRouter } from 'next/router';
import { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import * as d3 from 'd3';
import { useSharedGraphState } from '../../src/hooks/useSharedGraphState';
import { parseCrdKey } from '../../src/lib/parseKey';
import { extractNamesFromPayload, getContentBlock, resolveEntityDisplayName } from '../../src/lib/extractNames';
import { toProperCaseName } from '../../src/lib/format';
import { PanelHeader } from '../../src/components/panel/PanelHeader';
import { StatusBox } from '../../src/components/panel/StatusBox';
import { deriveStatusBadge, deriveTerminatedBadge } from '../../src/lib/statusBadge';
import { FgHeader } from '../../src/components/graph/FgHeader';
import { FgDrawer } from '../../src/components/graph/FgDrawer';
import { useSelectionLog } from '../../src/hooks/useSelectionLog';

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
	/** Inactive/terminated on FINRA+SEC (or sole source) — gray node styling. */
	inactive?: boolean;
};

/** True when record is inactive/terminated and not active on any source. */
function isDetailPayloadInactive(detailJson: string | null | undefined, entityType: GraphEntityType = 'individual'): boolean {
	if (!detailJson) return false;
	try {
		const payload = JSON.parse(detailJson);
		const sources = payload && typeof payload === 'object' ? (payload as any).sources : null;
		const evaluateContent = (content: Record<string, any> | null | undefined, source: 'finra' | 'sec') => {
			if (!content) return null as 'active' | 'inactive' | null;
			const bi = (content.basicInformation && typeof content.basicInformation === 'object' ? content.basicInformation : {}) as Record<string, any>;
			const terminated = deriveTerminatedBadge([bi.firmStatus, bi.firmStatusDate], [content.firmStatus, content.firmStatusDate]);
			const status = deriveStatusBadge(source === 'sec' ? bi.iaScope : bi.bcScope, content.status, content.currentStatus);
			const labels = [terminated?.label, status?.label].filter(Boolean).join(' ').toLowerCase();
			if (!labels) return null;
			if (/(^|\s)active(\s|$)/.test(labels) && !/inactive/.test(labels) && !/terminated/.test(labels)) return 'active';
			if (/inactive|terminated|not in scope|notinscope/.test(labels)) return 'inactive';
			return null;
		};

		const flags: Array<'active' | 'inactive'> = [];
		if (sources && typeof sources === 'object') {
			for (const key of ['finra', 'sec'] as const) {
				const entry = sources[key];
				const sourcePayload =
					entry?.payload ??
					(typeof entry?.rawPayload === 'string' ?
						(() => {
							try {
								return JSON.parse(entry.rawPayload);
							} catch {
								return null;
							}
						})()
					:	null);
				const content = (getContentBlock(sourcePayload, key, entityType) ?? sourcePayload) as Record<string, any> | null;
				const flag = evaluateContent(content, key);
				if (flag) flags.push(flag);
			}
		} else {
			const content =
				(getContentBlock(payload, 'finra', entityType) as Record<string, any> | null) ||
				(getContentBlock(payload, 'sec', entityType) as Record<string, any> | null) ||
				(payload as Record<string, any>);
			const finraFlag = evaluateContent(getContentBlock(payload, 'finra', entityType) as Record<string, any> | null, 'finra');
			const secFlag = evaluateContent(getContentBlock(payload, 'sec', entityType) as Record<string, any> | null, 'sec');
			if (finraFlag) flags.push(finraFlag);
			if (secFlag) flags.push(secFlag);
			if (!flags.length) {
				const anyFlag = evaluateContent(content, 'finra') || evaluateContent(content, 'sec');
				if (anyFlag) flags.push(anyFlag);
			}
		}

		if (!flags.length) return false;
		// Gray only when nothing is active and at least one source is inactive/terminated.
		return flags.every((f) => f === 'inactive');
	} catch {
		return false;
	}
}

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
		nodeCount > 1000 ? 14
		: nodeCount > 600 ? 12
		: nodeCount > 300 ? 10.5
		: nodeCount > 120 ? 9
		: 7.5;
	const cap =
		nodeCount > 1000 ? 340
		: nodeCount > 600 ? 280
		: nodeCount > 300 ? 240
		: nodeCount > 120 ? 200
		: 160;
	return Math.min(cap, Math.sqrt(degree) * multiplier);
}

/** Default rendered radii (must stay in sync with nodeRadius callback defaults). */
const GRAPH_FIRM_NODE_RADIUS = 110;
const GRAPH_INDIVIDUAL_NODE_RADIUS = 65;

/**
 * Private orbit around an expanded hub: circumference spacing from node size + child count.
 */
function graphOrbitRadiusForHub(opts: { hubIsFirm: boolean; childCount: number; ringIndex?: number; ringCount?: number; preferSingleRing?: boolean }): {
	radius: number;
	ringCount: number;
} {
	const childCount = Math.max(1, opts.childCount | 0);
	const hubSize = opts.hubIsFirm ? GRAPH_FIRM_NODE_RADIUS : GRAPH_INDIVIDUAL_NODE_RADIUS;
	const childSize = opts.hubIsFirm ? GRAPH_INDIVIDUAL_NODE_RADIUS : GRAPH_FIRM_NODE_RADIUS;
	const arcPad = childSize * 2.7;
	const minClear = hubSize + childSize + Math.max(48, childSize * 1.1);

	let ringCount = opts.ringCount ?? 1;
	if (opts.preferSingleRing && childCount <= 28) {
		ringCount = 1;
	} else if (opts.ringCount == null) {
		if (childCount > 200) ringCount = 7;
		else if (childCount > 120) ringCount = 6;
		else if (childCount > 70) ringCount = 5;
		else if (childCount > 36) ringCount = 4;
		else if (childCount > 18) ringCount = 3;
		else if (childCount > 10) ringCount = 2;
		else ringCount = 1;
	}

	const perRing = Math.max(1, Math.ceil(childCount / ringCount));
	const fromArc = (perRing * arcPad) / (Math.PI * 2);
	const base = Math.max(minClear, fromArc, opts.hubIsFirm ? 360 : 440);
	const ring = Math.max(0, opts.ringIndex ?? 0);
	const ringStep = Math.max(childSize * 3 + 48, 160 + Math.min(100, Math.sqrt(childCount) * 11));
	return { radius: base + ring * ringStep, ringCount };
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

function parseGraphCrdRef(value: string | null | undefined): { type: GraphEntityType; crd: string } | null {
	const raw = String(value || '').trim();
	if (!raw) return null;
	const full = raw.match(/^(?:finra|sec):(individual|firm|person):(\d+)$/i);
	if (full) return { type: full[1].toLowerCase() === 'firm' ? 'firm' : 'individual', crd: full[2] };
	const short = raw.match(/^(individual|firm|person):(\d+)$/i);
	if (short) return { type: short[1].toLowerCase() === 'firm' ? 'firm' : 'individual', crd: short[2] };
	const rel = raw.match(/^relation-(individual|firm)-(\d+)$/i);
	if (rel) return { type: rel[1].toLowerCase() === 'firm' ? 'firm' : 'individual', crd: rel[2] };
	const search = raw.match(/^search-(individual|firm)-(\d+)/i);
	if (search) return { type: search[1].toLowerCase() === 'firm' ? 'firm' : 'individual', crd: search[2] };
	return null;
}

function graphNodeToCrdRef(node: Pick<GraphNode, 'id' | 'loadKey' | 'entityType'>): { type: GraphEntityType; crd: string } | null {
	return parseGraphCrdRef(node.loadKey) || parseGraphCrdRef(node.id) || null;
}

function finraKeyFromCrdRef(ref: { type: GraphEntityType; crd: string }): string {
	return `finra:${ref.type}:${ref.crd}`;
}

function snapshotKeyAliases(key: string): string[] {
	const ref = parseGraphCrdRef(key) || parseCrdKey(key);
	if (!ref?.crd) return [key];
	const type = ref.type === 'firm' ? 'firm' : 'individual';
	return Array.from(new Set([key, `finra:${type}:${ref.crd}`, `sec:${type}:${ref.crd}`, `${type}:${ref.crd}`, type === 'individual' ? `person:${ref.crd}` : ''].filter(Boolean)));
}

function resolveNodeEntityType(
	node: Pick<GraphNode, 'id'> & Partial<Pick<GraphNode, 'entityType' | 'loadKey' | 'kind' | 'label'>>,
	hubEntityType?: GraphEntityType,
): GraphEntityType {
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
	/** true = current relationship; false = previous/former */
	isCurrent?: boolean;
};

type GraphLinkKind = 'owner' | 'current' | 'previous';

function graphLinkKind(link: Pick<GraphLink, 'label' | 'isCurrent'>): GraphLinkKind {
	const label = String(link.label || '').toLowerCase();
	if (label.includes('owner') || label.includes('control')) return 'owner';
	if (link.isCurrent === false || /previous|former|prior/.test(label)) return 'previous';
	return 'current';
}

/** Color role for a spoke node: owners first, then current, else previous-only. */
function graphNodeLinkKind(nodeId: string, links: GraphLink[]): GraphLinkKind | null {
	if (nodeId === 'primary') return null;
	let sawPrevious = false;
	for (const link of links) {
		const sourceId = typeof link.source === 'string' ? link.source : String((link as any).source?.id ?? link.source);
		const targetId = typeof link.target === 'string' ? link.target : String((link as any).target?.id ?? link.target);
		if (sourceId !== nodeId && targetId !== nodeId) continue;
		const kind = graphLinkKind(link);
		if (kind === 'owner') return 'owner';
		if (kind === 'current') return 'current';
		if (kind === 'previous') sawPrevious = true;
	}
	return sawPrevious ? 'previous' : null;
}

// Shape returned by GET /api/finra/expand/[nodeId] (see pages/api/_graphIndex.ts).
// That endpoint reads directly from the Redis-backed saved-payload store and
// resolves BOTH current and previous employments (for individuals) and
// current owners/control persons plus current+previous employees (for
// firms) — i.e. exactly the "reveal connected nodes" data this page needs
// when a node is clicked, without re-deriving it from scratch here.
type ExpandApiNode = { id: string; label: string; group: 'individual' | 'firm'; crd: string; city?: string; state?: string; inactive?: boolean };
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

	// Hub snapshot only has current relations here; expand API adds previous.
	const relationArrays = [
		['currentEmployments', 'Employment', 'firm', true],
		['currentIAEmployments', 'Adviser', 'firm', true],
		['directOwners', 'Direct owner', 'individual', true],
		['indirectOwners', 'Indirect owner', 'individual', true],
		// Some payloads also expose previous arrays on the content block.
		['previousEmployments', 'Previous employment', 'firm', false],
		['previousIAEmployments', 'Previous employment', 'firm', false],
	] as const;

	for (const content of contents) {
		if (!content) continue;
		for (const [key, fallbackLabel, relatedType, isCurrent] of relationArrays) {
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
				const existing = links.find((l) => l.source === 'primary' && l.target === nodeId);
				if (!existing) {
					links.push({ source: 'primary', target: nodeId, label: fallbackLabel, isCurrent });
				} else if (isCurrent && existing.isCurrent === false) {
					// Prefer current styling if both current + previous edges collapse onto one node.
					existing.isCurrent = true;
					existing.label = fallbackLabel;
				}
			}
		}
	}

	return { nodes, links };
}

const DEFAULT_SCALE = 0.8;
const DEFAULT_TRANSFORM = d3.zoomIdentity.translate(600 * (1 - DEFAULT_SCALE), 400 * (1 - DEFAULT_SCALE)).scale(DEFAULT_SCALE);

export default function NodeGraphPage() {
	const router = useRouter();
	const { cache, setSnapshot, clear } = useSharedGraphState();
	const { selectionLog, clearSelectionLog } = useSelectionLog();

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

	const isTargetLargeBottom = Boolean(routeParams && routeParams.type === 'individual' && routeParams.crd === '1156956');

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
	const [sessionHydrated, setSessionHydrated] = useState(false);
	const restoredSessionRef = useRef(false);
	const skipSessionSaveRef = useRef(true);

	// Click-to-expand: when a node is clicked, its own connections (current
	// AND previous employments for individuals; owners/control persons plus
	// current+previous employees for firms) are fetched from
	// /api/finra/expand and merged into the graph in place — the existing
	// graph is never replaced. `expandedKeysRef` tracks which entities
	// (canonical "individual:<crd>" / "firm:<crd>") have already been
	// expanded so re-clicking a node doesn't refetch.
	const [expansionNodes, setExpansionNodes] = useState<GraphNode[]>([]);
	const [expansionLinks, setExpansionLinks] = useState<GraphLink[]>([]);
	const [firmCacheNodes, setFirmCacheNodes] = useState<GraphNode[]>([]);
	const [firmCacheLinks, setFirmCacheLinks] = useState<GraphLink[]>([]);
	const [expandingNodeId, setExpandingNodeId] = useState<string | null>(null);
	const expandedKeysRef = useRef<Set<string>>(new Set());
	// Explicit hub key — graph topology is built from this snapshot only.
	// Clicking relation nodes must NOT replace the hub (only the side panel).
	const [hubKey, setHubKey] = useState<string | null>(null);
	// Side-panel payload for the currently selected node (may differ from hub).
	const [panelSnapshot, setPanelSnapshot] = useState<{
		key: string;
		resolvedKey: string;
		detailJson: string | null;
		loading: boolean;
		error: string;
	} | null>(null);
	const panelRequestRef = useRef(0);

	const activeSnapshot = useMemo(() => {
		if (hubKey) {
			const aliases = snapshotKeyAliases(hubKey);
			for (const alias of aliases) {
				if (cache[alias]) return cache[alias];
			}
			const match = Object.values(cache).find((s) => aliases.includes(s.key) || aliases.includes(s.resolvedKey));
			if (match) return match;
		}
		return Object.values(cache).sort((a, b) => b.fetchedAt - a.fetchedAt)[0] ?? null;
	}, [cache, hubKey]);

	const parsedPayload = useMemo(() => readSnapshotPayload(activeSnapshot?.detailJson ?? null), [activeSnapshot]);

	const parsedKeyInfo = useMemo(() => parseCrdKey(activeSnapshot?.resolvedKey || activeSnapshot?.key || ''), [activeSnapshot]);
	const entityType: 'individual' | 'firm' = (parsedKeyInfo?.type as 'individual' | 'firm') || 'individual';

	const finraContent = useMemo(() => getContentBlock(parsedPayload, 'finra', entityType), [parsedPayload, entityType]);
	const secContent = useMemo(() => getContentBlock(parsedPayload, 'sec', entityType), [parsedPayload, entityType]);
	const primaryContent = (finraContent?.basicInformation ? finraContent : secContent) as Record<string, any> | null;

	const nameInfo = useMemo(() => extractNamesFromPayload(primaryContent ?? parsedPayload, entityType), [primaryContent, parsedPayload, entityType]);

	const entityTitle = useMemo(() => {
		const crd = parsedKeyInfo?.crd || '';
		const resolved = resolveEntityDisplayName({
			payload: parsedPayload,
			type: entityType,
			crd,
			candidates: [nameInfo.primary],
		});
		const title = resolved || crd || activeSnapshot?.resolvedKey || activeSnapshot?.key || '';
		if (entityType === 'individual' && title && title !== crd) return toProperCaseName(title);
		return title;
	}, [nameInfo, entityType, activeSnapshot, parsedPayload, parsedKeyInfo]);

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
			const fromKey = graphNodeToCrdRef(node);
			return fromKey ? `${fromKey.type}:${fromKey.crd}` : null;
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
						const byId = new Map(prev.map((n) => [n.id, n]));
						for (const raw of rawNodes) {
							const city = stringValue(raw.city);
							const state = stringValue(raw.state);
							const inactive = Boolean(raw.inactive);
							const existing = byId.get(raw.id);
							if (existing) {
								// Refresh inactive flag from expand even if the node
								// was already present (e.g. hub relation stub).
								if (existing.inactive !== inactive) {
									byId.set(raw.id, { ...existing, inactive });
								}
								continue;
							}
							// Seed node itself is already in the graph as primary/hub.
							if (raw.id === canonicalId) {
								// Still record inactive under canonical id so merge can
								// stamp hub stubs that share this CRD.
								byId.set(raw.id, {
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
									inactive,
								});
								continue;
							}
							byId.set(raw.id, {
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
								inactive,
							});
						}
						return Array.from(byId.values());
					});

					setExpansionLinks((prev) => {
						const linkKey = (l: { source: string; target: string; label: string }) => `${l.source}->${l.target}:${l.label}`;
						const seen = new Set(prev.map(linkKey));
						const merged = prev.slice();
						for (const raw of rawLinks) {
							const label = expandedLinkLabel(raw.relationship, raw.isCurrent);
							const candidate: GraphLink = {
								source: raw.source,
								target: raw.target,
								label,
								isCurrent: Boolean(raw.isCurrent),
							};
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
	// if found, stores it in the shared graph cache. Treats orphan CRD bundles
	// (scraped from a parent firm with no live FINRA/SEC profile) as found so
	// deep-links like /graph/individual/<orphanCrd> don't show a false "not found"
	// error under search.
	const fetchAndApplyKey = useCallback(
		(key: string, requestKey: string, options?: { force?: boolean; asHub?: boolean }) => {
			return fetch(`/api/key?name=${encodeURIComponent(key)}${options?.force ? `&t=${Date.now()}` : ''}`)
				.then(async (r) => {
					const data = await r.json();
					if (!r.ok) throw new Error(String(data?.error || `HTTP ${r.status}`));
					return data;
				})
				.then((data) => {
					const bundle = data?.bundle && typeof data.bundle === 'object' ? data.bundle : null;
					const liveFound = Boolean(bundle?.sources?.finra?.found || bundle?.sources?.sec?.found);
					const orphan =
						bundle?.orphan && typeof bundle.orphan === 'object' ? bundle.orphan
						: data?.orphan && typeof data.orphan === 'object' ? data.orphan
						: null;
					const hasOrphanCard = Boolean(orphan);
					const found = liveFound || hasOrphanCard;
					if (!found) return { found: false as const, data, resolvedKey: key, detailValue: null as string | null };
					const resolvedKey = typeof data?.resolvedKey === 'string' ? data.resolvedKey : key;
					// Prefer API rawPayload (dashboard/StatusBox parity); fall back to orphan bundle JSON.
					const detailValue =
						typeof data?.rawPayload === 'string' ? data.rawPayload
						: bundle ? JSON.stringify(bundle, null, 2)
						: JSON.stringify(data?.payload ?? data ?? null, null, 2);
					const snapshot = { key: requestKey, resolvedKey, detailJson: detailValue, fetchedAt: Date.now(), source: 'shared' as const };
					setSnapshot(requestKey, snapshot);
					if (resolvedKey !== requestKey) setSnapshot(resolvedKey, snapshot);
					if (options?.asHub !== false) {
						setHubKey(resolvedKey || requestKey);
						setPanelSnapshot({
							key: requestKey,
							resolvedKey,
							detailJson: detailValue,
							loading: false,
							error: '',
						});
					}
					return { found: true as const, data, resolvedKey, detailValue };
				});
		},
		[setSnapshot],
	);

	// Loads an explicit, unambiguous key (source:type:crd, or type:crd) as the
	// graph hub — used by search, deep links, refresh, and search-result clicks.
	const loadKey = useCallback(
		(key: string, options?: { force?: boolean }) => {
			if (!key) return;
			setSearchLoading(true);
			setSearchError('');
			fetchAndApplyKey(key, key, { ...options, asHub: true })
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

	useEffect(() => {
		let cancelled = false;
		fetch('/api/finra/graph')
			.then((res) => (res.ok ? res.json() : null))
			.then((data) => {
				if (cancelled) return;
				const session = data?.session;
				if (!session || !Array.isArray(session.nodes) || session.nodes.length === 0) {
					skipSessionSaveRef.current = false;
					setSessionHydrated(true);
					return;
				}
				restoredSessionRef.current = true;
				skipSessionSaveRef.current = true;
				const extraNodes: GraphNode[] = (session.nodes as GraphNode[]).filter((node) => node && node.id);
				const extraLinks: GraphLink[] = Array.isArray(session.links) ? session.links : [];
				const positions: Record<string, { x: number; y: number }> = {};
				for (const row of Array.isArray(session.nodePositions) ? session.nodePositions : []) {
					if (row?.id && Number.isFinite(row.x) && Number.isFinite(row.y)) positions[row.id] = { x: row.x, y: row.y };
				}
				positionsRef.current = positions;
				setGraphPositions(positions);
				sessionLayoutLockedRef.current = extraNodes.length > 0;
				setExpansionNodes(extraNodes);
				setExpansionLinks(extraLinks);
				if (session.zoomTransform && typeof session.zoomTransform.k === 'number') {
					const z = session.zoomTransform;
					setTransform(d3.zoomIdentity.translate(z.x || 0, z.y || 0).scale(z.k));
				}
				const hubKey = String(session.hubKey || extraNodes[0]?.loadKey || extraNodes[0]?.id || '').trim();
				if (hubKey) {
					const parsed = parseCrdKey(hubKey) || (hubKey.match(/^(individual|firm):\d+$/i) ? { type: hubKey.split(':')[0], crd: hubKey.split(':')[1] } : null);
					if (parsed?.type && parsed?.crd) lastRouteKeyRef.current = `${parsed.type}:${parsed.crd}`;
					loadKey(hubKey);
				}
				if (session.selectedNodeId) setFocusedNodeId(session.selectedNodeId);
				window.setTimeout(() => {
					if (!cancelled) skipSessionSaveRef.current = false;
				}, 800);
				setSessionHydrated(true);
			})
			.catch(() => {
				if (!cancelled) setSessionHydrated(true);
			});
		return () => {
			cancelled = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// Loads detail JSON into the side panel for a clicked graph node without
	// replacing the hub / rebuilding the whole graph.
	const loadPanelForNode = useCallback(
		(node: GraphNode) => {
			const requestId = ++panelRequestRef.current;

			if (node.id === 'primary') {
				const key = activeSnapshot?.resolvedKey || activeSnapshot?.key || '';
				setPanelSnapshot({
					key,
					resolvedKey: key,
					detailJson: activeSnapshot?.detailJson ?? null,
					loading: false,
					error: '',
				});
				return;
			}

			const crdRef = graphNodeToCrdRef(node);
			const requestKey = crdRef ? finraKeyFromCrdRef(crdRef) : node.loadKey || '';
			const aliases = requestKey ? snapshotKeyAliases(requestKey) : [];

			if (!requestKey) {
				setPanelSnapshot({
					key: node.id,
					resolvedKey: node.id,
					detailJson: null,
					loading: false,
					error: `No CRD key available for ${node.label}`,
				});
				return;
			}

			const cached =
				aliases.map((alias) => cache[alias]).find((entry) => entry?.detailJson) ||
				Object.values(cache).find((entry) => aliases.includes(entry.key) || aliases.includes(entry.resolvedKey)) ||
				null;
			const cachedLooksRight = Boolean(cached?.detailJson && (!crdRef || cached.detailJson.includes(crdRef.crd)));
			if (cachedLooksRight && cached?.detailJson) {
				setPanelSnapshot({
					key: cached.key,
					resolvedKey: cached.resolvedKey || cached.key,
					detailJson: cached.detailJson,
					loading: false,
					error: '',
				});
				return;
			}

			setPanelSnapshot({
				key: requestKey,
				resolvedKey: requestKey,
				detailJson: null,
				loading: true,
				error: '',
			});

			const keysToTry = crdRef ? [requestKey, `finra:${crdRef.type === 'firm' ? 'individual' : 'firm'}:${crdRef.crd}`] : [requestKey];

			(async () => {
				let lastError = '';
				for (const key of keysToTry) {
					try {
						const result = await fetchAndApplyKey(key, key, { asHub: false });
						if (panelRequestRef.current !== requestId) return;
						if (result.found && result.detailValue) {
							setPanelSnapshot({
								key,
								resolvedKey: result.resolvedKey || key,
								detailJson: result.detailValue,
								loading: false,
								error: '',
							});
							return;
						}
						lastError = `No FINRA/SEC record found for ${key}`;
					} catch (err: unknown) {
						lastError = err instanceof Error ? err.message : `Could not load data for ${key}`;
					}
				}
				if (panelRequestRef.current !== requestId) return;
				setPanelSnapshot({
					key: requestKey,
					resolvedKey: requestKey,
					detailJson: null,
					loading: false,
					error: lastError || `No FINRA/SEC record found for ${requestKey}`,
				});
			})();
		},
		[activeSnapshot, cache, fetchAndApplyKey],
	);

	// Deep-link support: when this page is reached via /graph/individual/<crd>
	// (or /graph/firm/<crd>), load that entity as the hub on mount and
	// whenever the URL's params actually change to a different entity —
	// `lastRouteKeyRef` guards against re-loading the entity we ourselves
	// just pushed into the URL below.
	const lastRouteKeyRef = useRef<string | null>(null);
	useEffect(() => {
		if (!sessionHydrated) return;
		if (restoredSessionRef.current) return;
		if (!routeParams) return;
		const key = `${routeParams.type}:${routeParams.crd}`;
		if (lastRouteKeyRef.current === key) return;
		lastRouteKeyRef.current = key;
		loadKey(key);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [sessionHydrated, routeParams]);

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
		fetch(`/api/local-name-search?q=${encodeURIComponent(query)}`)
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
				// If we have any matches, load the highest-ranking one directly as the hub
				// entity. Dropping dozens of unconnected nodes into the physics sim
				// is confusing and makes it look like the search didn't work.
				if (matches.length > 0) {
					const best = matches[0];
					const type =
						best.type === 'firm' ? 'firm'
						: best.type === 'individual' ? 'individual'
						: '';
					const key = best.key || (type && best.crd ? `${type}:${best.crd}` : String(best.crd));
					loadKey(key);
					return;
				}
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
		skipSessionSaveRef.current = true;
		restoredSessionRef.current = false;
		void fetch('/api/finra/graph', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'reset' }),
		}).catch(() => {});
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
		setFirmCacheNodes([]);
		setFirmCacheLinks([]);
		setExpandingNodeId(null);
		setLabelModeById({});
		setHubKey(null);
		setPanelSnapshot(null);
		setGraphPositions({});
		positionsRef.current = {};
		sessionLayoutLockedRef.current = false;
		panelRequestRef.current += 1;
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
	// Reset the focused/highlighted node whenever the hub entity itself changes.
	// Do not key this off cache writes from clicking other nodes — that was
	// wiping the clicked CRD's panel JSON and snapping selection back to primary.
	useEffect(() => {
		setFocusedNodeId('primary');
		if (!hubKey || !activeSnapshot) return;
		const hubAliases = snapshotKeyAliases(hubKey);
		const isHubSnapshot = hubAliases.includes(activeSnapshot.key) || hubAliases.includes(activeSnapshot.resolvedKey);
		if (!isHubSnapshot) return;
		setPanelSnapshot({
			key: activeSnapshot.key,
			resolvedKey: activeSnapshot.resolvedKey || activeSnapshot.key,
			detailJson: activeSnapshot.detailJson,
			loading: false,
			error: '',
		});
	}, [hubKey]);

	// Auto-expand the primary node the moment its entity loads, so its full
	// current + previous connections are visible immediately instead of only
	// the "current" subset buildGraphData derives from the loaded snapshot.
	useEffect(() => {
		if (!activeSnapshot || !parsedKeyInfo?.crd) return;
		if (restoredSessionRef.current) return;
		expandNode({ id: 'primary', label: entityTitle, kind: 'primary', entityType: entityType === 'firm' ? 'firm' : 'individual' });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [activeSnapshot?.resolvedKey, parsedKeyInfo?.crd]);

	// Firm payloads only carry owners. Current/previous people live in Redis
	// (`graph:firm-connections:v9` / `graph:firm-emp-adj:v1`) — pull them
	// directly so the hub graph is not limited to Direct owners.
	useEffect(() => {
		if (restoredSessionRef.current) return;
		if (entityType !== 'firm' || !parsedKeyInfo?.crd) {
			setFirmCacheNodes([]);
			setFirmCacheLinks([]);
			return;
		}
		const crd = parsedKeyInfo.crd;
		const firmCanonical = `firm:${crd}`;
		let cancelled = false;
		fetch(`/api/finra/firm/${encodeURIComponent(crd)}/connections`)
			.then((res) => (res.ok ? res.json() : null))
			.then((data) => {
				if (cancelled || !data) return;
				const nodes: GraphNode[] = [];
				const links: GraphLink[] = [];
				const seen = new Set<string>();
				const add = (entry: any, isCurrent: boolean) => {
					const personCrd = String(entry?.individualId || entry?.personCrd || entry?.crd || '').trim();
					if (!personCrd || !/^\d{1,10}$/.test(personCrd) || seen.has(`${personCrd}:${isCurrent}`)) return;
					seen.add(`${personCrd}:${isCurrent}`);
					const nodeId = `individual:${personCrd}`;
					const name = toProperCaseName(String(entry?.name || entry?.personName || entry?.individualName || '').trim()) || personCrd;
					if (!nodes.some((n) => n.id === nodeId)) {
						nodes.push({
							id: nodeId,
							label: name,
							kind: 'relation',
							entityType: 'individual',
							subLabel: isCurrent ? 'Current connection' : 'Previous connection',
							loadKey: `finra:individual:${personCrd}`,
						});
					}
					links.push({
						source: nodeId,
						target: firmCanonical,
						label: isCurrent ? 'Employment' : 'Previous employment',
						isCurrent,
					});
				};
				for (const entry of Array.isArray(data.currentConnections) ? data.currentConnections : []) add(entry, true);
				for (const entry of Array.isArray(data.previousConnections) ? data.previousConnections : []) add(entry, false);
				setFirmCacheNodes(nodes);
				setFirmCacheLinks(links);
			})
			.catch(() => {
				if (!cancelled) {
					setFirmCacheNodes([]);
					setFirmCacheLinks([]);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [entityType, parsedKeyInfo?.crd]);

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
			} else if (/^(individual|firm):\d+$/.test(node.id)) {
				canonical = node.id;
			}
			if (canonical && !canonicalToId.has(canonical)) canonicalToId.set(canonical, node.id);
		};
		hub.nodes.forEach(registerCanonical);

		const hubIds = new Set(hub.nodes.map((n) => n.id));
		const extraSearchNodes = searchResultNodes.filter((n) => !hubIds.has(n.id));
		extraSearchNodes.forEach(registerCanonical);

		// Expand API inactive flags keyed by canonical id (and CRD fallback).
		const inactiveByCanonical = new Map<string, boolean>();
		for (const expansionNode of expansionNodes) {
			if (!expansionNode.inactive) continue;
			inactiveByCanonical.set(expansionNode.id, true);
			if (expansionNode.loadKey) {
				const parts = expansionNode.loadKey.split(':');
				if (parts.length === 3) inactiveByCanonical.set(`${parts[1]}:${parts[2]}`, true);
			}
		}

		const stampInactive = (node: GraphNode): GraphNode => {
			if (node.inactive) return node;
			let canonical: string | null = null;
			if (node.id === 'primary') {
				canonical = parsedKeyInfo?.crd ? `${entityType}:${parsedKeyInfo.crd}` : null;
			} else if (node.loadKey) {
				const parts = node.loadKey.split(':');
				canonical = parts.length === 3 ? `${parts[1]}:${parts[2]}` : null;
			} else if (/^(individual|firm):\d+$/.test(node.id)) {
				canonical = node.id;
			}
			if (canonical && inactiveByCanonical.get(canonical)) return { ...node, inactive: true };
			// Hub relation ids: relation-firm-123 / relation-individual-123
			const relMatch = node.id.match(/^relation-(individual|firm)-(\d+)$/);
			if (relMatch && inactiveByCanonical.get(`${relMatch[1]}:${relMatch[2]}`)) return { ...node, inactive: true };
			return node;
		};

		const nodes = [...hub.nodes, ...extraSearchNodes].map(stampInactive);
		const seenIds = new Set(nodes.map((n) => n.id));
		if (seenIds.has('primary')) canonicalToId.set('primary', 'primary');
		for (const extraNode of [...expansionNodes, ...firmCacheNodes]) {
			if (canonicalToId.has(extraNode.id) || seenIds.has(extraNode.id)) continue;
			// Skip the live hub's canonical id only when `primary` is already present.
			if (seenIds.has('primary') && extraNode.id === (parsedKeyInfo?.crd ? `${entityType}:${parsedKeyInfo.crd}` : '')) continue;
			if (extraNode.id === 'primary') canonicalToId.set('primary', 'primary');
			canonicalToId.set(extraNode.id, extraNode.id);
			seenIds.add(extraNode.id);
			nodes.push(stampInactive(extraNode));
			registerCanonical(extraNode);
		}

		const resolveLinkEnd = (rawId: string) => {
			if (canonicalToId.has(rawId)) return canonicalToId.get(rawId) as string;
			const ref = parseGraphCrdRef(rawId);
			if (ref) {
				const canonical = `${ref.type}:${ref.crd}`;
				if (canonicalToId.has(canonical)) return canonicalToId.get(canonical) as string;
			}
			if (rawId === 'primary' && seenIds.has('primary')) return 'primary';
			return rawId;
		};

		const links: GraphLink[] = hub.links.map((l) => ({ ...l, isCurrent: l.isCurrent !== false }));
		const seenLinkKeys = new Set(links.map((l) => `${l.source}->${l.target}:${l.label}`));
		for (const extraLink of [...expansionLinks, ...firmCacheLinks]) {
			const source = resolveLinkEnd(extraLink.source);
			const target = resolveLinkEnd(extraLink.target);
			if (source === target) continue;
			if (!seenIds.has(source) || !seenIds.has(target)) continue;
			const key = `${source}->${target}:${extraLink.label}`;
			const reverseKey = `${target}->${source}:${extraLink.label}`;
			if (seenLinkKeys.has(key) || seenLinkKeys.has(reverseKey)) continue;
			seenLinkKeys.add(key);
			links.push({
				source,
				target,
				label: extraLink.label,
				isCurrent: extraLink.isCurrent !== false,
			});
		}

		return { nodes: nodes.map(stampInactive), links: links.filter((l) => seenIds.has(l.source) && seenIds.has(l.target)) };
	}, [
		activeSnapshot,
		finraContent,
		secContent,
		entityTitle,
		searchResultNodes,
		expansionNodes,
		expansionLinks,
		firmCacheNodes,
		firmCacheLinks,
		entityType,
		parsedKeyInfo,
		hubLocation,
	]);

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
			const node = graphData.nodes.find((n) => n.id === nodeId);
			const entityTypeForNode =
				node ? resolveNodeEntityType(node, entityType === 'firm' ? 'firm' : 'individual')
				: kind === 'primary' ?
					entityType === 'firm' ?
						'firm'
					:	'individual'
				:	entityTypeFromLoadKey(nodeId) || (nodeId.startsWith('firm:') || nodeId.includes(':firm:') ? 'firm' : 'individual');
			return entityTypeForNode === 'firm' ? GRAPH_FIRM_NODE_RADIUS : GRAPH_INDIVIDUAL_NODE_RADIUS;
		},
		[connectionCountById, graphData.nodes, entityType],
	);

	const focusedNode = useMemo(() => graphData.nodes.find((node) => node.id === focusedNodeId) ?? graphData.nodes[0], [graphData.nodes, focusedNodeId]);

	// CRDs / node ids known inactive from hub payload + any cached relation payloads.
	const inactiveNodeIds = useMemo(() => {
		const ids = new Set<string>();
		const hubInactive = isDetailPayloadInactive(activeSnapshot?.detailJson ?? null, entityType === 'firm' ? 'firm' : 'individual');
		if (hubInactive) {
			ids.add('primary');
			if (parsedKeyInfo?.crd) {
				ids.add(`${entityType}:${parsedKeyInfo.crd}`);
				ids.add(`relation-${entityType}-${parsedKeyInfo.crd}`);
			}
		}
		for (const node of graphData.nodes) {
			if (node.inactive) {
				ids.add(node.id);
				continue;
			}
			const keys: string[] = [];
			if (node.loadKey) keys.push(node.loadKey);
			const canonical = canonicalIdForNode(node);
			if (canonical) {
				const [type, crd] = canonical.split(':');
				keys.push(canonical, `finra:${type}:${crd}`, `sec:${type}:${crd}`, `${type}:${crd}`);
			}
			for (const key of keys) {
				const snap = cache[key] || Object.values(cache).find((s) => s.key === key || s.resolvedKey === key);
				if (!snap?.detailJson) continue;
				const type = (parseCrdKey(snap.resolvedKey || snap.key)?.type as GraphEntityType | undefined) || resolveNodeEntityType(node, entityType === 'firm' ? 'firm' : 'individual');
				if (isDetailPayloadInactive(snap.detailJson, type)) {
					ids.add(node.id);
					if (canonical) ids.add(canonical);
					break;
				}
			}
		}
		return ids;
	}, [activeSnapshot?.detailJson, entityType, parsedKeyInfo, graphData.nodes, cache, canonicalIdForNode]);

	// Keep the address bar on the *hub* entity only. Selecting a relation node
	// updates the side panel/highlight but must not rewrite the URL — a shallow
	// replace to another CRD can still jostle the page/zoom and feels like the
	// viewport jumped. Hub loads (search, deep link, search-result promote)
	// still sync /graph/{type}/{crd}.
	useEffect(() => {
		if (!router.isReady || !parsedKeyInfo?.crd) return;
		const type = entityType === 'firm' ? 'firm' : 'individual';
		const canonical = `${type}:${parsedKeyInfo.crd}`;
		if (lastRouteKeyRef.current === canonical) return;
		lastRouteKeyRef.current = canonical;
		const as = `/graph/${type}/${parsedKeyInfo.crd}`;
		router.replace({ pathname: '/graph/[[...params]]', query: { params: [type, parsedKeyInfo.crd] } }, as, { shallow: true });
	}, [router.isReady, parsedKeyInfo?.crd, entityType, router]);

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
	const [transform, setTransform] = useState<d3.ZoomTransform>(DEFAULT_TRANSFORM);
	const [graphPositions, setGraphPositions] = useState<Record<string, { x: number; y: number }>>({});

	// Latest node positions, kept in sync so the force-simulation effect
	// below (which re-runs whenever graphData changes, e.g. after an
	// in-place expansion) can seed already-placed nodes at their current
	// spot instead of snapping the whole graph back to random positions
	// near the center — that full-graph reset was what made expanded
	// graphs look like nodes "disconnecting" from their links.
	const positionsRef = useRef<Record<string, { x: number; y: number }>>({});
	// After the user clicks/drags/expands, freeze already-placed nodes until Reset.
	const sessionLayoutLockedRef = useRef(false);
	useEffect(() => {
		positionsRef.current = graphPositions;
	}, [graphPositions]);

	const lockSessionLayout = useCallback(() => {
		sessionLayoutLockedRef.current = true;
		const next = { ...positionsRef.current };
		for (const n of dragNodesRef.current) {
			if (!n?.id) continue;
			const x = typeof n.fx === 'number' ? n.fx : n.x;
			const y = typeof n.fy === 'number' ? n.fy : n.y;
			if (typeof x === 'number' && typeof y === 'number') next[n.id] = { x, y };
		}
		positionsRef.current = next;
		setGraphPositions(next);
	}, []);

	useEffect(() => {
		if (!sessionHydrated || skipSessionSaveRef.current) return;
		if (graphData.nodes.length === 0) return;
		const timer = window.setTimeout(() => {
			const nodePositions = Object.entries(positionsRef.current)
				.filter(([, point]) => Number.isFinite(point.x) && Number.isFinite(point.y))
				.map(([id, point]) => ({ id, x: point.x, y: point.y }));
			void fetch('/api/finra/graph', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					action: 'save',
					session: {
						hubKey: hubKey || activeSnapshot?.resolvedKey || activeSnapshot?.key || null,
						selectedNodeId: focusedNodeId,
						nodes: graphData.nodes,
						links: graphData.links,
						nodePositions,
						zoomTransform: { x: transform.x, y: transform.y, k: transform.k },
					},
				}),
			}).catch(() => {});
		}, 700);
		return () => window.clearTimeout(timer);
	}, [sessionHydrated, graphData, graphPositions, transform, hubKey, focusedNodeId, activeSnapshot]);

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
			// Stop both React and native bubbling so d3-zoom does not pan/scale
			// when the user presses a node to select or drag it.
			event.stopPropagation();
			event.nativeEvent.stopImmediatePropagation?.();
			lockSessionLayout();
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
			setDraggingNodeId(nodeId);
			simulationRef.current?.alphaTarget(0.3).restart();
			(event.target as Element).setPointerCapture?.(event.pointerId);
		},
		[clientPointToGraph, lockSessionLayout],
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
		// Remember the dropped position for the rest of the session.
		if (node && typeof node.x === 'number' && typeof node.y === 'number') {
			node.fx = node.x;
			node.fy = node.y;
			positionsRef.current[drag.id] = { x: node.x, y: node.y };
			setGraphPositions((prev) => ({ ...prev, [drag.id]: { x: node.x, y: node.y } }));
		}
		dragStateRef.current = null;
		setDraggingNodeId(null);
		simulationRef.current?.alphaTarget(0);
	}, []);

	// Graph dimensions
	const width = 10000;
	const height = 8000;

	// D3 Zoom Setup — pan/zoom only via wheel + background drag.
	// Node clicks must not start a zoom gesture or change transform.
	useEffect(() => {
		if (!svgRef.current) return;
		const zoom = d3
			.zoom<SVGSVGElement, unknown>()
			.scaleExtent([0.1, 40])
			.filter((event) => {
				// Never zoom/pan from interactions on nodes or labels.
				const target = event.target as Element | null;
				if (target?.closest?.('.graph-node-group')) return false;
				// Keep wheel zoom; allow primary-button pan on empty canvas only.
				if (event.type === 'wheel') return true;
				if (event.type === 'mousedown' || event.type === 'pointerdown') {
					return event.button === 0;
				}
				return !event.ctrlKey && !event.button;
			})
			.on('zoom', (event) => {
				// Ignore zoom events that are not user gestures (programmatic
				// re-apply can still update when we intentionally center).
				setTransform(event.transform);
			});
		zoomBehaviorRef.current = zoom;
		const selection = d3.select(svgRef.current);
		selection.call(zoom);
		// Initialize the zoom behavior with our default transform so the first pan/zoom doesn't snap to 1.0
		selection.call(zoom.transform, DEFAULT_TRANSFORM);
		// Double-click zoom steals node double-clicks and changes scale on select-ish gestures.
		selection.on('dblclick.zoom', null);
		return () => {
			selection.on('.zoom', null);
			if (zoomBehaviorRef.current === zoom) zoomBehaviorRef.current = null;
		};
	}, []);

	const handleCenter = useCallback(() => {
		if (svgRef.current && zoomBehaviorRef.current) {
			d3.select(svgRef.current).transition().duration(4000).ease(d3.easeLinear).call(zoomBehaviorRef.current.transform, DEFAULT_TRANSFORM);
		} else {
			setTransform(DEFAULT_TRANSFORM);
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
		const frozenPos = sessionLayoutLockedRef.current ? { ...positionsRef.current } : {};
		const frozenIds = new Set(Object.keys(frozenPos));

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
			const ringCount =
				unique.length > 400 ? 8
				: unique.length > 200 ? 7
				: unique.length > 80 ? 6
				: unique.length > 30 ? 5
				: 4;
			unique.forEach((child, i) => {
				const ring = i % ringCount;
				const angle = (i / Math.max(unique.length, 1)) * Math.PI * 2 + ring * 0.17;
				seedRingOf.set(child, { hub, ring, angle });
			});
		}

		const d3Nodes = graphData.nodes.map((n) => {
			const prev = prevById.get(n.id);
			const existing = frozenPos[n.id] || positionsRef.current[n.id];
			const lockPlaced = frozenIds.has(n.id);
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
						...(lockPlaced ? { fx: existing.x, fy: existing.y, vx: 0, vy: 0 } : {}),
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
							const hubNode = graphData.nodes.find((nn) => nn.id === seed.hub);
							const hubIsFirm =
								hubNode ?
									resolveNodeEntityType(hubNode, entityType === 'firm' ? 'firm' : 'individual') === 'firm'
								:	entityTypeFromLoadKey(seed.hub) === 'firm' || seed.hub.startsWith('firm:') || seed.hub.includes(':firm:') || (seed.hub === 'primary' && entityType === 'firm');
							const { radius: orbitR } = graphOrbitRadiusForHub({
								hubIsFirm,
								childCount: Math.max(hubDeg, 1),
								ringIndex: seed.ring,
							});
							const dist = orbitR;
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
						const anchor = hubPos || (loc ? { x: loc.x, y: loc.y } : null) || { x: width / 2, y: height / 2 };
						return {
							...n,
							x: anchor.x + (Math.random() - 0.5) * 220,
							y: anchor.y + (Math.random() - 0.5) * 220,
							radius,
							locKey,
							locX: loc?.x,
							locY: loc?.y,
							locStrength: loc?.strength ?? 0,
							entityType,
						};
					})();
			// Already-placed nodes stay pinned for the session. Only brand-new
			// (unplaced) nodes inherit leftover velocity from a live sim rebuild.
			if (!lockPlaced) {
				if (prev && typeof prev.vx === 'number') (base as any).vx = prev.vx * 0.7;
				if (prev && typeof prev.vy === 'number') (base as any).vy = prev.vy * 0.7;
			}
			return base;
		});
		const simNodeIds = new Set(d3Nodes.map((n) => n.id));
		const d3Links = graphData.links.filter((l) => simNodeIds.has(l.source) && simNodeIds.has(l.target)).map((l) => ({ source: l.source, target: l.target, label: l.label }));

		const nodeById = new Map(d3Nodes.map((n) => [n.id, n]));

		// Spread-out layout for open firm hubs: keep firm centers far apart,
		// fan employees onto wide staggered rings, and push hub clouds apart
		// so firm↔firm edges remain visible through the blue leaf mass.
		const centerStrength =
			dense ? 0.0008
			: mid ? 0.0014
			: 0.0035;
		const baseCharge =
			(dense ? -2200
			: mid ? -1750
			: -1200) * 5;
		const linkStrengthBase =
			dense ? 0.16
			: mid ? 0.22
			: 0.32;
		const linkDistBase =
			(nCount > 1000 ? 560
			: nCount > 300 ? 480
			: nCount > 150 ? 420
			: nCount > 80 ? 460
			: 560) * 5;
		const collidePad =
			nCount > 1000 ? 36
			: nCount > 600 ? 44
			: nCount > 300 ? 52
			: nCount > 120 ? 64
			: nCount > 60 ? 78
			: 92;
		const labelPad =
			nCount > 1000 ? 34
			: nCount > 600 ? 32
			: nCount > 300 ? 30
			: 26;
		// Very slow restart so expand / selection motion is easy to follow.
		const restartAlpha =
			nCount <= 0 ? 0.12
			: nCount > 1000 ? 0.08
			: nCount > 300 ? 0.1
			: 0.12;

		const degreeOf = (d: any) => connectionCountById[d?.id] || 0;
		const isFirmNode = (d: any) => resolveNodeEntityType(d as GraphNode) === 'firm' || d?.entityType === 'firm';

		// Once the user has interacted, keep already-placed nodes fixed.
		// New expanded nodes stay free so they can settle around that layout.
		const pinRememberedNodes = () => {
			if (!frozenIds.size) return;
			const draggingId = dragStateRef.current?.id;
			for (const raw of d3Nodes) {
				const n = raw as any;
				if (!n?.id || !frozenIds.has(n.id) || n.id === draggingId) continue;
				const remembered = positionsRef.current[n.id] || frozenPos[n.id];
				if (!remembered) continue;
				n.fx = remembered.x;
				n.fy = remembered.y;
				n.x = remembered.x;
				n.y = remembered.y;
				n.vx = 0;
				n.vy = 0;
			}
		};
		pinRememberedNodes();

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
		const childSlotIndex = new Map<string, number>(); // `${hub}|${child}` -> angular slot
		const hubOrbitMeta = new Map<string, { ringCount: number; kidCount: number; hubIsFirm: boolean }>();
		for (const [hub, kids] of childrenByHub) {
			const unique = Array.from(new Set(kids)).sort((a, b) => a.localeCompare(b));
			const hubNode = nodeById.get(hub);
			const hubIsFirm = isFirmNode(hubNode);
			const { ringCount } = graphOrbitRadiusForHub({
				hubIsFirm,
				childCount: unique.length,
				preferSingleRing: unique.length <= 28,
			});
			hubOrbitMeta.set(hub, { ringCount, kidCount: unique.length, hubIsFirm });
			unique.forEach((child, i) => {
				childRingIndex.set(`${hub}|${child}`, i % ringCount);
				childSlotIndex.set(`${hub}|${child}`, i);
			});
		}
		const staggeredChildDistance = (hubId: string, childId: string, hubDeg: number) => {
			const ring = childRingIndex.get(`${hubId}|${childId}`) ?? 0;
			const meta = hubOrbitMeta.get(hubId);
			const hubIsFirm = meta?.hubIsFirm ?? isFirmNode(nodeById.get(hubId));
			const kidCount = Math.max(meta?.kidCount || 1, hubDeg || 1);
			const { radius } = graphOrbitRadiusForHub({
				hubIsFirm,
				childCount: kidCount,
				ringIndex: ring,
				ringCount: meta?.ringCount,
				preferSingleRing: kidCount <= 28,
			});
			const jitter = ((hashString(`${hubId}:${childId}`) % 1000) / 999 - 0.5) * 28;
			return radius + jitter;
		};

		const collisionRadius = (d: any) => {
			const deg = degreeOf(d);
			const firm = isFirmNode(d);
			const body = Number(d.radius) || (firm ? GRAPH_FIRM_NODE_RADIUS : GRAPH_INDIVIDUAL_NODE_RADIUS);
			// Expanded hubs (firm or person) keep a private keep-out for their orbit.
			const hubHalo =
				firm ? Math.min(nCount > 1000 ? 320 : 280, body + 50 + Math.sqrt(Math.max(deg, 1)) * (dense ? 18 : 16))
				: deg >= 4 ? Math.min(220, body + 36 + Math.sqrt(Math.max(deg, 1)) * 12)
				: body * 0.25;
			const scatterPad = Math.min(nCount > 1000 ? 96 : 80, nodeScatterBoost(deg, nCount) * 0.55);
			const labelLenPad = Math.min(34, Math.max(0, String(d?.label || '').length - 8) * 0.65);
			const leafBoost =
				deg <= 2 ? body * 0.45
				: deg <= 4 ? body * 0.28
				: 0;
			return body + collidePad + labelPad + scatterPad + labelLenPad + leafBoost + hubHalo;
		};

		// Push expanded hubs (firms and people) apart so each keeps its private orbit.
		const expandedHubIds = d3Nodes.filter((n: any) => degreeOf(n) >= 4).map((n: any) => n.id);
		const firmHubSeparation = (alpha: number) => {
			if (expandedHubIds.length < 2) return;
			for (let i = 0; i < expandedHubIds.length; i++) {
				const a = nodeById.get(expandedHubIds[i]) as any;
				if (!a) continue;
				const aMeta = hubOrbitMeta.get(a.id);
				const aOrbit =
					aMeta ?
						graphOrbitRadiusForHub({
							hubIsFirm: aMeta.hubIsFirm,
							childCount: aMeta.kidCount,
							ringIndex: Math.max(0, aMeta.ringCount - 1),
							ringCount: aMeta.ringCount,
						}).radius
					:	graphOrbitRadiusForHub({ hubIsFirm: isFirmNode(a), childCount: Math.max(degreeOf(a), 4) }).radius;
				for (let j = i + 1; j < expandedHubIds.length; j++) {
					const b = nodeById.get(expandedHubIds[j]) as any;
					if (!b) continue;
					const bMeta = hubOrbitMeta.get(b.id);
					const bOrbit =
						bMeta ?
							graphOrbitRadiusForHub({
								hubIsFirm: bMeta.hubIsFirm,
								childCount: bMeta.kidCount,
								ringIndex: Math.max(0, bMeta.ringCount - 1),
								ringCount: bMeta.ringCount,
							}).radius
						:	graphOrbitRadiusForHub({ hubIsFirm: isFirmNode(b), childCount: Math.max(degreeOf(b), 4) }).radius;
					let dx = (b.x ?? 0) - (a.x ?? 0);
					let dy = (b.y ?? 0) - (a.y ?? 0);
					let dist = Math.hypot(dx, dy);
					const need = aOrbit + bOrbit + Math.max(100, GRAPH_FIRM_NODE_RADIUS * 1.1);
					if (dist >= need) continue;
					if (dist < 1e-6) {
						const ang = ((hashString(`${a.id}|${b.id}`) % 1000) / 999) * Math.PI * 2;
						dx = Math.cos(ang);
						dy = Math.sin(ang);
						dist = 1;
					}
					const push = ((need - dist) / need) * alpha * 0.9;
					const ux = (dx / dist) * push;
					const uy = (dy / dist) * push;
					if (a.fx == null) {
						a.vx = (a.vx ?? 0) - ux;
						a.vy = (a.vy ?? 0) - uy;
					}
					if (b.fx == null) {
						b.vx = (b.vx ?? 0) + ux;
						b.vy = (b.vy ?? 0) + uy;
					}
				}
			}
		};

		// Keep leaves orbiting their firm hub on the assigned ring so charge
		// doesn't collapse them into a single overlapping blob.
		const ringOrbitForce = (alpha: number) => {
			for (const [key, ring] of childRingIndex) {
				const sep = key.indexOf('|');
				if (sep < 0) continue;
				const hubId = key.slice(0, sep);
				const childId = key.slice(sep + 1);
				const hub = nodeById.get(hubId) as any;
				const child = nodeById.get(childId) as any;
				if (!hub || !child) continue;
				if (child.fx != null || child.fy != null) continue;
				const hubDeg = degreeOf(hub);
				if (hubDeg < 4) continue;
				const childDeg = degreeOf(child);
				if (childDeg > 4) continue; // only pin true leaves to rings
				const targetDist = staggeredChildDistance(hubId, childId, hubDeg);
				const slot = childSlotIndex.get(key) ?? 0;
				const kids = childrenByHub.get(hubId)?.length || 1;
				const angle = (slot / Math.max(kids, 1)) * Math.PI * 2 + ring * 0.17;
				const tx = (hub.x ?? 0) + Math.cos(angle) * targetDist;
				const ty = (hub.y ?? 0) + Math.sin(angle) * targetDist;
				const strength =
					(dense ? 0.12
					: mid ? 0.16
					: 0.2) * alpha;
				child.vx = (child.vx ?? 0) + (tx - (child.x ?? 0)) * strength;
				child.vy = (child.vy ?? 0) + (ty - (child.y ?? 0)) * strength;
			}
		};

		const simulation = d3
			.forceSimulation(d3Nodes as d3.SimulationNodeDatum[])
			.alpha(restartAlpha)
			.alphaMin(0.00035)
			.alphaDecay(
				dense ? 0.005
				: mid ? 0.004
				: 0.0035,
			)
			.velocityDecay(mid || dense ? 0.74 : 0.7)
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
						const sFirm = isFirmNode(s);
						const tFirm = isFirmNode(t);

						const degScale =
							hubDeg > 100 ? 1.85
							: hubDeg > 50 ? 1.6
							: hubDeg > 20 ? 1.35
							: 1.15;
						const scatter = Math.max(nodeScatterBoost(sDeg, nCount), nodeScatterBoost(tDeg, nCount));
						const label = String(d.label || '').toLowerCase();
						const former = label.includes('previous') || label.includes('former');
						const controls = label.includes('control') || label.includes('owner');

						// Firm↔firm edges: stretch far so clouds don't fuse.
						if (sFirm && tFirm) {
							return linkDistBase * 1.9 + scatter * 2.1 + Math.sqrt(Math.max(sDeg, 1)) * 36 + Math.sqrt(Math.max(tDeg, 1)) * 36 + (former ? 40 : 0);
						}

						// Stagger leaf spokes off hubs; keep hub–hub edges longer but uniform.
						const childIsLeaf = Math.min(sDeg, tDeg) <= 3;
						const stagger = childIsLeaf && hubDeg >= 4 ? staggeredChildDistance(hubId, childId, hubDeg) : 0;
						const base = stagger > 0 ? stagger : linkDistBase * degScale + scatter * 1.7;

						return (
							base +
							(controls ? 50
							: former ? 34
							: 0)
						);
					})
					// Softer springs on high-degree hubs so stagger distances can stick.
					.strength((d: any) => {
						const s = typeof d.source === 'object' ? d.source : nodeById.get(d.source);
						const t = typeof d.target === 'object' ? d.target : nodeById.get(d.target);
						if (isFirmNode(s) && isFirmNode(t)) return linkStrengthBase * 0.35;
						const deg = Math.max(degreeOf(s), degreeOf(t));
						if (deg > 80) return linkStrengthBase * 0.42;
						if (deg > 20) return linkStrengthBase * 0.62;
						return linkStrengthBase;
					}),
			)
			.force(
				'charge',
				d3
					.forceManyBody()
					.strength((d: any) => {
						const deg = degreeOf(d);
						const firm = isFirmNode(d);
						// Firm hubs repel very strongly so open firm clusters peel apart.
						if (firm) {
							const hubMul =
								deg > 80 ? 3.4
								: deg > 20 ? 2.6
								: 2.0;
							return baseCharge * hubMul;
						}
						// Leaves repel a bit more so they don't clump on the same arc.
						const leaf =
							deg <= 2 ? 1.45
							: deg <= 4 ? 1.2
							: 1;
						return (deg > 20 ? 1.9 * baseCharge : baseCharge) * leaf;
					})
					.distanceMax(
						dense ? 1600
						: mid ? 1300
						: 1100,
					)
					.theta(mid || dense ? 0.86 : 0.76),
			)
			.force('x', d3.forceX(width / 2).strength(centerStrength))
			.force('y', d3.forceY(height / 2).strength(centerStrength))
			.force(
				'location-x',
				// Mild region bias only — strong location pull collapses firm clouds.
				d3.forceX((d: any) => (typeof d.locX === 'number' ? d.locX : width / 2)).strength((d: any) => (d.locStrength || 0) * (dense ? 0.22 : 0.35)),
			)
			.force(
				'location-y',
				d3.forceY((d: any) => (typeof d.locY === 'number' ? d.locY : height / 2)).strength((d: any) => 0.85 * (d.locStrength || 0) * (dense ? 0.22 : 0.35)),
			)
			.force(
				'collision',
				d3
					.forceCollide()
					.radius((d: any) => collisionRadius(d))
					.strength(1)
					.iterations(dense || mid ? 3 : 2),
			)
			.force('firm-separate', firmHubSeparation as any)
			.force('ring-orbit', ringOrbitForce as any);

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
			pinRememberedNodes();
			// While hot, only push every 2nd tick (reference cadence).
			if (simulation.alpha() > 0.1 && tickCount % 2 !== 0) return;

			// Low ease = very slow visual settle toward simulation targets.
			const ease = 0.08;
			d3Nodes.forEach((raw) => {
				const n = raw as any;
				if (!n.id) return;
				const tx = typeof n.fx === 'number' ? n.fx : (n.x ?? 0);
				const ty = typeof n.fy === 'number' ? n.fy : (n.y ?? 0);
				const prev = displayPos[n.id];
				if (typeof n.fx === 'number' && typeof n.fy === 'number') {
					// Selected / dragged nodes stay exactly fixed.
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

		// Longer settle window so the slow alpha can finish separating orbits.
		const stopMs =
			dense ? 24000
			: mid ? 20000
			: 16000;
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
			lockSessionLayout();
			setFocusedNodeId(nodeId);
			// Selecting any node (including the primary/hub node) reveals the
			// detail drawer, matching the reference site's "closed until a
			// node is picked" behavior.
			setDrawerOpen(true);

			// Keep the clicked node where it is. Do not reheat or unpin the rest
			// of the graph — the session layout stays put until Reset.
			const simNode = dragNodesRef.current.find((n) => n.id === nodeId) as any;
			if (simNode) {
				const px = typeof simNode.x === 'number' ? simNode.x : positionsRef.current[nodeId]?.x;
				const py = typeof simNode.y === 'number' ? simNode.y : positionsRef.current[nodeId]?.y;
				if (typeof px === 'number' && typeof py === 'number') {
					simNode.fx = px;
					simNode.fy = py;
					simNode.x = px;
					simNode.y = py;
					simNode.vx = 0;
					simNode.vy = 0;
					positionsRef.current[nodeId] = { x: px, y: py };
					setGraphPositions((prev) => ({ ...prev, [nodeId]: { x: px, y: py } }));
				}
			}

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

			// Side panel always reflects the clicked node (hub or relation).
			loadPanelForNode(node);

			// Every other node — the primary hub node or any relation node —
			// reveals its own connections (current + previous employments for
			// a person; owners/control persons and current+previous employees
			// for a firm) merged into the existing graph, in place.
			expandNode(node);
		},
		[graphData.nodes, loadKey, loadPanelForNode, expandNode, lockSessionLayout],
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

	// Empty-canvas click closes the side panel (node/label clicks stopPropagation).
	const handleCanvasClick = useCallback((event: React.MouseEvent<SVGSVGElement>) => {
		const target = event.target as Element | null;
		if (!target) return;
		// Ignore interactions on nodes, labels, or toolbar-adjacent SVG UI.
		if (target.closest('.graph-node-group')) return;
		setDrawerOpen(false);
	}, []);

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

	// Side panel content for the focused node (not necessarily the hub).
	const panelActiveKey = panelSnapshot?.resolvedKey || panelSnapshot?.key || activeSnapshot?.resolvedKey || activeSnapshot?.key || '';
	const panelDetailJson = panelSnapshot ? panelSnapshot.detailJson : (activeSnapshot?.detailJson ?? null);
	const panelLoading = Boolean(panelSnapshot?.loading || (searchLoading && !panelDetailJson));
	const panelTitle = useMemo(() => {
		if (focusedNode && focusedNode.id !== 'primary') return focusedNode.label || entityTitle;
		return entityTitle;
	}, [focusedNode, entityTitle]);
	const panelRoleRows = useMemo(() => {
		if (!panelDetailJson) return focusedNode?.id === 'primary' ? roleRows : [];
		if (focusedNode?.id === 'primary' || !panelSnapshot || panelSnapshot.resolvedKey === (activeSnapshot?.resolvedKey || activeSnapshot?.key)) {
			return roleRows;
		}
		try {
			const payload = JSON.parse(panelDetailJson);
			const parsed = parseCrdKey(panelActiveKey);
			const type = (parsed?.type as 'individual' | 'firm') || focusedNode?.entityType || 'individual';
			const finra = getContentBlock(payload, 'finra', type);
			const sec = getContentBlock(payload, 'sec', type);
			const rows: string[] = [];
			if (toArray(finra?.currentEmployments).length > 0) rows.push('Broker Regulated by FINRA');
			if (toArray(finra?.currentIAEmployments).length > 0 || toArray(sec?.currentIAEmployments).length > 0) rows.push('Investment Adviser');
			return rows;
		} catch {
			return [];
		}
	}, [panelDetailJson, focusedNode, roleRows, panelSnapshot, activeSnapshot, panelActiveKey]);

	return (
		<>
			<Head>
				<title>{`${entityTitle ? `${entityTitle} • Node Graph` : 'Node Graph'} • FINRA / SEC`}</title>
			</Head>

			<div
				className={`node-graph-page fullscreen-mode theme-${theme}`}
				data-theme={theme}>
				{/* Page toolbar under the shared app top-nav (brand + primary links live in _app). */}
				<FgHeader
					focusLabel={entityTitle || focusedNode?.label || null}
					focusCrd={focusedNode ? canonicalIdForNode(focusedNode)?.split(':')[1] || null : null}
					showFocusReadout={!!(entityTitle || focusedNode)}
					showDrawerToggle={true}
					drawerOpen={drawerOpen}
					setDrawerOpen={setDrawerOpen}
					errorMessage={searchError}
					searchQuery={searchInput}
					onSearchQueryChange={setSearchInput}
					onSearchSubmit={handleSearch}
					searchDisabled={false}
					searchLoading={searchLoading}
					searchBanner={searchBanner}
					setSearchBanner={setSearchBanner as any}
				/>

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
						aria-label='Relationship graph'
						onClick={handleCanvasClick}>
						{/* Full-canvas hit target so empty space receives clicks even when
						    the force layer is transformed / sparse. */}
						<rect
							className='graph-canvas-bg'
							x={0}
							y={0}
							width={width}
							height={height}
							fill='transparent'
							pointerEvents='all'
						/>
						<g transform={transform.toString()}>
							{visibleLinks.map((link) => {
								const sourceId = typeof link.source === 'string' ? link.source : String((link as any).source?.id ?? link.source);
								const targetId = typeof link.target === 'string' ? link.target : String((link as any).target?.id ?? link.target);
								const sourcePos = graphPositions[sourceId];
								const targetPos = graphPositions[targetId];
								if (!sourcePos || !targetPos) return null;
								const dimmed = traceConnectedIds ? !(traceConnectedIds.has(sourceId) && traceConnectedIds.has(targetId)) : false;
								const linkKind = graphLinkKind(link);
								// Previous spokes stay gray even if the other end is still active.
								const grayDashed = linkKind === 'previous';
								const touchesSelection = Boolean(focusedNodeId) && (sourceId === focusedNodeId || targetId === focusedNodeId);
								const isSelectedSpoke = touchesSelection && linkKind !== 'previous' && !dimmed;
								return (
									<line
										key={`${sourceId}-${targetId}-${link.label}-${linkKind}`}
										className={`graph-link-glow ${linkKind}${dimmed ? ' dimmed' : ''}${isSelectedSpoke ? ' selected' : ''}${touchesSelection && grayDashed ? ' selection-muted' : ''}`}
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
								const canonical = canonicalIdForNode(node);
								const isInactive =
									inactiveNodeIds.has(node.id) ||
									(!!node.loadKey && inactiveNodeIds.has(node.loadKey)) ||
									(!!canonical && inactiveNodeIds.has(canonical)) ||
									Boolean(node.inactive);
								const spokeKind = graphNodeLinkKind(node.id, graphData.links);
								const radius = nodeRadius(node.id, node.kind);
								const labelMode: LabelMode = labelModeById[node.id] ?? 'auto';
								// Auto labels hide when zoomed out halfway; pinned large/small stay.
								let showLabel = labelMode !== 'auto' || zoomScale >= LABEL_HIDE_SCALE;
								let labelSizeClass =
									labelMode === 'large' ? ' size-large'
									: labelMode === 'small' ? ' size-small'
									: ' size-auto';
								// Special-case: on individual/1156956 show labels below nodes and much larger.
								if (isTargetLargeBottom) {
									showLabel = true;
									labelSizeClass = ' size-giant';
								}
								// Translate the group so circle/label stay locked to the
								// same origin as link endpoints (cx/cy stay fixed at 0).
								return (
									<g
										key={node.id}
										className={`graph-node-group${dimmed ? ' dimmed' : ''}${draggingNodeId === node.id ? ' dragging' : ''}${expandingNodeId === node.id ? ' expanding' : ''}${isInactive ? ' inactive' : ''}`}
										transform={`translate(${position.x},${position.y})`}
										onClick={(event) => {
											event.stopPropagation();
											handleNodeClick(node.id);
										}}
										onPointerDown={(event) => handleNodePointerDown(event, node.id)}
										onPointerMove={handleNodePointerMove}
										onPointerUp={handleNodePointerUp}
										onPointerCancel={handleNodePointerUp}>
										<title>
											{node.label}
											{isActive ? ' · Selected' : ''}
											{isInactive ? ' · Inactive' : ''}
											{connectionCountById[node.id] ? ` · ${connectionCountById[node.id]} connection${connectionCountById[node.id] === 1 ? '' : 's'}` : ''}
											{` · label: ${labelMode} (double-click label to cycle)`}
										</title>
										{isActive && (
											<>
												<circle
													className='graph-node-select-halo'
													cx={0}
													cy={0}
													r={radius + 10}
													pointerEvents='none'
												/>
												<circle
													className='graph-node-select-ring'
													cx={0}
													cy={0}
													r={radius + 5}
													pointerEvents='none'
												/>
											</>
										)}
										{nodeEntityType === 'firm' ?
											<polygon
												className={`graph-node firm${isPrimary ? ' primary' : ''}${isActive ? ' active' : ''}${isInactive && spokeKind !== 'owner' ? ' inactive' : ''}${spokeKind ? ` ${spokeKind}` : ''}`}
												points={`0,${-radius} ${radius * 0.866},${-radius / 2} ${radius * 0.866},${radius / 2} 0,${radius} ${-radius * 0.866},${radius / 2} ${-radius * 0.866},${-radius / 2}`}
											/>
										:	<circle
												className={`graph-node individual${isPrimary ? ' primary' : ''}${isActive ? ' active' : ''}${isInactive && spokeKind !== 'owner' ? ' inactive' : ''}${spokeKind ? ` ${spokeKind}` : ''}`}
												cx={0}
												cy={0}
												r={radius}
											/>
										}
										{isPrimary && !isInactive && roleRows.includes('Investment Adviser') && (
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
													isTargetLargeBottom ?
														radius +
														(labelMode === 'large' ? 12
														: labelMode === 'small' ? 6
														: 8) *
															3
													:	-(
															radius +
															(labelMode === 'large' ? 12
															: labelMode === 'small' ? 6
															: 8)
														)
												}
												className={`graph-label${labelSizeClass}${isActive ? ' active' : ''}${labelMode !== 'auto' ? ' pinned' : ''}${isInactive ? ' inactive' : ''}`}
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

				<FgDrawer
					drawerOpen={drawerOpen}
					setDrawerOpen={setDrawerOpen}
					showTitleAndRoles={!!(activeSnapshot || panelSnapshot)}
					panelTitle={panelTitle}
					panelRoleRows={panelRoleRows}
					panelError={panelSnapshot?.error}
					panelActiveKey={panelActiveKey}
					panelDetailJson={panelDetailJson}
					panelLoading={panelLoading}
					onSelectKey={loadKey}
					selectionLog={selectionLog}
					onClearSelectionLog={clearSelectionLog}
				/>
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
				/* Fill the app-page under the shared top-nav (do not cover the shell). */
				.node-graph-page.fullscreen-mode {
					display: flex;
					flex-direction: column;
					width: 100%;
					height: 100%;
					background: #040810;
					color: #ffffff;
					font-family: var(--font-sans, system-ui, -apple-system, sans-serif);
					position: relative;
					overflow: hidden;
				}
				.node-graph-page.theme-light {
					background: #f3f4f6;
					color: #111827;
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
					stroke-width: 0.8;
					stroke-linecap: round;
					/* No geometric transitions — edges must track node x/y every frame. */
					transition: opacity 150ms ease;
					pointer-events: none;
				}
				/* Direct owners / executive officers: light red. */
				.graph-link-glow.owner {
					stroke: rgba(248, 113, 113, 0.78);
					stroke-width: 0.9;
				}
				.theme-light .graph-link-glow.owner {
					stroke: rgba(239, 68, 68, 0.7);
				}
				.graph-link-glow.owner.selected {
					stroke: #f87171;
					stroke-width: 1.5;
				}
				/* Current connections: blue solid. */
				.graph-link-glow.current {
					stroke: rgba(30, 136, 255, 0.88);
					stroke-width: 0.8;
				}
				/* Previous connections: light gray dashed, regardless of endpoint status. */
				.graph-link-glow.previous {
					stroke: rgba(156, 163, 175, 0.55);
					stroke-width: 0.55;
					stroke-dasharray: 1 2;
					overflow: visible;
				}
				.theme-light .graph-link-glow.previous {
					stroke: rgba(156, 163, 175, 0.45);
				}
				/* Active spoke on selected node only (current active edges). */
				.graph-link-glow.current.selected {
					stroke: #60a5fa;
					stroke-width: 1.4;
				}
				/* Gray edges that touch selection stay gray dashed — never blue. */
				.graph-link-glow.previous.selection-muted {
					stroke: rgba(156, 163, 175, 0.8);
					stroke-width: 0.6;
					stroke-dasharray: 1 2;
					opacity: 0.85;
				}
				.theme-light .graph-link-glow.previous.selection-muted {
					stroke: rgba(148, 163, 184, 0.5);
					opacity: 0.8;
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
				/* People = blue, firms = cyan hexagon (including the hub/primary node). */
				.graph-node.individual {
					fill: #0ea5e9;
					stroke: #0ea5e9;
					filter: drop-shadow(0 0 8px rgba(14, 165, 233, 0.75));
				}
				.graph-node.individual.current {
					fill: #0ea5e9;
					stroke: #38bdf8;
					filter: drop-shadow(0 0 8px rgba(56, 189, 248, 0.8));
				}
				/* Direct owners & executive officers: light red node + matching stroke. */
				.graph-node.owner,
				.graph-node.individual.owner,
				.graph-node.firm.owner {
					fill: #fca5a5;
					stroke: #f87171;
					filter: drop-shadow(0 0 8px rgba(248, 113, 113, 0.7));
				}
				.graph-node.firm.owner {
					stroke-width: 2.5px;
				}
				.graph-node.firm {
					fill: #0f172a;
					stroke: #22d3ee;
					stroke-width: 2.5px;
					filter: drop-shadow(0 0 8px rgba(34, 211, 238, 0.7));
				}
				.graph-node.primary {
					stroke-width: 3.5px;
					filter: drop-shadow(0 0 12px rgba(34, 211, 238, 0.85));
				}
				.graph-node.individual.primary {
					filter: drop-shadow(0 0 12px rgba(14, 165, 233, 0.9));
				}
				.graph-node.firm.primary {
					filter: drop-shadow(0 0 14px rgba(34, 211, 238, 0.9));
				}
				.graph-node-adviser-badge {
					fill: #22d3ee;
					stroke: #ffffff;
					stroke-width: 1;
				}
				.graph-node:hover {
					stroke-width: 3;
				}
				/* Selection: outer halo + ring (does not change fill/type color). */
				.graph-node-select-halo {
					fill: rgba(245, 158, 11, 0.16);
					stroke: none;
					pointer-events: none;
				}
				.graph-node-select-ring {
					fill: none;
					stroke: #f59e0b;
					stroke-width: 2.75px;
					pointer-events: none;
					filter: drop-shadow(0 0 8px rgba(245, 158, 11, 0.95));
				}
				.graph-node.active {
					stroke: #f59e0b !important;
				}
				.graph-node.firm.active {
					fill: #f59e0b !important;
					stroke: #f59e0b !important;
				}
				.theme-light .graph-node-select-halo {
					fill: rgba(8, 145, 178, 0.14);
				}
				.theme-light .graph-node-select-ring {
					stroke: #0891b2;
					filter: drop-shadow(0 0 6px rgba(8, 145, 178, 0.65));
				}
				.graph-node.active {
					stroke: #ffffff;
					stroke-width: 2.75;
				}
				.graph-node.individual.active {
					filter: drop-shadow(0 0 16px rgba(34, 211, 238, 0.85));
				}
				.graph-node.firm.active {
					filter: drop-shadow(0 0 16px rgba(34, 211, 238, 0.85));
				}
				/* Inactive / terminated entities (e.g. both FINRA + SEC inactive). */
				.graph-node.inactive,
				.graph-node.individual.inactive,
				.graph-node.firm.inactive,
				.graph-node.individual.primary.inactive,
				.graph-node.firm.primary.inactive {
					fill: #6b7280;
					stroke: #9ca3af;
					filter: drop-shadow(0 0 6px rgba(107, 114, 128, 0.45));
				}
				/* Owners stay light red even if another rule marked them inactive. */
				.graph-node.owner,
				.graph-node.individual.owner,
				.graph-node.firm.owner,
				.graph-node.owner.inactive,
				.graph-node.individual.owner.inactive,
				.graph-node.firm.owner.inactive {
					fill: #fca5a5;
					stroke: #f87171;
					filter: drop-shadow(0 0 8px rgba(248, 113, 113, 0.7));
				}
				.graph-node.inactive.active,
				.graph-node.individual.inactive.active,
				.graph-node.firm.inactive.active {
					stroke: #ffffff;
					stroke-width: 2.75;
					filter: drop-shadow(0 0 14px rgba(34, 211, 238, 0.75));
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
					font-size: 66px;
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
				.graph-label.size-giant {
					font-size: 45px;
					font-weight: 800;
					stroke-width: 6px;
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
					fill: #a5f3fc;
					font-weight: 700;
				}
				.theme-light .graph-label.active {
					fill: #0e7490;
				}
				.graph-label:hover {
					fill: #f8fafc;
				}
				.theme-light .graph-label:hover {
					fill: #0f172a;
				}
				/* Inactive labels after base rules so fill wins over defaults. */
				.graph-label.inactive {
					fill: #9ca3af !important;
					font-weight: 500;
				}
				.graph-label.inactive.active,
				.graph-label.inactive:hover {
					fill: #d1d5db !important;
				}
				.theme-light .graph-label.inactive {
					fill: #9ca3af !important;
				}
				.theme-light .graph-label.inactive.active,
				.theme-light .graph-label.inactive:hover {
					fill: #6b7280 !important;
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
			`}</style>
		</>
	);
}
