import Head from 'next/head';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type Graph from 'graphology';
import type Sigma from 'sigma';
import { forceSimulation, forceLink, forceManyBody, forceCollide, forceX, forceY } from 'd3-force';
import { useSharedGraphState } from '../../src/hooks/useSharedGraphState';
import { useLocalNameSearch } from '../../src/hooks/useLocalNameSearch';
import { PanelHeader } from '../../src/components/panel/PanelHeader';
import { StatusBox, type SelectionLogEntry } from '../../src/components/panel/StatusBox';
import { extractNamesFromPayload, getContentBlock, resolveEntityDisplayName } from '../../src/lib/extractNames';
import { toProperCaseName } from '../../src/lib/format';
import { parseCrdKey } from '../../src/lib/parseKey';
import { readLastCrdSelection } from '../../src/lib/lastCrdSelection';
import { CHART_PRELOAD_SEEDS } from '../../src/lib/chartPreloadSeeds';
import { FgHeader } from '../../src/components/graph/FgHeader';
import { FgDrawer } from '../../src/components/graph/FgDrawer';
import { useSelectionLog } from '../../src/hooks/useSelectionLog';
import type { LocalNameSearchResult } from '../../src/types';

/** Sigma rendering touches WebGL globals — never import it at module top-level (SSR/Turbopack). */
function resolveDefaultExport<T = any>(mod: any): T {
	if (!mod) return null as T;
	if (typeof mod === 'function') return mod as T;
	if (typeof mod.default === 'function') return mod.default as T;
	if (mod.default && typeof mod.default.default === 'function') return mod.default.default as T;
	return (mod.default ?? mod) as T;
}

/** Resolve a Sigma Node/Edge program class from a dynamic import (CJS/ESM/Turbopack interop). */
function resolveProgramClass(mod: any, names: string[] = []): any {
	if (!mod) return null;
	if (typeof mod === 'function') return mod;
	for (const name of names) {
		if (typeof mod[name] === 'function') return mod[name];
		if (mod.default && typeof mod.default[name] === 'function') return mod.default[name];
	}
	if (typeof mod.default === 'function') return mod.default;
	if (mod.default && typeof mod.default.default === 'function') return mod.default.default;
	for (const value of Object.values(mod)) {
		if (typeof value === 'function') {
			const n = String((value as Function).name || '');
			if (/Program|Node|Edge/i.test(n) || !n) return value;
		}
		if (value && typeof (value as any).default === 'function') return (value as any).default;
	}
	return null;
}

function toArray(value: unknown): any[] {
	return Array.isArray(value) ? value : [];
}

/** Same unwrap as /graph so StatusBox/PanelHeader receive identical payload shapes. */
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

function pickSecNumberFromDetailJson(detailJson: string | null | undefined): string | null {
	if (!detailJson) return null;
	try {
		const root = JSON.parse(detailJson);
		const walk = (node: unknown, depth = 0): Record<string, unknown> | null => {
			if (!node || typeof node !== 'object' || depth > 8) return null;
			const obj = node as Record<string, unknown>;
			if (obj.basicInformation && typeof obj.basicInformation === 'object') {
				return obj.basicInformation as Record<string, unknown>;
			}
			for (const key of ['content', 'data', 'payload', 'finraBrokerCheck', 'sources', 'finra', 'sec']) {
				const child = obj[key];
				if (child && typeof child === 'object') {
					const found = walk(child, depth + 1);
					if (found) return found;
				}
			}
			// bundle.sources.finra.payload shape
			if (obj.payload && typeof obj.payload === 'object') {
				const found = walk(obj.payload, depth + 1);
				if (found) return found;
			}
			return null;
		};
		const bi = walk(root) || {};
		const sec =
			bi.bdSECNumber != null && String(bi.bdSECNumber).trim() ? String(bi.bdSECNumber).trim()
			: bi.iaSECNumber != null && String(bi.iaSECNumber).trim() ? String(bi.iaSECNumber).trim()
			: null;
		return sec;
	} catch {
		return null;
	}
}

