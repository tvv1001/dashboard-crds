import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type Graph from 'graphology';
import type Sigma from 'sigma';
import { useSharedGraphState } from '../../src/hooks/useSharedGraphState';
import { PanelHeader } from '../../src/components/panel/PanelHeader';
import { StatusBox } from '../../src/components/panel/StatusBox';

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
};

type LayoutEdge = {
	id: string;
	source: string;
	target: string;
	type: string;
	weight: number;
};

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
	{ key: 'employment', label: 'Employment', match: (t) => t === 'employment' || !t },
	{ key: 'firm_link', label: 'Firm links', match: (t) => t === 'firm_link' },
	{ key: 'ownership', label: 'Ownership', match: (t) => t === 'ownership' },
	{ key: 'location', label: 'Location', match: (t) => t === 'location' },
	{ key: 'succession', label: 'Succession', match: (t) => t === 'succession' },
	{ key: 'other', label: 'Other', match: (t) => !['employment', 'firm_link', 'ownership', 'location', 'succession', ''].includes(t) },
];

function normalizeEdgeType(raw: string | undefined): EdgeTypeKey {
	const t = String(raw || 'employment');
	for (const meta of EDGE_TYPE_META) {
		if (meta.key === 'other') continue;
		if (meta.match(t)) return meta.key;
	}
	return 'other';
}

/** d3-force bake is already wide; client scale opens dense firm clusters more. */
const LAYOUT_SPREAD = 1.7;

/**
 * Draw labels centered above the node disk (Sigma default is to the right).
 */
