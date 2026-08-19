// Persist the graph-page session in Redis using the same store as the chart
// app: `finra:graph` (nodes/links/meta) plus `finra:graph:session` (layout
// template: hub, positions, zoom). Cleared only on Reset Session.
import zlib from 'zlib';
import { deleteGraphCacheKey, getGraphCacheValue, getLocalRedisValue, setGraphCacheValue } from './_lib';

export const REDIS_GRAPH_KEY = 'finra:graph';
export const REDIS_GRAPH_UPDATED_AT_KEY = 'finra:graph:updated-at';
export const REDIS_GRAPH_SESSION_KEY = 'finra:graph:session';

export type GraphSessionNode = {
	id: string;
	label: string;
	kind: 'primary' | 'relation';
	entityType?: 'individual' | 'firm';
	subLabel?: string;
	loadKey?: string;
	city?: string;
	state?: string;
	inactive?: boolean;
};

export type GraphSessionLink = {
	source: string;
	target: string;
	label: string;
	isCurrent?: boolean;
};

export type GraphSessionPayload = {
	hubKey: string | null;
	selectedNodeId: string | null;
	nodes: GraphSessionNode[];
	links: GraphSessionLink[];
	nodePositions: Array<{ id: string; x: number; y: number }>;
	zoomTransform: { x: number; y: number; k: number } | null;
	updatedAt: number;
};

function decodeStored(raw: string): string {
	if (raw.startsWith('br:')) {
		try {
			return zlib.brotliDecompressSync(Buffer.from(raw.slice(3), 'base64')).toString('utf8');
		} catch {
			return raw;
		}
	}
	try {
		return zlib.gunzipSync(Buffer.from(raw, 'base64')).toString('utf8');
	} catch {
		return raw;
	}
}