function formatSelectionLogDisplay(label: string, crd: string, secNumber?: string | null): string {
	// Prefer real node labels; never invent "Individual/Firm …" generics.
	const raw = String(label || '')
		.replace(/\s+/g, ' ')
		.trim();
	const generic = !raw || /^(individual|firm|person|crd)(\s+#?\d+)?$/i.test(raw) || raw.toLowerCase() === `crd ${crd}`.toLowerCase();
	const name = generic ? String(crd || '').trim() || raw : raw;
	return `${name} :: CRD# ${crd}`;
}

type LayoutNode = {
	id: string;
	label: string;
	type: 'individual' | 'firm' | 'unknown';
	x: number;
	y: number;
	size: number;
	color: string;
	degree: number;
	cluster?: number;
	region?: string;
	regionGroup?: string;
	brokerCount?: number;
	firmLinkCount?: number;
	weight?: number;
	/** True when FINRA/SEC show inactive/terminated (still expandable). */
	inactive?: boolean;
};

/** Inactive people/firms: slate gray (still clickable / expandable). */
const INACTIVE_NODE_COLOR = '#6b7280';
const INACTIVE_NODE_COLOR_DIM = '#4b5563';
const INACTIVE_NODE_STROKE = '#9ca3af';
/** People: sky-blue circles. Firms: /graph MS hex — dark fill + cyan stroke in shader. */
const INDIVIDUAL_NODE_COLOR = '#0ea5e9';
const FIRM_NODE_COLOR = '#0f172a';
/** Active click / multi-select — amber. */
const SELECTED_NODE_COLOR = '#f59e0b';
/**
 * Connections already revealed (clicked/expanded) but not the active selection.
 * Slightly shifted fills so opened hubs read as "done" while type stays recognizable.
 */
const REVEALED_INDIVIDUAL_COLOR = '#38bdf8';
const REVEALED_FIRM_COLOR = '#164e63';
const REVEALED_INACTIVE_COLOR = '#78716c';
/** Canvas rings: selected (amber) vs revealed (violet person / teal firm). */
const SELECTED_RING_COLOR = '#f59e0b';
const SELECTED_RING_FILL = 'rgba(245, 158, 11, 0.16)';
const REVEALED_RING_INDIVIDUAL = '#c084fc';
const REVEALED_RING_FIRM = '#2dd4bf';
const REVEALED_RING_FILL_INDIVIDUAL = 'rgba(192, 132, 252, 0.12)';
const REVEALED_RING_FILL_FIRM = 'rgba(45, 212, 191, 0.12)';

function nodeDisplayColor(type: string, inactive?: boolean, degree?: number): string {
	void degree;
	if (inactive) return INACTIVE_NODE_COLOR;
	if (type === 'firm') return FIRM_NODE_COLOR;
	return INDIVIDUAL_NODE_COLOR;
}

/** Stable type color for a node (never selection/revealed tint). */
function nodeTypeBaseColor(type: string, inactive?: boolean): string {
	return nodeDisplayColor(type, inactive);
}

/** Fill color for selected / revealed / default states. */
function nodeStateColor(opts: { type: string; inactive?: boolean; selected?: boolean; revealed?: boolean }): string {
	if (opts.selected) return SELECTED_NODE_COLOR;
	if (opts.inactive) return opts.revealed ? REVEALED_INACTIVE_COLOR : INACTIVE_NODE_COLOR;
	if (opts.revealed) {
		return opts.type === 'firm' ? REVEALED_FIRM_COLOR : REVEALED_INDIVIDUAL_COLOR;
	}
	return nodeTypeBaseColor(opts.type, false);
}

function nodeRenderType(type: string): 'circle' | 'hexagon' {
	return type === 'firm' ? 'hexagon' : 'circle';
}

type LayoutEdge = {
	id: string;
	source: string;
	target: string;
	type: string;
	weight: number;
	/** false = previous/former employment (from expand); undefined = unknown/catalog. */
	isCurrent?: boolean;
};

/** True when an edge index row is known previous/former. */
function layoutEdgeIsPrevious(e: Pick<LayoutEdge, 'type' | 'isCurrent'>): boolean {
	if (e.isCurrent === false) return true;
	if (e.isCurrent === true) return false;
	return /previous|former|prior/i.test(String(e.type || ''));
}

/** Normalize expand/catalog link into a layout edge (current vs previous). */
function makeEmploymentEdge(source: string, target: string, relRaw: string, isCurrentRaw: unknown, weight = 1): LayoutEdge {
	const rel = String(relRaw || 'employment');
	const isCurrent = isCurrentRaw !== false && isCurrentRaw !== 0 && isCurrentRaw !== 'false' && !/previous|former|prior/i.test(rel);
	const type =
		isCurrent ?
			rel.includes('previous') ?
				'employment'
			:	rel || 'employment'
		: /previous|former|prior/i.test(rel) ? rel
		: `previous_${rel || 'employment'}`;
	return {
		id: `${source}:${target}:${type}`,
		source,
		target,
		type,
		weight: Number(weight) || 1,
		isCurrent,
	};
}

/** Insert/upgrade a spoke in edgesByNode (previous wins over unknown/current catalog stubs). */
function upsertIndexedEdge(map: Map<string, LayoutEdge[]>, edge: LayoutEdge) {
	const samePair = (x: LayoutEdge) => (x.source === edge.source && x.target === edge.target) || (x.source === edge.target && x.target === edge.source);

	for (const end of [edge.source, edge.target]) {
		const list = map.get(end) || [];
		const idx = list.findIndex(samePair);
		if (idx < 0) {
			list.push(edge);
			map.set(end, list);
			continue;
		}
		const existing = list[idx];
		const nextPrev = layoutEdgeIsPrevious(edge);
		const curPrev = layoutEdgeIsPrevious(existing);
		// Prefer explicit previous; otherwise keep richer type / higher weight.
		if (nextPrev && !curPrev) {
			list[idx] = { ...existing, ...edge, isCurrent: false, type: edge.type };
		} else if (!nextPrev && curPrev) {
			// keep previous
		} else if (edge.isCurrent !== undefined && existing.isCurrent === undefined) {
			list[idx] = { ...existing, ...edge };
		} else if ((edge.weight || 0) > (existing.weight || 0)) {
			list[idx] = { ...existing, weight: edge.weight };
		}
		map.set(end, list);
	}
}

type LayoutPayload = {
	version?: number;
	generatedAt?: string;
	stats?: {
		nodeCount?: number;
		edgeCount?: number;
		firmCount?: number;
		individualCount?: number;
		buildMs?: number;
		edgeTypes?: Record<string, number>;
		clusterCount?: number;
	};
	params?: Record<string, unknown>;
	nodes: LayoutNode[];
	edges: LayoutEdge[];
};

type HoverInfo = {
	id: string;
	label: string;
	type: string;
	degree: number;
	cluster?: number;
	region?: string;
	regionGroup?: string;
	brokerCount?: number;
	firmLinkCount?: number;
	weight?: number;
};

type FocusInfo = HoverInfo & { neighborCount: number };

type EdgeTypeKey = 'employment' | 'firm_link' | 'ownership' | 'location' | 'succession' | 'other';

const EDGE_TYPE_META: { key: EdgeTypeKey; label: string; match: (t: string) => boolean }[] = [
	// Include previous/former employment under the Employment filter (left /graph parity).
	{
		key: 'employment',
		label: 'Employment',
		match: (t) => !t || t === 'employment' || /previous|former|prior/.test(t) || t.includes('employ'),
	},
	{ key: 'firm_link', label: 'Firm links', match: (t) => t === 'firm_link' },
	{ key: 'ownership', label: 'Ownership', match: (t) => t === 'ownership' || t.includes('owner') || t.includes('control') },
	{ key: 'location', label: 'Location', match: (t) => t === 'location' },
	{ key: 'succession', label: 'Succession', match: (t) => t === 'succession' },
	{ key: 'other', label: 'Other', match: (t) => !['employment', 'firm_link', 'ownership', 'location', 'succession', ''].includes(t) },
];

function normalizeEdgeType(raw: string | undefined): EdgeTypeKey {
	const t = String(raw || 'employment').toLowerCase();
	for (const meta of EDGE_TYPE_META) {
		if (meta.key === 'other') continue;
		if (meta.match(t)) return meta.key;
	}
	return 'other';
}

/** d3-force bake is already wide; client scale opens dense firm clusters more. */
const LAYOUT_SPREAD = 7;

/**
 * Local testing: bare `/chart` preloads curated CRD seeds (see chartPreloadSeeds)
 * plus catalog edges among them. Set false to restore blank-canvas behavior.
 */
const CHART_USE_PRELOAD_SEEDS = false;

function hashString(input: string): number {
	let h = 2166136261;
	for (let i = 0; i < input.length; i++) {
		h ^= input.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

type LabelHitBox = { nodeId: string; x: number; y: number; w: number; h: number };

/** Viewport-space label rects from the last labels paint (for click/hover hit-tests). */
const labelHitBoxesRef: { current: LabelHitBox[] } = { current: [] };

/**
 * Draw labels centered above the node disk (Sigma default is to the right).
 * Font size is always CSS/screen px (not zoom-scaled). Optionally records hit boxes.
 */
function drawLabelAbove(
	context: CanvasRenderingContext2D,
	data: { x: number; y: number; size: number; label: string | null; color: string; key?: string },
	settings: {
		labelSize: number;
		labelFont: string;
		labelWeight: string;
		labelColor: { color?: string; attribute?: string };
	},
	opts?: { hover?: boolean; recordHit?: boolean },
) {
	if (!data.label) return;
	// Fixed screen-pixel type — never scale with camera ratio.
	const size = settings.labelSize;
	const font = settings.labelFont;
	const weight = settings.labelWeight;
	const color = settings.labelColor.attribute ? (data as any)[settings.labelColor.attribute] || settings.labelColor.color || '#e2e8f0' : settings.labelColor.color || '#e2e8f0';

	context.font = `${weight} ${size}px ${font}`;
	const text = String(data.label);
	const metrics = context.measureText(text);
	const padX = opts?.hover ? 6 : 4;
	const padY = opts?.hover ? 3 : 2;
	const w = Math.round(metrics.width + padX * 2);
	const h = Math.round(size + padY * 2);
	const x = data.x - w / 2;
	// Place fully above the disk with a small gap (data.size is already viewport px).
	const y = data.y - data.size - h - 4;

	if (opts?.recordHit && data.key) {
		labelHitBoxesRef.current.push({ nodeId: String(data.key), x, y, w, h });
	}

	if (opts?.hover) {
		context.fillStyle = 'rgba(15,23,42,0.88)';
		context.strokeStyle = 'rgba(148,163,184,0.55)';
		context.lineWidth = 1;
		const r = 4;
		context.beginPath();
		context.moveTo(x + r, y);
		context.lineTo(x + w - r, y);
		context.quadraticCurveTo(x + w, y, x + w, y + r);
		context.lineTo(x + w, y + h - r);
		context.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
		context.lineTo(x + r, y + h);
		context.quadraticCurveTo(x, y + h, x, y + h - r);
		context.lineTo(x, y + r);
		context.quadraticCurveTo(x, y, x + r, y);
		context.closePath();
		context.fill();
		context.stroke();
	} else {
		// Soft halo so thin labels stay readable on dark/light edges.
		context.fillStyle = 'rgba(2,6,23,0.55)';
		context.fillRect(x - 1, y - 1, w + 2, h + 2);
	}

	context.fillStyle = color;
	context.textBaseline = 'middle';
	context.textAlign = 'left';
	context.fillText(text, x + padX, y + h / 2);
}

function hitTestLabel(clientX: number, clientY: number, container: HTMLElement | null): string | null {
	if (!container) return null;
	const rect = container.getBoundingClientRect();
	const x = clientX - rect.left;
	const y = clientY - rect.top;
	// Top-most last drawn wins — walk reverse.
	const boxes = labelHitBoxesRef.current;
	for (let i = boxes.length - 1; i >= 0; i--) {
		const b = boxes[i];
		if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return b.nodeId;
	}
	return null;
}

let globalLayoutAnimId: any = null;

/**
 * Animated force-directed layout that smoothly settles expanded nodes in WebGL.
 * Default: ego `/graph`-style spread (flat, multi-ring).
 * Person→firms focus (ref: finra-data-chart-next-02 /individual/…): single circular
 * star — hub center, firm leaves on one long ring, bright radial spokes.
 */
function runFluidLayout(graph: Graph, sigma: Sigma, opts?: { egoHubId?: string | null }) {
	if (globalLayoutAnimId !== null) {
		globalLayoutAnimId.stop();
		globalLayoutAnimId = null;
	}
	if (graph.order < 2) return;
	// Skip expensive iterative layout on large precomputed global graphs
	if (graph.order > 3000) return;

	const nCount = graph.order;
	const dense = nCount > 300;
	const mid = nCount > 120 && !dense;

	const pts: any[] = [];
	const nodeById = new Map<string, any>();

	graph.forEachNode((id, attrs) => {
		const degree = Number(attrs.degree) || graph.degree(id) || 1;
		const nodeType = String(attrs.nodeType || attrs.type || 'unknown');
		const firm = nodeType === 'firm';
		const p = {
			id,
			x: Number(attrs.x) || 0,
			y: Number(attrs.y) || 0,
			degree,
			nodeType,
			firm,
			pinned: Boolean(attrs.pinned),
		};
		pts.push(p);
		nodeById.set(id, p);
	});

	const edges: any[] = [];
	graph.forEachEdge((_e, _attrs, source, target) => {
		if (nodeById.has(source) && nodeById.has(target)) {
			edges.push({ source, target });
		}
	});

	// Ego star (left /graph parity): focused person→firms or firm→direct neighbors.
	// Auto-detect only for individual hubs with many firm leaves so progressive
	// multi-hub maps (thousands of nodes) stay wide/flat instead of collapsing.
	let egoHubId = opts?.egoHubId || null;
	if (!egoHubId) {
		let best: { id: string; deg: number } | null = null;
		for (const p of pts) {
			if (p.nodeType !== 'individual' && p.nodeType !== 'person') continue;
			const deg = graph.degree(p.id);
			if (!best || deg > best.deg) best = { id: p.id, deg };
		}
		if (best && best.deg >= 4) {
			const spokeCount = edges.filter((e) => e.source === best!.id || e.target === best!.id).length;
			// Only auto-star when the canvas is mostly this ego (not a full map dump).
			if (spokeCount >= 4 && nCount <= Math.max(40, spokeCount + 12)) egoHubId = best.id;
		}
	}
	const starEgo = Boolean(egoHubId && nodeById.has(egoHubId));
	const egoHubNode = egoHubId ? nodeById.get(egoHubId) : null;
	const egoIsPerson = Boolean(egoHubNode && !egoHubNode.firm);

	// Prefer high-degree endpoint as hub for ring assignment (same as /graph).
	// Star ego: force the focused person as sole hub for all their firm spokes.
	const childrenByHub = new Map<string, string[]>();
	for (const l of edges) {
		const s = nodeById.get(l.source);
		const t = nodeById.get(l.target);
		if (!s || !t) continue;
		let hubId: string;
		let childId: string;
		if (starEgo && (s.id === egoHubId || t.id === egoHubId)) {
			hubId = egoHubId!;
			childId = s.id === egoHubId ? t.id : s.id;
		} else {
			hubId = s.degree >= t.degree ? s.id : t.id;
			childId = s.degree >= t.degree ? t.id : s.id;
		}
		const list = childrenByHub.get(hubId) || [];
		list.push(childId);
		childrenByHub.set(hubId, list);
	}
	const childRingIndex = new Map<string, number>();
	const childSlotIndex = new Map<string, number>();
	const hubOrbitMeta = new Map<string, { ringCount: number; kidCount: number; hubType: string; ringSizes: number[] }>();
	for (const [hub, kids] of childrenByHub) {
		const unique = Array.from(new Set(kids)).sort((a, b) => a.localeCompare(b));
		const hubNode = nodeById.get(hub);
		const hubType = hubNode?.firm ? 'firm' : 'individual';
		// Prefer a single ring only for small stars; dense hubs use multi-ring packing.
		const preferSingle = unique.length <= 18 || Boolean(starEgo && hub === egoHubId && unique.length <= 28);
		const { ringCount } = orbitRadiusForHub({
			hubType,
			childCount: unique.length,
			preferSingleRing: preferSingle,
		});
		// Distribute children across rings proportional to each ring's radius (i.e. its
		// available circumference), instead of an even round-robin split. A flat split
		// gives the innermost ring the same node count as the outermost — but the inner
		// ring has far less arc length, so those nodes end up crushed together right next
		// to the hub while the outer ring has room to spare. Weighting by radius keeps
		// on-screen spacing roughly consistent across every ring.
		const ringRadii: number[] = [];
		for (let r = 0; r < ringCount; r++) {
			ringRadii.push(orbitRadiusForHub({ hubType, childCount: unique.length, ringIndex: r, ringCount, preferSingleRing: preferSingle }).radius);
		}
		const radiusSum = ringRadii.reduce((s, r) => s + r, 0) || 1;
		const ringSizes = ringRadii.map((r) => Math.max(1, Math.round((r / radiusSum) * unique.length)));
		// Rounding can drift the total off unique.length — true it up, adjusting outer
		// rings first since they have the most slack.
		let drift = unique.length - ringSizes.reduce((s, n) => s + n, 0);
		let adjustIdx = ringCount - 1;
		while (drift !== 0 && ringCount > 0) {
			if (drift > 0) {
				ringSizes[adjustIdx] += 1;
				drift -= 1;
			} else if (ringSizes[adjustIdx] > 1) {
				ringSizes[adjustIdx] -= 1;
				drift += 1;
			}
			adjustIdx = (adjustIdx - 1 + ringCount) % ringCount;
		}
		hubOrbitMeta.set(hub, { ringCount, kidCount: unique.length, hubType, ringSizes });
		let childIdx = 0;
		for (let r = 0; r < ringCount; r++) {
			for (let s = 0; s < ringSizes[r] && childIdx < unique.length; s++, childIdx++) {
				const child = unique[childIdx];
				childRingIndex.set(`${hub}|${child}`, r);
				// Slot is now the index WITHIN this ring (not a global index), so angular
				// placement below spaces nodes evenly around their own ring's circumference.
				childSlotIndex.set(`${hub}|${child}`, s);
			}
		}
	}

	const staggeredChildDistance = (hubId: string, childId: string, hubDeg: number) => {
		const ring = childRingIndex.get(`${hubId}|${childId}`) ?? 0;
		const meta = hubOrbitMeta.get(hubId);
		const hubType = meta?.hubType || (nodeById.get(hubId)?.firm ? 'firm' : 'individual');
		const kidCount = Math.max(meta?.kidCount || 1, hubDeg || 1);
		const { radius } = orbitRadiusForHub({
			hubType,
			childCount: kidCount,
			ringIndex: ring,
			ringCount: meta?.ringCount,
			preferSingleRing: kidCount <= 18,
		});
		const jitter = ((hashString(`${hubId}:${childId}`) % 1000) / 999 - 0.5) * 12;
		return radius + jitter;
	};

	// Force constants: keep hubs near enough to read as one map, but far enough
	// that private orbits don't interpenetrate. Prior values over-pushed clusters
	// across the canvas while still allowing leaf piles on dense rings.
	const baseCharge =
		starEgo ?
			egoIsPerson ? -2000
			:	-2400
		: dense ? -3800
		: mid ? -3000
		: -2400;
	const linkStrengthBase =
		starEgo ?
			egoIsPerson ? 0.44
			:	0.36
		: dense ? 0.1
		: mid ? 0.15
		: 0.24;
	const linkDistBase =
		starEgo ?
			egoIsPerson ? 480
			:	420
		: nCount > 1000 ? 820
		: nCount > 300 ? 720
		: nCount > 150 ? 640
		: nCount > 80 ? 580
		: 540;
	// Leaf body padding in graph units — enough to stop disk stacks without
	// inflating hub-to-hub distance (hubs use orbit-based collision below).
	const collidePad =
		starEgo ?
			egoIsPerson ? 88
			:	100
		: nCount > 1000 ? 64
		: nCount > 600 ? 76
		: nCount > 300 ? 84
		: nCount > 120 ? 96
		: nCount > 60 ? 112
		: 124;
	// Weak centering so multi-hub maps don't collapse back together.
	const centerStrength =
		starEgo ? 0.014
		: dense ? 0.0004
		: mid ? 0.0007
		: 0.0015;
	// Full 2D (circular) — no Y squash.
	const yFlatten = 1;

	let cx = 0;
	let cy = 0;
	pts.forEach((p) => {
		cx += p.x;
		cy += p.y;
	});
	cx /= pts.length;
	cy /= pts.length;

	// Treat any node with kids (or pinned/selected expand hubs) as needing orbit clearance.
	const expandedHubIds = pts
		.filter((p) => {
			const kids = childrenByHub.get(p.id)?.length || 0;
			return kids >= 2 || p.degree >= 3 || p.pinned || (starEgo && p.id === egoHubId);
		})
		.map((p) => p.id);

	const hubOuterOrbit = (id: string, fallbackDeg: number, firm: boolean) => {
		const meta = hubOrbitMeta.get(id);
		if (meta) {
			return outerOrbitRadius({
				hubType: meta.hubType,
				childCount: Math.max(meta.kidCount, 1),
				ringCount: meta.ringCount,
			});
		}
		return outerOrbitRadius({
			hubType: firm ? 'firm' : 'individual',
			childCount: Math.max(fallbackDeg, childrenByHub.get(id)?.length || 4, 4),
		});
	};

	// Hard push so private orbits never stack (pinned hubs still repel unpinned ones).
	const firmHubSeparation = (alpha: number) => {
		if (expandedHubIds.length < 2) return;
		const pushScale = 1.55 + Math.min(1.2, expandedHubIds.length * 0.04);
		for (let i = 0; i < expandedHubIds.length; i++) {
			const a = nodeById.get(expandedHubIds[i]);
			if (!a) continue;
			const aOrbit = hubOuterOrbit(a.id, a.degree, a.firm);
			for (let j = i + 1; j < expandedHubIds.length; j++) {
				const b = nodeById.get(expandedHubIds[j]);
				if (!b) continue;
				const bOrbit = hubOuterOrbit(b.id, b.degree, b.firm);
				let dx = (b.x ?? 0) - (a.x ?? 0);
				let dy = (b.y ?? 0) - (a.y ?? 0);
				let dist = Math.hypot(dx, dy);
				const need = aOrbit + bOrbit + ORBIT_HUB_GAP;
				if (dist >= need) continue;
				if (dist < 1e-6) {
					const ang = ((hashString(`${a.id}|${b.id}`) % 1000) / 999) * Math.PI * 2;
					dx = Math.cos(ang);
					dy = Math.sin(ang);
					dist = 1;
				}
				// Absolute graph-unit push (not only normalized) so stuck hubs break free.
				const overlap = need - dist;
				const push = (overlap / Math.max(need, 1)) * alpha * pushScale + overlap * alpha * 0.06;
				const ux = (dx / dist) * push;
				const uy = (dy / dist) * push;
				const aFixed = Boolean(a.pinned || (starEgo && a.id === egoHubId));
				const bFixed = Boolean(b.pinned || (starEgo && b.id === egoHubId));
				if (aFixed && bFixed) {
					// Both fixed: still separate by nudging positions slightly so pinned
					// multi-select hubs don't stay stacked on top of each other.
					const half = 0.55;
					if (typeof a.fx === 'number') {
						a.fx -= ux * half;
						a.x = a.fx;
					} else {
						a.vx = (a.vx ?? 0) - ux * 0.8;
						a.vy = (a.vy ?? 0) - uy * 0.8;
					}
					if (typeof b.fx === 'number') {
						b.fx += ux * half;
						b.x = b.fx;
					} else {
						b.vx = (b.vx ?? 0) + ux * 0.8;
						b.vy = (b.vy ?? 0) + uy * 0.8;
					}
					if (typeof a.fy === 'number') a.fy -= uy * half;
					if (typeof b.fy === 'number') b.fy += uy * half;
					if (typeof a.fy === 'number') a.y = a.fy;
					if (typeof b.fy === 'number') b.y = b.fy;
					continue;
				}
				if (aFixed && !bFixed) {
					// Move free hub fully out of the pinned orbit.
					b.vx = (b.vx ?? 0) + ux * 1.7;
					b.vy = (b.vy ?? 0) + uy * 1.7;
					continue;
				}
				if (!aFixed && bFixed) {
					a.vx = (a.vx ?? 0) - ux * 1.7;
					a.vy = (a.vy ?? 0) - uy * 1.7;
					continue;
				}
				// Mass-weight the push by orbit size so a large freshly-expanded hub stays
				// put while smaller neighboring hubs are the ones shoved clear of it.
				const totalOrbit = Math.max(aOrbit + bOrbit, 1);
				const aShare = bOrbit / totalOrbit;
				const bShare = aOrbit / totalOrbit;
				a.vx = (a.vx ?? 0) - ux * aShare * 1.6;
				a.vy = (a.vy ?? 0) - uy * aShare * 1.6;
				b.vx = (b.vx ?? 0) + ux * bShare * 1.6;
				b.vy = (b.vy ?? 0) + uy * bShare * 1.6;
			}
		}
	};

	/** Pairwise leaf body separation — kills disk stacks without inflating hub gaps. */
	const leafBodySeparate = (alpha: number) => {
		const bodies = pts.filter((p) => {
			const kids = childrenByHub.get(p.id)?.length || 0;
			return kids < 2 && p.degree <= 4 && !(starEgo && p.id === egoHubId);
		});
		for (let i = 0; i < bodies.length; i++) {
			const a = bodies[i];
			const aBody = (a.firm ? FIRM_NODE_SIZE : INDIVIDUAL_NODE_SIZE) + collidePad * 0.55;
			for (let j = i + 1; j < bodies.length; j++) {
				const b = bodies[j];
				const bBody = (b.firm ? FIRM_NODE_SIZE : INDIVIDUAL_NODE_SIZE) + collidePad * 0.55;
				let dx = (b.x ?? 0) - (a.x ?? 0);
				let dy = (b.y ?? 0) - (a.y ?? 0);
				let dist = Math.hypot(dx, dy);
				const need = aBody + bBody;
				if (dist >= need) continue;
				if (dist < 1e-6) {
					const ang = ((hashString(`${a.id}|${b.id}|leaf`) % 1000) / 999) * Math.PI * 2;
					dx = Math.cos(ang);
					dy = Math.sin(ang);
					dist = 1;
				}
				const push = ((need - dist) / need) * alpha * 1.15;
				const ux = (dx / dist) * push;
				const uy = (dy / dist) * push;
				if (!a.pinned) {
					a.vx = (a.vx ?? 0) - ux;
					a.vy = (a.vy ?? 0) - uy;
				}
				if (!b.pinned) {
					b.vx = (b.vx ?? 0) + ux;
					b.vy = (b.vy ?? 0) + uy;
				}
			}
		}
	};

	const ringOrbitForce = (alpha: number) => {
		for (const [key, ring] of childRingIndex) {
			const sep = key.indexOf('|');
			if (sep < 0) continue;
			const hubId = key.slice(0, sep);
			const childId = key.slice(sep + 1);
			const hub = nodeById.get(hubId);
			const child = nodeById.get(childId);
			if (!hub || !child) continue;
			// Seat leaves on hub rings; multi-hub maps also seat mid-degree nodes lightly.
			if (starEgo) {
				if (hubId !== egoHubId) continue;
			} else {
				if (hub.degree < 3 && !(childrenByHub.get(hubId)?.length || 0)) continue;
				// Don't yank another expanded hub off its own center onto a leaf ring.
				if (child.degree > 6 && (childrenByHub.get(childId)?.length || 0) >= 3) continue;
			}
			const kidsArr = childrenByHub.get(hubId) || [];
			const uniqueKids = Math.max(1, new Set(kidsArr).size);
			const targetDist = staggeredChildDistance(hubId, childId, Math.max(hub.degree, uniqueKids));
			const slot = childSlotIndex.get(key) ?? 0;
			const meta = hubOrbitMeta.get(hubId);
			const ringCount = meta?.ringCount || 1;
			// slot is already the index within this specific ring (assigned proportionally
			// to ring radius above), and onRing is that ring's own node count — not a flat
			// childCount/ringCount split — so angular spacing matches each ring's actual capacity.
			const onRing = Math.max(1, meta?.ringSizes?.[ring] ?? Math.ceil(uniqueKids / ringCount));
			const indexOnRing = slot;
			const angle = (indexOnRing / onRing) * Math.PI * 2 + ring * 0.21;
			const tx = (hub.x ?? 0) + Math.cos(angle) * targetDist;
			const ty = (hub.y ?? 0) + Math.sin(angle) * targetDist * yFlatten;
			const strength =
				(starEgo ?
					egoIsPerson ? 0.55
					:	0.48
				: dense ? 0.32
				: mid ? 0.38
				: 0.44) * alpha;
			// Direct position blend for leaves so they don't pile under competing forces.
			const blend = starEgo ? 0.18 : 0.12;
			if (!child.pinned) {
				child.x = (child.x ?? 0) + (tx - (child.x ?? 0)) * blend * Math.min(1, alpha * 8);
				child.y = (child.y ?? 0) + (ty - (child.y ?? 0)) * blend * Math.min(1, alpha * 8);
			}
			child.vx = (child.vx ?? 0) + (tx - (child.x ?? 0)) * strength;
			child.vy = (child.vy ?? 0) + (ty - (child.y ?? 0)) * strength;
		}
	};

	// Keep selected / ego hubs fixed in place while the rest of the graph settles slowly.
	const pinFixedHubs = () => {
		for (const p of pts) {
			if (p.pinned || (starEgo && egoHubId && p.id === egoHubId)) {
				if (typeof p.fx !== 'number') p.fx = p.x;
				if (typeof p.fy !== 'number') p.fy = p.y;
				p.x = p.fx;
				p.y = p.fy;
				p.vx = 0;
				p.vy = 0;
			}
		}
	};
	pinFixedHubs();

	/** Final hard de-overlap after forces settle — resolves residual leaf stacks. */
	const hardResolveOverlaps = () => {
		for (let iter = 0; iter < 18; iter++) {
			let moved = false;
			for (let i = 0; i < pts.length; i++) {
				const a = pts[i];
				const aKids = childrenByHub.get(a.id)?.length || 0;
				const aIsHub = aKids >= 2 || a.degree >= 4 || a.pinned || (starEgo && a.id === egoHubId);
				const aR = aIsHub ? hubOuterOrbit(a.id, a.degree, a.firm) * 0.78 + ORBIT_HUB_GAP * 0.2 : (a.firm ? FIRM_NODE_SIZE : INDIVIDUAL_NODE_SIZE) + collidePad * 0.65;
				for (let j = i + 1; j < pts.length; j++) {
					const b = pts[j];
					const bKids = childrenByHub.get(b.id)?.length || 0;
					const bIsHub = bKids >= 2 || b.degree >= 4 || b.pinned || (starEgo && b.id === egoHubId);
					// Hub↔hub handled by orbit packing; only force body-level here when at least one is a leaf.
					if (aIsHub && bIsHub) {
						let dx = (b.x ?? 0) - (a.x ?? 0);
						let dy = (b.y ?? 0) - (a.y ?? 0);
						let dist = Math.hypot(dx, dy);
						const need = hubOuterOrbit(a.id, a.degree, a.firm) + hubOuterOrbit(b.id, b.degree, b.firm) + ORBIT_HUB_GAP;
						if (dist >= need) continue;
						if (dist < 1e-6) {
							const ang = ((hashString(`${a.id}|${b.id}|hard`) % 1000) / 999) * Math.PI * 2;
							dx = Math.cos(ang);
							dy = Math.sin(ang);
							dist = 1;
						}
						const push = (need - dist) * 0.52;
						const ux = (dx / dist) * push;
						const uy = (dy / dist) * push;
						const aLock = a.pinned || (starEgo && a.id === egoHubId);
						const bLock = b.pinned || (starEgo && b.id === egoHubId);
						if (aLock && bLock) {
							a.x = (a.x ?? 0) - ux * 0.5;
							a.y = (a.y ?? 0) - uy * 0.5;
							b.x = (b.x ?? 0) + ux * 0.5;
							b.y = (b.y ?? 0) + uy * 0.5;
							if (typeof a.fx === 'number') a.fx = a.x;
							if (typeof a.fy === 'number') a.fy = a.y;
							if (typeof b.fx === 'number') b.fx = b.x;
							if (typeof b.fy === 'number') b.fy = b.y;
						} else if (aLock) {
							b.x = (b.x ?? 0) + ux;
							b.y = (b.y ?? 0) + uy;
						} else if (bLock) {
							a.x = (a.x ?? 0) - ux;
							a.y = (a.y ?? 0) - uy;
						} else {
							a.x = (a.x ?? 0) - ux * 0.5;
							a.y = (a.y ?? 0) - uy * 0.5;
							b.x = (b.x ?? 0) + ux * 0.5;
							b.y = (b.y ?? 0) + uy * 0.5;
						}
						moved = true;
						continue;
					}
					const bR = bIsHub ? hubOuterOrbit(b.id, b.degree, b.firm) * 0.78 + ORBIT_HUB_GAP * 0.2 : (b.firm ? FIRM_NODE_SIZE : INDIVIDUAL_NODE_SIZE) + collidePad * 0.65;
					let dx = (b.x ?? 0) - (a.x ?? 0);
					let dy = (b.y ?? 0) - (a.y ?? 0);
					let dist = Math.hypot(dx, dy);
					const need = aR + bR;
					if (dist >= need) continue;
					if (dist < 1e-6) {
						const ang = ((hashString(`${a.id}|${b.id}|leafhard`) % 1000) / 999) * Math.PI * 2;
						dx = Math.cos(ang);
						dy = Math.sin(ang);
						dist = 1;
					}
					const push = (need - dist) * 0.55;
					const ux = (dx / dist) * push;
					const uy = (dy / dist) * push;
					// Prefer moving leaves over hubs / pinned.
					if (aIsHub && !bIsHub) {
						b.x = (b.x ?? 0) + ux;
						b.y = (b.y ?? 0) + uy;
					} else if (!aIsHub && bIsHub) {
						a.x = (a.x ?? 0) - ux;
						a.y = (a.y ?? 0) - uy;
					} else {
						if (!a.pinned) {
							a.x = (a.x ?? 0) - ux * 0.5;
							a.y = (a.y ?? 0) - uy * 0.5;
						}
						if (!b.pinned) {
							b.x = (b.x ?? 0) + ux * 0.5;
							b.y = (b.y ?? 0) + uy * 0.5;
						}
					}
					moved = true;
				}
			}
			if (!moved) break;
		}
		for (const p of pts) {
			if (!graph.hasNode(p.id)) continue;
			graph.setNodeAttribute(p.id, 'x', p.x);
			graph.setNodeAttribute(p.id, 'y', p.y);
		}
	};

	let tickCount = 0;
	const sim = forceSimulation(pts)
		// Enough energy to unstack leaves, then settle cleanly (no endless drift).
		.alpha(0.16)
		.alphaMin(0.0025)
		.alphaDecay(0.028)
		.velocityDecay(0.8)
		.force(
			'charge',
			forceManyBody()
				.strength((d: any) => {
					const deg = d.degree || 1;
					const kids = childrenByHub.get(d.id)?.length || 0;
					if (d.firm || kids >= 3) {
						const hubMul =
							deg > 80 || kids > 80 ? 2.8
							: deg > 20 || kids > 20 ? 2.2
							: 1.7;
						return baseCharge * hubMul;
					}
					const leaf =
						deg <= 2 ? 2.4
						: deg <= 4 ? 3.0
						: 1.8;
					return (deg > 20 ? 1.6 * baseCharge : baseCharge) * leaf;
				})
				.distanceMax(
					dense ? 4200
					: mid ? 3400
					: 2800,
				)
				.theta(dense || mid ? 0.82 : 0.72),
		)
		.force(
			'link',
			forceLink(edges)
				.id((d: any) => d.id)
				.distance((d: any) => {
					const s = typeof d.source === 'object' ? d.source : nodeById.get(d.source);
					const t = typeof d.target === 'object' ? d.target : nodeById.get(d.target);
					if (!s || !t) return linkDistBase;
					const sDeg = s.degree || 1;
					const tDeg = t.degree || 1;
					const hubDeg = Math.max(sDeg, tDeg);
					const hubId = sDeg >= tDeg ? s.id : t.id;
					const childId = sDeg >= tDeg ? t.id : s.id;

					// Firm↔firm: moderate stretch — avoid both clumping and map-wide gaps.
					if (s.firm && t.firm) {
						return linkDistBase * 1.65 + Math.sqrt(Math.max(sDeg, 1)) * 28 + Math.sqrt(Math.max(tDeg, 1)) * 28;
					}

					const childKids = childrenByHub.get(childId)?.length || 0;
					const childIsLeaf = Math.min(sDeg, tDeg) <= 4 && childKids < 3;
					const stagger = childIsLeaf && hubDeg >= 3 ? staggeredChildDistance(hubId, childId, hubDeg) : 0;
					const degScale =
						hubDeg > 100 ? 1.45
						: hubDeg > 50 ? 1.3
						: hubDeg > 20 ? 1.18
						: 1.08;
					const base = stagger > 0 ? stagger : linkDistBase * degScale;
					return base * 1.35;
				})
				.strength((d: any) => {
					const s = typeof d.source === 'object' ? d.source : nodeById.get(d.source);
					const t = typeof d.target === 'object' ? d.target : nodeById.get(d.target);
					if (s?.firm && t?.firm) return linkStrengthBase * 0.28;
					const deg = Math.max(s?.degree || 1, t?.degree || 1);
					if (deg > 80) return linkStrengthBase * 0.42;
					if (deg > 20) return linkStrengthBase * 0.58;
					return linkStrengthBase;
				}),
		)
		.force(
			'collide',
			forceCollide()
				.radius((d: any) => {
					const deg = d.degree || 1;
					const body = d.firm ? FIRM_NODE_SIZE : INDIVIDUAL_NODE_SIZE;
					const kids = childrenByHub.get(d.id)?.length || 0;
					// Expanded hubs reserve most of their outer orbit so rings don't interpenetrate,
					// but not the full radius + huge gap (that flings clusters across the map).
					if (kids >= 2 || deg >= 4 || d.pinned) {
						const outer = hubOuterOrbit(d.id, deg, d.firm);
						return Math.max(body + collidePad, outer * 0.8);
					}
					const leafBoost =
						deg <= 2 ? body * 0.55
						: deg <= 4 ? body * 0.35
						: body * 0.15;
					return body + collidePad + leafBoost;
				})
				.strength(0.98)
				.iterations(dense || mid || starEgo ? 5 : 4),
		)
		.force('x', forceX(starEgo && egoHubId ? (nodeById.get(egoHubId)?.x ?? cx) : cx).strength(centerStrength))
		// Equal X/Y centering keeps orbits circular in true 2D (no vertical squash).
		.force('y', forceY(starEgo && egoHubId ? (nodeById.get(egoHubId)?.y ?? cy) : cy).strength(centerStrength))
		.force('firm-separate', firmHubSeparation as any)
		.force('leaf-separate', leafBodySeparate as any)
		.force('ring-orbit', ringOrbitForce as any)
		.on('tick', () => {
			tickCount += 1;
			pinFixedHubs();
			// Soft early freeze: once alpha is nearly spent, kill residual velocity
			// so custom forces can't keep nodes twitching.
			if (sim.alpha() < 0.006) {
				for (const p of pts) {
					p.vx = 0;
					p.vy = 0;
				}
			}
			// While hot, skip every other paint (same cadence as /graph).
			if (sim.alpha() > 0.12 && tickCount % 2 !== 0) return;
			for (const p of pts) {
				if (!graph.hasNode(p.id)) continue;
				// Pinned selection never drifts — write fixed coords back.
				if (p.pinned || (starEgo && egoHubId && p.id === egoHubId)) {
					const fx = typeof p.fx === 'number' ? p.fx : p.x;
					const fy = typeof p.fy === 'number' ? p.fy : p.y;
					graph.setNodeAttribute(p.id, 'x', fx);
					graph.setNodeAttribute(p.id, 'y', fy);
				} else {
					graph.setNodeAttribute(p.id, 'x', p.x);
					graph.setNodeAttribute(p.id, 'y', p.y);
				}
			}
			try {
				sigma.refresh();
			} catch {
				sim.stop(); // Canvas unmounted
			}
		})
		.on('end', () => {
			hardResolveOverlaps();
			// Permanently freeze every node so custom forces can't nudge them again.
			for (const p of pts) {
				p.vx = 0;
				p.vy = 0;
				p.fx = p.x;
				p.fy = p.y;
				if (graph.hasNode(p.id)) {
					graph.setNodeAttribute(p.id, 'x', p.x);
					graph.setNodeAttribute(p.id, 'y', p.y);
				}
			}
			globalLayoutAnimId = null;
			try {
				sigma.refresh();
			} catch {
				// ignore
			}
		});

	globalLayoutAnimId = sim;

	// Hard failsafe: competing custom forces can keep alpha above alphaMin.
	// Stop after a short settle, run one hard de-overlap, then freeze.
	window.setTimeout(() => {
		if (globalLayoutAnimId !== sim) return;
		hardResolveOverlaps();
		for (const p of pts) {
			p.vx = 0;
			p.vy = 0;
			p.fx = p.x;
			p.fy = p.y;
			if (graph.hasNode(p.id)) {
				graph.setNodeAttribute(p.id, 'x', p.x);
				graph.setNodeAttribute(p.id, 'y', p.y);
			}
		}
		sim.alpha(0);
		sim.stop();
		globalLayoutAnimId = null;
		try {
			sigma.refresh();
		} catch {
			// ignore
		}
	}, 2600);
}

/**
 * True fixed screen-pixel node radius for Sigma.
 *
 * Sigma 3 formula (scaleSize):
 *   size / zoomToSizeRatioFunction(camera.ratio)
 *   * (itemSizesReference === 'positions' ? camera.ratio * graphToViewportRatio : 1)
 *
 * With itemSizesReference:'screen' and zoomToSizeRatioFunction:() => 1, rendered
 * size equals the attribute. We still force the attribute every indexation via
 * nodeReducer so weight/degree/layout size can never leak into the WebGL buffer.
 */
const STATIC_NODE_SIZE = 46;

/** Collision / separation radius in graph units — independent of on-screen disk px. */
const COLLISION_GRAPH_RADIUS = 14;

/** On-screen px: match finra-data-chart-next-02 reference (large hubs, tiny leaves) */
const FIRM_NODE_SIZE = 12;
const INDIVIDUAL_NODE_SIZE = 12; // Increased from 10 to match firms perfectly for physics layout

function dynamicNodeSize(degree: number, type: string): number {
	if (type === 'firm') return FIRM_NODE_SIZE;
	if (degree <= 1) return INDIVIDUAL_NODE_SIZE;
	// Grow size smoothly based on number of connections up to firm size
	return Math.min(FIRM_NODE_SIZE, INDIVIDUAL_NODE_SIZE + (degree - 1) * 1);
}

/**
 * Private orbit around an expanded hub — same formula as /graph `graphOrbitRadiusForHub`
 * so chart expand seats leaves the same way.
 * Dense hubs get more rings + larger arc padding so leaves stay readable.
 */
function orbitRadiusForHub(opts: { hubType: string; childCount: number; ringIndex?: number; ringCount?: number; preferSingleRing?: boolean }): {
	radius: number;
	ringCount: number;
} {
	const childCount = Math.max(1, opts.childCount | 0);
	const hubIsFirm = opts.hubType === 'firm';
	const hubSize = hubIsFirm ? FIRM_NODE_SIZE : INDIVIDUAL_NODE_SIZE;
	// Children of a firm are mostly people (smaller); children of a person are firms (larger).
	const childSize = hubIsFirm ? INDIVIDUAL_NODE_SIZE : FIRM_NODE_SIZE;
	// Use symmetric arc padding so both person nodes and firm nodes spread out 
	// equally on their orbits without clumping.
	const arcPad =
		childSize * (
			childCount > 80 ? 4.8
			: childCount > 24 ? 4.4
			: 4.0
		);
	const minClear = hubSize + childSize + Math.max(72, childSize * 1.45);

	let ringCount = opts.ringCount ?? 1;
	if (opts.preferSingleRing && childCount <= 22) {
		ringCount = 1;
	} else if (opts.ringCount == null) {
		// Prefer more rings earlier so dense hubs don't pack leaves into one clump.
		if (childCount > 160) ringCount = 8;
		else if (childCount > 100) ringCount = 7;
		else if (childCount > 60) ringCount = 6;
		else if (childCount > 36) ringCount = 5;
		else if (childCount > 22) ringCount = 4;
		else if (childCount > 12) ringCount = 3;
		else if (childCount > 7) ringCount = 2;
		else ringCount = 1;
	}

	const perRing = Math.max(1, Math.ceil(childCount / ringCount));
	// Radius from arc length: 2πr / n >= arcPad  =>  r >= n * arcPad / 2π
	const fromArc = (perRing * arcPad) / (Math.PI * 2);
	const base = Math.max(minClear, fromArc, 360);
	const ring = Math.max(0, opts.ringIndex ?? 0);
	const ringStep = Math.max(childSize * 3.1 + 56, 130 + Math.min(110, Math.sqrt(childCount) * 12));

	// Revert to original dense layout from finra-data-chart-next-02
	return { radius: base + ring * ringStep, ringCount };
}

/** Outer orbit radius for a hub (used for hub-to-hub packing). */
function outerOrbitRadius(opts: { hubType: string; childCount: number; ringCount?: number; preferSingleRing?: boolean }): number {
	const { radius, ringCount } = orbitRadiusForHub({
		hubType: opts.hubType,
		childCount: opts.childCount,
		ringIndex: Math.max(0, (opts.ringCount ?? orbitRadiusForHub({ hubType: opts.hubType, childCount: opts.childCount, preferSingleRing: opts.preferSingleRing }).ringCount) - 1),
		ringCount: opts.ringCount,
		preferSingleRing: opts.preferSingleRing,
	});
	// Leaf body + small margin so neighboring orbits don't kiss.
	const leaf = opts.hubType === 'firm' ? INDIVIDUAL_NODE_SIZE : FIRM_NODE_SIZE;
	return radius + leaf * 0.65;
}

/**
 * Deterministic angular slot for a newly expanded hub around the local cluster,
 * so successive expands fan out instead of stacking on the same baked coordinates.
 */
function packNewHubAwayFromOthers(hubX: number, hubY: number, myOuter: number, others: Array<{ x: number; y: number; r: number }>, hubId: string): { x: number; y: number } {
	if (!others.length) return { x: hubX, y: hubY };

	let px = hubX;
	let py = hubY;
	// Strong iterative separation: push fully clear of every other orbit.
	for (let iter = 0; iter < 28; iter++) {
		let moved = false;
		for (const o of others) {
			let dx = px - o.x;
			let dy = py - o.y;
			let dist = Math.hypot(dx, dy);
			const need = myOuter + o.r + ORBIT_HUB_GAP;
			if (dist >= need) continue;
			if (dist < 1e-3) {
				const ang = ((hashString(`${hubId}|${o.x},${o.y}`) % 1000) / 999) * Math.PI * 2;
				dx = Math.cos(ang);
				dy = Math.sin(ang);
				dist = 1;
			}
			const push = (need - dist) * 1.05;
			px += (dx / dist) * push;
			py += (dy / dist) * push;
			moved = true;
		}
		if (!moved) break;
	}

	// If still colliding (pathological pile), park on a free angular slot around centroid.
	let stillHit = false;
	for (const o of others) {
		const need = myOuter + o.r + ORBIT_HUB_GAP;
		if (Math.hypot(px - o.x, py - o.y) < need) {
			stillHit = true;
			break;
		}
	}
	if (stillHit) {
		let cx = 0;
		let cy = 0;
		for (const o of others) {
			cx += o.x;
			cy += o.y;
		}
		cx /= others.length;
		cy /= others.length;
		const baseAng = ((hashString(hubId) % 1000) / 999) * Math.PI * 2;
		let best = { x: px, y: py, score: -Infinity };
		for (let k = 0; k < 24; k++) {
			const ang = baseAng + (k / 24) * Math.PI * 2;
			// Radius grows until clear of all others.
			let rad = myOuter + ORBIT_HUB_GAP;
			for (const o of others) {
				rad = Math.max(rad, Math.hypot(o.x - cx, o.y - cy) + o.r + myOuter + ORBIT_HUB_GAP);
			}
			const tx = cx + Math.cos(ang) * rad;
			const ty = cy + Math.sin(ang) * rad;
			let minClear = Infinity;
			for (const o of others) {
				const need = myOuter + o.r + ORBIT_HUB_GAP;
				minClear = Math.min(minClear, Math.hypot(tx - o.x, ty - o.y) - need);
			}
			if (minClear > best.score) best = { x: tx, y: ty, score: minClear };
			if (minClear >= 0) break;
		}
		px = best.x;
		py = best.y;
	}
	return { x: px, y: py };
}

/** Gap between outer edges of two expanded hub orbits.
 *  Large enough that rings don't interpenetrate; small enough clusters stay nearby. */
const ORBIT_HUB_GAP = Math.max(220, FIRM_NODE_SIZE * 14);

/** Stamp display sizes onto layout nodes once (collision uses node size). */
function bakeDisplaySizes(payload: LayoutPayload): LayoutPayload {
	for (const n of payload.nodes) {
		n.size = dynamicNodeSize(Number(n.degree) || 1, String(n.type || 'unknown'));
	}
	return payload;
}

function edgeBaseSize(weight?: number, grayDashed = false): number {
	const w = Number(weight) || 1;
	// Previous/inactive dashed links stay slightly thinner, but still clearly visible.
	if (grayDashed) return Math.min(1.4, 0.8 + w * 0.04);
	return Math.min(1.6, 1.0 + w * 0.05);
}

/**
 * Line colors from finra-data-chart-next-02 reference:
 * - current employment (both ends active): blue employed line
 * - previous employment OR either endpoint inactive: full red line
 */
const CURRENT_EDGE_COLOR = '#3b82f6'; // solid hex — floatColor-safe
const GRAY_DASHED_EDGE_COLOR = 'rgba(156, 163, 175, 0.45)'; // Light gray with opacity

function edgeColor(opts: { previous?: boolean; inactiveEndpoint?: boolean; isDimmed?: boolean }): string {
	const gray = Boolean(opts.previous || opts.inactiveEndpoint);
	if (gray) return opts.isDimmed ? 'rgba(156, 163, 175, 0.15)' : GRAY_DASHED_EDGE_COLOR;
	return opts.isDimmed ? 'rgba(59, 130, 246, 0.15)' : CURRENT_EDGE_COLOR;
}

/** Selected hub spoke — brighter blue (current) / stronger gray (previous). */
const SELECTED_EDGE_COLOR = '#60a5fa';
const SELECTED_PREV_EDGE_COLOR = 'rgba(156, 163, 175, 0.8)';
/** Screen-pixel thickness for selected hub→child spokes. */
const SELECTED_EDGE_SIZE = 1.6;
const SELECTED_EDGE_SIZE_MAX = 2.4;
const SELECTED_PREV_EDGE_SIZE = 1.4;
const SELECTED_PREV_EDGE_SIZE_MAX = 2.0;

/**
 * Global network map: WebGL via Sigma + graphology, positions precomputed offline.
 * Routes mirror ego graph / dashboard:
 *   /chart
 *   /chart/individual/<crd>
 *   /chart/firm/<crd>
 */
export default function GlobalGraphPage() {
	const router = useRouter();
	const containerRef = useRef<HTMLDivElement>(null);
	const sigmaRef = useRef<Sigma | null>(null);
	const graphRef = useRef<Graph | null>(null);
	const focusedIdRef = useRef<string | null>(null);
	const pinnedIdRef = useRef<string | null>(null);
	/** Multi-select set — previous selections stay until Clear Highlight. */
	const selectedIdsRef = useRef<Set<string>>(new Set());
	/** Visited/Revealed set — persists until the session is fully reset. */
	const visitedIdsRef = useRef<Set<string>>(new Set());
	const hoverIdRef = useRef<string | null>(null);
	const cameraPinUnlockRef = useRef<(() => void) | null>(null);
	/** Last URL entity we applied or wrote — avoids replace loops. */
	const lastRouteKeyRef = useRef<string | null>(null);
	/** Last deep-link key we successfully added+focused on canvas. */
	const appliedRouteKeyRef = useRef<string | null>(null);
	const routeBootstrapDoneRef = useRef(false);
	/** Only auto-open last dashboard CRD once per map mount (not after Clear). */
	const lastSelectionAutoOpenDoneRef = useRef(false);

	// /chart/individual/5567605  (same shape as /graph/... and /individual/...)
	// Prefer query.params; fall back to asPath so hard-refresh deep links work before
	// Next finishes hydrating dynamic route segments.
	const routeParams = useMemo(() => {
		const fromParts = (parts: string[]) => {
			const type =
				parts[0] === 'firm' ? 'firm'
				: parts[0] === 'individual' ? 'individual'
				: null;
			const crd = parts[1] && /^\d+$/.test(parts[1]) ? parts[1] : null;
			return type && crd ? { type: type as 'individual' | 'firm', crd } : null;
		};
		const raw = (router.query as { params?: string | string[] }).params;
		const queryParts =
			Array.isArray(raw) ? raw
			: typeof raw === 'string' ? [raw]
			: [];
		const fromQuery = fromParts(queryParts);
		if (fromQuery) return fromQuery;
		const path = String(router.asPath || '')
			.split('?')[0]
			.split('#')[0];
		const m = path.match(/^\/chart\/(individual|firm)\/(\d+)\/?$/i);
		if (m) return { type: m[1].toLowerCase() as 'individual' | 'firm', crd: m[2] };
		return null;
	}, [router.query, router.asPath]);

	const [status, setStatus] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading');
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const [stats, setStats] = useState<LayoutPayload['stats'] | null>(null);
	const [generatedAt, setGeneratedAt] = useState<string | null>(null);
	const [hover, setHover] = useState<HoverInfo | null>(null);
	const [focus, setFocus] = useState<FocusInfo | null>(null);
	/** Drives Clear Highlight enablement for multi-select (ref alone doesn't re-render). */
	const [selectionCount, setSelectionCount] = useState(0);
	const [query, setQuery] = useState('');
	const [lodHint, setLodHint] = useState('blank · search to add');
	const [visibleCount, setVisibleCount] = useState(0);
	const [theme, setTheme] = useState<'dark' | 'light'>('dark');
	const [toolbarMinimized, setToolbarMinimized] = useState(false);
	const [drawerOpen, setDrawerOpen] = useState(false);
	/** Synchronous mirror of drawerOpen for camera math (avoids stale closures in useCallback). */
	const drawerOpenRef = useRef(false);
	useEffect(() => {
		drawerOpenRef.current = drawerOpen;
	}, [drawerOpen]);
	const [searchLoading, setSearchLoading] = useState(false);
	const [searchBanner, setSearchBanner] = useState<{ query: string; count: number } | null>(null);
	/** Same name-search path as dashboard bottom panel (`useLocalNameSearch` → `/api/local-name-search`). */
	const { search: searchRedisNames, setQuery: setNameSearchQuery } = useLocalNameSearch();
	const [panelSnapshot, setPanelSnapshot] = useState<{
		key: string;
		resolvedKey: string;
		detailJson: string | null;
		loading: boolean;
		error: string;
	} | null>(null);
	const { selectionLog, setSelectionLog, clearSelectionLog } = useSelectionLog();
	const panelRequestRef = useRef(0);
	const lastLoggedFocusIdRef = useRef<string | null>(null);
	const { cache, setSnapshot, clear: clearSharedCache } = useSharedGraphState();
	/** All edge types stay on — UI edge filters removed. */
	const edgeTypesEnabledRef = useRef<Record<EdgeTypeKey, boolean>>({
		employment: true,
		firm_link: true,
		ownership: true,
		location: true,
		succession: true,
		other: true,
	});
	const layoutRef = useRef<LayoutPayload | null>(null);
	const nodeIndexRef = useRef<Map<string, LayoutNode>>(new Map());
	const edgesByNodeRef = useRef<Map<string, LayoutEdge[]>>(new Map());
	const visibleIdsRef = useRef<Set<string>>(new Set());
	/**
	 * Ego focus mode (parity with /graph individual view):
	 * - person-firms: only person↔firm employment spokes (no employer clique / firm_link mesh)
	 * - firm-star: only firm↔direct-neighbor spokes when firm is expanded alone
	 * null: progressive global map — any edge between visible nodes may paint
	 */
	const egoModeRef = useRef<null | { hubId: string; kind: 'person-firms' | 'firm-star' }>(null);
	const addNodeToCanvasRef = useRef<(nodeId: string, opts?: { withNeighbors?: boolean | 'firms' | 'all' | 'none'; neighborLimit?: number }) => boolean>(() => false);
	const focusNodeRef = useRef<
		(
			nodeId: string,
			opts?: {
				openEgo?: boolean;
				animate?: boolean;
				addIfMissing?: boolean;
				syncUrl?: boolean;
				withNeighbors?: boolean | 'firms' | 'all' | 'none';
				fetchExpand?: boolean;
				typeHint?: 'firm' | 'individual';
			},
		) => boolean
	>(() => false);
	const clearFocusRef = useRef<() => void>(() => undefined);
	const applyHighlightRef = useRef<() => void>(() => undefined);

	const syncGlobalRoute = useCallback(
		(type: 'individual' | 'firm' | null, crd: string | null) => {
			if (!router.isReady) return;
			if (type && crd) {
				const key = `${type}:${crd}`;
				if (lastRouteKeyRef.current === key) return;
				lastRouteKeyRef.current = key;
				const as = `/chart/${type}/${crd}`;
				void router.replace({ pathname: '/chart/[[...params]]', query: { params: [type, crd] } }, as, { shallow: true });
				return;
			}
			if (lastRouteKeyRef.current === null || lastRouteKeyRef.current === '') return;
			lastRouteKeyRef.current = null;
			void router.replace({ pathname: '/chart/[[...params]]', query: {} }, '/chart', {
				shallow: true,
			});
		},
		[router],
	);
	/** Camera LOD label only — edges stay visible at every zoom (user preference). */
	const edgeLodModeRef = useRef<'overview' | 'mid' | 'detail' | 'focus'>('detail');
	const edgeLodIndexRef = useRef(0);

	const labelPointerCleanupRef = useRef<(() => void) | null>(null);

	const destroySigma = useCallback(() => {
		if (globalLayoutAnimId !== null) {
			globalLayoutAnimId.stop();
			globalLayoutAnimId = null;
		}
		if (cameraPinUnlockRef.current) {
			try {
				cameraPinUnlockRef.current();
			} catch {
				// ignore
			}
			cameraPinUnlockRef.current = null;
		}
		if (labelPointerCleanupRef.current) {
			try {
				labelPointerCleanupRef.current();
			} catch {
				// ignore
			}
			labelPointerCleanupRef.current = null;
		}
		labelHitBoxesRef.current = [];
		if (sigmaRef.current) {
			try {
				sigmaRef.current.kill();
			} catch {
				// ignore
			}
			sigmaRef.current = null;
		}
		graphRef.current = null;
		// Keep focusedIdRef/pinnedIdRef so type-filter remounts can restore pin + camera.
		hoverIdRef.current = null;
	}, []);

	const applyHighlight = useCallback(() => {
		const graph = graphRef.current;
		const sigma = sigmaRef.current;
		if (!graph || !sigma) return;

		const focusId = focusedIdRef.current;
		const hoverId = hoverIdRef.current;
		const selected = selectedIdsRef.current;
		const visited = visitedIdsRef.current;

		// Stable selection hubs (multi-select + primary focus). Hover is separate so
		// mousing a firm doesn't light every employee while a child is selected.
		const selectedHubIds = new Set<string>();
		for (const id of selected) {
			if (graph.hasNode(id)) selectedHubIds.add(id);
		}
		if (focusId && graph.hasNode(focusId)) selectedHubIds.add(focusId);

		const selectedIndividuals = new Set<string>();
		for (const id of selectedHubIds) {
			const t = String(graph.getNodeAttribute(id, 'nodeType') || '');
			if (t !== 'firm') selectedIndividuals.add(id);
		}

		/** Previous/former edge (still drawn; firm-alone focus lights them too). */
		const isPreviousEdge = (attrs: Record<string, unknown>): boolean => {
			if (attrs.isCurrent === false || attrs.inactive === true) return true;
			const edgeType = String(attrs.edgeType || attrs.type || '');
			if (/previous|former|prior/i.test(edgeType)) return true;
			const detail = String(attrs.detail || attrs.label || attrs.edgeLabel || attrs.relationship || '');
			return /previous|former|prior|terminated/i.test(detail) && !/current/i.test(detail);
		};

		/**
		 * Fully disabled edges (never emphasize). Previous edges are *not* disabled —
		 * firm deep-links / firm-alone selection reveal current + previous spokes.
		 */
		const isDisabledEdge = (attrs: Record<string, unknown>, _source: string, _target: string): boolean => {
			if (attrs.disabled === true) return true;
			// previous edges: allowed (styled separately when emphasized)
			if (isPreviousEdge(attrs)) return false;
			const detail = String(attrs.detail || attrs.label || attrs.edgeLabel || attrs.relationship || '');
			if (/disabled/i.test(detail) && !/current/i.test(detail)) return true;
			return false;
		};

		/** Firm-only selection (no selected individuals) → full direct star including previous. */
		const firmAloneSelection =
			selectedHubIds.size > 0 && selectedIndividuals.size === 0 && [...selectedHubIds].every((id) => String(graph.getNodeAttribute(id, 'nodeType') || '') === 'firm');

		/**
		 * Child (individual) selected → only that node + edges to its parent(s).
		 * Firm selected alone → all firm→child spokes (current + previous).
		 * Firm + some children selected → only spokes to those selected children
		 * (never light sibling employees off the parent).
		 */
		const isEmphasizedEdge = (source: string, target: string, attrs?: Record<string, unknown>): boolean => {
			if (attrs && isDisabledEdge(attrs, source, target)) return false;
			const srcSel = selectedHubIds.has(source);
			const tgtSel = selectedHubIds.has(target);
			const previous = Boolean(attrs && isPreviousEdge(attrs));

			if (!srcSel && !tgtSel) {
				// Hover preview: edges incident to the hovered node (incl. previous).
				if (hoverId && (source === hoverId || target === hoverId)) return true;
				return false;
			}

			// Previous edges: only emphasize for firm-alone selection, both ends
			// selected, or hover (handled above). Avoid red-lighting them when a
			// person is the hub unless that edge is the person's own link.
			if (previous && !firmAloneSelection && !(srcSel && tgtSel)) {
				const hub = srcSel ? source : target;
				const hubType = String(graph.getNodeAttribute(hub, 'nodeType') || '');
				// Person hub may still show previous employers (direct).
				if (hubType === 'firm' && selectedIndividuals.size > 0) return false;
			}

			// Edge between two selected hubs always counts.
			if (srcSel && tgtSel) return true;

			const hub = srcSel ? source : target;
			const other = srcSel ? target : source;
			const hubType = String(graph.getNodeAttribute(hub, 'nodeType') || '');

			// Individual hub: every direct edge (to parent firm / other employers).
			if (hubType !== 'firm') return true;

			// Firm hub: if any individuals are selected, only keep edges to those
			// selected children — do not fan out to every employee on the firm.
			if (selectedIndividuals.size > 0) return selectedIndividuals.has(other);

			// Firm-only selection: full star of direct spokes (current + previous).
			return true;
		};

		const hasSelectionOrHover = selectedHubIds.size > 0 || Boolean(hoverId && graph.hasNode(hoverId));
		const enabled = edgeTypesEnabledRef.current;

		const darkenHex = (c: string) => {
			if (!c.startsWith('#') || (c.length !== 7 && c.length !== 4)) return '#334155';
			const hex = c.length === 4 ? '#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3] : c;
			const r = Math.floor(parseInt(hex.slice(1, 3), 16) * 0.45);
			const g = Math.floor(parseInt(hex.slice(3, 5), 16) * 0.45);
			const b = Math.floor(parseInt(hex.slice(5, 7), 16) * 0.45);
			return `rgb(${r},${g},${b})`;
		};

		// Node states:
		// - selected (active click / multi-select): amber fill + amber ring
		// - revealed (connections expanded at least once): type-shifted fill + teal/violet ring
		// - unrevealed: default type colors, no ring
		// Never overwrite typeBaseColor with selection tint (keeps deselect correct).
		graph.forEachNode((node, attrs) => {
			const inactive = attrs.inactive === true;
			const nodeType = String(attrs.nodeType || 'unknown');
			const typeBase = typeof attrs.typeBaseColor === 'string' && attrs.typeBaseColor ? String(attrs.typeBaseColor) : nodeTypeBaseColor(nodeType, inactive);

			const isSelected = selected.has(node) || node === focusId;
			const isRevealed = visited.has(node) || attrs.revealed === true;
			const isHoverCenter = node === hoverId;
			const highlight = isSelected || isHoverCenter || isRevealed;

			const displayColor = nodeStateColor({
				type: nodeType,
				inactive,
				selected: isSelected,
				revealed: isRevealed && !isSelected,
			});

			graph.setNodeAttribute(node, 'type', nodeRenderType(nodeType));
			graph.setNodeAttribute(node, 'typeBaseColor', typeBase);
			// baseColor = stable type color (never selection amber) for unlock/restore paths.
			graph.setNodeAttribute(node, 'baseColor', typeBase);
			graph.setNodeAttribute(node, 'color', displayColor);
			graph.setNodeAttribute(node, 'highlighted', isSelected);
			graph.setNodeAttribute(node, 'revealed', isRevealed);
			graph.setNodeAttribute(
				node,
				'zIndex',
				isSelected ? 5
				: isHoverCenter ? 4
				: isRevealed ? 3
				: 2,
			);
			graph.setNodeAttribute(node, 'forceLabel', highlight || graph.degree(node) > 8);
			graph.setNodeAttribute(node, 'pinned', isSelected);
		});

		// Edges: keep the full map lit. Selection thickens hub spokes (current + previous).
		// Reference (finra-data-chart-next-02): previous OR inactive-endpoint links are
		// gray dashed for the FULL length (even when the other end is active).
		// Person hubs often have only previous employers — those must still read clearly.
		graph.forEachEdge((edge, attrs, source, target) => {
			const et = normalizeEdgeType(String(attrs.edgeType || ''));
			const typeOn = enabled[et] !== false && !attrs.filterHidden && !attrs.typeHidden;
			if (!typeOn) {
				graph.setEdgeAttribute(edge, 'hidden', true);
				return;
			}

			const attrsRec = attrs as Record<string, unknown>;
			const previous = isPreviousEdge(attrsRec);
			const srcInactive = graph.getNodeAttribute(source, 'inactive') === true;
			const tgtInactive = graph.getNodeAttribute(target, 'inactive') === true;
			const inactiveEndpoint = srcInactive || tgtInactive;
			// Gray dashed whenever previous OR either endpoint is inactive.
			const grayDashed = previous || inactiveEndpoint;
			// Always recompute base size so older thin values get upgraded.
			const baseSize = edgeBaseSize(Number(attrs.weight), grayDashed);
			const disabled = isDisabledEdge(attrsRec, source, target);
			const emphasized = hasSelectionOrHover && !disabled && isEmphasizedEdge(source, target, attrsRec);

			// Always keep type-enabled edges visible (no hide/dim of background lines).
			graph.setEdgeAttribute(edge, 'hidden', false);

			if (emphasized) {
				const weightBoost = Math.min(1.25, 1 + (Number(attrs.weight) || 1) * 0.03);
				if (grayDashed) {
					// Previous / inactive endpoint: thicker gray dashed so person stars stay readable.
					const spokeSize = Math.min(SELECTED_PREV_EDGE_SIZE_MAX, SELECTED_PREV_EDGE_SIZE * weightBoost);
					graph.setEdgeAttribute(edge, 'type', 'dashed');
					graph.setEdgeAttribute(edge, 'color', SELECTED_PREV_EDGE_COLOR);
					graph.setEdgeAttribute(edge, 'zIndex', -1);
					graph.setEdgeAttribute(edge, 'size', spokeSize);
					graph.setEdgeAttribute(edge, 'baseSize', baseSize);
					return;
				}
				const spokeSize = Math.min(SELECTED_EDGE_SIZE_MAX, SELECTED_EDGE_SIZE * weightBoost);
				graph.setEdgeAttribute(edge, 'type', 'line');
				graph.setEdgeAttribute(edge, 'color', SELECTED_EDGE_COLOR);
				graph.setEdgeAttribute(edge, 'zIndex', -1);
				graph.setEdgeAttribute(edge, 'size', spokeSize);
				graph.setEdgeAttribute(edge, 'baseSize', baseSize);
				return;
			}

			// Base style: blue solid for active current; gray dashed full edge otherwise.
			graph.setEdgeAttribute(edge, 'type', grayDashed ? 'dashed' : 'line');
			graph.setEdgeAttribute(edge, 'color', edgeColor({ previous, inactiveEndpoint, isDimmed: false }));
			graph.setEdgeAttribute(edge, 'zIndex', grayDashed ? -3 : -2);
			graph.setEdgeAttribute(edge, 'size', baseSize);
			graph.setEdgeAttribute(edge, 'baseSize', baseSize);
		});

		void darkenHex;

		sigma.refresh();
	}, []);

	const unlockPinnedNode = useCallback((nodeId: string | null) => {
		const graph = graphRef.current;
		if (!graph || !nodeId || !graph.hasNode(nodeId)) return;
		try {
			// Keep multi-selected nodes pinned until Clear Highlight.
			if (selectedIdsRef.current.has(nodeId)) {
				graph.setNodeAttribute(nodeId, 'pinned', true);
				return;
			}
			graph.setNodeAttribute(nodeId, 'pinned', false);
			// Restore type/revealed color if highlight isn't about to repaint.
			const attrs = graph.getNodeAttributes(nodeId);
			const nodeType = String(attrs.nodeType || 'unknown');
			const inactive = attrs.inactive === true;
			const revealed = visitedIdsRef.current.has(nodeId) || attrs.revealed === true;
			const color = nodeStateColor({ type: nodeType, inactive, selected: false, revealed });
			if (focusedIdRef.current !== nodeId && hoverIdRef.current !== nodeId && !selectedIdsRef.current.has(nodeId)) {
				graph.setNodeAttribute(nodeId, 'color', color);
				graph.setNodeAttribute(nodeId, 'zIndex', revealed ? 3 : 2);
				graph.setNodeAttribute(nodeId, 'forceLabel', revealed || graph.degree(nodeId) > 8);
				graph.setNodeAttribute(nodeId, 'highlighted', false);
				graph.setNodeAttribute(nodeId, 'revealed', revealed);
			}
		} catch {
			// ignore
		}
	}, []);

	const attachCameraPin = useCallback((nodeId: string, opts?: { animate?: boolean; fitRatio?: boolean }) => {
		const sigma = sigmaRef.current;
		if (!sigma) return;
		// Drop previous camera lock (previous selection unlocks).
		if (cameraPinUnlockRef.current) {
			try {
				cameraPinUnlockRef.current();
			} catch {
				// ignore
			}
			cameraPinUnlockRef.current = null;
		}

		const camera = sigma.getCamera();
		let suppressing = false;
		let animating = false;
		let disposed = false;
		const retryTimers: number[] = [];
		const doAnimate = opts?.animate !== false;
		// Never change zoom on selection unless an explicit caller opts in.
		const fitRatio = opts?.fitRatio === true;

		const readGraphPos = (s: Sigma, id: string) => {
			const g = s.getGraph();
			if (!g.hasNode(id)) return null;
			return {
				x: Number(g.getNodeAttribute(id, 'x')) || 0,
				y: Number(g.getNodeAttribute(id, 'y')) || 0,
			};
		};

		/**
		 * Sigma camera x/y live in *framed* (normalized) graph space — NOT raw node x/y.
		 * Feeding raw layout coords (thousands) flings the whole graph off-screen.
		 */
		const framedPosOf = (s: Sigma, id: string): { x: number; y: number } | null => {
			const pos = readGraphPos(s, id);
			if (!pos) return null;
			try {
				const vp = s.graphToViewport(pos);
				const framed = s.viewportToFramedGraph(vp);
				if (Number.isFinite(framed.x) && Number.isFinite(framed.y)) return { x: framed.x, y: framed.y };
			} catch {
				// fall through
			}
			// Node display data is already in framed space after indexation.
			const display = s.getNodeDisplayData(id);
			if (display && Number.isFinite(display.x) && Number.isFinite(display.y)) {
				return { x: display.x, y: display.y };
			}
			return null;
		};

		const viewportOfPinned = (s: Sigma): { x: number; y: number } | null => {
			const pos = readGraphPos(s, nodeId);
			if (!pos) return null;
			try {
				const vp = s.graphToViewport(pos);
				if (vp && Number.isFinite(vp.x) && Number.isFinite(vp.y)) return vp;
			} catch {
				// ignore
			}
			return null;
		};

		const desiredRatio = (current: number) => {
			if (!fitRatio) return current;
			// Opt-in only: Sigma smaller ratio = closer.
			let next = current;
			if (!Number.isFinite(next) || next <= 0) next = 0.35;
			if (next > 0.85) next = 0.35;
			else if (next > 0.6) next = 0.45;
			if (next < 0.04) next = 0.04;
			return next;
		};

		/** Half the open detail-drawer width (see `.node-detail-drawer { width: 410px }`),
		 *  plus a small buffer. The drawer auto-opens on focus and permanently occupies
		 *  the right edge of the canvas; newly expanded neighbor orbits land all around
		 *  the pinned hub, so anything centered dead-center of the *full* canvas can end
		 *  up rendered directly behind (and hidden by) that panel. */
		const drawerShiftPx = () => (drawerOpenRef.current ? 235 : 0);

		/** Same as framedPosOf, but treats the hub as sitting `shiftPx` to the right of
		 * true viewport center — reserving that much room on-screen for the drawer. */
		const framedPosOfShifted = (s: Sigma, id: string, shiftPx: number): { x: number; y: number } | null => {
			const pos = readGraphPos(s, id);
			if (!pos || !shiftPx) return framedPosOf(s, id);
			try {
				const vp = s.graphToViewport(pos);
				const framed = s.viewportToFramedGraph({ x: vp.x + shiftPx, y: vp.y });
				if (Number.isFinite(framed.x) && Number.isFinite(framed.y)) return { x: framed.x, y: framed.y };
			} catch {
				// fall through
			}
			return framedPosOf(s, id);
		};

		const centerOnPinned = (animate: boolean) => {
			const s = sigmaRef.current;
			if (disposed || !s || pinnedIdRef.current !== nodeId) return;
			try {
				s.refresh({ skipIndexation: false, schedule: false });
			} catch {
				// ignore
			}
			const framed = framedPosOfShifted(s, nodeId, drawerShiftPx());
			if (!framed) return;
			const cam = s.getCamera();
			const state = cam.getState();
			// Preserve current zoom (ratio) on selection — pan only.
			const next = {
				x: framed.x,
				y: framed.y,
				ratio: desiredRatio(state.ratio),
				angle: state.angle || 0,
			};
			if (Math.abs(state.x - next.x) < 1e-7 && Math.abs(state.y - next.y) < 1e-7 && Math.abs(state.ratio - next.ratio) < 1e-7) {
				return;
			}
			suppressing = true;
			if (animate) {
				animating = true;
				// Snappy pan (was a 14s linear glide — read as "nodes still drifting" and
				// only visibly stopped when a zoom action canceled it). Freeze quickly instead.
				cam.animate(next, { duration: 900, easing: 'quadraticOut' }, () => {
					animating = false;
					suppressing = false;
				});
				// Hard failsafe: guarantee the camera lands exactly on target and fully
				// stops, even if the tween gets interrupted/cancelled elsewhere.
				window.setTimeout(() => {
					if (disposed || pinnedIdRef.current !== nodeId) return;
					try {
						cam.setState(next);
					} catch {
						// ignore
					}
					animating = false;
					suppressing = false;
				}, 1000);
			} else {
				cam.setState(next);
				requestAnimationFrame(() => {
					suppressing = false;
				});
			}
		};

		/** Soft clamp only when the hub left the padded viewport (framed coords). */
		const keepPinnedInView = (forceCenter = false) => {
			const s = sigmaRef.current;
			if (disposed || !s || suppressing || animating || pinnedIdRef.current !== nodeId) return;
			try {
				if (s.getCamera().isAnimated()) return;
			} catch {
				// ignore
			}
			const dims = s.getDimensions();
			if (!dims.width || !dims.height) return;

			const vp = viewportOfPinned(s);
			const shiftPx = drawerShiftPx();
			const framed = framedPosOfShifted(s, nodeId, shiftPx);
			if (!framed) return;

			const marginX = Math.max(48, dims.width * 0.1);
			const marginY = Math.max(48, dims.height * 0.1);
			// Treat the drawer-occupied strip as outside the usable viewport too.
			const rightBound = dims.width - marginX - shiftPx;
			const out = forceCenter || !vp || vp.x < marginX || vp.x > rightBound || vp.y < marginY || vp.y > dims.height - marginY;
			if (!out) return;

			const cam = s.getCamera();
			const state = cam.getState();
			suppressing = true;
			cam.setState({ x: framed.x, y: framed.y, ratio: state.ratio, angle: state.angle || 0 });
			requestAnimationFrame(() => {
				suppressing = false;
			});
		};

		const onCameraUpdated = () => {
			if (suppressing || animating) return;
			// Removed keepPinnedInView on pan to allow free dragging
		};

		// Initial center + short retries (indexation can lag one frame after add).
		centerOnPinned(doAnimate);
		for (const ms of [60, 200]) {
			const t = window.setTimeout(() => {
				if (disposed || pinnedIdRef.current !== nodeId) return;
				centerOnPinned(false);
			}, ms);
			retryTimers.push(t);
		}

		const onResize = () => {
			if (disposed) return;
			keepPinnedInView(true);
		};
		window.addEventListener('resize', onResize);

		cameraPinUnlockRef.current = () => {
			disposed = true;
			for (const t of retryTimers) window.clearTimeout(t);
			window.removeEventListener('resize', onResize);
			try {
				const camAny = camera as unknown as { removeListener?: Function; off?: Function };
				if (typeof camAny.removeListener === 'function') camAny.removeListener('updated', onCameraUpdated);
				else if (typeof camAny.off === 'function') camAny.off('updated', onCameraUpdated);
			} catch {
				// ignore
			}
			animating = false;
			suppressing = false;
		};
	}, []);

	const ensureNodeOnGraph = useCallback((n: LayoutNode, pos?: { x: number; y: number }): boolean => {
		const graph = graphRef.current;
		if (!graph) return false;

		const inactive = Boolean(n.inactive);
		const finalColor = nodeDisplayColor(n.type, inactive);
		const size = dynamicNodeSize(Number(n.degree) || 1, n.type);

		if (graph.hasNode(n.id)) {
			// Refresh label/inactive/type when expand or deep-link hydrates metadata.
			if (n.label) graph.setNodeAttribute(n.id, 'label', n.label);
			graph.setNodeAttribute(n.id, 'type', nodeRenderType(n.type));
			graph.setNodeAttribute(n.id, 'nodeType', n.type);
			const revealed = visitedIdsRef.current.has(n.id) || graph.getNodeAttribute(n.id, 'revealed') === true;
			const selected = selectedIdsRef.current.has(n.id) || focusedIdRef.current === n.id;
			if (inactive) {
				graph.setNodeAttribute(n.id, 'inactive', true);
				graph.setNodeAttribute(n.id, 'typeBaseColor', INACTIVE_NODE_COLOR);
				graph.setNodeAttribute(n.id, 'baseColor', INACTIVE_NODE_COLOR);
				graph.setNodeAttribute(n.id, 'color', nodeStateColor({ type: n.type, inactive: true, selected, revealed }));
			} else if (graph.getNodeAttribute(n.id, 'inactive') !== true) {
				graph.setNodeAttribute(n.id, 'inactive', false);
				graph.setNodeAttribute(n.id, 'typeBaseColor', finalColor);
				graph.setNodeAttribute(n.id, 'baseColor', finalColor);
				graph.setNodeAttribute(n.id, 'color', nodeStateColor({ type: n.type, inactive: false, selected, revealed }));
			}
			if (typeof n.degree === 'number') graph.setNodeAttribute(n.id, 'degree', n.degree);
			visibleIdsRef.current.add(n.id);
			return false;
		}

		graph.addNode(n.id, {
			label: n.label,
			x: pos ? pos.x : n.x * LAYOUT_SPREAD,
			// Slight vertical compress on baked coords so the map opens wider than tall.
			y: pos ? pos.y : n.y * LAYOUT_SPREAD * 4,
			size,
			baseSize: size,
			type: nodeRenderType(n.type),
			color: finalColor,
			baseColor: finalColor,
			typeBaseColor: finalColor,
			nodeType: n.type,
			degree: n.degree,
			weight: n.weight ?? n.degree,
			region: n.region || '',
			regionGroup: n.regionGroup || '',
			brokerCount: n.brokerCount || 0,
			firmLinkCount: n.firmLinkCount || 0,
			cluster: n.cluster,
			inactive,
			zIndex: 2,
			forceLabel: false,
			pinned: false,
			highlighted: false,
			revealed: false,
		});
		visibleIdsRef.current.add(n.id);
		return true;
	}, []);

	/**
	 * Whether an edge may be drawn under the current ego / progressive policy.
	 * Person ego matches /graph: only hub employment spokes — never firm↔firm mesh.
	 */
	const edgeAllowedInEgo = useCallback((e: LayoutEdge, ego: { hubId: string; kind: 'person-firms' | 'firm-star' } | null): boolean => {
		if (!ego) return true;
		const touchesHub = e.source === ego.hubId || e.target === ego.hubId;
		if (!touchesHub) return false;
		const raw = String(e.type || 'employment').toLowerCase();
		if (ego.kind === 'person-firms') {
			// Employment / ownership / previous only — skip catalog firm_link / location chords.
			if (raw === 'firm_link' || raw === 'location' || raw === 'succession') return false;
			return true;
		}
		// firm-star: any direct spoke type (employees, owners, previous).
		return true;
	}, []);

	/** Drop non-spoke edges so a person focus can't keep a leftover firm clique. */
	const pruneEdgesToEgoSpokes = useCallback(
		(hubId: string, kind: 'person-firms' | 'firm-star') => {
			const graph = graphRef.current;
			if (!graph || !graph.hasNode(hubId)) return;
			const drop: string[] = [];
			graph.forEachEdge((edge, attrs, source, target) => {
				const fake: LayoutEdge = {
					id: edge,
					source,
					target,
					type: String(attrs.edgeType || attrs.type || 'employment'),
					weight: Number(attrs.weight) || 1,
				};
				if (!edgeAllowedInEgo(fake, { hubId, kind })) drop.push(edge);
			});
			for (const edge of drop) {
				try {
					graph.dropEdge(edge);
				} catch {
					// ignore
				}
			}
		},
		[edgeAllowedInEgo],
	);

	const ensureEdgeOnGraph = useCallback(
		(e: LayoutEdge): boolean => {
			const graph = graphRef.current;
			if (!graph) return false;
			if (!graph.hasNode(e.source) || !graph.hasNode(e.target)) return false;
			if (!edgeAllowedInEgo(e, egoModeRef.current)) return false;
			const isPrevious = layoutEdgeIsPrevious(e);
			const edgeType = isPrevious ? e.type || 'previous_employment' : e.type || 'employment';
			const srcInactive = graph.getNodeAttribute(e.source, 'inactive') === true;
			const tgtInactive = graph.getNodeAttribute(e.target, 'inactive') === true;
			const inactiveEndpoint = srcInactive || tgtInactive;
			// Full-length gray dashed if previous OR either end is inactive (reference rule).
			const grayDashed = isPrevious || inactiveEndpoint;
			const size = edgeBaseSize(e.weight, grayDashed);
			const applyAttrs = (edgeKey: string) => {
				graph.setEdgeAttribute(edgeKey, 'weight', e.weight);
				graph.setEdgeAttribute(edgeKey, 'edgeType', edgeType);
				graph.setEdgeAttribute(edgeKey, 'isCurrent', !isPrevious);
				graph.setEdgeAttribute(edgeKey, 'inactive', isPrevious);
				graph.setEdgeAttribute(edgeKey, 'type', grayDashed ? 'dashed' : 'line');
				graph.setEdgeAttribute(edgeKey, 'color', edgeColor({ previous: isPrevious, inactiveEndpoint, isDimmed: false }));
				graph.setEdgeAttribute(edgeKey, 'size', size);
				graph.setEdgeAttribute(edgeKey, 'baseSize', size);
			};
			// Single undirected edge per pair (layout + expand merges).
			if (graph.hasEdge(e.source, e.target) || graph.hasEdge(e.target, e.source)) {
				try {
					const existing = graph.hasEdge(e.source, e.target) ? graph.edge(e.source, e.target) : graph.edge(e.target, e.source);
					if (!existing) return false;
					const wasCurrent = graph.getEdgeAttribute(existing, 'isCurrent');
					// Expand previous / inactive-endpoint must overwrite catalog "employment" stubs.
					if (isPrevious || grayDashed || wasCurrent === undefined) {
						applyAttrs(existing);
					}
				} catch {
					// ignore
				}
				return false;
			}
			const enabled = edgeTypesEnabledRef.current;
			const et = normalizeEdgeType(edgeType);
			const edgeKey = e.id || `${e.source}:${e.target}:${edgeType}`;
			try {
				graph.addEdgeWithKey(edgeKey, e.source, e.target, {
					weight: e.weight,
					size,
					baseSize: size,
					// Gray dashed for previous or inactive endpoint; solid blue only for active current.
					type: grayDashed ? 'dashed' : 'line',
					color: edgeColor({ previous: isPrevious, inactiveEndpoint, isDimmed: false }),
					edgeType,
					isCurrent: !isPrevious,
					inactive: isPrevious,
					filterHidden: false,
					hidden: false,
					typeHidden: enabled[et] === false,
					zIndex: grayDashed ? -3 : -2,
				});
				return true;
			} catch {
				return false;
			}
		},
		[edgeAllowedInEgo],
	);

	/**
	 * Bare `/chart` test preload: paint curated CRDs + catalog edges among them.
	 * Uses a local spiral (not global bake coords) so camera fit stays on-screen.
	 */
	const seedPreloadIntoGraph = useCallback(
		(opts?: { cancelled?: () => boolean }): { nodesAdded: number; edgesAdded: number; missingFromCatalog: number } => {
			const cancelled = opts?.cancelled || (() => false);
			const graph = graphRef.current;
			const sigma = sigmaRef.current;
			const payload = layoutRef.current;
			if (!graph || !sigma || !payload || !CHART_USE_PRELOAD_SEEDS || CHART_PRELOAD_SEEDS.length === 0) {
				return { nodesAdded: 0, edgesAdded: 0, missingFromCatalog: 0 };
			}
			if (cancelled()) return { nodesAdded: 0, edgesAdded: 0, missingFromCatalog: 0 };

			egoModeRef.current = null;
			const nMap = nodeIndexRef.current;
			const seedSet = new Set(CHART_PRELOAD_SEEDS.map((s) => String(s.crd)));
			// Precompute neighbor sets among seeds from the catalog payload edges
			const seedNeighborMap = new Map<string, Set<string>>();
			for (const id of seedSet) seedNeighborMap.set(id, new Set<string>());
			for (const e of payload.edges || []) {
				const s = String(e.source);
				const t = String(e.target);
				if (seedSet.has(s) && t) seedNeighborMap.get(s)?.add(t);
				if (seedSet.has(t) && s) seedNeighborMap.get(t)?.add(s);
			}
			let nodesAdded = 0;
			let edgesAdded = 0;
			let missingFromCatalog = 0;
			const golden = 2.399963229728653;
			const ringStep = 28;

			CHART_PRELOAD_SEEDS.forEach((seed, i) => {
				const crd = String(seed.crd);
				const catalog = nMap.get(crd);
				const type = (catalog?.type === 'firm' || catalog?.type === 'individual' ? catalog.type : seed.type) as LayoutNode['type'];
				const catLabel = catalog?.label ? String(catalog.label).trim() : '';
				const label = (catLabel && !/^crd\s*\d+$/i.test(catLabel) && catLabel !== crd ? catLabel : null) || seed.label || crd;
				const degree = Math.max(1, Number(catalog?.degree) || 1);
				const angle = i * golden;
				const radius = ringStep * Math.sqrt(i + 1);
				// Compute weighting factors to give an "organic" spread:
				// - industryFactor: use industryDate proxy (older = stronger push)
				// - internalConn: how many connections this seed has to other seeds
				// - mutualPartners: shared-neighbor count with other seeds
				// - regionFactor: small bias for regionGroup to create clusters
				const seedId = String(seed.crd);
				const neighbors = seedNeighborMap.get(seedId) || new Set<string>();
				const internalConn = neighbors.size;
				let mutualPartners = 0;
				for (const otherId of seedSet) {
					if (otherId === seedId) continue;
					const otherNeighbors = seedNeighborMap.get(otherId) || new Set<string>();
					// intersection size
					for (const v of neighbors) if (otherNeighbors.has(v)) mutualPartners++;
				}
				// Normalize mutualPartners roughly by seed count so large seeds don't dominate
				mutualPartners = Math.round(mutualPartners / Math.max(1, CHART_PRELOAD_SEEDS.length / 40));
				const catalogIndustryDate = Number((catalog as any)?.industryDate || 0) || 0;
				// industryDate is usually a timestamp string; treat larger as more senior
				const industryFactor = catalogIndustryDate ? Math.min(1.6, 1 + Math.log10(1 + Math.abs(Date.now() - catalogIndustryDate)) * 0.0000000001) : 1;
				// regionGroup bias: small angular jitter per region so same-region seeds cluster
				const regionSeed = catalog?.regionGroup ? (hashString(String(catalog.regionGroup)) % 360) * (Math.PI / 180) : 0;
				// Combine into a single multiplier for radial spread
				const weightScore = 1 + Math.log1p(internalConn) * 0.28 + Math.log1p(mutualPartners) * 0.18 + (industryFactor - 1) * 0.6;
				const spreadMul = Math.max(1.2, Math.min(6, weightScore));

				const gx = Math.cos(angle + regionSeed) * radius * LAYOUT_SPREAD * spreadMul;
				const gy = Math.sin(angle + regionSeed) * radius * LAYOUT_SPREAD * 0.85 * spreadMul;
				const stub: LayoutNode = {
					id: crd,
					label,
					type,
					x: catalog && Number.isFinite(Number(catalog.x)) ? Number(catalog.x) : gx / LAYOUT_SPREAD,
					y: catalog && Number.isFinite(Number(catalog.y)) ? Number(catalog.y) : gy / (LAYOUT_SPREAD * 0.85),
					size: catalog?.size ?? 1,
					color: catalog?.color || nodeDisplayColor(type),
					degree,
					cluster: catalog?.cluster,
					region: catalog?.region,
					regionGroup: catalog?.regionGroup,
					brokerCount: catalog?.brokerCount,
					firmLinkCount: catalog?.firmLinkCount,
					// Store computed weight so downstream layout can use it.
					weight: Math.max(1, Math.round((catalog?.weight ?? degree) * spreadMul)),
					inactive: catalog?.inactive,
				};
				if (!catalog) {
					missingFromCatalog++;
					nMap.set(crd, stub);
				} else {
					catalog.label = label;
					if (catalog.type !== 'firm' && catalog.type !== 'individual') catalog.type = type;
					nMap.set(crd, catalog);
				}
				const meta = nMap.get(crd)!;
				if (ensureNodeOnGraph(meta, { x: gx, y: gy })) nodesAdded++;
			});

			for (const e of payload.edges || []) {
				const s = String(e.source);
				const t = String(e.target);
				if (!seedSet.has(s) || !seedSet.has(t)) continue;
				if (ensureEdgeOnGraph({ ...e, source: s, target: t })) edgesAdded++;
			}

			setVisibleCount(visibleIdsRef.current.size);
			setLodHint(`preload · ${visibleIdsRef.current.size} nodes · ${edgesAdded} edges` + (missingFromCatalog ? ` · ${missingFromCatalog} off-layout` : ''));

			if (graph.order >= 1 && !cancelled()) {
				try {
					if (graph.order >= 2) runFluidLayout(graph, sigma);
				} catch {
					// ignore
				}
				try {
					let minX = Infinity;
					let maxX = -Infinity;
					let minY = Infinity;
					let maxY = -Infinity;
					graph.forEachNode((_id, attrs) => {
						const x = Number(attrs.x);
						const y = Number(attrs.y);
						if (!Number.isFinite(x) || !Number.isFinite(y)) return;
						if (x < minX) minX = x;
						if (x > maxX) maxX = x;
						if (y < minY) minY = y;
						if (y > maxY) maxY = y;
					});
					if (Number.isFinite(minX) && Number.isFinite(maxX) && Number.isFinite(minY) && Number.isFinite(maxY)) {
						if (!(maxX > minX)) {
							minX -= 200;
							maxX += 200;
						}
						if (!(maxY > minY)) {
							minY -= 200;
							maxY += 200;
						}
						const cx = (minX + maxX) / 2;
						const cy = (minY + maxY) / 2;
						const dims = sigma.getDimensions();
						const w = Math.max(Number(dims.width) || 0, 800);
						const h = Math.max(Number(dims.height) || 0, 600);
						const ratio = 1.25;
						sigma.getCamera().setState({ x: cx, y: cy, ratio: ratio, angle: 0 });
						window.setTimeout(() => {
							try {
								if (cancelled() || sigmaRef.current !== sigma) return;
								const d2 = sigma.getDimensions();
								const w2 = Math.max(Number(d2.width) || 0, 1);
								const h2 = Math.max(Number(d2.height) || 0, 1);
								if (w2 < 2 || h2 < 2) return;
								const vpTL = sigma.graphToViewport({ x: minX, y: minY });
								const vpBR = sigma.graphToViewport({ x: maxX, y: maxY });
								const framed = sigma.viewportToFramedGraph(sigma.graphToViewport({ x: cx, y: cy }));
								const r2 = 1.25;
								sigma.getCamera().animate({ x: framed.x, y: framed.y, ratio: r2, angle: 0 }, { duration: 700, easing: 'quadraticInOut' });
								sigma.refresh();
							} catch {
								// ignore
							}
						}, 120);
					}
				} catch {
					// ignore camera fit
				}
			}

			applyHighlightRef.current();
			try {
				sigma.refresh();
			} catch {
				// ignore
			}
			return { nodesAdded, edgesAdded, missingFromCatalog };
		},
		[ensureEdgeOnGraph, ensureNodeOnGraph],
	);

	/**
	 * Neighbor policy (/graph expand-in-place):
	 * - person/individual → attached firm nodes (current + previous)
	 * - firm → full direct star (employees/owners + previous) unless caller forces 'none'
	 */
	const resolveNeighborMode = useCallback((seedType: string, withNeighbors?: boolean | 'firms' | 'all' | 'none'): 'none' | 'firms' | 'all' => {
		if (withNeighbors === 'none' || withNeighbors === false) return 'none';
		if (withNeighbors === 'firms') return 'firms';
		if (withNeighbors === 'all' || withNeighbors === true) return 'all';
		// Default by entity type when option omitted.
		return seedType === 'firm' ? 'all' : 'firms';
	}, []);

	/** Add a layout node (and optional 1-hop neighbors). Ego modes only draw hub spokes. */
	const addNodeToCanvas = useCallback(
		(nodeId: string, opts?: { withNeighbors?: boolean | 'firms' | 'all' | 'none'; neighborLimit?: number }) => {
			const graph = graphRef.current;
			const sigma = sigmaRef.current;
			const payload = layoutRef.current;
			if (!graph || !sigma || !payload) return false;
			const seed = nodeIndexRef.current.get(nodeId);
			if (!seed) return false;

			const neighborMode = resolveNeighborMode(seed.type, opts?.withNeighbors);
			// Person→firms star (left /graph): large firm ring. Firm-all: employee star.
			const neighborLimit =
				opts?.neighborLimit ??
				(neighborMode === 'firms' ? 160
				: neighborMode === 'all' ? 280
				: 48);
			let added = 0;
			const starEgoSeed = neighborMode === 'firms' && seed.type !== 'firm';
			const firmStarSeed = neighborMode === 'all' && seed.type === 'firm';

			// Ego policy for this paint (matches /graph individual: spokes only).
			if (starEgoSeed) egoModeRef.current = { hubId: nodeId, kind: 'person-firms' };
			else if (firmStarSeed) egoModeRef.current = { hubId: nodeId, kind: 'firm-star' };
			// Keep prior ego if adding unrelated progressive nodes while a hub is focused.
			else if (neighborMode === 'none' && egoModeRef.current?.hubId === nodeId) {
				// firm alone — still ego hub with no leaves yet
				egoModeRef.current = { hubId: nodeId, kind: 'firm-star' };
			}

			if (ensureNodeOnGraph(seed)) added++;

			if (neighborMode !== 'none') {
				const incident = edgesByNodeRef.current.get(nodeId) || [];
				const candidates: { id: string; weight: number; edge: LayoutEdge }[] = [];
				for (const e of incident) {
					const other = e.source === nodeId ? e.target : e.source;
					if (other === nodeId) continue;
					if (!edgeAllowedInEgo(e, egoModeRef.current)) continue;
					const meta = nodeIndexRef.current.get(other);
					if (!meta) continue;
					// Person fetch: only attach firm nodes. Firm+all: any neighbor type.
					if (neighborMode === 'firms' && meta.type !== 'firm') continue;
					candidates.push({ id: other, weight: e.weight || 1, edge: e });
				}
				// Prefer current employment over previous when ranking; stable by id.
				// Deduplicate by neighbor id, keeping the best (current > previous) edge row.
				const bestByNeighbor = new Map<string, { id: string; weight: number; edge: LayoutEdge }>();
				for (const c of candidates) {
					const prev = bestByNeighbor.get(c.id);
					if (!prev) {
						bestByNeighbor.set(c.id, c);
						continue;
					}
					const aPrev = layoutEdgeIsPrevious(c.edge);
					const bPrev = layoutEdgeIsPrevious(prev.edge);
					if (bPrev && !aPrev) bestByNeighbor.set(c.id, c);
					else if (aPrev === bPrev && (c.weight || 0) > (prev.weight || 0)) bestByNeighbor.set(c.id, c);
				}
				const ranked = Array.from(bestByNeighbor.values()).sort((a, b) => {
					const aPrev = layoutEdgeIsPrevious(a.edge) ? 0 : 1;
					const bPrev = layoutEdgeIsPrevious(b.edge) ? 0 : 1;
					return bPrev - aPrev || b.weight - a.weight || a.id.localeCompare(b.id);
				});
				candidates.length = 0;
				candidates.push(...ranked);
				const seen = new Set<string>();
				const placeCap = Math.min(candidates.length, neighborLimit);
				const preferSingleRingForCap = starEgoSeed || (firmStarSeed && placeCap <= 18) || placeCap <= 18;
				// Same private-orbit seating as /graph expand merge.
				const { ringCount: sizedRings } = orbitRadiusForHub({
					hubType: seed.type,
					childCount: Math.max(1, placeCap),
					preferSingleRing: preferSingleRingForCap,
				});
				const ringCount = sizedRings;
				// Distribute nodes across rings proportional to each ring's radius (arc
				// capacity) instead of an even split — otherwise the innermost ring (least
				// circumference) gets crushed together right on top of the hub while outer
				// rings have room to spare. Mirrors the same fix in runFluidLayout.
				const placeRingRadii: number[] = [];
				for (let r = 0; r < ringCount; r++) {
					placeRingRadii.push(
						orbitRadiusForHub({
							hubType: seed.type,
							childCount: Math.max(1, placeCap),
							ringIndex: r,
							ringCount,
							preferSingleRing: preferSingleRingForCap,
						}).radius,
					);
				}
				const placeRadiusSum = placeRingRadii.reduce((s, r) => s + r, 0) || 1;
				const placeRingSizes = placeRingRadii.map((r) => Math.max(1, Math.round((r / placeRadiusSum) * placeCap)));
				let placeDrift = placeCap - placeRingSizes.reduce((s, n) => s + n, 0);
				let placeAdjustIdx = ringCount - 1;
				while (placeDrift !== 0 && ringCount > 0) {
					if (placeDrift > 0) {
						placeRingSizes[placeAdjustIdx] += 1;
						placeDrift -= 1;
					} else if (placeRingSizes[placeAdjustIdx] > 1) {
						placeRingSizes[placeAdjustIdx] -= 1;
						placeDrift += 1;
					}
					placeAdjustIdx = (placeAdjustIdx - 1 + ringCount) % ringCount;
				}
				// Cumulative offsets so we can map a flat slot index -> (ring, indexOnRing).
				const placeRingStart: number[] = [];
				{
					let acc = 0;
					for (let r = 0; r < ringCount; r++) {
						placeRingStart.push(acc);
						acc += placeRingSizes[r];
					}
				}
				// Always circular 2D placement (no Y squash).
				const yScale = 1;
				let hubX = seed.x * LAYOUT_SPREAD;
				let hubY = seed.y * LAYOUT_SPREAD;
				if (graph.hasNode(nodeId)) {
					hubX = Number(graph.getNodeAttribute(nodeId, 'x')) || hubX;
					hubY = Number(graph.getNodeAttribute(nodeId, 'y')) || hubY;
				}
				// Hard pack this hub away from every other expanded orbit before seating leaves.
				const otherHubs: Array<{ x: number; y: number; r: number }> = [];
				graph.forEachNode((id, attrs) => {
					if (id === nodeId) return;
					const deg = Number(attrs.degree) || graph.degree(id) || 0;
					const kidsOnCanvas = graph.degree(id);
					// Count anything already expanded / multi-neighbor as an orbit owner.
					if (deg < 2 && kidsOnCanvas < 2 && !visitedIdsRef.current.has(id) && !selectedIdsRef.current.has(id)) return;
					const nt = String(attrs.nodeType || '');
					const otherOrbit = outerOrbitRadius({
						hubType: nt === 'firm' ? 'firm' : 'individual',
						childCount: Math.max(deg, kidsOnCanvas, 4),
						preferSingleRing: kidsOnCanvas <= 22,
					});
					otherHubs.push({
						x: Number(attrs.x) || 0,
						y: Number(attrs.y) || 0,
						r: otherOrbit,
					});
				});
				const myOuter = outerOrbitRadius({
					hubType: seed.type,
					childCount: Math.max(1, placeCap),
					ringCount,
					preferSingleRing: starEgoSeed || (firmStarSeed && placeCap <= 22) || placeCap <= 22,
				});
				if (otherHubs.length) {
					const packed = packNewHubAwayFromOthers(hubX, hubY, myOuter, otherHubs, nodeId);
					hubX = packed.x;
					hubY = packed.y;
					if (graph.hasNode(nodeId)) {
						try {
							graph.setNodeAttribute(nodeId, 'x', hubX);
							graph.setNodeAttribute(nodeId, 'y', hubY);
						} catch {
							// ignore
						}
					}
				}
				let slot = 0;
				for (const c of candidates) {
					if (seen.has(c.id)) continue;
					seen.add(c.id);
					if (seen.size > neighborLimit) break;
					const meta = nodeIndexRef.current.get(c.id);
					if (!meta) continue;
					// Map the flat slot index into (ring, indexOnRing) using the proportional
					// per-ring sizes computed above, so angular spacing matches each ring's
					// actual arc capacity instead of an even flat split.
					let ring = ringCount - 1;
					for (let r = 0; r < ringCount; r++) {
						if (slot < placeRingStart[r] + placeRingSizes[r]) {
							ring = r;
							break;
						}
					}
					const onRing = Math.max(1, placeRingSizes[ring] || 1);
					const indexOnRing = slot - placeRingStart[ring];
					const angle = (indexOnRing / onRing) * Math.PI * 2 + ring * 0.21;
					const { radius } = orbitRadiusForHub({
						hubType: seed.type,
						childCount: Math.max(1, placeCap),
						ringIndex: ring,
						ringCount,
						preferSingleRing: starEgoSeed || (firmStarSeed && placeCap <= 22) || placeCap <= 22,
					});
					// Tiny jitter only — large jitter caused leaf piles on dense rings.
					const jitter = ((hashString(`${nodeId}:${c.id}`) % 1000) / 999 - 0.5) * 1;
					const dist = radius + jitter;
					const pos = {
						x: hubX + Math.cos(angle) * dist,
						y: hubY + Math.sin(angle) * dist * yScale,
					};
					// Always re-seat leaves of this expand onto the hub's private orbit.
					// Other expanded hubs keep their own centers (handled in fluid layout).
					const childIsOtherHub = graph.hasNode(c.id) && graph.degree(c.id) > 6;
					if (starEgoSeed || firmStarSeed || !graph.hasNode(c.id) || !childIsOtherHub) {
						if (ensureNodeOnGraph(meta, pos)) added++;
						else if (graph.hasNode(c.id) && !childIsOtherHub) {
							try {
								graph.setNodeAttribute(c.id, 'x', pos.x);
								graph.setNodeAttribute(c.id, 'y', pos.y);
							} catch {
								// ignore
							}
						}
					} else if (ensureNodeOnGraph(meta)) {
						added++;
					}
					// Draw spoke immediately (ego-safe).
					ensureEdgeOnGraph(c.edge);
					slot++;
				}
			}

			// Materialize edges between any pair of visible nodes.
			// Progressive chart: never drop existing edges when focus moves to another node
			// (pruning greys out / removes prior firm stars and background lines).
			for (const id of visibleIdsRef.current) {
				const list = edgesByNodeRef.current.get(id) || [];
				for (const e of list) {
					if (visibleIdsRef.current.has(e.source) && visibleIdsRef.current.has(e.target)) {
						// Still ego-safe on *add* (person won't create firm↔firm mesh via ensureEdgeOnGraph),
						// but already-drawn edges stay put.
						ensureEdgeOnGraph(e);
					}
				}
			}

			// Mark visited/revealed when all catalog neighbors are already visible,
			// and stamp graph attrs so rings/fills update without a re-click.
			for (const id of visibleIdsRef.current) {
				const list = edgesByNodeRef.current.get(id) || [];
				const hasUnrevealed = list.some((e) => {
					const other = e.source === id ? e.target : e.source;
					return !visibleIdsRef.current.has(other);
				});
				if (!hasUnrevealed) {
					visitedIdsRef.current.add(id);
					if (graph.hasNode(id)) {
						try {
							graph.setNodeAttribute(id, 'revealed', true);
						} catch {
							// ignore
						}
					}
				}
			}

			// Open dense clumps and resolve overlaps smoothly with an animation loop.
			// Person→firms: pass hub id so layout settles as a circular star (left /graph).
			const layoutEgoId =
				starEgoSeed ? nodeId
				: firmStarSeed ? nodeId
				: undefined;
			if ((added > 0 || starEgoSeed || firmStarSeed) && graph.order >= 2) {
				runFluidLayout(graph, sigma, layoutEgoId ? { egoHubId: layoutEgoId } : undefined);
			}

			setVisibleCount(visibleIdsRef.current.size);
			if (added > 0 || graph.hasNode(nodeId)) {
				edgeLodModeRef.current = 'detail';
				setLodHint(
					starEgoSeed ? 'ego · person→firms'
					: firmStarSeed ? 'ego · firm star'
					: 'edges on',
				);
				applyHighlight();
				try {
					// Positions changed — reindex so labels/hit-tests track new coords.
					sigma.refresh();
				} catch {
					// ignore
				}
			}
			return graph.hasNode(nodeId);
		},
		[applyHighlight, edgeAllowedInEgo, ensureEdgeOnGraph, ensureNodeOnGraph, resolveNeighborMode],
	);

	const clearCanvas = useCallback(() => {
		if (globalLayoutAnimId !== null) {
			globalLayoutAnimId.stop();
			globalLayoutAnimId = null;
		}
		const graph = graphRef.current;
		const sigma = sigmaRef.current;
		if (!graph || !sigma) return;
		if (cameraPinUnlockRef.current) {
			try {
				cameraPinUnlockRef.current();
			} catch {
				// ignore
			}
			cameraPinUnlockRef.current = null;
		}
		const nodeIds = graph.nodes();
		for (const id of nodeIds) {
			try {
				graph.dropNode(id);
			} catch {
				// ignore
			}
		}
		visibleIdsRef.current.clear();
		setVisibleCount(0);
		pinnedIdRef.current = null;
		focusedIdRef.current = null;
		selectedIdsRef.current.clear();
		visitedIdsRef.current.clear();
		egoModeRef.current = null;
		setSelectionCount(0);
		hoverIdRef.current = null;
		appliedRouteKeyRef.current = null;
		setFocus(null);
		setErrorMessage(null);
		setLodHint('blank · search to add');
		edgeLodModeRef.current = 'overview';
		syncGlobalRoute(null, null);
		try {
			sigma.refresh();
			sigma.getCamera().animatedReset({ duration: 4000, easing: 'linear' });
		} catch {
			// ignore
		}
	}, [syncGlobalRoute]);

	const focusNode = useCallback(
		(
			nodeId: string,
			opts?: {
				openEgo?: boolean;
				animate?: boolean;
				addIfMissing?: boolean;
				syncUrl?: boolean;
				/** Override default neighbor policy (person→firms, firm→alone). */
				withNeighbors?: boolean | 'firms' | 'all' | 'none';
				/** When false, skip /api/finra/expand (already-fetched focus only). */
				fetchExpand?: boolean;
				/** When catalog lacks the CRD, seed as this type (dashboard deep-links). */
				typeHint?: 'firm' | 'individual';
			},
		) => {
			const graph = graphRef.current;
			const sigma = sigmaRef.current;
			const payload = layoutRef.current;
			if (!graph || !sigma || !payload) return false;

			// Out-of-catalog CRDs (most dashboard picks) must still land on the map.
			if (!nodeIndexRef.current.has(nodeId) && opts?.addIfMissing !== false && /^\d+$/.test(nodeId)) {
				const typeHint =
					opts?.typeHint === 'firm' ? 'firm'
					: opts?.typeHint === 'individual' ? 'individual'
					: 'individual';
				const basex = focusedIdRef.current && graph.hasNode(focusedIdRef.current) ? Number(graph.getNodeAttribute(focusedIdRef.current, 'x')) || 0 : 0;
				const basey = focusedIdRef.current && graph.hasNode(focusedIdRef.current) ? Number(graph.getNodeAttribute(focusedIdRef.current, 'y')) || 0 : 0;
				nodeIndexRef.current.set(nodeId, {
					id: nodeId,
					type: typeHint,
					label: nodeId,
					degree: 1,
					weight: 1,
					size: dynamicNodeSize(1, typeHint),
					x: basex / LAYOUT_SPREAD + (Math.random() - 0.15) * 50,
					y: basey / LAYOUT_SPREAD + (Math.random() - 0.15) * 30,
					color: nodeDisplayColor(typeHint, false),
					inactive: false,
				});
			}

			const catalogMeta = nodeIndexRef.current.get(nodeId);
			const seedTypeHint =
				catalogMeta?.type === 'firm' ? 'firm'
				: catalogMeta?.type === 'individual' ? 'individual'
				: opts?.typeHint === 'firm' ? 'firm'
				: opts?.typeHint === 'individual' ? 'individual'
				: graph.hasNode(nodeId) ? String(graph.getNodeAttribute(nodeId, 'nodeType') || 'unknown')
				: 'unknown';
			// Match /graph expand-in-place: person → firms; firm → full direct star (employees + previous).
			const neighborOpt =
				opts?.withNeighbors !== undefined ? opts.withNeighbors
				: seedTypeHint === 'firm' ? 'all'
				: 'firms';

			if (!graph.hasNode(nodeId)) {
				if (opts?.addIfMissing !== false) {
					const ok = addNodeToCanvas(nodeId, { withNeighbors: neighborOpt });
					if (!ok) {
						const meta = nodeIndexRef.current.get(nodeId);
						if (meta && opts?.openEgo) {
							const t = meta.type === 'firm' ? 'firm' : 'individual';
							void router.push(`/graph/${t}/${nodeId}`);
							return true;
						}
						return false;
					}
				} else {
					const meta = nodeIndexRef.current.get(nodeId);
					if (meta && opts?.openEgo) {
						const t = meta.type === 'firm' ? 'firm' : 'individual';
						void router.push(`/graph/${t}/${nodeId}`);
						return true;
					}
					return false;
				}
			} else {
				// Already on canvas: still reveal type-appropriate neighbors from local index.
				addNodeToCanvas(nodeId, { withNeighbors: neighborOpt });
			}

			// Single focus like /graph: new click replaces selection; prior nodes stay on canvas.
			const prevPinned = pinnedIdRef.current;
			const prevSelected = [...selectedIdsRef.current];
			selectedIdsRef.current.clear();
			for (const id of prevSelected) {
				if (id !== nodeId) unlockPinnedNode(id);
			}
			if (prevPinned && prevPinned !== nodeId) unlockPinnedNode(prevPinned);

			const attrs = graph.getNodeAttributes(nodeId);
			const neighborCount = graph.degree(nodeId);
			const nodeType =
				attrs.nodeType === 'firm' ? 'firm'
				: attrs.nodeType === 'individual' ? 'individual'
				: null;
			focusedIdRef.current = nodeId;
			pinnedIdRef.current = nodeId;
			selectedIdsRef.current.add(nodeId);
			// Click = connections are being revealed for this hub.
			visitedIdsRef.current.add(nodeId);
			setSelectionCount(1);
			if (graph.hasNode(nodeId)) {
				graph.setNodeAttribute(nodeId, 'pinned', true);
				graph.setNodeAttribute(nodeId, 'revealed', true);
				graph.setNodeAttribute(nodeId, 'highlighted', true);
			}
			setFocus({
				id: nodeId,
				label: String(attrs.label || nodeId),
				type: String(attrs.nodeType || 'unknown'),
				degree: Number(attrs.degree) || 0,
				cluster: typeof attrs.cluster === 'number' ? attrs.cluster : undefined,
				region: attrs.region ? String(attrs.region) : undefined,
				regionGroup: attrs.regionGroup ? String(attrs.regionGroup) : undefined,
				brokerCount: Number(attrs.brokerCount) || 0,
				firmLinkCount: Number(attrs.firmLinkCount) || 0,
				weight: Number(attrs.weight) || Number(attrs.degree) || 0,
				neighborCount,
			});
			setErrorMessage(null);
			applyHighlight();

			if (opts?.syncUrl !== false && nodeType && /^\d+$/.test(nodeId)) {
				syncGlobalRoute(nodeType, nodeId);
				appliedRouteKeyRef.current = `${nodeType}:${nodeId}`;
			} else if (nodeType && /^\d+$/.test(nodeId)) {
				appliedRouteKeyRef.current = `${nodeType}:${nodeId}`;
			}

			// Pan toward the newest hub without zooming; prior selections stay highlighted.
			attachCameraPin(nodeId, {
				animate: opts?.animate !== false,
				fitRatio: false,
			});

			if (opts?.openEgo) {
				const t = attrs.nodeType === 'firm' ? 'firm' : 'individual';
				void router.push(`/graph/${t}/${nodeId}`);
			}

			if (opts?.fetchExpand === false) return true;

			// Fetch connections and merge onto the existing canvas (never replace the graph).
			// Person → firm spokes (current + previous). Firm → full direct star.
			const fetchId = attrs.nodeType === 'firm' ? `firm:${nodeId}` : `individual:${nodeId}`;
			const expandNeighborMode = resolveNeighborMode(
				String(attrs.nodeType || seedTypeHint),
				neighborOpt === 'none' && String(attrs.nodeType || seedTypeHint) === 'firm' ? 'all' : neighborOpt,
			);
			fetch(`/api/finra/expand/${encodeURIComponent(fetchId)}?hops=1`)
				.then((r) => (r.ok ? r.json() : null))
				.then((data) => {
					if (!data || !data.nodes || !data.links) return;
					if (focusedIdRef.current !== nodeId && !selectedIdsRef.current.has(nodeId)) return;
					let changed = false;
					const g = graphRef.current;
					const basex = g?.hasNode(nodeId) ? Number(g.getNodeAttribute(nodeId, 'x')) || 0 : 0;
					const basey = g?.hasNode(nodeId) ? Number(g.getNodeAttribute(nodeId, 'y')) || 0 : 0;

					for (const n of data.nodes) {
						const crd = String(
							n.crd ||
								String(n.id || '')
									.split(':')
									.pop() ||
								'',
						).trim();
						if (!crd) continue;
						const type: 'firm' | 'individual' = n.group === 'firm' || n.type === 'firm' ? 'firm' : 'individual';
						const inactive = Boolean(n.inactive);
						const existing = nodeIndexRef.current.get(crd);
						if (!existing) {
							nodeIndexRef.current.set(crd, {
								id: crd,
								type,
								label: n.label || crd,
								degree: Number(n.degree) || 1,
								weight: Number(n.weight) || 1,
								size: dynamicNodeSize(Number(n.degree) || 1, type),
								x: basex / LAYOUT_SPREAD + (Math.random() - 0.5) * 100,
								y: basey / LAYOUT_SPREAD + (Math.random() - 0.5) * 100,
								color: nodeDisplayColor(type, inactive),
								inactive,
							});
							changed = true;
						} else {
							if (n.label && (!existing.label || existing.label === crd)) existing.label = n.label;
							if (inactive) {
								existing.inactive = true;
								existing.color = INACTIVE_NODE_COLOR;
							}
							if (typeof n.degree === 'number') existing.degree = n.degree;
						}

						// Mark seed itself inactive when expand reports it.
						if (crd === nodeId && g?.hasNode(nodeId) && inactive) {
							const selected = selectedIdsRef.current.has(nodeId) || focusedIdRef.current === nodeId;
							const revealed = visitedIdsRef.current.has(nodeId);
							g.setNodeAttribute(nodeId, 'inactive', true);
							g.setNodeAttribute(nodeId, 'typeBaseColor', INACTIVE_NODE_COLOR);
							g.setNodeAttribute(nodeId, 'baseColor', INACTIVE_NODE_COLOR);
							g.setNodeAttribute(
								nodeId,
								'color',
								nodeStateColor({
									type: String(g.getNodeAttribute(nodeId, 'nodeType') || 'unknown'),
									inactive: true,
									selected,
									revealed,
								}),
							);
							if (n.label) g.setNodeAttribute(nodeId, 'label', n.label);
							changed = true;
						}
					}

					for (const e of data.links) {
						const sCrd = String(e.source).split(':').pop() || '';
						const tCrd = String(e.target).split(':').pop() || '';
						if (!sCrd || !tCrd) continue;
						// Person focus: only index spokes that touch the focused person
						// (avoid unrelated firm mesh). Firm focus: direct spokes only.
						if (sCrd !== nodeId && tCrd !== nodeId) continue;
						const edgeObj = makeEmploymentEdge(sCrd, tCrd, String(e.relationship || e.edgeType || 'employment'), e.isCurrent, Number(e.weight) || 1);
						const before = (edgesByNodeRef.current.get(sCrd) || []).find((x) => (x.source === sCrd && x.target === tCrd) || (x.source === tCrd && x.target === sCrd));
						upsertIndexedEdge(edgesByNodeRef.current, edgeObj);
						const after = (edgesByNodeRef.current.get(sCrd) || []).find((x) => (x.source === sCrd && x.target === tCrd) || (x.source === tCrd && x.target === sCrd));
						if (!before || before.type !== after?.type || before.isCurrent !== after?.isCurrent) changed = true;
					}
					// Always re-materialize with policy: person paints firms (current+previous);
					// firm stays alone unless expandNeighborMode is 'all'.
					addNodeToCanvasRef.current(nodeId, {
						withNeighbors: expandNeighborMode,
						neighborLimit:
							expandNeighborMode === 'firms' ? 500
							: expandNeighborMode === 'all' ? 500
							: 64,
					});
					if (changed || expandNeighborMode !== 'none') {
						applyHighlightRef.current();
						try {
							sigmaRef.current?.refresh();
						} catch {
							// ignore
						}
					}
				})
				.catch(() => {});

			return true;
		},
		[addNodeToCanvas, applyHighlight, attachCameraPin, resolveNeighborMode, router, syncGlobalRoute, unlockPinnedNode],
	);

	/**
	 * Panel connection / owner / selection-log rows → focus on the map.
	 * Person: fetch + attach firm nodes. Firm: fetch alone (no employee dump).
	 * Seeds out-of-catalog CRDs so clicks work even when layout index lacks them.
	 */
	const activateKeyOnMap = useCallback(
		async (rawKey: string, typeHint?: 'firm' | 'individual') => {
			const key = String(rawKey || '').trim();
			if (!key) return false;

			let type: 'firm' | 'individual' | undefined = typeHint;
			let crd = '';

			const finraMatch = key.match(/^(?:finra:)?(firm|individual):(\d+)$/i);
			if (finraMatch) {
				type = finraMatch[1].toLowerCase() as 'firm' | 'individual';
				crd = finraMatch[2];
			} else if (/^\d+$/.test(key)) {
				crd = key;
			} else {
				const parts = key.split(':');
				const last = parts[parts.length - 1];
				if (/^\d+$/.test(last)) {
					crd = last;
					const maybeType = parts.find((p) => /^(firm|individual)$/i.test(p));
					if (maybeType) type = maybeType.toLowerCase() as 'firm' | 'individual';
				}
			}
			if (!crd) return false;

			const existing = nodeIndexRef.current.get(crd);
			if (!type) {
				if (existing?.type === 'firm' || existing?.type === 'individual') type = existing.type;
				else if (graphRef.current?.hasNode(crd)) {
					const nt = String(graphRef.current.getNodeAttribute(crd, 'nodeType') || '');
					type = nt === 'firm' ? 'firm' : 'individual';
				} else {
					type = 'individual';
				}
			}

			// Seed layout index when connection target is not in the global catalog.
			if (!existing) {
				const basex = focusedIdRef.current && graphRef.current?.hasNode(focusedIdRef.current) ? Number(graphRef.current.getNodeAttribute(focusedIdRef.current, 'x')) || 0 : 0;
				const basey = focusedIdRef.current && graphRef.current?.hasNode(focusedIdRef.current) ? Number(graphRef.current.getNodeAttribute(focusedIdRef.current, 'y')) || 0 : 0;
				nodeIndexRef.current.set(crd, {
					id: crd,
					type,
					label: crd,
					degree: 1,
					weight: 1,
					size: dynamicNodeSize(1, type),
					x: basex / LAYOUT_SPREAD + (Math.random() - 0.5) * 8,
					y: basey / LAYOUT_SPREAD + (Math.random() - 0.5) * 8,
					color: nodeDisplayColor(type, false),
					inactive: false,
				});
			} else if (type && existing.type !== type) {
				// Prefer explicit key type when catalog was wrong/unknown.
				existing.type = type;
			}

			// Same expand policy as node click: firm star / person firms, merge in place.
			const withNeighbors = type === 'firm' ? 'all' : 'firms';
			const ok = focusNode(crd, {
				animate: true,
				addIfMissing: true,
				withNeighbors,
				fetchExpand: true,
				typeHint: type,
			});
			if (ok) return true;

			// Last resort: pull /api/key for label + type, then retry focus.
			try {
				const requestKey = `finra:${type}:${crd}`;
				const r = await fetch(`/api/key?name=${encodeURIComponent(requestKey)}`);
				if (r.ok) {
					const data = await r.json();
					const bundle = data?.bundle && typeof data.bundle === 'object' ? data.bundle : null;
					const finra = bundle?.sources?.finra;
					const sec = bundle?.sources?.sec;
					const label =
						String(
							finra?.basicInformation?.firmName || finra?.basicInformation?.name || finra?.content?.basicInformation?.firmName || sec?.FirmName || sec?.firmName || crd,
						).trim() || crd;
					const stub = nodeIndexRef.current.get(crd);
					if (stub) {
						stub.label = label;
						stub.type = type;
						stub.color = nodeDisplayColor(type, Boolean(stub.inactive));
					}
				}
			} catch {
				// ignore
			}

			return focusNode(crd, {
				animate: true,
				addIfMissing: true,
				withNeighbors,
				fetchExpand: true,
				typeHint: type,
			});
		},
		[focusNode],
	);

	const clearFocus = useCallback(() => {
		const graph = graphRef.current;
		const selected = [...selectedIdsRef.current];
		if (cameraPinUnlockRef.current) {
			try {
				cameraPinUnlockRef.current();
			} catch {
				// ignore
			}
			cameraPinUnlockRef.current = null;
		}
		selectedIdsRef.current.clear();
		setSelectionCount(0);
		// Leaving multi-highlight keeps nodes; drop ego edge filter only when canvas cleared.
		for (const id of selected) unlockPinnedNode(id);
		const prev = pinnedIdRef.current || focusedIdRef.current;
		if (prev && !selected.includes(prev)) unlockPinnedNode(prev);
		pinnedIdRef.current = null;
		focusedIdRef.current = null;
		appliedRouteKeyRef.current = null;
		setFocus(null);
		// Keep nodes on canvas; bare /chart while map stays populated.
		syncGlobalRoute(null, null);
		applyHighlight();
		// Do not reset camera on clear-highlight — only drop selection styling.
		if (graph) {
			// ensure pinned flags cleared after unlock
			try {
				for (const id of selected) {
					if (graph.hasNode(id)) graph.setNodeAttribute(id, 'pinned', false);
				}
			} catch {
				// ignore
			}
		}
	}, [applyHighlight, syncGlobalRoute, unlockPinnedNode]);

	// Keep latest handlers for Sigma event bindings (mount once).
	useEffect(() => {
		addNodeToCanvasRef.current = addNodeToCanvas;
	}, [addNodeToCanvas]);
	useEffect(() => {
		focusNodeRef.current = focusNode;
	}, [focusNode]);
	useEffect(() => {
		clearFocusRef.current = clearFocus;
	}, [clearFocus]);
	useEffect(() => {
		applyHighlightRef.current = applyHighlight;
	}, [applyHighlight]);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			setErrorMessage(null);
			try {
				setStatus('loading');
				const res = await fetch('/api/global-graph');
				if (res.status === 404) {
					if (!cancelled) {
						setStatus('missing');
						const body = await res.json().catch(() => null);
						setErrorMessage(body?.hint || 'Layout file missing');
					}
					return;
				}
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const payload = (await res.json()) as LayoutPayload;
				if (!payload?.nodes?.length) throw new Error('Layout has no nodes');
				if (cancelled) return;
				bakeDisplaySizes(payload);
				layoutRef.current = payload;
				const nMap = new Map<string, LayoutNode>();
				for (const n of payload.nodes) nMap.set(n.id, n);
				nodeIndexRef.current = nMap;
				const eMap = new Map<string, LayoutEdge[]>();
				for (const e of payload.edges || []) {
					if (!eMap.has(e.source)) eMap.set(e.source, []);
					if (!eMap.has(e.target)) eMap.set(e.target, []);
					eMap.get(e.source)!.push(e);
					if (e.source !== e.target) eMap.get(e.target)!.push(e);
				}
				edgesByNodeRef.current = eMap;
				setStats(payload.stats || null);
				setGeneratedAt(payload.generatedAt || null);

				if (!containerRef.current) return;
				destroySigma();
				containerRef.current.innerHTML = '';
				visibleIdsRef.current.clear();
				setVisibleCount(0);

				// Client-only: sigma/rendering and our WebGL programs touch WebGL* globals.
				const [graphologyMod, sigmaMod, renderingMod, dashedMod, hexMod, circleMod] = await Promise.all([
					import('graphology'),
					import('sigma'),
					import('sigma/rendering'),
					import('../../src/lib/sigmaEdgeDashed'),
					import('../../src/lib/sigmaNodeHexagon'),
					import('../../src/lib/sigmaNodeCircle'),
				]);
				if (cancelled || !containerRef.current) return;

				const GraphCtor = resolveDefaultExport<any>(graphologyMod);
				const SigmaCtor = resolveDefaultExport<any>(sigmaMod);
				// Prefer custom glow circle; fall back to stock Sigma circle if interop fails.
				const NodeCircleGlowProgram = resolveProgramClass(circleMod, ['NodeCircleGlowProgram', 'default']);
				const NodeCircleProgram =
					NodeCircleGlowProgram ||
					resolveProgramClass(renderingMod, ['NodeCircleProgram']) ||
					(renderingMod as any)?.NodeCircleProgram ||
					(renderingMod as any)?.default?.NodeCircleProgram;
				const EdgeDashedProgram = resolveProgramClass(dashedMod, ['EdgeDashedProgram', 'default']);
				const NodeHexagonProgram = resolveProgramClass(hexMod, ['NodeHexagonProgram', 'default']);
				if (!GraphCtor || !SigmaCtor) throw new Error('Failed to load graphology/sigma');
				if (typeof NodeCircleProgram !== 'function') {
					throw new Error('NodeCircleProgram failed to load (custom glow + sigma/rendering)');
				}
				if (typeof NodeHexagonProgram !== 'function') throw new Error('NodeHexagonProgram failed to load');
				if (typeof EdgeDashedProgram !== 'function') throw new Error('EdgeDashedProgram failed to load');

				// Firm → hexagon, people → circle. Must match constructor + post-construct reducer.
				const firmHexNodeReducer = (_id: string, attrs: Record<string, any>) => {
					const nodeType = String(attrs?.nodeType || '');
					const isFirm = nodeType === 'firm' || attrs?.type === 'hexagon';
					return {
						...attrs,
						type: isFirm ? 'hexagon' : 'circle',
						// Keep every node above every edge in the zIndex-enabled programs.
						zIndex: Math.max(2, Number(attrs?.zIndex) || 0),
					};
				};

				const nodeProgramClasses = {
					circle: NodeCircleProgram,
					hexagon: NodeHexagonProgram,
				};
				const edgeProgramClasses = {
					dashed: EdgeDashedProgram,
				};

				// Blank graph — search / expand merge nodes onto the canvas (never replace).
				const graph = new GraphCtor({ type: 'undirected', multi: false, allowSelfLoops: false });
				// Reset label hit targets each paint cycle (before labels layer draws).
				labelHitBoxesRef.current = [];
				const sigma = new SigmaCtor(graph, containerRef.current, {
					allowInvalidContainer: true,
					renderLabels: true,
					// Required for clickEdge / enterEdge (connection lines are pickable).
					enableEdgeEvents: true,
					// Screen-pixel sizes: scaleSize(s) = s / zoomFn(ratio) [* positions term].
					// Linear zoomFn + 'screen' => rendered radius scales exactly with zoom.
					itemSizesReference: 'screen',
					zoomToSizeRatioFunction: (ratio: number) => ratio,
					nodeReducer: firmHexNodeReducer,
					// Labels use fixed CSS px via drawLabelAbove; keep threshold low so they stay on.
					labelRenderedSizeThreshold: 0,
					labelDensity: 0.55,
					labelGridCellSize: 120,
					labelSize: 12,
					labelFont: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif',
					labelWeight: '600',
					labelColor: { color: '#e2e8f0' },
					defaultDrawNodeLabel: (context: CanvasRenderingContext2D, data: any, settings: any) => {
						drawLabelAbove(context, data as any, settings as any, { hover: false, recordHit: true });
					},
					defaultDrawNodeHover: (context: CanvasRenderingContext2D, data: any, settings: any) => {
						// Sigma already passes scaleSize()'d size (viewport px). Keep rings
						// proportional so they don't dwarf tiny zoomed-out disks.
						const size = Math.max(2.5, Number((data as any).size) || 11);
						const x = Number((data as any).x);
						const y = Number((data as any).y);
						// Never fall back to (0,0) — that paints a stuck ring in the canvas top-left.
						if (!Number.isFinite(x) || !Number.isFinite(y)) {
							drawLabelAbove(context, data as any, settings as any, { hover: true, recordHit: true });
							return;
						}
						const selected = Boolean((data as any).highlighted);
						const revealed = Boolean((data as any).revealed);
						const nodeType = String((data as any).nodeType || '');
						const isFirm = nodeType === 'firm' || (data as any).type === 'hexagon';

						if (selected) {
							const outer = Math.max(3, size * 0.42);
							context.beginPath();
							context.arc(x, y, size + outer, 0, Math.PI * 2);
							context.closePath();
							context.fillStyle = SELECTED_RING_FILL;
							context.fill();

							context.beginPath();
							context.arc(x, y, size + outer * 0.55, 0, Math.PI * 2);
							context.closePath();
							context.lineWidth = Math.max(1.5, Math.min(2.75, size * 0.22));
							context.strokeStyle = SELECTED_RING_COLOR;
							context.stroke();
						} else if (revealed) {
							const outer = Math.max(2.5, size * 0.38);
							context.beginPath();
							context.arc(x, y, size + outer, 0, Math.PI * 2);
							context.closePath();
							context.fillStyle = isFirm ? REVEALED_RING_FILL_FIRM : REVEALED_RING_FILL_INDIVIDUAL;
							context.fill();

							context.beginPath();
							context.arc(x, y, size + outer * 0.55, 0, Math.PI * 2);
							context.closePath();
							context.lineWidth = Math.max(1.25, Math.min(2.4, size * 0.2));
							context.strokeStyle = isFirm ? REVEALED_RING_FIRM : REVEALED_RING_INDIVIDUAL;
							context.stroke();
						} else {
							// Hover-only: thin ring
							context.beginPath();
							context.arc(x, y, size + Math.max(2, size * 0.28), 0, Math.PI * 2);
							context.closePath();
							context.lineWidth = Math.max(1.25, Math.min(2, size * 0.18));
							context.strokeStyle = 'rgba(245, 158, 11, 0.85)';
							context.stroke();
						}

						drawLabelAbove(context, data as any, settings as any, { hover: true, recordHit: true });
					},
					defaultEdgeColor: 'rgba(59,130,246,0.55)',
					defaultEdgeType: 'line',
					defaultNodeType: 'circle',
					// Firms = hexagon, people = circle; previous edges = dashed program.
					// Always include `circle` explicitly: some Sigma merges replace the whole map.
					nodeProgramClasses,
					edgeProgramClasses,
					defaultNodeColor: INDIVIDUAL_NODE_COLOR,
					minCameraRatio: 0.025,
					maxCameraRatio: 8,
					zIndex: true,
				});
				// Re-assert after construct — some Sigma paths re-merge defaults once.
				sigma.setSetting('itemSizesReference', 'screen');
				sigma.setSetting('zoomToSizeRatioFunction', (ratio: number) => ratio);
				sigma.setSetting('enableEdgeEvents', true);
				// Keep firm → hexagon mapping (same function as constructor).
				sigma.setSetting('nodeReducer', firmHexNodeReducer as any);
				// Force-register programs after construct so settings + this.nodePrograms stay aligned.
				// setSetting(nodeProgramClasses) triggers registerNodeProgram via handleSettingsUpdate.
				sigma.setSetting('nodeProgramClasses', { ...nodeProgramClasses });
				sigma.setSetting('edgeProgramClasses', {
					...(sigma.getSetting('edgeProgramClasses') || {}),
					...edgeProgramClasses,
				});
				// Hard fallback if setSetting path skipped registration for any reason.
				try {
					if (typeof sigma.registerNodeProgram === 'function') {
						sigma.registerNodeProgram('circle', NodeCircleProgram);
						sigma.registerNodeProgram('hexagon', NodeHexagonProgram);
					}
					if (typeof sigma.registerEdgeProgram === 'function') {
						sigma.registerEdgeProgram('dashed', EdgeDashedProgram);
					}
				} catch {
					// ignore — constructor path may already own these
				}
				sigma.setSetting('edgeReducer', (_id: string, attrs: Record<string, any>) => ({
					...attrs,
					// Edges always stay under the node layer (never compete with disks).
					// Floor thickness so person spokes never disappear at fine zoom.
					size: attrs.hidden ? 0 : Math.max(Number(attrs.size) || 1.6, 1.6),
					zIndex: Math.min(-1, Number(attrs.zIndex) || -1),
				}));
				// Ensure solid default line program is registered (dashed is custom).
				try {
					sigma.setSetting('minEdgeThickness', 1.25);
				} catch {
					// older sigma builds may ignore
				}

				// Hard DOM/CSS stack: edges under nodes under labels (Sigma default
				// append order can lose to host CSS; pin it explicitly).
				const pinLayerStack = () => {
					const host = containerRef.current;
					if (!host) return;
					const order = ['edges', 'edgeLabels', 'nodes', 'labels', 'hovers', 'hoverNodes', 'mouse'] as const;
					const zFor: Record<string, number> = {
						edges: 1,
						edgeLabels: 2,
						nodes: 3,
						labels: 4,
						hovers: 5,
						hoverNodes: 6,
						mouse: 7,
					};
					for (const id of order) {
						const el = host.querySelector(`canvas.sigma-${id}`) as HTMLCanvasElement | null;
						if (!el) continue;
						el.style.position = 'absolute';
						el.style.inset = '0';
						el.style.zIndex = String(zFor[id] ?? 1);
						host.appendChild(el); // re-append in paint order (last = top)
					}
				};
				pinLayerStack();

				// Clear hit boxes at the start of each Sigma render so stale rects don't linger.
				const clearLabelHits = () => {
					labelHitBoxesRef.current = [];
				};
				sigma.on('beforeRender', clearLabelHits);

				// Selected + revealed rings when node is not under the hover layer.
				sigma.on('afterRender', () => {
					const host = containerRef.current;
					if (!host) return;
					const canvas = host.querySelector('canvas.sigma-hovers') as HTMLCanvasElement | null;
					if (!canvas) return;
					const ctx = canvas.getContext('2d');
					if (!ctx) return;

					const selected = selectedIdsRef.current;
					const visited = visitedIdsRef.current;
					const focusId = focusedIdRef.current;
					const hoverId = hoverIdRef.current;

					const toDraw = new Set<string>();
					for (const id of selected) toDraw.add(id);
					if (focusId) toDraw.add(focusId);
					for (const id of visited) toDraw.add(id);
					// Hover path already draws ring treatment in defaultDrawNodeHover.
					if (hoverId) toDraw.delete(hoverId);

					/**
					 * Viewport position + on-screen radius matching WebGL nodes.
					 * getNodeDisplayData().size is raw graph size; Sigma's canvas hover/labels
					 * apply scaleSize() — without that, rings stay fixed while disks shrink
					 * when zoomed out (and grow when zoomed in).
					 */
					const projectNode = (id: string): { x: number; y: number; size: number } | null => {
						if (!graph.hasNode(id)) return null;
						let x = NaN;
						let y = NaN;
						let rawSize = 11;
						try {
							const g = sigma.getGraph();
							const gx = Number(g.getNodeAttribute(id, 'x'));
							const gy = Number(g.getNodeAttribute(id, 'y'));
							if (Number.isFinite(gx) && Number.isFinite(gy)) {
								const vp = sigma.graphToViewport({ x: gx, y: gy });
								if (vp && Number.isFinite(vp.x) && Number.isFinite(vp.y)) {
									x = vp.x;
									y = vp.y;
								}
							}
						} catch {
							// fall through
						}
						const display = sigma.getNodeDisplayData(id);
						if (display) {
							rawSize = Number(display.size) || rawSize;
							if (!Number.isFinite(x) || !Number.isFinite(y)) {
								const dx = Number(display.x);
								const dy = Number(display.y);
								if (Number.isFinite(dx) && Number.isFinite(dy)) {
									x = dx;
									y = dy;
								}
							}
						}
						if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
						if (Math.abs(x) < 0.5 && Math.abs(y) < 0.5) {
							try {
								const g = sigma.getGraph();
								const gx = Number(g.getNodeAttribute(id, 'x'));
								const gy = Number(g.getNodeAttribute(id, 'y'));
								if (!(Number.isFinite(gx) && Number.isFinite(gy) && Math.hypot(gx, gy) < 1)) return null;
							} catch {
								return null;
							}
						}
						// Same scaleSize Sigma uses for labels/hover (tracks camera.ratio).
						let size = rawSize;
						try {
							if (typeof (sigma as any).scaleSize === 'function') {
								size = Number((sigma as any).scaleSize(rawSize));
							} else {
								const ratio = Number(sigma.getCamera().ratio) || 1;
								const zoomFn = sigma.getSetting('zoomToSizeRatioFunction') as ((r: number) => number) | undefined;
								const z = typeof zoomFn === 'function' ? zoomFn(ratio) : Math.sqrt(ratio);
								size = rawSize / Math.max(z, 1e-6);
							}
						} catch {
							// keep rawSize fallback
						}
						// Floor so tiny zoomed-out disks still get a visible ring halo.
						size = Math.max(2.5, size);
						return { x, y, size };
					};

					/** Ring pad/stroke in screen px relative to on-screen disk radius. */
					const ringPad = (r: number, kind: 'selected' | 'revealed') => {
						// Keep a tight halo (~30–45% beyond disk) at every zoom.
						const outer = kind === 'selected' ? Math.max(3, r * 0.42) : Math.max(2.5, r * 0.38);
						const stroke = kind === 'selected' ? Math.max(1.5, Math.min(2.75, r * 0.22)) : Math.max(1.25, Math.min(2.4, r * 0.2));
						const fillR = r + outer;
						const strokeR = r + outer * 0.55;
						return { fillR, strokeR, stroke };
					};

					// Revealed first (under), selected on top.
					for (const id of toDraw) {
						const isSelected = selected.has(id) || id === focusId;
						const isRevealed = visited.has(id) || (graph.hasNode(id) && graph.getNodeAttribute(id, 'revealed') === true);
						if (isSelected || !isRevealed) continue;
						const p = projectNode(id);
						if (!p) continue;
						const nt = String(graph.getNodeAttribute(id, 'nodeType') || '');
						const isFirm = nt === 'firm';
						const { fillR, strokeR, stroke } = ringPad(p.size, 'revealed');
						ctx.beginPath();
						ctx.arc(p.x, p.y, fillR, 0, Math.PI * 2);
						ctx.closePath();
						ctx.fillStyle = isFirm ? REVEALED_RING_FILL_FIRM : REVEALED_RING_FILL_INDIVIDUAL;
						ctx.fill();
						ctx.beginPath();
						ctx.arc(p.x, p.y, strokeR, 0, Math.PI * 2);
						ctx.closePath();
						ctx.lineWidth = stroke;
						ctx.strokeStyle = isFirm ? REVEALED_RING_FIRM : REVEALED_RING_INDIVIDUAL;
						ctx.stroke();
					}
					for (const id of toDraw) {
						const isSelected = selected.has(id) || id === focusId;
						if (!isSelected) continue;
						const p = projectNode(id);
						if (!p) continue;
						const { fillR, strokeR, stroke } = ringPad(p.size, 'selected');
						ctx.beginPath();
						ctx.arc(p.x, p.y, fillR, 0, Math.PI * 2);
						ctx.closePath();
						ctx.fillStyle = SELECTED_RING_FILL;
						ctx.fill();
						ctx.beginPath();
						ctx.arc(p.x, p.y, strokeR, 0, Math.PI * 2);
						ctx.closePath();
						ctx.lineWidth = stroke;
						ctx.strokeStyle = SELECTED_RING_COLOR;
						ctx.stroke();
					}
				});

				let lastLodMode: string | null = null;
				const updateLod = () => {
					const ratio = sigma.getCamera().ratio;
					const active = Boolean(focusedIdRef.current || hoverIdRef.current || selectedIdsRef.current.size > 0);
					const empty = graph.order === 0;
					// Smaller camera.ratio = more zoomed in. Labels only when sufficiently close.
					const LABELS_MAX_RATIO = 0.22;
					const labelsOn = !empty && ratio < LABELS_MAX_RATIO;
					const mode =
						empty ? 'overview'
						: labelsOn && ratio < 0.12 ? 'detail'
						: labelsOn ? 'mid'
						: 'overview';
					const modeChanged = mode !== lastLodMode;
					lastLodMode = mode;
					edgeLodModeRef.current = mode;
					// Sizes are constant screen px; don't cull labels by disk size once zoomed in.
					sigma.setSetting('labelRenderedSizeThreshold', 0);
					if (empty) {
						sigma.setSetting('renderLabels', false);
						labelHitBoxesRef.current = [];
						if (modeChanged) setLodHint('blank · search to add');
						return;
					}
					if (labelsOn) {
						sigma.setSetting('renderLabels', true);
						sigma.setSetting('labelDensity', ratio < 0.12 || graph.order < 40 ? 0.55 : 0.32);
						if (modeChanged) setLodHint(active ? 'focus · labels on' : 'zoomed · labels on');
					} else {
						// Zoomed out: hide all node labels (hover chip still draws via hover layer).
						sigma.setSetting('renderLabels', false);
						labelHitBoxesRef.current = [];
						if (modeChanged) setLodHint(active ? 'focus · zoom in for labels' : 'overview · zoom in for labels');
					}
					if (modeChanged) applyHighlightRef.current();
				};

				sigma.getCamera().on('updated', updateLod);
				updateLod();

				sigma.on('enterNode', ({ node }: { node: string }) => {
					hoverIdRef.current = node;
					const attrs = graph.getNodeAttributes(node);
					setHover({
						id: node,
						label: String(attrs.label || node),
						type: String(attrs.nodeType || 'unknown'),
						degree: Number(attrs.degree) || 0,
						cluster: typeof attrs.cluster === 'number' ? attrs.cluster : undefined,
						region: attrs.region ? String(attrs.region) : undefined,
						regionGroup: attrs.regionGroup ? String(attrs.regionGroup) : undefined,
						brokerCount: Number(attrs.brokerCount) || 0,
						firmLinkCount: Number(attrs.firmLinkCount) || 0,
						weight: Number(attrs.weight) || Number(attrs.degree) || 0,
					});
					applyHighlightRef.current();
					updateLod();
				});
				sigma.on('leaveNode', () => {
					hoverIdRef.current = null;
					setHover(null);
					applyHighlightRef.current();
					updateLod();
				});
				// Click any visible person/firm (or its label) to focus + expand in place (/graph parity).
				// Person → firm spokes; firm → employees/owners + previous. Never replaces existing nodes.
				const activateNode = (node: string, original?: MouseEvent | TouchEvent | null, openEgo = false) => {
					void original;
					const meta = nodeIndexRef.current.get(node);
					const t = meta?.type || (graph.hasNode(node) ? String(graph.getNodeAttribute(node, 'nodeType') || '') : '');
					const withNeighbors = t === 'firm' ? 'all' : 'firms';
					// Ensure node is on canvas (out-of-catalog neighbors get addIfMissing via focus).
					if (!graph.hasNode(node) && meta) {
						addNodeToCanvasRef.current(node, { withNeighbors });
					}
					focusNodeRef.current(node, {
						openEgo,
						animate: true,
						addIfMissing: true,
						withNeighbors,
						fetchExpand: true,
					});
				};

				sigma.on('clickNode', ({ node, event }: { node: string; event: any }) => {
					event.original.preventDefault();
					event.original.stopPropagation();
					const oe = event.original as MouseEvent;
					activateNode(node, oe, Boolean(oe.metaKey));
				});
				sigma.on('doubleClickNode', ({ node, event }: { node: string; event: any }) => {
					event.preventSigmaDefault();
					focusNodeRef.current(node, { openEgo: true, addIfMissing: true, fetchExpand: true });
				});
				// Click a connection line → focus the other endpoint (or the non-focused end).
				sigma.on('clickEdge', ({ edge, event }: { edge: string; event: any }) => {
					event.original.preventDefault();
					event.original.stopPropagation();
					const oe = event.original as MouseEvent;
					const ends = graph.extremities(edge);
					if (!ends || ends.length < 2) return;
					const [a, b] = ends;
					const focusId = focusedIdRef.current;
					const target =
						focusId && (a === focusId || b === focusId) ?
							a === focusId ?
								b
							:	a
						: hoverIdRef.current === a ? b
						: hoverIdRef.current === b ? a
						: a;
					activateNode(target, oe, Boolean(oe.metaKey));
				});
				// Label chips sit on the labels canvas (not the WebGL node picker).
				// clickStage fires when the node pick buffer misses — still select via label hit-test.
				// Blank stage click: collapse the detail drawer (parity with /graph canvas bg click).
				sigma.on('clickStage', ({ event }: { event: any }) => {
					const oe = event.original as MouseEvent;
					const labelNode = hitTestLabel(oe.clientX, oe.clientY, containerRef.current);
					if (labelNode && graph.hasNode(labelNode)) {
						oe.preventDefault();
						oe.stopPropagation();
						activateNode(labelNode, oe, Boolean(oe.metaKey));
						return;
					}
					// Empty map space → close side panel; keep nodes/selection on canvas.
					setDrawerOpen(false);
				});

				// Pointer over a label chip (above the disk) — cursor + hover parity.
				const onContainerMove = (ev: MouseEvent) => {
					const el = containerRef.current;
					const labelNode = hitTestLabel(ev.clientX, ev.clientY, el);
					if (el) el.style.cursor = labelNode ? 'pointer' : '';
					if (!labelNode || !graph.hasNode(labelNode)) return;
					if (hoverIdRef.current === labelNode) return;
					// Don't steal hover while the pointer is over a different node disk.
					if (hoverIdRef.current && hoverIdRef.current !== labelNode) return;
					hoverIdRef.current = labelNode;
					const attrs = graph.getNodeAttributes(labelNode);
					setHover({
						id: labelNode,
						label: String(attrs.label || labelNode),
						type: String(attrs.nodeType || 'unknown'),
						degree: Number(attrs.degree) || 0,
						cluster: typeof attrs.cluster === 'number' ? attrs.cluster : undefined,
						region: attrs.region ? String(attrs.region) : undefined,
						regionGroup: attrs.regionGroup ? String(attrs.regionGroup) : undefined,
						brokerCount: Number(attrs.brokerCount) || 0,
						firmLinkCount: Number(attrs.firmLinkCount) || 0,
						weight: Number(attrs.weight) || Number(attrs.degree) || 0,
					});
					applyHighlightRef.current();
					updateLod();
				};
				const containerEl = containerRef.current;
				containerEl.addEventListener('mousemove', onContainerMove);
				labelPointerCleanupRef.current = () => {
					containerEl.removeEventListener('mousemove', onContainerMove);
					containerEl.style.cursor = '';
				};

				graphRef.current = graph;
				sigmaRef.current = sigma;
				focusedIdRef.current = null;
				pinnedIdRef.current = null;
				selectedIdsRef.current.clear();
				setSelectionCount(0);
				setFocus(null);
				setLodHint('blank · search to add');

				// Testing bootstrap (bare /chart only): curated CRD list + edges among them.
				// Deep-links (/chart/firm|individual/…) skip this so focus stays clean.
				const pathNow =
					typeof window !== 'undefined' ?
						String(window.location.pathname || '')
							.split('?')[0]
							.split('#')[0]
							.replace(/\/+$/, '') || '/'
					:	'';
				const bareChart = pathNow === '/chart' || /\/chart$/.test(pathNow);
				if (bareChart && !cancelled) {
					seedPreloadIntoGraph({ cancelled: () => cancelled });
				}

				if (!cancelled) setStatus('ready');
			} catch (err) {
				if (!cancelled) {
					setStatus('error');
					setErrorMessage(err instanceof Error ? err.message : String(err));
				}
			}
		})();
		return () => {
			cancelled = true;
			destroySigma();
		};
	}, [destroySigma, ensureEdgeOnGraph, ensureNodeOnGraph, seedPreloadIntoGraph]);

	// Fallback: if mount bootstrap missed bare /chart (race / path) and canvas is empty, seed once ready.
	useEffect(() => {
		if (status !== 'ready') return;
		if (!CHART_USE_PRELOAD_SEEDS || CHART_PRELOAD_SEEDS.length === 0) return;
		if (routeParams) return;
		const graph = graphRef.current;
		const sigma = sigmaRef.current;
		if (!graph || !sigma) return;
		if (graph.order > 0) return;
		const path = String(typeof window !== 'undefined' ? window.location.pathname : router.asPath || '')
			.split('?')[0]
			.split('#')[0]
			.replace(/\/+$/, '');
		if (path !== '/chart' && !/\/chart$/.test(path)) return;
		seedPreloadIntoGraph();
	}, [status, routeParams, router.asPath, seedPreloadIntoGraph]);

	// Bare /chart with a remembered dashboard CRD → open that node once (fetch if needed).
	// Skip when test bootstrap is seeding a dense map (would navigate away immediately).
	useEffect(() => {
		if (status !== 'ready' || !router.isReady) return;
		if (CHART_USE_PRELOAD_SEEDS && CHART_PRELOAD_SEEDS.length > 0) {
			lastSelectionAutoOpenDoneRef.current = true;
			return;
		}
		if (routeParams) {
			lastSelectionAutoOpenDoneRef.current = true;
			return;
		}
		if (lastSelectionAutoOpenDoneRef.current) return;
		if (appliedRouteKeyRef.current || focusedIdRef.current) {
			lastSelectionAutoOpenDoneRef.current = true;
			return;
		}
		const last = readLastCrdSelection();
		lastSelectionAutoOpenDoneRef.current = true;
		if (!last) return;
		const path = String(router.asPath || '')
			.split('?')[0]
			.split('#')[0];
		if (path !== '/chart' && path !== '/chart/') return;
		syncGlobalRoute(last.type, last.crd);
	}, [status, routeParams, router.isReady, router.asPath, syncGlobalRoute]);

	// Deep-link: /chart/{type}/{crd} → add + focus when catalog is ready.
	// CRDs missing from the precomputed layout (inactive / out-of-sample) are
	// seeded on demand via /api/key + /api/finra/expand — same data as dashboard.
	useEffect(() => {
		if (status !== 'ready') return;
		if (!routeParams) {
			// Bare /chart — do not force-clear an in-session focus unless URL was cleared intentionally.
			routeBootstrapDoneRef.current = true;
			return;
		}

		const key = `${routeParams.type}:${routeParams.crd}`;
		if (appliedRouteKeyRef.current === key && focusedIdRef.current === routeParams.crd && graphRef.current?.hasNode(routeParams.crd)) {
			routeBootstrapDoneRef.current = true;
			return;
		}

		let cancelled = false;

		const seedMissingFromApis = async (type: 'firm' | 'individual', crd: string): Promise<LayoutNode | null> => {
			const size = dynamicNodeSize(1, type);
			const stub: LayoutNode = {
				id: crd,
				type,
				label: crd,
				degree: 1,
				weight: 1,
				size,
				color: nodeDisplayColor(type, false),
				x: (Math.random() - 0.5) * 8,
				y: (Math.random() - 0.5) * 8,
			};
			nodeIndexRef.current.set(crd, stub);

			// Hydrate label + inactive from the same key endpoint dashboard uses.
			try {
				const requestKey = `finra:${type}:${crd}`;
				const res = await fetch(`/api/key?name=${encodeURIComponent(requestKey)}`);
				if (res.ok) {
					const data = await res.json();
					const bundle = data?.bundle && typeof data.bundle === 'object' ? data.bundle : null;
					const orphan =
						bundle?.orphan && typeof bundle.orphan === 'object' ? bundle.orphan
						: data?.orphan && typeof data.orphan === 'object' ? data.orphan
						: null;
					const found = Boolean(bundle?.sources?.finra?.found || bundle?.sources?.sec?.found || orphan);
					if (found) {
						const detailJson =
							typeof data?.rawPayload === 'string' ? data.rawPayload
							: bundle ? JSON.stringify(bundle)
							: '';
						let label = stub.label;
						try {
							const root = detailJson ? JSON.parse(detailJson) : bundle;
							const bi =
								root?.sources?.finra?.payload?.basicInformation || root?.sources?.sec?.payload?.basicInformation || root?.basicInformation || orphan?.basicInformation || {};
							const firmName = typeof bi.firmName === 'string' ? bi.firmName.trim() : '';
							const person = [bi.firstName, bi.middleName, bi.lastName].filter((p) => typeof p === 'string' && p.trim()).join(' ');
							if (firmName) label = firmName;
							else if (person) label = person;
							else if (typeof orphan?.name === 'string' && orphan.name.trim()) label = orphan.name.trim();
						} catch {
							// keep stub label
						}
						// Soft inactive heuristic from raw text (expand will refine).
						const blob = `${detailJson}`.toLowerCase();
						const inactive = Boolean(orphan) || (/inactive|terminated|not in scope|notinscope/.test(blob) && !/\bactive\b/.test(blob.replace(/inactive/g, '')));
						stub.label = label || crd;
						stub.inactive = inactive;
						stub.color = nodeDisplayColor(type, inactive);
						nodeIndexRef.current.set(crd, stub);
					}
				}
			} catch {
				// keep stub; expand may still work
			}

			// Prefetch direct neighbors (hops=1) into the runtime edge index so
			// firm deep-links can paint current + previous spokes on first focus.
			try {
				const fetchId = `${type}:${crd}`;
				const exp = await fetch(`/api/finra/expand/${encodeURIComponent(fetchId)}?hops=1`);
				if (exp.ok) {
					const data = await exp.json();
					for (const n of data?.nodes || []) {
						const nCrd = String(
							n.crd ||
								String(n.id || '')
									.split(':')
									.pop() ||
								'',
						).trim();
						if (!nCrd) continue;
						const nType: 'firm' | 'individual' = n.group === 'firm' || n.type === 'firm' ? 'firm' : 'individual';
						const inactive = Boolean(n.inactive);
						if (nCrd === crd) {
							if (n.label) stub.label = n.label;
							if (inactive) {
								stub.inactive = true;
								stub.color = INACTIVE_NODE_COLOR;
							}
							if (typeof n.degree === 'number') stub.degree = n.degree;
							nodeIndexRef.current.set(crd, stub);
							continue;
						}
						if (!nodeIndexRef.current.has(nCrd)) {
							nodeIndexRef.current.set(nCrd, {
								id: nCrd,
								type: nType,
								label: n.label || nCrd,
								degree: Number(n.degree) || 1,
								weight: 1,
								size: dynamicNodeSize(1, nType),
								color: nodeDisplayColor(nType, inactive),
								inactive,
								x: stub.x + (Math.random() - 0.5) * 12,
								y: stub.y + (Math.random() - 0.5) * 12,
							});
						}
					}
					for (const e of data?.links || []) {
						const sCrd = String(e.source).split(':').pop() || '';
						const tCrd = String(e.target).split(':').pop() || '';
						if (!sCrd || !tCrd) continue;
						// Only index direct spokes involving the deep-linked CRD.
						if (sCrd !== crd && tCrd !== crd) continue;
						const edgeObj = makeEmploymentEdge(sCrd, tCrd, String(e.relationship || e.edgeType || 'employment'), e.isCurrent, Number(e.weight) || 1);
						upsertIndexedEdge(edgesByNodeRef.current, edgeObj);
					}
				}
			} catch {
				// focusNode will retry expand
			}

			return stub;
		};

		const tryApply = async (attempt: number): Promise<void> => {
			if (cancelled) return;
			const graph = graphRef.current;
			const sigma = sigmaRef.current;
			const payload = layoutRef.current;
			if (!graph || !sigma || !payload) {
				if (attempt < 20) {
					window.setTimeout(() => {
						void tryApply(attempt + 1);
					}, 50);
				} else {
					setErrorMessage(`Map not ready for CRD ${routeParams.crd}`);
					routeBootstrapDoneRef.current = true;
				}
				return;
			}

			let meta = nodeIndexRef.current.get(routeParams.crd);
			if (!meta) {
				// Not in precomputed catalog — seed from dashboard APIs (inactive OK).
				meta = (await seedMissingFromApis(routeParams.type, routeParams.crd)) || undefined;
				if (cancelled) return;
				if (!meta) {
					setErrorMessage(`CRD ${routeParams.crd} could not be loaded`);
					routeBootstrapDoneRef.current = true;
					return;
				}
			} else {
				// In catalog: still hydrate expand so previous employers get isCurrent=false
				// (layout only stores generic "employment" spokes).
				try {
					const fetchId = `${routeParams.type}:${routeParams.crd}`;
					const exp = await fetch(`/api/finra/expand/${encodeURIComponent(fetchId)}?hops=1`);
					if (exp.ok) {
						const data = await exp.json();
						const crd = routeParams.crd;
						for (const n of data?.nodes || []) {
							const nCrd = String(
								n.crd ||
									String(n.id || '')
										.split(':')
										.pop() ||
									'',
							).trim();
							if (!nCrd || nCrd === crd) continue;
							const nType: 'firm' | 'individual' = n.group === 'firm' || n.type === 'firm' ? 'firm' : 'individual';
							const inactive = Boolean(n.inactive);
							if (!nodeIndexRef.current.has(nCrd)) {
								nodeIndexRef.current.set(nCrd, {
									id: nCrd,
									type: nType,
									label: n.label || nCrd,
									degree: Number(n.degree) || 1,
									weight: 1,
									size: dynamicNodeSize(1, nType),
									color: nodeDisplayColor(nType, inactive),
									inactive,
									x: (meta.x || 0) + (Math.random() - 0.5) * 12,
									y: (meta.y || 0) + (Math.random() - 0.5) * 12,
								});
							}
						}
						for (const e of data?.links || []) {
							const sCrd = String(e.source).split(':').pop() || '';
							const tCrd = String(e.target).split(':').pop() || '';
							if (!sCrd || !tCrd) continue;
							if (sCrd !== crd && tCrd !== crd) continue;
							upsertIndexedEdge(edgesByNodeRef.current, makeEmploymentEdge(sCrd, tCrd, String(e.relationship || e.edgeType || 'employment'), e.isCurrent, Number(e.weight) || 1));
						}
					}
				} catch {
					// focusNode expand still runs
				}
			}
			if (cancelled) return;

			const canonicalType =
				meta.type === 'firm' ? 'firm'
				: meta.type === 'individual' ? 'individual'
				: routeParams.type;

			// Seed URL bookkeeping before focus so shallow replace does not re-enter as "new".
			lastRouteKeyRef.current = `${canonicalType}:${meta.id}`;

			// Direct URL: firm → reveal all direct connections (current + previous);
			// individual → attached firms (existing person policy).
			const deepLinkNeighbors = canonicalType === 'firm' ? 'all' : 'firms';
			const ok = focusNodeRef.current(meta.id, {
				animate: attempt === 0 && !routeBootstrapDoneRef.current,
				addIfMissing: true,
				syncUrl: false,
				withNeighbors: deepLinkNeighbors,
				fetchExpand: true,
				typeHint: canonicalType,
			});

			if (!ok) {
				if (attempt < 12) {
					window.setTimeout(() => {
						void tryApply(attempt + 1);
					}, 80);
					return;
				}
				setErrorMessage(`Could not open ${routeParams.type} ${routeParams.crd} on the map`);
				routeBootstrapDoneRef.current = true;
				return;
			}

			appliedRouteKeyRef.current = key;
			if (canonicalType !== routeParams.type) {
				syncGlobalRoute(canonicalType, meta.id);
			} else {
				// Keep address bar in sync without fighting focusNode.
				lastRouteKeyRef.current = key;
			}
			setErrorMessage(null);
			routeBootstrapDoneRef.current = true;
		};

		void tryApply(0);
		return () => {
			cancelled = true;
		};
	}, [status, routeParams, syncGlobalRoute]);

	const findHits = useCallback((qRaw: string, limit = 12): LayoutNode[] => {
		const payload = layoutRef.current;
		const q = qRaw.trim().toLowerCase();
		if (!payload || !q) return [];
		const scored: { n: LayoutNode; s: number }[] = [];
		for (const n of payload.nodes) {
			const id = n.id.toLowerCase();
			const label = (n.label || '').toLowerCase();
			let s = -1;
			if (id === q) s = 1000;
			else if (id.startsWith(q)) s = 800;
			else if (label.startsWith(q)) s = 700;
			else if (id.includes(q)) s = 500;
			else if (label.includes(q)) s = 400;
			if (s < 0) continue;
			s += Math.min(50, Math.log2(1 + (n.weight || n.degree || 0)) * 4);
			scored.push({ n, s });
		}
		scored.sort((a, b) => b.s - a.s || (b.n.weight || 0) - (a.n.weight || 0));
		return scored.slice(0, limit).map((x) => x.n);
	}, []);

	const findHit = useCallback(
		(qRaw: string) => {
			const hits = findHits(qRaw, 1);
			return hits[0] || null;
		},
		[findHits],
	);

	const upsertSearchHit = useCallback((hit: LocalNameSearchResult): string | null => {
		const crd = String(hit.crd || '').trim();
		if (!crd) return null;
		const type: 'firm' | 'individual' = hit.type === 'firm' ? 'firm' : 'individual';

		if (!nodeIndexRef.current.has(crd)) {
			const size = dynamicNodeSize(1, type);
			nodeIndexRef.current.set(crd, {
				id: crd,
				type,
				label: hit.name || crd,
				degree: 1,
				weight: 1,
				size,
				color: nodeDisplayColor(type, false),
				x: (Math.random() - 0.5) * 10,
				y: (Math.random() - 0.5) * 10,
			});
		} else {
			const existing = nodeIndexRef.current.get(crd)!;
			if (hit.name && (!existing.label || existing.label === crd)) {
				existing.label = hit.name;
			}
			if (existing.type === 'unknown') existing.type = type;
		}
		return crd;
	}, []);

	const runFocusSearch = useCallback(async () => {
		const q = query.trim();
		if (!q) return;
		setSearchLoading(true);
		setErrorMessage(null);
		setSearchBanner(null);
		const before = visibleIdsRef.current.size;

		try {
			// Same fetch path as dashboard bottom Redis Search (`useLocalNameSearch`).
			setNameSearchQuery(q);
			const matches = await searchRedisNames(q);

			if (!matches.length) {
				// Fallback to searching the currently loaded global layout.
				// This is critical for pure CRD numbers that might not be in the Redis 
				// search index yet, but are physically present in the graph layout.
				const localHits = findHits(q, 1);
				if (localHits.length > 0) {
					const first = localHits[0];
					const ok = focusNode(first.id, { animate: true, addIfMissing: false });
					if (ok) {
						setSearchBanner({ query: q, count: 1 });
						setSearchLoading(false);
						return;
					}
				}

				setErrorMessage(`No matches found for "${q}"`);
				setSearchLoading(false);
				return;
			}

			// If we have any matches, load the highest-ranking one directly as the hub.
			// (Dropping dozens of unconnected nodes into the physics sim is chaotic and
			// calling rebuildForceGraph inside a loop hangs the browser).
			if (matches.length > 0) {
				const hit = matches[0];
				const crd = upsertSearchHit(hit);
				if (!crd) {
					setErrorMessage(`Could not add “${hit.name || q}” to graph`);
					setSearchLoading(false);
					return;
				}
				const ok = focusNode(crd, { animate: true, addIfMissing: true });
				if (!ok) setErrorMessage(`Could not add “${hit.name || crd}” to graph`);
				else {
					const added = Math.max(0, visibleIdsRef.current.size - before);
					setSearchBanner({ query: q, count: Math.max(1, added) });
				}
				setSearchLoading(false);
				return;
			}
		} catch (err) {
			setErrorMessage(`Search error: ${err instanceof Error ? err.message : String(err)}`);
		}
		setSearchLoading(false);
	}, [query, focusNode, searchRedisNames, setNameSearchQuery, upsertSearchHit, addNodeToCanvas]);

	const runOpenEgo = useCallback(() => {
		if (focus) {
			const t = focus.type === 'firm' ? 'firm' : 'individual';
			void router.push(`/graph/${t}/${focus.id}`);
		}
	}, [focus, router]);

	const loadPanelForFocus = useCallback(
		(nodeId: string, nodeType: string, label: string) => {
			const requestId = ++panelRequestRef.current;
			const t = nodeType === 'firm' ? 'firm' : 'individual';
			const requestKey = /^\d+$/.test(nodeId) ? `finra:${t}:${nodeId}` : nodeId;
			const cached = cache[requestKey] || Object.values(cache).find((s) => s.key === requestKey || s.resolvedKey === requestKey) || null;
			if (cached?.detailJson) {
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
			fetch(`/api/key?name=${encodeURIComponent(requestKey)}`)
				.then(async (r) => {
					const data = await r.json();
					if (!r.ok) throw new Error(String(data?.error || `HTTP ${r.status}`));
					return data;
				})
				.then((data) => {
					if (panelRequestRef.current !== requestId) return;
					// Match dashboard /api/key consumers (StatusBox): live FINRA/SEC hits
					// OR synthetic orphan bundles scraped from a parent firm page.
					const bundle = data?.bundle && typeof data.bundle === 'object' ? data.bundle : null;
					const found = Boolean(bundle?.sources?.finra?.found || bundle?.sources?.sec?.found);
					const orphan =
						bundle?.orphan && typeof bundle.orphan === 'object' ? bundle.orphan
						: data?.orphan && typeof data.orphan === 'object' ? data.orphan
						: null;
					const hasOrphanCard = Boolean(orphan);
					if (!found && !hasOrphanCard) {
						setPanelSnapshot({
							key: requestKey,
							resolvedKey: requestKey,
							detailJson: null,
							loading: false,
							error: `No FINRA/SEC record found for ${label || requestKey}`,
						});
						return;
					}
					const resolvedKey = typeof data?.resolvedKey === 'string' ? data.resolvedKey : requestKey;
					// Prefer API rawPayload (same string dashboard feeds StatusBox).
					const detailValue =
						typeof data?.rawPayload === 'string' ? data.rawPayload
						: bundle ? JSON.stringify(bundle, null, 2)
						: JSON.stringify(data?.payload ?? data ?? null, null, 2);
					const snapshot = {
						key: requestKey,
						resolvedKey,
						detailJson: detailValue,
						fetchedAt: Date.now(),
						source: 'shared' as const,
					};
					setSnapshot(requestKey, snapshot);
					if (resolvedKey !== requestKey) setSnapshot(resolvedKey, snapshot);
					setPanelSnapshot({
						key: requestKey,
						resolvedKey,
						detailJson: detailValue,
						loading: false,
						error: '',
					});
				})
				.catch((err: unknown) => {
					if (panelRequestRef.current !== requestId) return;
					setPanelSnapshot({
						key: requestKey,
						resolvedKey: requestKey,
						detailJson: null,
						loading: false,
						error: err instanceof Error ? err.message : `Could not load data for ${requestKey}`,
					});
				});
		},
		[cache, setSnapshot],
	);

	// When focus changes, hydrate the node-graph-style detail drawer and append Selection Log.
	useEffect(() => {
		if (!focus) {
			setPanelSnapshot(null);
			return;
		}
		loadPanelForFocus(focus.id, focus.type, focus.label);
		setDrawerOpen(true);

		// Most-recent-first selection history (dedupe consecutive same id; re-click moves to top).
		if (lastLoggedFocusIdRef.current !== focus.id) {
			lastLoggedFocusIdRef.current = focus.id;
			const crd = /^\d+$/.test(focus.id) ? focus.id : focus.id.split(':').pop() || focus.id;
			const type =
				focus.type === 'firm' ? 'firm'
				: focus.type === 'individual' ? 'individual'
				: 'unknown';
			const key = /^\d+$/.test(crd) ? `finra:${type === 'firm' ? 'firm' : 'individual'}:${crd}` : focus.id;
			const entry: SelectionLogEntry = {
				id: focus.id,
				label: focus.label || crd,
				display: formatSelectionLogDisplay(focus.label || crd, crd, null),
				type,
				crd,
				secNumber: null,
				key,
				ts: Date.now(),
			};
			setSelectionLog((prev) => {
				const without = prev.filter((row) => row.id !== entry.id && row.crd !== entry.crd);
				return [entry, ...without].slice(0, 200);
			});
		}
		// Intentionally only re-run when the focused CRD changes (not when cache identity changes).
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [focus?.id]);

	// Enrich the latest log row with SEC# once panel payload arrives so it is searchable.
	useEffect(() => {
		if (!panelSnapshot?.detailJson || panelSnapshot.loading) return;
		const sec = pickSecNumberFromDetailJson(panelSnapshot.detailJson);
		if (!sec) return;
		const crdFromKey = String(panelSnapshot.resolvedKey || panelSnapshot.key || '')
			.split(':')
			.pop();
		if (!crdFromKey) return;
		setSelectionLog((prev) => {
			let changed = false;
			const next = prev.map((row) => {
				if (row.crd !== crdFromKey && row.id !== crdFromKey) return row;
				if (row.secNumber === sec) return row;
				changed = true;
				return {
					...row,
					secNumber: sec,
				};
			});
			return changed ? next : prev;
		});
	}, [panelSnapshot?.detailJson, panelSnapshot?.loading, panelSnapshot?.key, panelSnapshot?.resolvedKey]);

	const handleCenter = useCallback(() => {
		const sigma = sigmaRef.current;
		const id = focusedIdRef.current;
		if (!sigma) return;
		if (id && graphRef.current?.hasNode(id)) {
			attachCameraPin(id);
			return;
		}
		try {
			sigma.getCamera().animatedReset({ duration: 4000, easing: 'linear' });
		} catch {
			// ignore
		}
	}, [attachCameraPin]);

	const handleResetSession = useCallback(() => {
		clearCanvas();
		clearSharedCache();
		setPanelSnapshot(null);
		clearSelectionLog();
		lastLoggedFocusIdRef.current = null;
		setDrawerOpen(false);
		setSearchBanner(null);
		setSearchBanner(null);
		setQuery('');
		setErrorMessage(null);
	}, [clearCanvas, clearSharedCache]);

	const handleSearchSubmit = useCallback(
		async (e?: { preventDefault?: () => void }) => {
			e?.preventDefault?.();
			await runFocusSearch();
		},
		[runFocusSearch],
	);

	const panelActiveKey = panelSnapshot?.resolvedKey || panelSnapshot?.key || '';
	const panelDetailJson = panelSnapshot?.detailJson ?? null;
	const panelLoading = Boolean(panelSnapshot?.loading);

	// Match /graph drawer: title + FINRA/IA role chips from the loaded record payload
	// (not graphology degree / region metadata).
	const panelTitle = useMemo(() => {
		const fallback = focus?.label || 'Details';
		if (!panelDetailJson) return fallback;
		try {
			const payload = readSnapshotPayload(panelDetailJson);
			const parsed = parseCrdKey(panelActiveKey);
			const type = (parsed?.type as 'individual' | 'firm') || (focus?.type === 'firm' ? 'firm' : 'individual');
			const crd = parsed?.crd || (focus && /^\d+$/.test(focus.id) ? focus.id : '') || '';
			const finra = getContentBlock(payload, 'finra', type);
			const sec = getContentBlock(payload, 'sec', type);
			const primaryContent = (finra?.basicInformation ? finra : sec) as Record<string, any> | null;
			const nameInfo = extractNamesFromPayload(primaryContent ?? payload, type);
			const resolved = resolveEntityDisplayName({
				payload,
				type,
				crd,
				candidates: [nameInfo.primary, focus?.label],
			});
			const title = resolved || fallback || crd || panelActiveKey;
			if (type === 'individual' && title && title !== crd) return toProperCaseName(title);
			return title;
		} catch {
			return fallback;
		}
	}, [panelDetailJson, panelActiveKey, focus]);

	const panelRoleRows = useMemo(() => {
		if (!panelDetailJson) return [] as string[];
		try {
			const payload = readSnapshotPayload(panelDetailJson);
			const parsed = parseCrdKey(panelActiveKey);
			const type = (parsed?.type as 'individual' | 'firm') || (focus?.type === 'firm' ? 'firm' : 'individual');
			const finra = getContentBlock(payload, 'finra', type);
			const sec = getContentBlock(payload, 'sec', type);
			const rows: string[] = [];
			if (toArray(finra?.currentEmployments).length > 0) rows.push('Broker Regulated by FINRA');
			if (toArray(finra?.currentIAEmployments).length > 0 || toArray(sec?.currentIAEmployments).length > 0) {
				rows.push('Investment Adviser');
			}
			return rows;
		} catch {
			return [];
		}
	}, [panelDetailJson, panelActiveKey, focus?.type]);

	return (
		<>
			<Head>
				<title>{`${focus ? `${focus.label} • Global Map` : 'Global Map'} • FINRA / SEC`}</title>
			</Head>

			<div
				className={`node-graph-page fullscreen-mode theme-${theme} global-graph-webgl`}
				data-theme={theme}>
				{/* Page toolbar under the shared app top-nav (brand + primary links live in _app). */}
				<FgHeader
					focusLabel={focus?.label || hover?.label || null}
					focusCrd={focus?.id || hover?.id || null}
					showFocusReadout={!!(focus || hover)}
					showDrawerToggle={true}
					drawerOpen={drawerOpen}
					setDrawerOpen={setDrawerOpen}
					errorMessage={(errorMessage || status === 'error') && status !== 'loading' ? errorMessage || 'Failed to load global layout' : null}
					searchBanner={searchBanner}
					setSearchBanner={setSearchBanner as any}
				/>

				<main className='graph-main-canvas'>
					{(status === 'loading' || searchLoading) && (
						<div className='fg-loading-overlay'>
							<span>{status === 'loading' ? 'Loading map catalog…' : 'Loading…'}</span>
						</div>
					)}
					{status === 'missing' && (
						<div className='fg-empty-card gg-missing-card'>
							<p className='fg-empty-eyebrow'>Layout not built yet</p>
							<p className='gg-empty-detail'>Generate the precomputed WebGL layout:</p>
							<pre className='gg-code'>pnpm run build-global-graph-layout</pre>
							<p className='gg-empty-detail'>Smoke test (~5k nodes):</p>
							<pre className='gg-code'>pnpm run build-global-graph-layout:smoke</pre>
						</div>
					)}
					{status === 'ready' && visibleCount === 0 && !searchLoading && (
						<div className='fg-empty-card'>
							<p className='fg-empty-eyebrow'>Search for a firm, person, or CRD/SEC# to begin.</p>
						</div>
					)}

					<div
						ref={containerRef}
						className='gg-webgl-host'
						aria-label='Global network WebGL canvas'
					/>
				</main>

				{(status === 'ready' || visibleCount > 0) && (
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
								<div className='fg-toolbar-controls'>
									<button
										type='button'
										className='fg-toolbar-minimize-btn'
										onClick={() => setToolbarMinimized(true)}
										aria-label='Minimize toolbar'>
										◀
									</button>
									<div className='fg-toolbar fg-toolbar-row'>
										<button
											type='button'
											className='fg-toolbar-btn'
											onClick={() => {
												// Refresh catalog positions stay; re-focus current if any.
												if (focus) focusNode(focus.id, { animate: true, addIfMissing: true });
												else handleCenter();
											}}>
											Refresh ⟳
										</button>
										<button
											type='button'
											className='fg-toolbar-btn'
											onClick={runOpenEgo}
											disabled={!focus && !query.trim()}>
											Open ego
										</button>
										<button
											type='button'
											className='fg-toolbar-btn danger'
											onClick={handleResetSession}>
											Reset Session
										</button>
										<button
											type='button'
											className='fg-toolbar-btn'
											onClick={clearCanvas}
											disabled={visibleCount === 0}>
											Clear map
										</button>
										<button
											type='button'
											className='fg-toolbar-btn'
											onClick={clearFocus}
											disabled={!focus && selectionCount === 0}
											title={selectionCount > 1 ? `Clear ${selectionCount} highlighted nodes` : 'Clear highlight'}>
											Clear Highlight{selectionCount > 1 ? ` (${selectionCount})` : ''}
										</button>
										<button
											type='button'
											className='fg-toolbar-btn fg-center-btn'
											onClick={handleCenter}>
											Center ✦
										</button>
										<button
											type='button'
											className='fg-theme-toggle'
											onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
											aria-label='Toggle theme'>
											{theme === 'dark' ? '☀️' : '🌙'}
										</button>
									</div>
								</div>
								<div
									className='fg-state-legend'
									aria-label='Node state legend'>
									<span className='fg-state-legend-item'>
										<span className='fg-state-dot selected' />
										Selected
									</span>
									<span className='fg-state-legend-item'>
										<span className='fg-state-dot revealed-firm' />
										Firm opened
									</span>
									<span className='fg-state-legend-item'>
										<span className='fg-state-dot revealed-person' />
										Person opened
									</span>
								</div>
							</>
						}
					</div>
				)}

				<FgDrawer
					drawerOpen={drawerOpen}
					setDrawerOpen={setDrawerOpen}
					searchQuery={query}
					onSearchQueryChange={setQuery}
					onSearchSubmit={handleSearchSubmit}
					searchDisabled={status !== 'ready' && status !== 'loading'}
					searchLoading={searchLoading}
					showTitleAndRoles={!!(focus || panelSnapshot)}
					panelTitle={panelTitle}
					panelRoleRows={panelRoleRows}
					panelError={panelSnapshot?.error || errorMessage}
					panelActiveKey={panelActiveKey}
					panelDetailJson={panelDetailJson}
					panelLoading={panelLoading}
					onSelectKey={(key) => {
						void activateKeyOnMap(key);
					}}
					selectionLog={selectionLog}
					onClearSelectionLog={() => {
						clearSelectionLog();
						lastLoggedFocusIdRef.current = null;
					}}
					onFocusSelectionLogEntry={(entry) => {
						const crd = entry.crd || entry.id;
						const type =
							entry.type === 'firm' ? 'firm'
							: entry.type === 'individual' ? 'individual'
							: undefined;
						if (crd) void activateKeyOnMap(entry.key || crd, type);
					}}
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

				.gg-suggest-dropdown {
					position: absolute;
					left: 0;
					top: calc(100% + 6px);
					z-index: 30;
					margin: 0;
					padding: 4px;
					list-style: none;
					min-width: min(320px, 80vw);
					max-height: 280px;
					overflow: auto;
					background: rgba(15, 23, 42, 0.98);
					border: 1px solid rgba(148, 163, 184, 0.35);
					border-radius: 8px;
					box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
				}
				.theme-light .gg-suggest-dropdown {
					background: #ffffff;
					border-color: rgba(15, 23, 42, 0.12);
				}
				.gg-suggest-item {
					display: flex;
					flex-direction: column;
					align-items: flex-start;
					gap: 2px;
					width: 100%;
					text-align: left;
					background: transparent;
					border: none;
					color: inherit;
					padding: 8px 10px;
					border-radius: 6px;
					cursor: pointer;
					font-size: 0.82rem;
				}
				.gg-suggest-item:hover {
					background: rgba(37, 99, 235, 0.18);
				}
				.gg-suggest-label {
					font-weight: 600;
				}
				.gg-suggest-meta {
					font-size: 0.72rem;
					color: #94a3b8;
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
				.gg-webgl-host {
					position: absolute;
					inset: 0;
					width: 100%;
					height: 100%;
				}
				.gg-webgl-host canvas {
					outline: none;
					width: 100% !important;
					height: 100% !important;
					position: absolute !important;
					inset: 0;
					/* Default under nodes; specific layers override below. */
					z-index: 1;
				}
				/* Edges must never paint over node disks. */
				.gg-webgl-host canvas.sigma-edges {
					z-index: 1 !important;
				}
				.gg-webgl-host canvas.sigma-edgeLabels {
					z-index: 2 !important;
				}
				.gg-webgl-host canvas.sigma-nodes {
					z-index: 3 !important;
				}
				.gg-webgl-host canvas.sigma-labels,
				.gg-webgl-host canvas.sigma-hovers,
				.gg-webgl-host canvas.sigma-hoverNodes {
					z-index: 4 !important;
				}
				.gg-webgl-host canvas.sigma-mouse {
					z-index: 5 !important;
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
					pointer-events: none;
				}
				.gg-missing-card {
					pointer-events: auto;
					max-width: 480px;
					padding: 20px 24px;
					background: rgba(15, 23, 42, 0.92);
					border: 1px solid rgba(148, 163, 184, 0.25);
					border-radius: 10px;
				}
				.fg-empty-eyebrow {
					margin: 0;
				}
				.gg-empty-detail {
					margin: 10px 0 4px;
					font-size: 0.82rem;
					color: #cbd5e1;
				}
				.gg-code {
					margin: 6px 0;
					padding: 10px 12px;
					background: #020617;
					border-radius: 6px;
					font-size: 0.78rem;
					overflow-x: auto;
					color: #67e8f9;
					text-align: left;
				}

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
					flex-direction: column;
					align-items: stretch;
					gap: 6px;
					padding: 6px 8px 8px;
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
					padding: 0;
				}
				.fg-toolbar-controls {
					display: flex;
					align-items: center;
					gap: 0;
				}
				.fg-state-legend {
					display: flex;
					flex-wrap: wrap;
					gap: 10px 14px;
					padding: 2px 6px 0;
					font-size: 0.68rem;
					font-weight: 600;
					letter-spacing: 0.02em;
					color: #94a3b8;
					user-select: none;
				}
				.theme-light .fg-state-legend {
					color: #64748b;
				}
				.fg-state-legend-item {
					display: inline-flex;
					align-items: center;
					gap: 5px;
				}
				.fg-state-dot {
					width: 9px;
					height: 9px;
					border-radius: 50%;
					box-sizing: border-box;
					flex-shrink: 0;
				}
				.fg-state-dot.selected {
					background: #f59e0b;
					box-shadow: 0 0 0 2px rgba(245, 158, 11, 0.35);
				}
				.fg-state-dot.revealed-firm {
					background: #164e63;
					box-shadow: 0 0 0 2px #2dd4bf;
				}
				.fg-state-dot.revealed-person {
					background: #38bdf8;
					box-shadow: 0 0 0 2px #c084fc;
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
				.fg-toolbar-btn:disabled {
					opacity: 0.4;
					cursor: not-allowed;
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