function drawLabelAbove(
	context: CanvasRenderingContext2D,
	data: { x: number; y: number; size: number; label: string | null; color: string },
	settings: {
		labelSize: number;
		labelFont: string;
		labelWeight: string;
		labelColor: { color?: string; attribute?: string };
	},
	opts?: { hover?: boolean },
) {
	if (!data.label) return;
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
	// Place fully above the disk with a small gap.
	const y = data.y - data.size - h - 4;

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

/**
 * Extra open-up for dense on-canvas neighborhoods (e.g. firm-link clumps).
 * Expands each node away from the centroid of its on-canvas neighbors.
 */
function loosenDenseClusters(graph: Graph, opts?: { iterations?: number; strength?: number; minDegree?: number }) {
	const iterations = opts?.iterations ?? 10;
	const strength = opts?.strength ?? 0.22;
	const minDegree = opts?.minDegree ?? 3;
	if (graph.order < 4) return;

	for (let iter = 0; iter < iterations; iter++) {
		const deltas = new Map<string, { dx: number; dy: number }>();
		graph.forEachNode((id) => {
			const deg = graph.degree(id);
			if (deg < minDegree) return;
			let cx = 0;
			let cy = 0;
			let n = 0;
			graph.forEachNeighbor(id, (nb) => {
				cx += Number(graph.getNodeAttribute(nb, 'x')) || 0;
				cy += Number(graph.getNodeAttribute(nb, 'y')) || 0;
				n++;
			});
			if (n < minDegree) return;
			cx /= n;
			cy /= n;
			const x = Number(graph.getNodeAttribute(id, 'x')) || 0;
			const y = Number(graph.getNodeAttribute(id, 'y')) || 0;
			let dx = x - cx;
			let dy = y - cy;
			let dist = Math.hypot(dx, dy);
			if (dist < 1e-6) {
				const ang = (Number(id.replace(/\D/g, '').slice(-4) || '1') % 360) * (Math.PI / 180);
				dx = Math.cos(ang);
				dy = Math.sin(ang);
				dist = 1;
			}
			// Push outward from local neighborhood centroid; denser hubs get more air.
			const boost = strength * (0.65 + Math.min(1.8, Math.sqrt(deg) * 0.18));
			const scale = boost * (8 + Math.min(40, 120 / Math.max(dist, 1)));
			const prev = deltas.get(id) || { dx: 0, dy: 0 };
			prev.dx += (dx / dist) * scale;
			prev.dy += (dy / dist) * scale;
			deltas.set(id, prev);
		});

		// Also gently separate high-degree pairs that sit too close.
		const hubs: string[] = [];
		graph.forEachNode((id) => {
			if (graph.degree(id) >= minDegree) hubs.push(id);
		});
		for (let i = 0; i < hubs.length; i++) {
			const a = hubs[i];
			const ax = Number(graph.getNodeAttribute(a, 'x')) || 0;
			const ay = Number(graph.getNodeAttribute(a, 'y')) || 0;
			const ar = (Number(graph.getNodeAttribute(a, 'size')) || 4) * LAYOUT_SPREAD * 0.9;
			for (let j = i + 1; j < hubs.length; j++) {
				const b = hubs[j];
				const bx = Number(graph.getNodeAttribute(b, 'x')) || 0;
				const by = Number(graph.getNodeAttribute(b, 'y')) || 0;
				const br = (Number(graph.getNodeAttribute(b, 'size')) || 4) * LAYOUT_SPREAD * 0.9;
				let dx = bx - ax;
				let dy = by - ay;
				let dist = Math.hypot(dx, dy);
				const minD = ar + br + 18;
				if (dist >= minD) continue;
				if (dist < 1e-6) {
					dx = 1;
					dy = 0;
					dist = 1;
				}
				const push = ((minD - dist) * 0.35) / dist;
				const da = deltas.get(a) || { dx: 0, dy: 0 };
				const db = deltas.get(b) || { dx: 0, dy: 0 };
				da.dx -= dx * push;
				da.dy -= dy * push;
				db.dx += dx * push;
				db.dy += dy * push;
				deltas.set(a, da);
				deltas.set(b, db);
			}
		}

		if (!deltas.size) break;
		for (const [id, d] of deltas) {
			graph.setNodeAttribute(id, 'x', (Number(graph.getNodeAttribute(id, 'x')) || 0) + d.dx);
			graph.setNodeAttribute(id, 'y', (Number(graph.getNodeAttribute(id, 'y')) || 0) + d.dy);
		}
	}
}

/**
 * Hard non-overlap: treat each node as a disk of radius ~display size in graph units
 * and fully separate every colliding pair until none remain (or max rounds).
 * Must run after final sizes are set and coordinates are spread — before Sigma mounts.
 */
function resolveNodeOverlaps(graph: Graph, opts?: { maxIterations?: number; padding?: number; sizeToGraph?: number }): { iterations: number; remaining: number } {
	const maxIterations = opts?.maxIterations ?? 400;
	const padding = opts?.padding ?? 4;
	// Map Sigma-ish display size into current graph coordinates (already × LAYOUT_SPREAD).
	const sizeToGraph = opts?.sizeToGraph ?? LAYOUT_SPREAD * 0.55;

	const pts: { id: string; x: number; y: number; r: number; mass: number }[] = [];
	graph.forEachNode((id, attrs) => {
		const size = Number(attrs.size) || 2;
		const deg = Number(attrs.degree) || 0;
		pts.push({
			id,
			x: Number(attrs.x) || 0,
			y: Number(attrs.y) || 0,
			// Disk radius in graph units + small air gap so edges don't kiss.
			r: size * sizeToGraph + padding,
			mass: 1 + Math.sqrt(Math.max(0, deg)) * 0.4,
		});
	});
	const n = pts.length;
	if (n < 2) return { iterations: 0, remaining: 0 };

	const sortedR = [...pts.map((p) => p.r)].sort((a, b) => a - b);
	let cell = Math.max(8, sortedR[Math.floor(sortedR.length * 0.5)] * 2.1);
	const key = (ix: number, iy: number) => `${ix},${iy}`;

	let iter = 0;
	let remaining = 0;
	for (; iter < maxIterations; iter++) {
		// Rebuild cell if radii are stable (they are) — still refresh grid each pass.
		if (iter % 40 === 0 && iter > 0) {
			const med = sortedR[Math.floor(sortedR.length * 0.5)];
			cell = Math.max(8, med * 2.1);
		}
		const grid = new Map<string, number[]>();
		for (let i = 0; i < n; i++) {
			const p = pts[i];
			const k = key(Math.floor(p.x / cell), Math.floor(p.y / cell));
			const bucket = grid.get(k);
			if (bucket) bucket.push(i);
			else grid.set(k, [i]);
		}

		remaining = 0;
		// Full correction (1.0): move pairs completely out of overlap each hit.
		// Slight overshoot early helps break jams; settle later.
		const overshoot =
			iter < 20 ? 1.08
			: iter < 80 ? 1.02
			: 1.0;

		for (let i = 0; i < n; i++) {
			const a = pts[i];
			const ax = Math.floor(a.x / cell);
			const ay = Math.floor(a.y / cell);
			for (let ox = -1; ox <= 1; ox++) {
				for (let oy = -1; oy <= 1; oy++) {
					const bucket = grid.get(key(ax + ox, ay + oy));
					if (!bucket) continue;
					for (const j of bucket) {
						if (j <= i) continue;
						const b = pts[j];
						let dx = b.x - a.x;
						let dy = b.y - a.y;
						let dist = Math.hypot(dx, dy);
						const minD = a.r + b.r;
						if (dist >= minD - 1e-9) continue;
						remaining++;
						if (dist < 1e-9) {
							const ang = ((i + 1) * 12.9898 + (j + 1) * 78.233) % (Math.PI * 2);
							dx = Math.cos(ang);
							dy = Math.sin(ang);
							dist = 1e-9;
						}
						// Separate along the line between centers by the full shortfall.
						const push = ((minD - dist) * overshoot) / dist;
						const inv = 1 / (a.mass + b.mass);
						const mx = dx * push;
						const my = dy * push;
						a.x -= mx * b.mass * inv;
						a.y -= my * b.mass * inv;
						b.x += mx * a.mass * inv;
						b.y += my * a.mass * inv;
					}
				}
			}
		}

		if (remaining === 0) break;

		// If still jammed after many passes, uniform expand about centroid then continue.
		if (remaining > 0 && iter > 0 && iter % 60 === 0) {
			let cx = 0;
			let cy = 0;
			for (const p of pts) {
				cx += p.x;
				cy += p.y;
			}
			cx /= n;
			cy /= n;
			const factor = 1.12;
			for (const p of pts) {
				p.x = cx + (p.x - cx) * factor;
				p.y = cy + (p.y - cy) * factor;
			}
		}
	}

	for (const p of pts) {
		graph.setNodeAttribute(p.id, 'x', p.x);
		graph.setNodeAttribute(p.id, 'y', p.y);
	}
	return { iterations: iter + (remaining === 0 ? 0 : 0), remaining };
}

/**
 * Display radius from connection weight (not raw layout size).
 * Individuals: layout `weight` is a career composite (current+previous employments,
 * state/SRO registrations, principal/BD control categories) — see build-global-graph-layout.
 * Higher weight → larger disk (√weight). Final size is fixed before Sigma mounts.
 */
function displayNodeSize(degree: number, type?: string, weight?: number): number {
	const t =
		type === 'firm' ? 'firm'
		: type === 'individual' ? 'individual'
		: 'unknown';
	// Prefer explicit career/composite weight; fall back to degree.
	const wRaw = weight != null && Number.isFinite(weight) && weight > 0 ? weight : degree;
	const dRaw = Number.isFinite(degree) ? degree : 0;
	// Individuals: never size smaller than either signal (previous jobs / regs live in weight).
	const w =
		t === 'individual' ? Math.max(wRaw, dRaw)
		: wRaw > 0 ? wRaw
		: dRaw;
	const leaf = t === 'firm' ? 3.0 : 3.2;
	const byW = Math.sqrt(Math.max(0, w)) * (t === 'firm' ? 0.52 : 0.62);
	const cap = t === 'firm' ? 21 : 26;
	return Math.min(cap, leaf + byW);
}

/** Stamp final sizes onto layout nodes once so first paint never flashes tiny disks. */
function bakeDisplaySizes(payload: LayoutPayload): LayoutPayload {
	for (const n of payload.nodes) {
		const deg = Number(n.degree) || 0;
		const w = Number(n.weight) || deg;
		// Always recompute client-side so size policy stays in one place; layout
		// bake still used for offline collision radii of matching scale.
		n.size = displayNodeSize(deg, n.type, w);
	}
	return payload;
}

/** Thin progressive-map edges — always drawn; alpha stays low so stacks stay readable. */
function edgeBaseSize(weight?: number): number {
	// ~half of prior stroke so lines stay hairline even when many stack.
	return Math.min(0.055, 0.012 + (Number(weight) || 1) * 0.0025);
}

function edgeColor(type: string, dimmed: boolean): string {
	const base =
		type === 'firm_link' || type === 'ownership' ? '167,139,250'
		: type === 'location' ? '52,211,153'
		: type === 'succession' ? '251,146,60'
		: '148,163,184';
	// Slightly clearer than before so thin lines remain visible; dimmed stays ghosted.
	const a =
		type === 'firm_link' ? 0.22
		: type === 'ownership' ? 0.26
		: type === 'location' ? 0.18
		: type === 'succession' ? 0.2
		: 0.14;
	return dimmed ? `rgba(${base},0.05)` : `rgba(${base},${a})`;
}

/**
 * Global network map: WebGL via Sigma + graphology, positions precomputed offline.
 * Routes mirror ego graph / dashboard:
 *   /global-graph
 *   /global-graph/individual/<crd>
 *   /global-graph/firm/<crd>
 */
export default function GlobalGraphPage() {
	const router = useRouter();
	const containerRef = useRef<HTMLDivElement>(null);
	const sigmaRef = useRef<Sigma | null>(null);
	const graphRef = useRef<Graph | null>(null);
	const focusedIdRef = useRef<string | null>(null);
	const pinnedIdRef = useRef<string | null>(null);
	const hoverIdRef = useRef<string | null>(null);
	const cameraPinUnlockRef = useRef<(() => void) | null>(null);
	/** Last URL entity we applied or wrote — avoids replace loops. */
	const lastRouteKeyRef = useRef<string | null>(null);
	/** Last deep-link key we successfully added+focused on canvas. */
	const appliedRouteKeyRef = useRef<string | null>(null);
	const routeBootstrapDoneRef = useRef(false);

	// /global-graph/individual/5567605  (same shape as /graph/... and /individual/...)
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
		const m = path.match(/^\/global-graph\/(individual|firm)\/(\d+)\/?$/i);
		if (m) return { type: m[1].toLowerCase() as 'individual' | 'firm', crd: m[2] };
		return null;
	}, [router.query, router.asPath]);

	const [status, setStatus] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading');
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const [stats, setStats] = useState<LayoutPayload['stats'] | null>(null);
	const [generatedAt, setGeneratedAt] = useState<string | null>(null);
	const [hover, setHover] = useState<HoverInfo | null>(null);
	const [focus, setFocus] = useState<FocusInfo | null>(null);
	const [filter, setFilter] = useState<'all' | 'firm' | 'individual'>('all');
	const [query, setQuery] = useState('');
	const [lodHint, setLodHint] = useState('blank · search to add');
	const [visibleCount, setVisibleCount] = useState(0);
	const [searchHits, setSearchHits] = useState<LayoutNode[]>([]);
	const [theme, setTheme] = useState<'dark' | 'light'>('dark');
	const [toolbarMinimized, setToolbarMinimized] = useState(false);
	const [drawerOpen, setDrawerOpen] = useState(false);
	const [searchLoading, setSearchLoading] = useState(false);
	const [searchBanner, setSearchBanner] = useState<{ query: string; count: number } | null>(null);
	const [panelSnapshot, setPanelSnapshot] = useState<{
		key: string;
		resolvedKey: string;
		detailJson: string | null;
		loading: boolean;
		error: string;
	} | null>(null);
	const panelRequestRef = useRef(0);
	const { cache, setSnapshot, clear: clearSharedCache } = useSharedGraphState();
	const [edgeTypesEnabled, setEdgeTypesEnabled] = useState<Record<EdgeTypeKey, boolean>>({
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
	const addNodeToCanvasRef = useRef<(nodeId: string, opts?: { withNeighbors?: boolean; neighborLimit?: number }) => boolean>(() => false);
	const focusNodeRef = useRef<(nodeId: string, opts?: { openEgo?: boolean; animate?: boolean; addIfMissing?: boolean; syncUrl?: boolean }) => boolean>(() => false);
	const clearFocusRef = useRef<() => void>(() => undefined);
	const applyHighlightRef = useRef<() => void>(() => undefined);
	const edgeTypesEnabledRef = useRef(edgeTypesEnabled);
	edgeTypesEnabledRef.current = edgeTypesEnabled;

	const syncGlobalRoute = useCallback(
		(type: 'individual' | 'firm' | null, crd: string | null) => {
			if (!router.isReady) return;
			if (type && crd) {
				const key = `${type}:${crd}`;
				if (lastRouteKeyRef.current === key) return;
				lastRouteKeyRef.current = key;
				const as = `/global-graph/${type}/${crd}`;
				void router.replace({ pathname: '/global-graph/[[...params]]', query: { params: [type, crd] } }, as, { shallow: true });
				return;
			}
			if (lastRouteKeyRef.current === null || lastRouteKeyRef.current === '') return;
			lastRouteKeyRef.current = null;
			void router.replace({ pathname: '/global-graph/[[...params]]', query: {} }, '/global-graph', {
				shallow: true,
			});
		},
		[router],
	);
	/** Camera LOD label only — edges stay visible at every zoom (user preference). */
	const edgeLodModeRef = useRef<'overview' | 'mid' | 'detail' | 'focus'>('detail');
	const edgeLodIndexRef = useRef(0);

	const availableEdgeTypes = useMemo(() => {
		const counts = stats?.edgeTypes;
		if (counts && Object.keys(counts).length) {
			return EDGE_TYPE_META.filter((m) => (counts[m.key] || 0) > 0);
		}
		return EDGE_TYPE_META.filter((m) => m.key === 'employment' || m.key === 'ownership');
	}, [stats]);

	const destroySigma = useCallback(() => {
		if (cameraPinUnlockRef.current) {
			try {
				cameraPinUnlockRef.current();
			} catch {
				// ignore
			}
			cameraPinUnlockRef.current = null;
		}
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
		const activeId = hoverId || focusId;

		const neighborSet = new Set<string>();
		if (activeId && graph.hasNode(activeId)) {
			neighborSet.add(activeId);
			graph.forEachNeighbor(activeId, (n) => neighborSet.add(n));
		}

		const enabled = edgeTypesEnabledRef.current;

		// Nodes always sit above edges (edge zIndex stays <= 0; nodes >= 1).
		graph.forEachNode((node, attrs) => {
			const baseColor = String(attrs.baseColor || attrs.color || '#94a3b8');
			const baseSize = Number(attrs.baseSize || attrs.size || 2);
			if (!activeId) {
				const isPinned = node === focusId;
				graph.setNodeAttribute(node, 'color', isPinned ? '#ffffff' : baseColor);
				// Keep baked non-overlap radii — emphasize pin with color/z only.
				graph.setNodeAttribute(node, 'size', baseSize);
				graph.setNodeAttribute(node, 'zIndex', isPinned ? 4 : 1);
				graph.setNodeAttribute(node, 'forceLabel', isPinned);
				graph.setNodeAttribute(node, 'pinned', isPinned);
				return;
			}
			const on = neighborSet.has(node);
			if (on) {
				const isPinned = node === focusId;
				const isCenter = node === activeId;
				// Pinned selection stays brightest; do not inflate size (would re-overlap neighbors).
				const highlight = isPinned || isCenter;
				graph.setNodeAttribute(
					node,
					'color',
					isPinned ? '#ffffff'
					: isCenter ? '#f8fafc'
					: baseColor,
				);
				graph.setNodeAttribute(node, 'size', baseSize);
				graph.setNodeAttribute(
					node,
					'zIndex',
					isPinned ? 4
					: isCenter ? 3
					: 2,
				);
				graph.setNodeAttribute(node, 'forceLabel', highlight || graph.degree(node) > 8);
				graph.setNodeAttribute(node, 'pinned', isPinned);
			} else {
				graph.setNodeAttribute(node, 'color', 'rgba(100,116,139,0.18)');
				// Dim without shrinking disks (preserves non-overlap footprint).
				graph.setNodeAttribute(node, 'size', baseSize);
				graph.setNodeAttribute(node, 'zIndex', 1);
				graph.setNodeAttribute(node, 'forceLabel', false);
				graph.setNodeAttribute(node, 'pinned', false);
			}
		});

		// No selection: all type-enabled edges stay thin/visible.
		// Selection/hover: only edges to the active node's neighbors (1-hop spokes).
		graph.forEachEdge((edge, attrs, source, target) => {
			const et = normalizeEdgeType(String(attrs.edgeType || ''));
			const typeOn = enabled[et] !== false && !attrs.filterHidden && !attrs.typeHidden;
			if (!typeOn) {
				graph.setEdgeAttribute(edge, 'hidden', true);
				return;
			}

			const baseSize = Number(attrs.baseSize) > 0 ? Number(attrs.baseSize) : edgeBaseSize(Number(attrs.weight));
			const touchesActive = Boolean(activeId && (source === activeId || target === activeId));

			if (activeId) {
				// Hide every line that is not a direct spoke of the selected/hovered node.
				if (!touchesActive) {
					graph.setEdgeAttribute(edge, 'hidden', true);
					return;
				}
				graph.setEdgeAttribute(edge, 'hidden', false);
				graph.setEdgeAttribute(edge, 'color', edgeColor(String(attrs.edgeType || 'employment'), false));
				graph.setEdgeAttribute(edge, 'zIndex', 0);
				graph.setEdgeAttribute(edge, 'size', Math.min(0.14, baseSize * 1.85));
				return;
			}

			graph.setEdgeAttribute(edge, 'hidden', false);
			graph.setEdgeAttribute(edge, 'color', edgeColor(String(attrs.edgeType || 'employment'), false));
			graph.setEdgeAttribute(edge, 'zIndex', -1);
			graph.setEdgeAttribute(edge, 'size', baseSize);
		});

		sigma.refresh();
	}, []);

	const applyEdgeTypeFilter = useCallback(() => {
		const graph = graphRef.current;
		if (!graph) return;
		const enabled = edgeTypesEnabledRef.current;
		graph.forEachEdge((edge, attrs) => {
			const et = normalizeEdgeType(String(attrs.edgeType || ''));
			const typeOn = enabled[et] !== false;
			graph.setEdgeAttribute(edge, 'typeHidden', !typeOn);
			// Don't force visibility here — LOD + highlight own `hidden`.
			if (!typeOn || attrs.filterHidden) {
				graph.setEdgeAttribute(edge, 'hidden', true);
			}
		});
		applyHighlight();
	}, [applyHighlight]);

	const unlockPinnedNode = useCallback((nodeId: string | null) => {
		const graph = graphRef.current;
		if (!graph || !nodeId || !graph.hasNode(nodeId)) return;
		try {
			graph.setNodeAttribute(nodeId, 'pinned', false);
			// Restore base geometry if highlight isn't about to repaint.
			const attrs = graph.getNodeAttributes(nodeId);
			const baseColor = String(attrs.baseColor || attrs.color || '#94a3b8');
			const baseSize = Number(attrs.baseSize || attrs.size || 2);
			if (focusedIdRef.current !== nodeId && hoverIdRef.current !== nodeId) {
				graph.setNodeAttribute(nodeId, 'color', baseColor);
				graph.setNodeAttribute(nodeId, 'size', baseSize);
				graph.setNodeAttribute(nodeId, 'zIndex', 1);
				graph.setNodeAttribute(nodeId, 'forceLabel', false);
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

		const centerOnPinned = (animate: boolean) => {
			const s = sigmaRef.current;
			if (disposed || !s || pinnedIdRef.current !== nodeId) return;
			try {
				s.refresh({ skipIndexation: false, schedule: false });
			} catch {
				// ignore
			}
			const framed = framedPosOf(s, nodeId);
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
				cam.animate(next, { duration: 420 }, () => {
					animating = false;
					suppressing = false;
				});
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
			const framed = framedPosOf(s, nodeId);
			if (!framed) return;

			const marginX = Math.max(48, dims.width * 0.1);
			const marginY = Math.max(48, dims.height * 0.1);
			const out = forceCenter || !vp || vp.x < marginX || vp.x > dims.width - marginX || vp.y < marginY || vp.y > dims.height - marginY;
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
			// Defer so we don't fight the active pan gesture mid-frame.
			window.setTimeout(() => {
				if (!disposed) keepPinnedInView(false);
			}, 0);
		};

		camera.on('updated', onCameraUpdated);

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

	const ensureNodeOnGraph = useCallback((n: LayoutNode): boolean => {
		const graph = graphRef.current;
		if (!graph || graph.hasNode(n.id)) return false;
		const size = Number(n.size) > 0 ? Number(n.size) : displayNodeSize(n.degree, n.type, n.weight);
		graph.addNode(n.id, {
			label: n.label,
			x: n.x * LAYOUT_SPREAD,
			y: n.y * LAYOUT_SPREAD,
			size,
			baseSize: size,
			color: n.color,
			baseColor: n.color,
			nodeType: n.type,
			degree: n.degree,
			weight: n.weight ?? n.degree,
			region: n.region || '',
			regionGroup: n.regionGroup || '',
			brokerCount: n.brokerCount || 0,
			firmLinkCount: n.firmLinkCount || 0,
			cluster: n.cluster,
			zIndex: 1,
			forceLabel: false,
			pinned: false,
		});
		visibleIdsRef.current.add(n.id);
		return true;
	}, []);

	const ensureEdgeOnGraph = useCallback((e: LayoutEdge): boolean => {
		const graph = graphRef.current;
		if (!graph) return false;
		if (!graph.hasNode(e.source) || !graph.hasNode(e.target)) return false;
		if (graph.hasEdge(e.source, e.target)) return false;
		const enabled = edgeTypesEnabledRef.current;
		const et = normalizeEdgeType(e.type);
		const size = edgeBaseSize(e.weight);
		try {
			graph.addEdgeWithKey(e.id || `${e.source}:${e.target}`, e.source, e.target, {
				weight: e.weight,
				size,
				baseSize: size,
				color: edgeColor(e.type || 'employment', false),
				edgeType: e.type || 'employment',
				filterHidden: false,
				hidden: false,
				typeHidden: enabled[et] === false,
				zIndex: -1,
			});
			return true;
		} catch {
			return false;
		}
	}, []);

	/** Add a layout node (and optional 1-hop neighbors + edges between visible nodes). */
	const addNodeToCanvas = useCallback(
		(nodeId: string, opts?: { withNeighbors?: boolean; neighborLimit?: number }) => {
			const graph = graphRef.current;
			const sigma = sigmaRef.current;
			const payload = layoutRef.current;
			if (!graph || !sigma || !payload) return false;
			const seed = nodeIndexRef.current.get(nodeId);
			if (!seed) return false;
			if (filter !== 'all' && seed.type !== filter) return false;

			const withNeighbors = opts?.withNeighbors !== false;
			const neighborLimit = opts?.neighborLimit ?? 48;
			let added = 0;

			if (ensureNodeOnGraph(seed)) added++;

			if (withNeighbors) {
				const incident = edgesByNodeRef.current.get(nodeId) || [];
				const candidates: { id: string; weight: number }[] = [];
				for (const e of incident) {
					const other = e.source === nodeId ? e.target : e.source;
					if (other === nodeId) continue;
					const meta = nodeIndexRef.current.get(other);
					if (!meta) continue;
					if (filter !== 'all' && meta.type !== filter) continue;
					candidates.push({ id: other, weight: e.weight || 1 });
				}
				candidates.sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
				const seen = new Set<string>();
				for (const c of candidates) {
					if (seen.has(c.id)) continue;
					seen.add(c.id);
					if (seen.size > neighborLimit) break;
					const meta = nodeIndexRef.current.get(c.id);
					if (!meta) continue;
					if (ensureNodeOnGraph(meta)) added++;
				}
			}

			// Materialize every layout edge whose endpoints are both on canvas.
			for (const id of visibleIdsRef.current) {
				const list = edgesByNodeRef.current.get(id) || [];
				for (const e of list) {
					if (visibleIdsRef.current.has(e.source) && visibleIdsRef.current.has(e.target)) {
						ensureEdgeOnGraph(e);
					}
				}
			}

			// Open dense firm-link clumps (bottom-right style packs) then hard-separate disks.
			if (added > 0 && graph.order >= 4) {
				loosenDenseClusters(graph, { iterations: 12, strength: 0.28, minDegree: 3 });
				resolveNodeOverlaps(graph, {
					maxIterations: 220,
					padding: 7,
					sizeToGraph: LAYOUT_SPREAD * 0.72,
				});
			}

			setVisibleCount(visibleIdsRef.current.size);
			if (added > 0 || graph.hasNode(nodeId)) {
				edgeLodModeRef.current = 'detail';
				setLodHint('edges on');
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
		[applyHighlight, ensureEdgeOnGraph, ensureNodeOnGraph, filter],
	);

	const clearCanvas = useCallback(() => {
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
		hoverIdRef.current = null;
		appliedRouteKeyRef.current = null;
		setFocus(null);
		setHover(null);
		setErrorMessage(null);
		setLodHint('blank · search to add');
		edgeLodModeRef.current = 'overview';
		syncGlobalRoute(null, null);
		try {
			sigma.refresh();
			sigma.getCamera().animatedReset({ duration: 280 });
		} catch {
			// ignore
		}
	}, [syncGlobalRoute]);

	const focusNode = useCallback(
		(nodeId: string, opts?: { openEgo?: boolean; animate?: boolean; addIfMissing?: boolean; syncUrl?: boolean }) => {
			const graph = graphRef.current;
			const sigma = sigmaRef.current;
			const payload = layoutRef.current;
			if (!graph || !sigma || !payload) return false;

			if (!graph.hasNode(nodeId)) {
				if (opts?.addIfMissing !== false) {
					const ok = addNodeToCanvas(nodeId, { withNeighbors: true });
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
			}

			// Unlock previous selection before pinning the new one.
			const prevPinned = pinnedIdRef.current;
			if (prevPinned && prevPinned !== nodeId) {
				unlockPinnedNode(prevPinned);
			}

			const attrs = graph.getNodeAttributes(nodeId);
			const neighborCount = graph.degree(nodeId);
			const nodeType =
				attrs.nodeType === 'firm' ? 'firm'
				: attrs.nodeType === 'individual' ? 'individual'
				: null;
			focusedIdRef.current = nodeId;
			pinnedIdRef.current = nodeId;
			graph.setNodeAttribute(nodeId, 'pinned', true);
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

			// Hold the focused hub in the viewport (URL deep-links included).
			// Camera x/y must be framed/normalized coords (handled inside attachCameraPin).
			// Do not change zoom on select — keep the user's current ratio.
			attachCameraPin(nodeId, {
				animate: opts?.animate !== false,
				fitRatio: false,
			});

			if (opts?.openEgo) {
				const t = attrs.nodeType === 'firm' ? 'firm' : 'individual';
				void router.push(`/graph/${t}/${nodeId}`);
			}
			return true;
		},
		[addNodeToCanvas, applyHighlight, attachCameraPin, router, syncGlobalRoute, unlockPinnedNode],
	);

	const clearFocus = useCallback(() => {
		const prev = pinnedIdRef.current || focusedIdRef.current;
		if (cameraPinUnlockRef.current) {
			try {
				cameraPinUnlockRef.current();
			} catch {
				// ignore
			}
			cameraPinUnlockRef.current = null;
		}
		unlockPinnedNode(prev);
		pinnedIdRef.current = null;
		focusedIdRef.current = null;
		appliedRouteKeyRef.current = null;
		setFocus(null);
		// Keep nodes on canvas; bare /global-graph while map stays populated.
		syncGlobalRoute(null, null);
		applyHighlight();
		const sigma = sigmaRef.current;
		if (sigma) {
			try {
				sigma.getCamera().animatedReset({ duration: 350 });
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

				const [{ default: GraphCtor }, { default: SigmaCtor }] = await Promise.all([import('graphology'), import('sigma')]);
				if (cancelled || !containerRef.current) return;

				// Blank graph — search adds nodes onto the canvas.
				const graph = new GraphCtor({ type: 'undirected', multi: false, allowSelfLoops: false });
				const sigma = new SigmaCtor(graph, containerRef.current, {
					allowInvalidContainer: true,
					renderLabels: true,
					labelRenderedSizeThreshold: 4,
					labelDensity: 0.55,
					labelGridCellSize: 120,
					labelSize: 12,
					labelFont: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif',
					labelWeight: '600',
					labelColor: { color: '#e2e8f0' },
					defaultDrawNodeLabel: (context, data, settings) => {
						drawLabelAbove(context, data as any, settings as any, { hover: false });
					},
					defaultDrawNodeHover: (context, data, settings) => {
						// Disc under cursor + label chip above (not to the right).
						const size = Number((data as any).size) || 4;
						const x = Number((data as any).x) || 0;
						const y = Number((data as any).y) || 0;
						context.fillStyle = String((data as any).color || '#f8fafc');
						context.beginPath();
						context.arc(x, y, size + 2, 0, Math.PI * 2);
						context.closePath();
						context.fill();
						context.fillStyle = 'rgba(15,23,42,0.35)';
						context.beginPath();
						context.arc(x, y, Math.max(1.5, size * 0.45), 0, Math.PI * 2);
						context.closePath();
						context.fill();
						drawLabelAbove(context, data as any, settings as any, { hover: true });
					},
					defaultEdgeColor: 'rgba(100,116,139,0.03)',
					defaultNodeColor: '#22d3ee',
					minCameraRatio: 0.004,
					maxCameraRatio: 40,
					zIndex: true,
				});

				let lastLodMode: string | null = null;
				const updateLod = () => {
					const ratio = sigma.getCamera().ratio;
					const active = Boolean(focusedIdRef.current || hoverIdRef.current);
					const empty = graph.order === 0;
					// Labels still LOD by zoom; edges stay drawn (thin) at every level.
					const mode =
						empty ? 'overview'
						: active ? 'focus'
						: ratio < 0.18 ? 'detail'
						: ratio < 0.55 ? 'mid'
						: 'overview';
					const modeChanged = mode !== lastLodMode;
					lastLodMode = mode;
					edgeLodModeRef.current = mode;
					if (empty) {
						sigma.setSetting('renderLabels', false);
						if (modeChanged) setLodHint('blank · search to add');
						return;
					}
					if (ratio < 0.12 || graph.order < 40) {
						sigma.setSetting('renderLabels', true);
						sigma.setSetting('labelDensity', 0.55);
						sigma.setSetting('labelRenderedSizeThreshold', 4);
						if (modeChanged) setLodHint(active ? 'focus · edges on' : 'detail · edges on');
					} else if (ratio < 0.55) {
						sigma.setSetting('renderLabels', true);
						sigma.setSetting('labelDensity', 0.2);
						sigma.setSetting('labelRenderedSizeThreshold', 9);
						if (modeChanged) setLodHint(active ? 'focus · edges on' : 'mid · edges on');
					} else {
						sigma.setSetting('renderLabels', active);
						sigma.setSetting('labelDensity', 0.08);
						sigma.setSetting('labelRenderedSizeThreshold', 14);
						if (modeChanged) setLodHint(active ? 'focus · edges on' : 'overview · edges on');
					}
					if (modeChanged) applyHighlightRef.current();
				};

				sigma.getCamera().on('updated', updateLod);
				updateLod();

				sigma.on('enterNode', ({ node }) => {
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
				sigma.on('clickNode', ({ node, event }) => {
					event.original.preventDefault();
					event.original.stopPropagation();
					addNodeToCanvasRef.current(node, { withNeighbors: true });
					focusNodeRef.current(node, {
						openEgo: Boolean(event.original.altKey || event.original.metaKey),
						animate: true,
						addIfMissing: false,
					});
				});
				sigma.on('doubleClickNode', ({ node, event }) => {
					event.preventSigmaDefault();
					focusNodeRef.current(node, { openEgo: true, addIfMissing: false });
				});
				sigma.on('clickStage', () => {
					if (focusedIdRef.current) clearFocusRef.current();
				});

				graphRef.current = graph;
				sigmaRef.current = sigma;
				focusedIdRef.current = null;
				pinnedIdRef.current = null;
				setFocus(null);
				setLodHint('blank · search to add');
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
	}, [destroySigma]);

	// Type filter only affects what search may add; wipe canvas when filter changes
	// so hidden-type nodes don't linger.
	useEffect(() => {
		if (status !== 'ready') return;
		const graph = graphRef.current;
		if (!graph || filter === 'all') return;
		const drop: string[] = [];
		graph.forEachNode((id, attrs) => {
			if (String(attrs.nodeType) !== filter) drop.push(id);
		});
		if (!drop.length) return;
		for (const id of drop) {
			try {
				graph.dropNode(id);
			} catch {
				// ignore
			}
			visibleIdsRef.current.delete(id);
		}
		if (focusedIdRef.current && drop.includes(focusedIdRef.current)) {
			pinnedIdRef.current = null;
			focusedIdRef.current = null;
			setFocus(null);
			syncGlobalRoute(null, null);
		}
		setVisibleCount(visibleIdsRef.current.size);
		applyHighlight();
		sigmaRef.current?.refresh();
	}, [filter, status, applyHighlight, syncGlobalRoute]);

	useEffect(() => {
		if (status !== 'ready') return;
		applyEdgeTypeFilter();
	}, [edgeTypesEnabled, status, applyEdgeTypeFilter]);

	// Deep-link: /global-graph/{type}/{crd} → add + focus when catalog is ready.
	useEffect(() => {
		if (status !== 'ready') return;
		if (!routeParams) {
			// Bare /global-graph — do not force-clear an in-session focus unless URL was cleared intentionally.
			routeBootstrapDoneRef.current = true;
			return;
		}

		const key = `${routeParams.type}:${routeParams.crd}`;
		if (appliedRouteKeyRef.current === key && focusedIdRef.current === routeParams.crd && graphRef.current?.hasNode(routeParams.crd)) {
			routeBootstrapDoneRef.current = true;
			return;
		}

		const tryApply = (attempt: number): void => {
			const graph = graphRef.current;
			const sigma = sigmaRef.current;
			const payload = layoutRef.current;
			if (!graph || !sigma || !payload) {
				if (attempt < 20) {
					window.setTimeout(() => tryApply(attempt + 1), 50);
				} else {
					setErrorMessage(`Map not ready for CRD ${routeParams.crd}`);
					routeBootstrapDoneRef.current = true;
				}
				return;
			}

			const meta = nodeIndexRef.current.get(routeParams.crd);
			if (!meta) {
				// Layout is a sampled catalog (smoke/full). Fall back: still try id, else show error.
				setErrorMessage(`CRD ${routeParams.crd} is not in the global layout catalog`);
				routeBootstrapDoneRef.current = true;
				return;
			}

			const canonicalType =
				meta.type === 'firm' ? 'firm'
				: meta.type === 'individual' ? 'individual'
				: routeParams.type;

			// Seed URL bookkeeping before focus so shallow replace does not re-enter as "new".
			lastRouteKeyRef.current = `${canonicalType}:${meta.id}`;

			const ok = focusNodeRef.current(meta.id, {
				animate: attempt === 0 && !routeBootstrapDoneRef.current,
				addIfMissing: true,
				syncUrl: false,
			});

			if (!ok) {
				if (attempt < 12) {
					window.setTimeout(() => tryApply(attempt + 1), 80);
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
			setQuery(meta.label || meta.id);
			routeBootstrapDoneRef.current = true;
		};

		tryApply(0);
	}, [status, routeParams, syncGlobalRoute]);

	const findHits = useCallback(
		(qRaw: string, limit = 12): LayoutNode[] => {
			const payload = layoutRef.current;
			const q = qRaw.trim().toLowerCase();
			if (!payload || !q) return [];
			const allow = (t: string) => filter === 'all' || t === filter;
			const scored: { n: LayoutNode; s: number }[] = [];
			for (const n of payload.nodes) {
				if (!allow(n.type)) continue;
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
		},
		[filter],
	);

	const findHit = useCallback(
		(qRaw: string) => {
			const hits = findHits(qRaw, 1);
			return hits[0] || null;
		},
		[findHits],
	);

	useEffect(() => {
		const q = query.trim();
		if (q.length < 2) {
			setSearchHits([]);
			return;
		}
		const t = window.setTimeout(() => setSearchHits(findHits(q, 10)), 120);
		return () => window.clearTimeout(t);
	}, [query, findHits]);

	const runFocusSearch = useCallback(() => {
		const hit = findHit(query);
		if (!hit) {
			setErrorMessage(`No node matching \u201c${query.trim()}\u201d in layout`);
			return;
		}
		const ok = focusNode(hit.id, { animate: true, addIfMissing: true });
		if (!ok) {
			setErrorMessage(`Could not add \u201c${hit.label}\u201d — try Show: All types`);
			return;
		}
		setSearchHits([]);
		setErrorMessage(null);
	}, [findHit, focusNode, query]);

	const runOpenEgo = useCallback(() => {
		const hit = findHit(query) || (focus ? layoutRef.current?.nodes.find((n) => n.id === focus.id) : null);
		if (!hit) {
			setErrorMessage('Select or search a node first');
			return;
		}
		const t = hit.type === 'firm' ? 'firm' : 'individual';
		void router.push(`/graph/${t}/${hit.id}`);
	}, [findHit, focus, query, router]);

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

	// When focus changes, hydrate the node-graph-style detail drawer.
	useEffect(() => {
		if (!focus) {
			setPanelSnapshot(null);
			return;
		}
		loadPanelForFocus(focus.id, focus.type, focus.label);
		setDrawerOpen(true);
		// Intentionally only re-run when the focused CRD changes (not when cache identity changes).
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [focus?.id]);

	const handleCenter = useCallback(() => {
		const sigma = sigmaRef.current;
		const id = focusedIdRef.current;
		if (!sigma) return;
		if (id && graphRef.current?.hasNode(id)) {
			attachCameraPin(id);
			return;
		}
		try {
			sigma.getCamera().animatedReset({ duration: 350 });
		} catch {
			// ignore
		}
	}, [attachCameraPin]);

	const handleResetSession = useCallback(() => {
		clearCanvas();
		clearSharedCache();
		setPanelSnapshot(null);
		setDrawerOpen(false);
		setSearchBanner(null);
		setQuery('');
		setSearchHits([]);
		setErrorMessage(null);
	}, [clearCanvas, clearSharedCache]);

	const handleSearchSubmit = useCallback(
		(e?: { preventDefault?: () => void }) => {
			e?.preventDefault?.();
			const q = query.trim();
			if (!q) return;
			setSearchLoading(true);
			const before = visibleIdsRef.current.size;
			runFocusSearch();
			// Banner after a tick so canvas counts update.
			window.setTimeout(() => {
				const added = Math.max(0, visibleIdsRef.current.size - before);
				if (added > 0 || focusedIdRef.current) {
					setSearchBanner({ query: q, count: Math.max(1, added) });
				}
				setSearchLoading(false);
			}, 80);
		},
		[query, runFocusSearch],
	);

	const dashboardHref = useMemo(() => {
		if (focus && /^\d+$/.test(focus.id)) {
			const t = focus.type === 'firm' ? 'firm' : 'individual';
			return `/${t}/${focus.id}`;
		}
		if (routeParams) return `/${routeParams.type}/${routeParams.crd}`;
		return '/';
	}, [focus, routeParams]);

	const panelActiveKey = panelSnapshot?.resolvedKey || panelSnapshot?.key || '';
	const panelDetailJson = panelSnapshot?.detailJson ?? null;
	const panelLoading = Boolean(panelSnapshot?.loading);
	const panelTitle = focus?.label || 'Details';

	const toggleEdgeType = (key: EdgeTypeKey) => {
		setEdgeTypesEnabled((prev) => ({ ...prev, [key]: !prev[key] }));
	};

	return (
		<>
			<Head>
				<title>{focus ? `${focus.label} • Global Map` : 'Global Map'} • FINRA / SEC</title>
			</Head>

			<div
				className={`node-graph-page fullscreen-mode theme-${theme} global-graph-webgl`}
				data-theme={theme}>
				<header className='fg-header'>
					<div className='fg-header-bar'>
						<div className='fg-header-brand'>
							<span className='fg-logo'>FINRA</span>
						</div>

						<div className='fg-header-controls'>
							<form
								className='fg-search fg-search--header'
								onSubmit={handleSearchSubmit}>
								<input
									className='fg-search-input'
									type='search'
									placeholder='firm, person, CRD/SEC#'
									value={query}
									onChange={(e) => setQuery(e.target.value)}
									aria-label='Search firm, person, or CRD'
									autoComplete='off'
									disabled={status !== 'ready' && status !== 'loading'}
								/>
								<button
									type='submit'
									className='fg-send-btn'
									aria-label='Search'
									disabled={status !== 'ready' || searchLoading}>
									➤
								</button>
							</form>
							{status === 'ready' && searchHits.length > 0 && (
								<ul className='gg-suggest-dropdown'>
									{searchHits.map((h) => (
										<li key={h.id}>
											<button
												type='button'
												className='gg-suggest-item'
												onClick={() => {
													setQuery(h.label || h.id);
													const before = visibleIdsRef.current.size;
													const ok = focusNode(h.id, { animate: true, addIfMissing: true });
													if (!ok) {
														setErrorMessage(`Could not add “${h.label}”`);
														return;
													}
													setSearchHits([]);
													setErrorMessage(null);
													const added = Math.max(1, visibleIdsRef.current.size - before);
													setSearchBanner({ query: h.label || h.id, count: added });
												}}>
												<span className='gg-suggest-label'>{h.label}</span>
												<span className='gg-suggest-meta'>
													{h.type} · {h.id}
													{h.regionGroup ? ` · ${h.regionGroup}` : ''}
												</span>
											</button>
										</li>
									))}
								</ul>
							)}
						</div>

						<div className={`fg-focus-readout${focus || hover ? ' fg-focus-readout--visible' : ''}`}>
							{focus ?
								<>
									<span className='fg-focus-readout__name'>{focus.label}</span>
									<span className='fg-focus-readout__crd'>CRD {focus.id}</span>
								</>
							: hover ?
								<>
									<span className='fg-focus-readout__name'>{hover.label}</span>
									<span className='fg-focus-readout__crd'>CRD {hover.id}</span>
								</>
							:	null}
						</div>

						<div className='fg-header-right-controls'>
							<select
								className='fg-type-filter'
								value={filter}
								onChange={(e) => setFilter(e.target.value as typeof filter)}
								aria-label='Filter node types'
								disabled={status !== 'ready' && status !== 'loading'}>
								<option value='all'>All types</option>
								<option value='firm'>Firms only</option>
								<option value='individual'>Individuals only</option>
							</select>
							<Link
								href={dashboardHref}
								className='fg-btn'
								title={dashboardHref === '/' ? 'Open dashboard' : `Open ${dashboardHref.replace(/^\//, '')} on dashboard`}>
								Dashboard
							</Link>
							{(focus || panelSnapshot) && (
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
					{(errorMessage || status === 'error') && status !== 'loading' && <div className='fg-search-error'>{errorMessage || 'Failed to load global layout'}</div>}
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

					{status === 'ready' && (
						<div
							className='gg-edge-strip'
							aria-label='Edge type filters'>
							<span className='gg-edge-strip-label'>Edges</span>
							{availableEdgeTypes.map((meta) => (
								<label
									key={meta.key}
									className={`gg-chip ${edgeTypesEnabled[meta.key] ? 'on' : ''}`}>
									<input
										type='checkbox'
										checked={edgeTypesEnabled[meta.key]}
										onChange={() => toggleEdgeType(meta.key)}
									/>
									{meta.label}
								</label>
							))}
							<span className='gg-lod-chip'>
								{visibleCount.toLocaleString()} on map · {lodHint}
							</span>
						</div>
					)}
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
										disabled={!focus}>
										Clear Highlight
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
							</>
						}
					</div>
				)}

				{(focus || panelSnapshot) && (
					<aside className={`node-detail-drawer${drawerOpen ? ' open' : ''}`}>
						<div className='sidebar-header'>
							<button
								type='button'
								className='drawer-close-btn'
								onClick={() => setDrawerOpen(false)}
								aria-label='Close details panel'>
								✕
							</button>
							<h1>{panelTitle}</h1>
							{focus && (
								<div className='role-rows'>
									<div className='role-row'>
										<span className='role-dot' />
										{focus.type} · deg {focus.degree} · neighbors {focus.neighborCount}
									</div>
									{focus.regionGroup && (
										<div className='role-row'>
											<span className='role-dot' />
											{focus.regionGroup}
											{focus.region ? ` · ${focus.region}` : ''}
										</div>
									)}
								</div>
							)}
							{panelSnapshot?.error ?
								<p className='fg-panel-error'>{panelSnapshot.error}</p>
							:	null}
							<div className='gg-drawer-links'>
								{focus && (
									<>
										<button
											type='button'
											className='fg-btn'
											onClick={() => {
												const t = focus.type === 'firm' ? 'firm' : 'individual';
												void router.push(`/graph/${t}/${focus.id}`);
											}}>
											Node Graph
										</button>
										<Link
											href={dashboardHref}
											className='fg-btn'>
											Dashboard
										</Link>
									</>
								)}
							</div>
						</div>

						<div className='sidebar-content'>
							<PanelHeader
								activeKey={panelActiveKey}
								payloads={[]}
								detailJson={panelDetailJson}
								onSelectKey={(key) => {
									const parts = String(key || '').split(':');
									const crd = parts[parts.length - 1];
									if (crd && /^\d+$/.test(crd)) {
										void focusNode(crd, { animate: true, addIfMissing: true });
									}
								}}
							/>
							<StatusBox
								statusMsg={panelSnapshot?.error || ''}
								statusHtml=''
								detailJson={panelDetailJson}
								panelLoading={panelLoading}
								activeKey={panelActiveKey}
								fetchLog={[]}
								onClearLog={() => {}}
								onSelectKey={(key) => {
									const parts = String(key || '').split(':');
									const crd = parts[parts.length - 1];
									if (crd && /^\d+$/.test(crd)) {
										void focusNode(crd, { animate: true, addIfMissing: true });
									}
								}}
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
				/* Hide app top-nav while global map is fullscreen (same as node graph). */
				.app-shell:has(.global-graph-webgl) > .top-nav {
					display: none;
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

				.fg-header {
					position: relative;
					display: flex;
					flex-direction: column;
					flex-shrink: 0;
					padding: 0;
					width: 100%;
					background: #0b1220;
					border-bottom: 1px solid rgba(148, 163, 184, 0.14);
					box-shadow: 0 2px 8px rgba(15, 23, 42, 0.35);
					z-index: 20;
				}
				.theme-light .fg-header {
					background: #ffffff;
					border-bottom-color: rgba(15, 23, 42, 0.1);
					box-shadow: 0 2px 8px rgba(15, 23, 42, 0.08);
				}
				.fg-header-bar {
					display: flex;
					align-items: center;
					gap: 5px;
					padding: 8px;
					min-height: 0;
					width: 100%;
					min-width: 0;
					flex-wrap: nowrap;
				}
				.fg-header-brand {
					display: flex;
					align-items: center;
					justify-content: flex-start;
					gap: 8px;
					min-width: 0;
					flex: 0 1 auto;
				}
				.fg-logo {
					font-weight: 800;
					letter-spacing: 0.06em;
					font-size: 0.95rem;
					line-height: 1;
					color: #f97316;
					padding: 0 6px 0 4px;
					user-select: none;
				}
				.fg-header-controls {
					display: flex;
					width: auto;
					flex: 0 0 auto;
					min-width: 0;
					margin-left: 0;
					flex-direction: row;
					align-items: center;
					justify-content: flex-start;
					gap: 8px;
					position: relative;
				}
				.fg-search,
				.fg-search--header {
					display: flex;
					align-items: center;
					gap: 8px;
					position: relative;
					min-width: 0;
				}
				.fg-search-input {
					font: 16px var(--font-sans, system-ui, -apple-system, sans-serif);
					width: min(280px, 100%);
					flex: 1 1 280px;
					min-width: 0;
					max-width: 280px;
					height: 36px;
					padding: 0 10px;
					border-radius: 2px;
					border: 1px solid rgba(148, 163, 184, 0.28);
					outline: none;
					background: rgba(255, 255, 255, 0.04);
					color: inherit;
					transition:
						border-color 0.15s,
						background 0.15s,
						box-shadow 0.15s;
				}
				.fg-search-input::placeholder {
					color: #64748b;
				}
				.fg-search-input::-webkit-search-cancel-button {
					-webkit-appearance: none;
				}
				.fg-search-input:focus {
					border-color: rgba(37, 99, 235, 0.55);
					background: rgba(255, 255, 255, 0.08);
					box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.14);
				}
				.theme-light .fg-search-input {
					background: #ffffff;
					border-color: rgba(15, 23, 42, 0.16);
					color: #0f172a;
				}
				.theme-light .fg-search-input:focus {
					background: #ffffff;
					border-color: rgba(37, 99, 235, 0.45);
					box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.12);
				}
				.fg-focus-readout {
					flex: 1 1 auto;
					display: flex;
					align-items: center;
					justify-content: flex-end;
					font-size: 14px;
					font-weight: 500;
					color: #94a3b8;
					padding: 0 16px;
					min-width: 0;
					text-align: right;
					white-space: nowrap;
					overflow: hidden;
					text-overflow: ellipsis;
					pointer-events: none;
					opacity: 0;
					transition: opacity 0.2s ease-in-out;
				}
				.fg-focus-readout--visible {
					opacity: 1;
				}
				.fg-focus-readout__name {
					color: #e2e8f0;
					margin-right: 8px;
					font-weight: 600;
					overflow: hidden;
					text-overflow: ellipsis;
				}
				.theme-light .fg-focus-readout {
					color: #64748b;
				}
				.theme-light .fg-focus-readout__name {
					color: #0f172a;
				}
				.fg-focus-readout__crd {
					font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
					font-size: 12px;
					opacity: 0.8;
					flex-shrink: 0;
				}
				.fg-header-right-controls {
					display: flex;
					align-items: center;
					justify-content: flex-end;
					gap: 8px;
					flex: 0 0 auto;
				}
				.fg-type-filter {
					height: 34px;
					padding: 0 8px;
					border-radius: 5px;
					border: 1px solid rgba(148, 163, 184, 0.28);
					background: rgba(255, 255, 255, 0.03);
					color: inherit;
					font-size: 12px;
					font-weight: 600;
				}
				.theme-light .fg-type-filter {
					background: #ffffff;
					border-color: rgba(15, 23, 42, 0.14);
					color: #0f172a;
				}
				.fg-btn {
					font: 600 13px/1 var(--font-sans, system-ui, -apple-system, sans-serif);
					padding: 6px 14px;
					min-height: 34px;
					display: inline-flex;
					align-items: center;
					justify-content: center;
					border-radius: 5px;
					border: 1px solid rgba(148, 163, 184, 0.28);
					background: rgba(255, 255, 255, 0.03);
					color: inherit;
					text-decoration: none;
					cursor: pointer;
					transition:
						background 0.15s,
						box-shadow 0.15s;
					-webkit-tap-highlight-color: transparent;
				}
				.fg-btn:hover {
					background: rgba(255, 255, 255, 0.08);
					box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
				}
				.theme-light .fg-btn {
					border-color: rgba(15, 23, 42, 0.14);
					background: #ffffff;
					color: #0f172a;
				}
				.theme-light .fg-btn:hover {
					background: #f8fafc;
					box-shadow: 0 1px 2px rgba(15, 23, 42, 0.08);
				}
				.fg-send-btn {
					width: 36px;
					height: 36px;
					min-width: 36px;
					border-radius: 5px;
					border: none;
					background: #2563eb;
					color: white;
					cursor: pointer;
					display: inline-flex;
					align-items: center;
					justify-content: center;
					font-size: 0.95rem;
					flex-shrink: 0;
					transition: background 0.15s;
				}
				.fg-send-btn:hover:not(:disabled) {
					background: #1d4ed8;
				}
				.fg-send-btn:disabled {
					opacity: 0.55;
					cursor: not-allowed;
				}
				.fg-hamburger-btn {
					width: 36px;
					height: 36px;
					min-width: 36px;
					border-radius: 5px;
					border: 1px solid rgba(148, 163, 184, 0.28);
					background: rgba(255, 255, 255, 0.03);
					color: inherit;
					font-size: 1rem;
					cursor: pointer;
					display: inline-flex;
					align-items: center;
					justify-content: center;
					transition:
						background 0.15s,
						border-color 0.15s;
				}
				.fg-hamburger-btn:hover {
					background: rgba(255, 255, 255, 0.08);
				}
				.fg-hamburger-btn.active {
					background: #2563eb;
					border-color: #2563eb;
					color: #ffffff;
					box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.18);
				}
				.theme-light .fg-hamburger-btn {
					border-color: rgba(15, 23, 42, 0.14);
					background: #ffffff;
				}
				.fg-search-error {
					padding: 0 12px 8px;
					color: #f87171;
					font-size: 0.8rem;
				}
				.fg-search-banner {
					position: absolute;
					top: calc(100% + 8px);
					left: 12px;
					z-index: 21;
					display: flex;
					align-items: center;
					gap: 10px;
					padding: 8px 12px;
					border-radius: 8px;
					border: 1px solid rgba(96, 165, 250, 0.4);
					background: rgba(30, 58, 138, 0.9);
					color: #bfdbfe;
					font-size: 0.8rem;
					box-shadow: 0 8px 20px rgba(0, 0, 0, 0.25);
				}
				.theme-light .fg-search-banner {
					border-color: rgba(37, 99, 235, 0.3);
					background: rgba(219, 234, 254, 0.98);
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
				@media (max-width: 720px) {
					.fg-focus-readout {
						display: none;
					}
					.fg-search-input {
						width: min(180px, 42vw);
						max-width: 180px;
						flex-basis: 180px;
					}
					.fg-type-filter {
						display: none;
					}
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
				.gg-edge-strip {
					position: absolute;
					left: 12px;
					top: 12px;
					z-index: 6;
					display: flex;
					flex-wrap: wrap;
					gap: 6px;
					align-items: center;
					max-width: min(720px, calc(100% - 24px));
					padding: 6px 8px;
					border-radius: 8px;
					background: rgba(13, 19, 31, 0.82);
					border: 1px solid rgba(255, 255, 255, 0.08);
					backdrop-filter: blur(6px);
				}
				.theme-light .gg-edge-strip {
					background: rgba(255, 255, 255, 0.9);
					border-color: rgba(0, 0, 0, 0.08);
				}
				.gg-edge-strip-label {
					font-size: 0.68rem;
					color: #64748b;
					text-transform: uppercase;
					letter-spacing: 0.06em;
					margin-right: 2px;
				}
				.gg-chip {
					display: inline-flex;
					align-items: center;
					gap: 5px;
					font-size: 0.72rem;
					color: #94a3b8;
					border: 1px solid rgba(148, 163, 184, 0.2);
					border-radius: 999px;
					padding: 2px 8px;
					cursor: pointer;
					user-select: none;
				}
				.gg-chip.on {
					color: #e2e8f0;
					border-color: rgba(34, 211, 238, 0.45);
					background: rgba(8, 145, 178, 0.15);
				}
				.theme-light .gg-chip.on {
					color: #0f172a;
				}
				.gg-chip input {
					margin: 0;
				}
				.gg-lod-chip {
					margin-left: 4px;
					font-size: 0.68rem;
					color: #64748b;
					white-space: nowrap;
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
				.node-detail-drawer {
					width: 410px;
					max-width: min(410px, 100vw);
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
					overflow-x: hidden;
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
				.node-detail-drawer .sidebar-content {
					padding: 16px 18px 20px;
				}
				.node-detail-drawer .sidebar-header {
					padding: 16px 18px;
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
				.fg-panel-error {
					margin: 8px 0 0;
					color: #f87171;
					font-size: 0.8rem;
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
				.gg-drawer-links {
					display: flex;
					flex-wrap: wrap;
					gap: 8px;
					margin-top: 10px;
				}
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