function parseJson(raw: unknown): any | null {
	if (raw == null) return null;
	if (typeof raw !== 'string') return raw && typeof raw === 'object' ? raw : null;
	const text = decodeStored(raw).trim();
	if (!text || !(text.startsWith('{') || text.startsWith('['))) return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function canonicalStoreId(id: string, entityType?: string, loadKey?: string): string | null {
	const raw = String(id || '').trim();
	if (/^(person|individual|firm):\d+$/i.test(raw)) {
		return raw.toLowerCase().replace(/^individual:/, 'person:');
	}
	const fromKey = String(loadKey || '').match(/^(finra|sec):(individual|firm):(\d+)$/i);
	if (fromKey) return `${fromKey[2].toLowerCase() === 'firm' ? 'firm' : 'person'}:${fromKey[3]}`;
	const rel = raw.match(/^relation-(individual|firm)-(\d+)$/i);
	if (rel) return `${rel[1].toLowerCase() === 'firm' ? 'firm' : 'person'}:${rel[2]}`;
	if (entityType === 'firm' || entityType === 'individual') return null;
	return null;
}

function storeRelationship(label: string, isCurrent?: boolean): { relationship: string; isCurrent: boolean } {
	const text = String(label || '').toLowerCase();
	if (text.includes('owner') || text.includes('control')) return { relationship: 'controls', isCurrent: isCurrent !== false };
	if (isCurrent === false || /previous|former|prior/.test(text)) return { relationship: 'previous_employed_by', isCurrent: false };
	return { relationship: 'employed_by', isCurrent: true };
}

function displayIdFromStore(id: string): { id: string; entityType: 'individual' | 'firm'; loadKey: string; crd: string } | null {
	const match = String(id || '')
		.trim()
		.match(/^(person|individual|firm):(\d+)$/i);
	if (!match) return null;
	const kind = match[1].toLowerCase() === 'firm' ? 'firm' : 'individual';
	const crd = match[2];
	return { id: `${kind}:${crd}`, entityType: kind, loadKey: `finra:${kind}:${crd}`, crd };
}

function displayLinkLabel(relationship: string, isCurrent?: boolean): { label: string; isCurrent: boolean } {
	const rel = String(relationship || '').toLowerCase();
	if (rel === 'controls' || rel === 'ownership' || rel === 'owner') return { label: 'Owner', isCurrent: isCurrent !== false };
	if (rel === 'previous_employed_by' || isCurrent === false) return { label: 'Previous employment', isCurrent: false };
	return { label: 'Employment', isCurrent: true };
}

export async function loadPersistedGraph(): Promise<{
	graph: { nodes: any[]; links: any[]; meta?: any } | null;
	session: GraphSessionPayload | null;
}> {
	const [sessionRaw, graphRaw] = await Promise.all([getGraphCacheValue(REDIS_GRAPH_SESSION_KEY), getGraphCacheValue(REDIS_GRAPH_KEY)]);
	const sessionParsed = parseJson(sessionRaw);
	const session: GraphSessionPayload | null =
		sessionParsed && typeof sessionParsed === 'object' && Array.isArray(sessionParsed.nodes) ? (sessionParsed as GraphSessionPayload) : null;
	const graphParsed = parseJson(graphRaw);
	const graph =
		graphParsed && typeof graphParsed === 'object' && Array.isArray(graphParsed.nodes) ?
			{ nodes: graphParsed.nodes || [], links: graphParsed.links || [], meta: graphParsed.meta }
		:	null;
	return { graph, session };
}

export function sessionFromFinraGraph(graph: { nodes: any[]; links: any[] } | null): GraphSessionPayload | null {
	if (!graph?.nodes?.length) return null;
	const nodes: GraphSessionNode[] = [];
	const idMap = new Map<string, string>();
	for (const raw of graph.nodes) {
		const mapped = displayIdFromStore(raw?.id);
		if (!mapped) continue;
		idMap.set(String(raw.id), mapped.id);
		nodes.push({
			id: mapped.id,
			label: String(raw.label || raw.crd || mapped.crd),
			kind: 'relation',
			entityType: mapped.entityType,
			subLabel: mapped.entityType === 'firm' ? 'Firm' : 'Individual',
			loadKey: mapped.loadKey,
			city: raw.city || raw.primaryOffice?.city,
			state: raw.state || raw.primaryOffice?.state,
			inactive: Boolean(raw.inactive),
		});
	}
	if (!nodes.length) return null;
	const links: GraphSessionLink[] = [];
	for (const raw of graph.links || []) {
		const source = idMap.get(String(raw.source?.id ?? raw.source)) || displayIdFromStore(String(raw.source?.id ?? raw.source))?.id;
		const target = idMap.get(String(raw.target?.id ?? raw.target)) || displayIdFromStore(String(raw.target?.id ?? raw.target))?.id;
		if (!source || !target || source === target) continue;
		const mapped = displayLinkLabel(raw.relationship, raw.isCurrent);
		links.push({ source, target, label: mapped.label, isCurrent: mapped.isCurrent });
	}
	const hub = nodes.find((n) => n.entityType === 'firm') || nodes[0];
	return {
		hubKey: hub.loadKey || hub.id,
		selectedNodeId: hub.id,
		nodes,
		links,
		nodePositions: nodes
			.map((n) => {
				const raw = graph.nodes.find((g: any) => displayIdFromStore(g?.id)?.id === n.id);
				const x = Number(raw?.x);
				const y = Number(raw?.y);
				return Number.isFinite(x) && Number.isFinite(y) ? { id: n.id, x, y } : null;
			})
			.filter((row): row is { id: string; x: number; y: number } => Boolean(row)),
		zoomTransform: null,
		updatedAt: Date.now(),
	};
}

function toFinraGraph(session: GraphSessionPayload) {
	const nodes: any[] = [];
	const seen = new Set<string>();
	const idMap = new Map<string, string>();
	for (const node of session.nodes || []) {
		const storeId = canonicalStoreId(node.id, node.entityType, node.loadKey);
		if (!storeId || seen.has(storeId)) continue;
		seen.add(storeId);
		idMap.set(node.id, storeId);
		const pos = session.nodePositions.find((p) => p.id === node.id);
		nodes.push({
			id: storeId,
			label: node.label,
			group: storeId.startsWith('firm:') ? 'firm' : 'individual',
			crd: storeId.split(':')[1],
			inactive: Boolean(node.inactive),
			city: node.city,
			state: node.state,
			...(pos ? { x: pos.x, y: pos.y } : {}),
		});
	}
	if (session.hubKey) {
		const hubMatch = String(session.hubKey).match(/(individual|firm):(\d+)/i);
		if (hubMatch) {
			const storeId = `${hubMatch[1].toLowerCase() === 'firm' ? 'firm' : 'person'}:${hubMatch[2]}`;
			idMap.set('primary', storeId);
			if (!seen.has(storeId)) {
				seen.add(storeId);
				const pos = session.nodePositions.find((p) => p.id === 'primary');
				nodes.push({
					id: storeId,
					label: session.nodes.find((n) => n.id === 'primary')?.label || hubMatch[2],
					group: storeId.startsWith('firm:') ? 'firm' : 'individual',
					crd: hubMatch[2],
					...(pos ? { x: pos.x, y: pos.y } : {}),
				});
			}
		}
	}
	const links: any[] = [];
	const linkSeen = new Set<string>();
	for (const link of session.links || []) {
		const source = idMap.get(link.source) || canonicalStoreId(link.source);
		const target = idMap.get(link.target) || canonicalStoreId(link.target);
		if (!source || !target || source === target) continue;
		const { relationship, isCurrent } = storeRelationship(link.label, link.isCurrent);
		const key = `${source}|${target}|${relationship}`;
		if (linkSeen.has(key)) continue;
		linkSeen.add(key);
		links.push({ source, target, relationship, isCurrent });
	}
	return {
		nodes,
		links,
		meta: {
			generated: new Date().toISOString(),
			sourceLabel: 'dashboard-crds session',
			totalIndividuals: nodes.filter((n) => n.group === 'individual').length,
			totalFirms: nodes.filter((n) => n.group === 'firm').length,
			totalEntities: 0,
			totalNodes: nodes.length,
			totalLinks: links.length,
		},
	};
}

async function mergeIntoFinraGraph(session: GraphSessionPayload) {
	const incoming = toFinraGraph(session);
	const existingRaw = await getLocalRedisValue(REDIS_GRAPH_KEY);
	const existing = parseJson(existingRaw);
	const prevNodes = Array.isArray(existing?.nodes) ? existing.nodes : [];
	const prevLinks = Array.isArray(existing?.links) ? existing.links : [];
	const byId = new Map<string, any>();
	for (const node of prevNodes) {
		if (node?.id) byId.set(String(node.id), node);
	}
	for (const node of incoming.nodes) byId.set(node.id, { ...(byId.get(node.id) || {}), ...node });
	const linkKey = (l: any) => `${l.source?.id ?? l.source}|${l.target?.id ?? l.target}|${l.relationship || ''}`;
	const linksByKey = new Map<string, any>();
	for (const link of prevLinks) linksByKey.set(linkKey(link), link);
	for (const link of incoming.links) linksByKey.set(linkKey(link), link);
	const nodes = Array.from(byId.values());
	const links = Array.from(linksByKey.values());
	return {
		nodes,
		links,
		meta: {
			...(existing?.meta || {}),
			generated: new Date().toISOString(),
			sourceLabel: 'dashboard-crds session',
			totalIndividuals: nodes.filter((n) => n.group === 'individual' || String(n.id || '').startsWith('person:')).length,
			totalFirms: nodes.filter((n) => n.group === 'firm' || String(n.id || '').startsWith('firm:')).length,
			totalNodes: nodes.length,
			totalLinks: links.length,
		},
	};
}

export async function saveGraphSession(session: GraphSessionPayload) {
	const payload: GraphSessionPayload = {
		hubKey: session.hubKey || null,
		selectedNodeId: session.selectedNodeId || null,
		nodes: Array.isArray(session.nodes) ? session.nodes : [],
		links: Array.isArray(session.links) ? session.links : [],
		nodePositions: Array.isArray(session.nodePositions) ? session.nodePositions : [],
		zoomTransform: session.zoomTransform || null,
		updatedAt: Date.now(),
	};
	const mergedGraph = await mergeIntoFinraGraph(payload);
	await Promise.all([
		setGraphCacheValue(REDIS_GRAPH_SESSION_KEY, JSON.stringify(payload)),
		setGraphCacheValue(REDIS_GRAPH_KEY, JSON.stringify(mergedGraph)),
		setGraphCacheValue(REDIS_GRAPH_UPDATED_AT_KEY, String(Date.now())),
	]);
	return payload;
}

export async function resetGraphSession() {
	const emptyGraph = {
		nodes: [],
		links: [],
		meta: {
			generated: new Date().toISOString(),
			sourceLabel: '(session reset)',
			totalIndividuals: 0,
			totalFirms: 0,
			totalEntities: 0,
			totalNodes: 0,
			totalLinks: 0,
		},
	};
	await Promise.all([
		deleteGraphCacheKey(REDIS_GRAPH_SESSION_KEY),
		setGraphCacheValue(REDIS_GRAPH_KEY, JSON.stringify(emptyGraph)),
		setGraphCacheValue(REDIS_GRAPH_UPDATED_AT_KEY, String(Date.now())),
	]);
}
