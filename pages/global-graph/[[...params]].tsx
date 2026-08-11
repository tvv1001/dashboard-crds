import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type Graph from 'graphology';
import type Sigma from 'sigma';
import { forceSimulation, forceLink, forceManyBody, forceCollide, forceX, forceY } from 'd3-force';
import { useSharedGraphState } from '../../src/hooks/useSharedGraphState';
import { useLocalNameSearch } from '../../src/hooks/useLocalNameSearch';
import { PanelHeader } from '../../src/components/panel/PanelHeader';
import { StatusBox, type SelectionLogEntry } from '../../src/components/panel/StatusBox';
import type { LocalNameSearchResult } from '../../src/types';

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
	if (secNumber) return `${name} :: CRD# ${crd} / SEC# ${secNumber}`;
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

const INACTIVE_NODE_COLOR = '#64748b';
const INACTIVE_NODE_COLOR_DIM = '#475569';

function nodeDisplayColor(type: string, inactive?: boolean): string {
	if (inactive) return INACTIVE_NODE_COLOR;
	return type === 'firm' ? '#22d3ee' : '#0ea5e9';
}

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
const LAYOUT_SPREAD = 2.6;

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
	for (const [hub, kids] of childrenByHub) {
		const unique = Array.from(new Set(kids)).sort((a, b) => a.localeCompare(b));
		// Star ego: one ring (screenshot). Multi-hub maps keep staggered rings.
		const ringCount =
			// Person ego: single ring. Firm ego with many leaves: a few rings for readability.
			starEgo && hub === egoHubId ?
				egoIsPerson || unique.length <= 24 ? 1
				: unique.length > 120 ? 5
				: 3
			: unique.length > 400 ? 8
			: unique.length > 200 ? 7
			: unique.length > 80 ? 6
			: unique.length > 30 ? 5
			: 4;
		unique.forEach((child, i) => {
			childRingIndex.set(`${hub}|${child}`, i % ringCount);
			childSlotIndex.set(`${hub}|${child}`, i);
		});
	}

	const staggeredChildDistance = (hubId: string, childId: string, hubDeg: number) => {
		const ring = childRingIndex.get(`${hubId}|${childId}`) ?? hashString(childId) % 6;
		if (starEgo && hubId === egoHubId) {
			// Person ego: long even ring (left /graph). Firm ego: slightly tighter + multi-ring ok.
			const orbitBase = egoIsPerson ? 320 + Math.min(480, Math.sqrt(Math.max(hubDeg, 1)) * 56) : 240 + Math.min(400, Math.sqrt(Math.max(hubDeg, 1)) * 44);
			const jitter = ((hashString(`${hubId}:${childId}`) % 1000) / 999 - 0.5) * (egoIsPerson ? 18 : 32);
			if (egoIsPerson) return orbitBase + jitter;
			const ringStep = 70 + Math.min(60, hubDeg * 0.35);
			return orbitBase + ring * ringStep + jitter;
		}
		const orbitBase = 180 + Math.min(360, Math.sqrt(Math.max(hubDeg, 1)) * 42);
		const ringStep = 78 + Math.min(72, hubDeg * 0.45);
		const jitter = ((hashString(`${hubId}:${childId}`) % 1000) / 999 - 0.5) * 44;
		return orbitBase + ring * ringStep + jitter;
	};

	const baseCharge =
		starEgo ?
			egoIsPerson ? -720
			:	-980
		: dense ? -1800
		: mid ? -1400
		: -1100;
	const linkStrengthBase =
		starEgo ?
			egoIsPerson ? 0.55
			:	0.38
		: dense ? 0.14
		: mid ? 0.2
		: 0.28;
	const linkDistBase =
		starEgo ?
			egoIsPerson ? 380
			:	320
		: nCount > 300 ? 420
		: nCount > 150 ? 380
		: nCount > 80 ? 400
		: 460;
	const collidePad =
		starEgo ?
			egoIsPerson ? 28
			:	20
		: nCount > 300 ? 28
		: nCount > 120 ? 36
		: nCount > 60 ? 44
		: 52;
	const centerStrength =
		starEgo ? 0.02
		: dense ? 0.0006
		: mid ? 0.001
		: 0.0022;
	// Star ego stays circular (left /graph). Progressive multi-hub maps flatten Y.
	const yFlatten = starEgo ? 1 : 0.55;

	let cx = 0;
	let cy = 0;
	pts.forEach((p) => {
		cx += p.x;
		cy += p.y;
	});
	cx /= pts.length;
	cy /= pts.length;

	const firmHubIds = pts.filter((p) => p.firm && p.degree >= 4).map((p) => p.id);
	const firmHubSeparation = (alpha: number) => {
		if (firmHubIds.length < 2) return;
		const minDistBase =
			dense ? 620
			: mid ? 540
			: 480;
		for (let i = 0; i < firmHubIds.length; i++) {
			const a = nodeById.get(firmHubIds[i]);
			if (!a) continue;
			for (let j = i + 1; j < firmHubIds.length; j++) {
				const b = nodeById.get(firmHubIds[j]);
				if (!b) continue;
				let dx = (b.x ?? 0) - (a.x ?? 0);
				let dy = (b.y ?? 0) - (a.y ?? 0);
				let dist = Math.hypot(dx, dy);
				const need = minDistBase + Math.sqrt(Math.max(a.degree, 1)) * 24 + Math.sqrt(Math.max(b.degree, 1)) * 24;
				if (dist >= need) continue;
				if (dist < 1e-6) {
					const ang = ((hashString(`${a.id}|${b.id}`) % 1000) / 999) * Math.PI * 2;
					dx = Math.cos(ang);
					dy = Math.sin(ang);
					dist = 1;
				}
				const push = ((need - dist) / need) * alpha * 0.85;
				const ux = (dx / dist) * push;
				const uy = (dy / dist) * push;
				a.vx = (a.vx ?? 0) - ux;
				a.vy = (a.vy ?? 0) - uy;
				b.vx = (b.vx ?? 0) + ux;
				b.vy = (b.vy ?? 0) + uy;
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
			// Star ego: pin every spoke leaf to the circle even if degree is high.
			if (!starEgo && (hub.degree < 4 || child.degree > 4)) continue;
			if (starEgo && hubId !== egoHubId) continue;
			const targetDist = staggeredChildDistance(hubId, childId, Math.max(hub.degree, childrenByHub.get(hubId)?.length || 1));
			const slot = childSlotIndex.get(key) ?? 0;
			const kids = childrenByHub.get(hubId)?.length || 1;
			const angle = (slot / Math.max(kids, 1)) * Math.PI * 2 + (starEgo ? 0 : ring * 0.17);
			const tx = (hub.x ?? 0) + Math.cos(angle) * targetDist;
			const ty = (hub.y ?? 0) + Math.sin(angle) * targetDist * yFlatten;
			const strength =
				(starEgo ?
					egoIsPerson ? 0.72
					:	0.48
				: dense ? 0.1
				: mid ? 0.14
				: 0.18) * alpha;
			child.vx = (child.vx ?? 0) + (tx - (child.x ?? 0)) * strength;
			child.vy = (child.vy ?? 0) + (ty - (child.y ?? 0)) * strength;
		}
	};

	// Keep the ego person fixed at the star center (reference screenshot).
	const pinEgoHub = () => {
		if (!starEgo || !egoHubId) return;
		const hub = nodeById.get(egoHubId);
		if (!hub) return;
		hub.fx = hub.x;
		hub.fy = hub.y;
		hub.vx = 0;
		hub.vy = 0;
	};
	pinEgoHub();

	let tickCount = 0;
	const sim = forceSimulation(pts)
		.alpha(dense ? 0.22 : 0.28)
		.alphaMin(0.001)
		.alphaDecay(
			dense ? 0.022
			: mid ? 0.016
			: 0.012,
		)
		.velocityDecay(dense || mid ? 0.52 : 0.48)
		.force(
			'charge',
			forceManyBody()
				.strength((d: any) => {
					const deg = d.degree || 1;
					if (d.firm) {
						const hubMul =
							deg > 80 ? 3.2
							: deg > 20 ? 2.5
							: 2.0;
						return baseCharge * hubMul;
					}
					const leaf =
						deg <= 2 ? 1.4
						: deg <= 4 ? 1.15
						: 1;
					return (deg > 20 ? 1.8 * baseCharge : baseCharge) * leaf;
				})
				.distanceMax(
					dense ? 1400
					: mid ? 1200
					: 1000,
				)
				.theta(dense || mid ? 0.86 : 0.78),
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

					if (s.firm && t.firm) {
						return linkDistBase * 2.4 + Math.sqrt(sDeg) * 32 + Math.sqrt(tDeg) * 32;
					}

					const childIsLeaf = Math.min(sDeg, tDeg) <= 3;
					const stagger = childIsLeaf && hubDeg >= 4 ? staggeredChildDistance(hubId, childId, hubDeg) : 0;
					const degScale =
						hubDeg > 100 ? 1.7
						: hubDeg > 50 ? 1.45
						: hubDeg > 20 ? 1.25
						: 1.1;
					return stagger > 0 ? stagger : linkDistBase * degScale;
				})
				.strength((d: any) => {
					const s = typeof d.source === 'object' ? d.source : nodeById.get(d.source);
					const t = typeof d.target === 'object' ? d.target : nodeById.get(d.target);
					if (s?.firm && t?.firm) return linkStrengthBase * 0.32;
					const deg = Math.max(s?.degree || 1, t?.degree || 1);
					if (deg > 80) return linkStrengthBase * 0.4;
					if (deg > 20) return linkStrengthBase * 0.6;
					return linkStrengthBase;
				}),
		)
		.force(
			'collide',
			forceCollide()
				.radius((d: any) => {
					const deg = d.degree || 1;
					const hubHalo = d.firm ? Math.min(180, 48 + Math.sqrt(deg) * 12) : 0;
					const leafBoost =
						deg <= 2 ? 18
						: deg <= 4 ? 10
						: 0;
					return collidePad + leafBoost + hubHalo + Math.min(28, Math.sqrt(deg) * 3);
				})
				.strength(1)
				.iterations(dense || mid ? 3 : 2),
		)
		.force('x', forceX(starEgo && egoHubId ? (nodeById.get(egoHubId)?.x ?? cx) : cx).strength(centerStrength))
		// Stronger Y pull + weaker Y motion keeps multi-hub maps flatter; star stays circular.
		.force('y', forceY(starEgo && egoHubId ? (nodeById.get(egoHubId)?.y ?? cy) : cy).strength(starEgo ? centerStrength : centerStrength * 2.4))
		.force('firm-separate', (starEgo ? () => undefined : firmHubSeparation) as any)
		.force('ring-orbit', ringOrbitForce as any)
		.on('tick', () => {
			tickCount += 1;
			pinEgoHub();
			// Flatten residual vertical motion so multi-hub layouts settle wide.
			if (!starEgo) {
				for (const p of pts) {
					if (typeof p.vy === 'number') p.vy *= yFlatten;
				}
			}
			// While hot, skip every other paint (same cadence as /graph).
			if (sim.alpha() > 0.15 && tickCount % 2 !== 0) return;
			for (const p of pts) {
				graph.setNodeAttribute(p.id, 'x', p.x);
				graph.setNodeAttribute(p.id, 'y', p.y);
			}
			try {
				sigma.refresh();
			} catch {
				sim.stop(); // Canvas unmounted
			}
		})
		.on('end', () => {
			globalLayoutAnimId = null;
		});

	globalLayoutAnimId = sim;
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

function dynamicNodeSize(degree: number, type: string): number {
	return 22;
}

/** Stamp display sizes onto layout nodes once (collision uses node size). */
function bakeDisplaySizes(payload: LayoutPayload): LayoutPayload {
	for (const n of payload.nodes) {
		n.size = dynamicNodeSize(Number(n.degree) || 1, String(n.type || 'unknown'));
	}
	return payload;
}

/** Thin progressive-map edges — always drawn; alpha stays low so stacks stay readable. */
function edgeBaseSize(weight?: number): number {
	// ~half of prior stroke so lines stay hairline even when many stack.
	return Math.min(0.055, 0.012 + (Number(weight) || 1) * 0.0025);
}

function edgeColor(edgeType: string, isDimmed: boolean) {
	if (edgeType === 'employment' || edgeType === 'firm_link') {
		return isDimmed ? 'rgba(59, 130, 246, 0.15)' : 'rgba(59, 130, 246, 0.55)'; // #3b82f6 (blue)
	}
	if (edgeType === 'previous_employment') {
		return isDimmed ? 'rgba(239, 68, 68, 0.15)' : 'rgba(239, 68, 68, 0.55)'; // #ef4444 (red)
	}
	return isDimmed ? 'rgba(100, 116, 139, 0.08)' : 'rgba(100, 116, 139, 0.25)';
}

/** Solid blue stroke for edges incident to the current selection (no dashes). */
const SELECTED_EDGE_COLOR = 'rgba(56,189,248,1)';
/** Previous/former spokes when a firm is focused alone (deep-link reveal). */
const SELECTED_PREVIOUS_EDGE_COLOR = 'rgba(248,113,113,0.92)';
/** Screen-pixel thickness for selected hub→child spokes (itemSizesReference: screen). */
const SELECTED_EDGE_SIZE = 2.8;
const SELECTED_EDGE_SIZE_MAX = 4.2;

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
	/** Drives Clear Highlight enablement for multi-select (ref alone doesn't re-render). */
	const [selectionCount, setSelectionCount] = useState(0);
	const [query, setQuery] = useState('');
	const [lodHint, setLodHint] = useState('blank · search to add');
	const [visibleCount, setVisibleCount] = useState(0);
	const [theme, setTheme] = useState<'dark' | 'light'>('dark');
	const [toolbarMinimized, setToolbarMinimized] = useState(false);
	const [drawerOpen, setDrawerOpen] = useState(false);
	const [searchLoading, setSearchLoading] = useState(false);
	const [searchBanner, setSearchBanner] = useState<{ query: string; count: number } | null>(null);
	/** Same Redis name-search path as dashboard bottom panel (`useLocalNameSearch` → `/api/redis-search`). */
	const { search: searchRedisNames, setQuery: setNameSearchQuery } = useLocalNameSearch();
	const [panelSnapshot, setPanelSnapshot] = useState<{
		key: string;
		resolvedKey: string;
		detailJson: string | null;
		loading: boolean;
		error: string;
	} | null>(null);
	const [selectionLog, setSelectionLog] = useState<SelectionLogEntry[]>([]);
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
			opts?: { openEgo?: boolean; animate?: boolean; addIfMissing?: boolean; syncUrl?: boolean; withNeighbors?: boolean | 'firms' | 'all' | 'none'; fetchExpand?: boolean },
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

		const litNodeIds = new Set<string>();
		for (const id of selectedHubIds) litNodeIds.add(id);
		if (hoverId && graph.hasNode(hoverId)) litNodeIds.add(hoverId);

		const hasSelectionOrHover = selectedHubIds.size > 0 || Boolean(hoverId && graph.hasNode(hoverId));

		// Collect endpoints of emphasized edges so parent firm stays lit for a child pick.
		if (hasSelectionOrHover) {
			graph.forEachEdge((edge, attrs, source, target) => {
				const et = normalizeEdgeType(String(attrs.edgeType || ''));
				const typeOn = edgeTypesEnabledRef.current[et] !== false && !attrs.filterHidden && !attrs.typeHidden;
				if (!typeOn) return;
				if (isEmphasizedEdge(source, target, attrs as Record<string, unknown>)) {
					litNodeIds.add(source);
					litNodeIds.add(target);
				}
			});
		}

		const enabled = edgeTypesEnabledRef.current;

		const darkenHex = (c: string) => {
			if (!c.startsWith('#') || (c.length !== 7 && c.length !== 4)) return '#334155';
			let hex = c.length === 4 ? '#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3] : c;
			const r = Math.floor(parseInt(hex.slice(1, 3), 16) * 0.45);
			const g = Math.floor(parseInt(hex.slice(3, 5), 16) * 0.45);
			const b = Math.floor(parseInt(hex.slice(5, 7), 16) * 0.45);
			return `rgb(${r},${g},${b})`;
		};

		// Nodes always sit above edges (edge zIndex stays < 0; nodes >= 2).
		// Size is always STATIC_NODE_SIZE — never grow/shrink on select/hover.
		// Inactive hubs stay slate-gray (still selectable / expandable).
		graph.forEachNode((node, attrs) => {
			const inactive = attrs.inactive === true;
			const baseColor = inactive ? INACTIVE_NODE_COLOR : String(attrs.baseColor || attrs.color || '#94a3b8');
			const isVisited = visited.has(node);
			const displayBaseColor =
				inactive ?
					isVisited ? INACTIVE_NODE_COLOR_DIM
					:	INACTIVE_NODE_COLOR
				: isVisited ? darkenHex(baseColor)
				: baseColor;

			if (!hasSelectionOrHover) {
				graph.setNodeAttribute(node, 'color', displayBaseColor);
				graph.setNodeAttribute(node, 'zIndex', 2);
				graph.setNodeAttribute(node, 'forceLabel', false);
				graph.setNodeAttribute(node, 'pinned', false);
				return;
			}
			const on = litNodeIds.has(node);
			if (on) {
				const isSelected = selected.has(node) || node === focusId;
				const isHoverCenter = node === hoverId;
				const highlight = isSelected || isHoverCenter;
				// Keep inactive nodes gray even when selected/hovered (dashboard parity).
				const litColor =
					inactive ?
						isSelected || isHoverCenter ?
							INACTIVE_NODE_COLOR
						:	displayBaseColor
					: isHoverCenter ? baseColor
					: isSelected ? darkenHex(baseColor)
					: displayBaseColor;
				graph.setNodeAttribute(node, 'color', litColor);
				graph.setNodeAttribute(
					node,
					'zIndex',
					isSelected ? 5
					: isHoverCenter ? 4
					: 3,
				);
				graph.setNodeAttribute(node, 'forceLabel', highlight || graph.degree(node) > 8);
				graph.setNodeAttribute(node, 'pinned', isSelected);
			} else {
				// Dim color only — keep full opacity so edge lines cannot show through disks.
				graph.setNodeAttribute(
					node,
					'color',
					inactive ? '#334155'
					: isVisited ? '#1e293b'
					: '#334155',
				);
				graph.setNodeAttribute(node, 'zIndex', 2);
				graph.setNodeAttribute(node, 'forceLabel', false);
				graph.setNodeAttribute(node, 'pinned', false);
			}
		});

		// No selection: all type-enabled edges stay thin/visible.
		// With selection(s)/hover: emphasize only the allowed spokes; fade the rest.
		graph.forEachEdge((edge, attrs, source, target) => {
			const et = normalizeEdgeType(String(attrs.edgeType || ''));
			const typeOn = enabled[et] !== false && !attrs.filterHidden && !attrs.typeHidden;
			if (!typeOn) {
				graph.setEdgeAttribute(edge, 'hidden', true);
				return;
			}

			const baseSize = Number(attrs.baseSize) > 0 ? Number(attrs.baseSize) : edgeBaseSize(Number(attrs.weight));
			const attrsRec = attrs as Record<string, unknown>;
			const disabled = isDisabledEdge(attrsRec, source, target);
			const previous = isPreviousEdge(attrsRec);
			const emphasize = hasSelectionOrHover && !disabled && isEmphasizedEdge(source, target, attrsRec);

			graph.setEdgeAttribute(edge, 'hidden', false);

			if (hasSelectionOrHover) {
				if (emphasize) {
					// Current: bright cyan spokes. Previous: red spokes (parity with /graph).
					// zIndex stays negative so edges never climb above node disks.
					const weightBoost = Math.min(1.4, 1 + (Number(attrs.weight) || 1) * 0.04);
					const spokeSize = Math.min(SELECTED_EDGE_SIZE_MAX, SELECTED_EDGE_SIZE * weightBoost * (previous ? 0.92 : 1));
					graph.setEdgeAttribute(edge, 'type', 'line');
					graph.setEdgeAttribute(edge, 'color', previous ? SELECTED_PREVIOUS_EDGE_COLOR : SELECTED_EDGE_COLOR);
					graph.setEdgeAttribute(edge, 'zIndex', previous ? -2 : -1);
					graph.setEdgeAttribute(edge, 'size', spokeSize);
				} else {
					const ego = egoModeRef.current;
					// Person/firm ego: hide non-spoke edges entirely (no firm↔firm mesh).
					if (ego && (ego.kind === 'person-firms' || ego.kind === 'firm-star')) {
						graph.setEdgeAttribute(edge, 'hidden', true);
						graph.setEdgeAttribute(edge, 'size', 0);
						return;
					}
					// Progressive map: fade other lines hard so selected spokes read clearly.
					graph.setEdgeAttribute(edge, 'type', 'line');
					graph.setEdgeAttribute(edge, 'color', disabled || previous ? 'rgba(100,116,139,0.06)' : 'rgba(100,116,139,0.04)');
					graph.setEdgeAttribute(edge, 'zIndex', -3);
					graph.setEdgeAttribute(edge, 'size', Math.max(0.4, Math.min(1.1, baseSize > 1 ? baseSize * 0.35 : 0.55)));
				}
				return;
			}

			graph.setEdgeAttribute(edge, 'type', 'line');
			graph.setEdgeAttribute(edge, 'color', edgeColor(String(attrs.edgeType || 'employment'), false));
			graph.setEdgeAttribute(edge, 'zIndex', -2);
			graph.setEdgeAttribute(edge, 'size', baseSize);
		});

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
			// Restore base geometry if highlight isn't about to repaint.
			const attrs = graph.getNodeAttributes(nodeId);
			const baseColor = String(attrs.baseColor || attrs.color || '#94a3b8');
			if (focusedIdRef.current !== nodeId && hoverIdRef.current !== nodeId && !selectedIdsRef.current.has(nodeId)) {
				graph.setNodeAttribute(nodeId, 'color', baseColor);
				graph.setNodeAttribute(nodeId, 'zIndex', 2);
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

	const ensureNodeOnGraph = useCallback((n: LayoutNode, pos?: { x: number; y: number }): boolean => {
		const graph = graphRef.current;
		if (!graph) return false;

		const inactive = Boolean(n.inactive);
		const finalColor = nodeDisplayColor(n.type, inactive);
		const size = dynamicNodeSize(Number(n.degree) || 1, n.type);

		if (graph.hasNode(n.id)) {
			// Refresh label/inactive when expand or deep-link hydrates metadata.
			if (n.label) graph.setNodeAttribute(n.id, 'label', n.label);
			if (inactive) {
				graph.setNodeAttribute(n.id, 'inactive', true);
				graph.setNodeAttribute(n.id, 'color', finalColor);
				graph.setNodeAttribute(n.id, 'baseColor', finalColor);
			} else if (graph.getNodeAttribute(n.id, 'inactive') !== true) {
				graph.setNodeAttribute(n.id, 'inactive', false);
				graph.setNodeAttribute(n.id, 'baseColor', finalColor);
			}
			if (typeof n.degree === 'number') graph.setNodeAttribute(n.id, 'degree', n.degree);
			visibleIdsRef.current.add(n.id);
			return false;
		}

		graph.addNode(n.id, {
			label: n.label,
			x: pos ? pos.x : n.x * LAYOUT_SPREAD,
			// Slight vertical compress on baked coords so the map opens wider than tall.
			y: pos ? pos.y : n.y * LAYOUT_SPREAD * 0.72,
			size,
			baseSize: size,
			color: finalColor,
			baseColor: finalColor,
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
			// Single undirected edge per pair (layout + expand merges).
			if (graph.hasEdge(e.source, e.target) || graph.hasEdge(e.target, e.source)) {
				// Upgrade attributes if a previous spoke replaces a generic edge.
				try {
					const existing = graph.hasEdge(e.source, e.target) ? graph.edge(e.source, e.target) : graph.edge(e.target, e.source);
					const isPrevious = /previous|former|prior/i.test(String(e.type || ''));
					if (existing && isPrevious) {
						graph.setEdgeAttribute(existing, 'edgeType', e.type || 'employment');
						graph.setEdgeAttribute(existing, 'isCurrent', false);
						graph.setEdgeAttribute(existing, 'inactive', true);
						graph.setEdgeAttribute(existing, 'color', edgeColor(e.type || 'previous_employment', false));
					}
				} catch {
					// ignore
				}
				return false;
			}
			const enabled = edgeTypesEnabledRef.current;
			const et = normalizeEdgeType(e.type);
			const size = edgeBaseSize(e.weight);
			const isPrevious = /previous|former|prior/i.test(String(e.type || ''));
			const edgeKey = e.id || `${e.source}:${e.target}`;
			try {
				graph.addEdgeWithKey(edgeKey, e.source, e.target, {
					weight: e.weight,
					size,
					baseSize: size,
					// Sigma render type: solid straight segment (not dashed/dotted).
					type: 'line',
					color: edgeColor(e.type || 'employment', false),
					edgeType: e.type || 'employment',
					isCurrent: !isPrevious,
					inactive: isPrevious,
					filterHidden: false,
					hidden: false,
					typeHidden: enabled[et] === false,
					zIndex: -2,
				});
				return true;
			} catch {
				return false;
			}
		},
		[edgeAllowedInEgo],
	);

	/**
	 * Neighbor policy:
	 * - person/individual → bring attached firm nodes
	 * - firm → alone (no auto employees), unless caller asks for 'all'/'firms'
	 */
	const resolveNeighborMode = useCallback((seedType: string, withNeighbors?: boolean | 'firms' | 'all' | 'none'): 'none' | 'firms' | 'all' => {
		if (withNeighbors === 'none' || withNeighbors === false) return 'none';
		if (withNeighbors === 'firms') return 'firms';
		if (withNeighbors === 'all' || withNeighbors === true) return 'all';
		// Default by entity type when option omitted.
		return seedType === 'firm' ? 'none' : 'firms';
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
				candidates.sort((a, b) => {
					const aPrev = /previous|former|prior/i.test(a.edge.type) ? 0 : 1;
					const bPrev = /previous|former|prior/i.test(b.edge.type) ? 0 : 1;
					return bPrev - aPrev || b.weight - a.weight || a.id.localeCompare(b.id);
				});
				const seen = new Set<string>();
				const hubDeg = Math.max(1, Number(seed.degree) || candidates.length || 1);
				// Star ego: single circular ring (left app). Firm-all uses staggered rings for large staff.
				const ringCount =
					starEgoSeed ? 1
					: candidates.length > 200 ? 7
					: candidates.length > 80 ? 6
					: candidates.length > 30 ? 5
					: 4;
				const orbitBase =
					starEgoSeed ? 340 + Math.min(420, Math.sqrt(hubDeg) * 52)
					: firmStarSeed ? 220 + Math.min(360, Math.sqrt(hubDeg) * 42)
					: 160 + Math.min(320, Math.sqrt(hubDeg) * 40);
				const ringStep = 72 + Math.min(64, hubDeg * 0.4);
				const yScale =
					starEgoSeed ? 1
					: firmStarSeed ? 1
					: 0.55;
				let hubX = seed.x * LAYOUT_SPREAD;
				let hubY = seed.y * LAYOUT_SPREAD * (starEgoSeed || firmStarSeed ? 1 : 0.72);
				if (graph.hasNode(nodeId)) {
					hubX = Number(graph.getNodeAttribute(nodeId, 'x')) || hubX;
					hubY = Number(graph.getNodeAttribute(nodeId, 'y')) || hubY;
				}
				const placeCap = Math.min(candidates.length, neighborLimit);
				let slot = 0;
				for (const c of candidates) {
					if (seen.has(c.id)) continue;
					seen.add(c.id);
					if (seen.size > neighborLimit) break;
					const meta = nodeIndexRef.current.get(c.id);
					if (!meta) continue;
					const ring = slot % ringCount;
					const angle = (slot / Math.max(placeCap, 1)) * Math.PI * 2 + (starEgoSeed ? 0 : ring * 0.17);
					const dist =
						starEgoSeed ?
							orbitBase + ((hashString(`${nodeId}:${c.id}`) % 1000) / 999 - 0.5) * 20
						:	orbitBase + ring * ringStep + ((hashString(`${nodeId}:${c.id}`) % 1000) / 999 - 0.5) * 36;
					const pos = {
						x: hubX + Math.cos(angle) * dist,
						y: hubY + Math.sin(angle) * dist * yScale,
					};
					// Star: re-seat leaves onto the ring even if already on canvas.
					if (starEgoSeed || firmStarSeed || !graph.hasNode(c.id)) {
						if (ensureNodeOnGraph(meta, pos)) added++;
						else if (graph.hasNode(c.id)) {
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

			// Materialize edges:
			// - ego modes: only spokes involving the hub (already mostly done above)
			// - progressive map: edges between any pair of visible nodes
			const ego = egoModeRef.current;
			if (ego && (ego.kind === 'person-firms' || ego.kind === 'firm-star')) {
				const list = edgesByNodeRef.current.get(ego.hubId) || [];
				for (const e of list) {
					if (visibleIdsRef.current.has(e.source) && visibleIdsRef.current.has(e.target)) {
						ensureEdgeOnGraph(e);
					}
				}
				pruneEdgesToEgoSpokes(ego.hubId, ego.kind);
			} else {
				for (const id of visibleIdsRef.current) {
					const list = edgesByNodeRef.current.get(id) || [];
					for (const e of list) {
						if (visibleIdsRef.current.has(e.source) && visibleIdsRef.current.has(e.target)) {
							ensureEdgeOnGraph(e);
						}
					}
				}
			}

			// Automatically mark visited if all catalog neighbors are already visible
			for (const id of visibleIdsRef.current) {
				const list = edgesByNodeRef.current.get(id) || [];
				const hasUnrevealed = list.some((e) => {
					const other = e.source === id ? e.target : e.source;
					return !visibleIdsRef.current.has(other);
				});
				if (!hasUnrevealed) {
					visitedIdsRef.current.add(id);
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
		[applyHighlight, edgeAllowedInEgo, ensureEdgeOnGraph, ensureNodeOnGraph, pruneEdgesToEgoSpokes, resolveNeighborMode],
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
			sigma.getCamera().animatedReset({ duration: 280 });
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
			},
		) => {
			const graph = graphRef.current;
			const sigma = sigmaRef.current;
			const payload = layoutRef.current;
			if (!graph || !sigma || !payload) return false;

			const catalogMeta = nodeIndexRef.current.get(nodeId);
			const seedTypeHint =
				catalogMeta?.type === 'firm' ? 'firm'
				: catalogMeta?.type === 'individual' ? 'individual'
				: graph.hasNode(nodeId) ? String(graph.getNodeAttribute(nodeId, 'nodeType') || 'unknown')
				: 'unknown';
			// Person → firms; firm → alone unless caller overrides ('all' for deep-link firm).
			const neighborOpt =
				opts?.withNeighbors !== undefined ? opts.withNeighbors
				: seedTypeHint === 'firm' ? 'none'
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

			// Multi-select: keep previous hubs; only unlock camera pin when leaving a node
			// that is no longer in the selection set (should not happen for prior picks).
			const prevPinned = pinnedIdRef.current;
			if (prevPinned && prevPinned !== nodeId && !selectedIdsRef.current.has(prevPinned)) {
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
			selectedIdsRef.current.add(nodeId);
			visitedIdsRef.current.add(nodeId);
			setSelectionCount(selectedIdsRef.current.size);
			// Ensure every selected hub stays marked pinned for camera/render.
			for (const id of selectedIdsRef.current) {
				if (graph.hasNode(id)) graph.setNodeAttribute(id, 'pinned', true);
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

			// Fetch connections for the selected node. Person → materialize firm neighbors;
			// firm + 'all' (deep-link) → paint full direct star including previous edges.
			const fetchId = attrs.nodeType === 'firm' ? `firm:${nodeId}` : `individual:${nodeId}`;
			const expandNeighborMode = resolveNeighborMode(String(attrs.nodeType || seedTypeHint), neighborOpt);
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
								x: basex / LAYOUT_SPREAD + (Math.random() - 0.5) * 10,
								y: basey / LAYOUT_SPREAD + (Math.random() - 0.5) * 10,
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
							g.setNodeAttribute(nodeId, 'inactive', true);
							g.setNodeAttribute(nodeId, 'baseColor', INACTIVE_NODE_COLOR);
							g.setNodeAttribute(nodeId, 'color', INACTIVE_NODE_COLOR);
							if (n.label) g.setNodeAttribute(nodeId, 'label', n.label);
							changed = true;
						}
					}

					for (const e of data.links) {
						const sCrd = String(e.source).split(':').pop() || '';
						const tCrd = String(e.target).split(':').pop() || '';
						if (!sCrd || !tCrd) continue;
						const rel = String(e.relationship || e.edgeType || 'employment');
						const isCurrent = e.isCurrent !== false && !/previous|former|prior/i.test(rel);
						const edgeObj: LayoutEdge & { isCurrent?: boolean; inactive?: boolean } = {
							id: `${sCrd}:${tCrd}:${rel}`,
							source: sCrd,
							target: tCrd,
							type:
								isCurrent ? rel
								: rel.includes('previous') ? rel
								: `previous_${rel}`,
							weight: Number(e.weight) || 1,
						};

						const listS = edgesByNodeRef.current.get(sCrd) || [];
						if (!listS.find((x) => x.source === sCrd && x.target === tCrd && x.type === edgeObj.type)) {
							listS.push(edgeObj);
							edgesByNodeRef.current.set(sCrd, listS);
							changed = true;
						}
						const listT = edgesByNodeRef.current.get(tCrd) || [];
						if (sCrd !== tCrd && !listT.find((x) => x.source === sCrd && x.target === tCrd && x.type === edgeObj.type)) {
							listT.push(edgeObj);
							edgesByNodeRef.current.set(tCrd, listT);
							changed = true;
						}
					}
					// Always re-materialize with policy: person paints firms; firm stays alone
					// unless expandNeighborMode is 'all' (firm deep-link → all direct, incl. previous).
					// Person star (ref): pull a large firm ring (~employment list size).
					addNodeToCanvasRef.current(nodeId, {
						withNeighbors: expandNeighborMode,
						neighborLimit:
							expandNeighborMode === 'firms' ? 160
							: expandNeighborMode === 'all' ? 280
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

			const withNeighbors = type === 'firm' ? 'none' : 'firms';
			const ok = focusNode(crd, {
				animate: true,
				addIfMissing: true,
				withNeighbors,
				fetchExpand: true,
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
		// Keep nodes on canvas; bare /global-graph while map stays populated.
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

				const [{ default: GraphCtor }, { default: SigmaCtor }] = await Promise.all([import('graphology'), import('sigma')]);
				if (cancelled || !containerRef.current) return;

				// Blank graph — search adds nodes onto the canvas.
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
					zoomToSizeRatioFunction: (ratio) => ratio,
					// Clamp every node to STATIC_NODE_SIZE on each indexation (overrides any
					// stale size/baseSize and ignores degree/weight in the data path).
					nodeReducer: (_id, attrs) => ({
						...attrs,
						zIndex: Math.max(2, Number(attrs.zIndex) || 0),
					}),
					// Labels use fixed CSS px via drawLabelAbove; keep threshold low so they stay on.
					labelRenderedSizeThreshold: 0,
					labelDensity: 0.55,
					labelGridCellSize: 120,
					labelSize: 12,
					labelFont: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif',
					labelWeight: '600',
					labelColor: { color: '#e2e8f0' },
					defaultDrawNodeLabel: (context, data, settings) => {
						drawLabelAbove(context, data as any, settings as any, { hover: false, recordHit: true });
					},
					defaultDrawNodeHover: (context, data, settings) => {
						// Hover disc uses the actual screen-rendered size.
						const size = (data as any).size;
						const x = Number((data as any).x) || 0;
						const y = Number((data as any).y) || 0;

						// Vector ring instead of solid heavy circle
						context.beginPath();
						context.arc(x, y, size + 3.5, 0, Math.PI * 2);
						context.closePath();
						context.lineWidth = 2.5;
						context.strokeStyle = String((data as any).color || '#f8fafc');
						context.stroke();

						drawLabelAbove(context, data as any, settings as any, { hover: true, recordHit: true });
					},
					defaultEdgeColor: 'rgba(100,116,139,0.03)',
					defaultEdgeType: 'line',
					defaultNodeColor: '#22d3ee',
					minCameraRatio: 0.004,
					maxCameraRatio: 40,
					zIndex: true,
				});
				// Re-assert after construct — some Sigma paths re-merge defaults once.
				sigma.setSetting('itemSizesReference', 'screen');
				sigma.setSetting('zoomToSizeRatioFunction', (ratio) => ratio);
				sigma.setSetting('enableEdgeEvents', true);
				sigma.setSetting('nodeReducer', (_id, attrs) => ({
					...attrs,
					// Keep every node above every edge in the zIndex-enabled programs.
					zIndex: Math.max(2, Number(attrs.zIndex) || 0),
				}));
				sigma.setSetting('edgeReducer', (_id, attrs) => ({
					...attrs,
					// Edges always stay under the node layer (never compete with disks).
					// Slight min size so thin spokes remain clickable (hidden → 0 / not pickable).
					size: attrs.hidden ? 0 : Math.max(Number(attrs.size) || 0.5, 1.6),
					zIndex: Math.min(-1, Number(attrs.zIndex) || -1),
				}));

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

				// Draw rings around selected nodes (hover draws its own ring via defaultDrawNodeHover).
				sigma.on('afterRender', () => {
					const host = containerRef.current;
					if (!host) return;
					const canvas = host.querySelector('canvas.sigma-hovers') as HTMLCanvasElement | null;
					if (!canvas) return;
					const ctx = canvas.getContext('2d');
					if (!ctx) return;

					const selected = selectedIdsRef.current;
					const focusId = focusedIdRef.current;
					const hoverId = hoverIdRef.current;

					const toDraw = new Set<string>();
					for (const id of selected) toDraw.add(id);
					if (focusId) toDraw.add(focusId);

					// hoverId already has a ring drawn by defaultDrawNodeHover, no need to draw twice
					if (hoverId) toDraw.delete(hoverId);

					for (const id of toDraw) {
						if (!graph.hasNode(id)) continue;
						const display = sigma.getNodeDisplayData(id);
						if (!display) continue;

						const drawColor = String(graph.getNodeAttribute(id, 'color') || '#ffffff');
						const size = display.size;

						ctx.beginPath();
						ctx.arc(display.x, display.y, size + 3.5, 0, Math.PI * 2);
						ctx.closePath();
						ctx.lineWidth = 2.5;
						ctx.strokeStyle = drawColor;
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
				// Click any visible person/firm (or its label) to focus + fetch.
				// Person → bring attached firms; firm → alone (shift/alt+click firm expands all).
				const activateNode = (node: string, original?: MouseEvent | TouchEvent | null, openEgo = false) => {
					const oe = original as MouseEvent | undefined;
					const forceAll = Boolean(oe && (oe.shiftKey || oe.altKey));
					const meta = nodeIndexRef.current.get(node);
					const t = meta?.type || (graph.hasNode(node) ? String(graph.getNodeAttribute(node, 'nodeType') || '') : '');
					const withNeighbors =
						forceAll ? 'all'
						: t === 'firm' ? 'none'
						: 'firms';
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

				sigma.on('clickNode', ({ node, event }) => {
					event.original.preventDefault();
					event.original.stopPropagation();
					const oe = event.original as MouseEvent;
					activateNode(node, oe, Boolean(oe.metaKey));
				});
				sigma.on('doubleClickNode', ({ node, event }) => {
					event.preventSigmaDefault();
					focusNodeRef.current(node, { openEgo: true, addIfMissing: true, fetchExpand: true });
				});
				// Click a connection line → focus the other endpoint (or the non-focused end).
				sigma.on('clickEdge', ({ edge, event }) => {
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
				sigma.on('clickStage', ({ event }) => {
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

	// Deep-link: /global-graph/{type}/{crd} → add + focus when catalog is ready.
	// CRDs missing from the precomputed layout (inactive / out-of-sample) are
	// seeded on demand via /api/key + /api/finra/expand — same data as dashboard.
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
						const rel = String(e.relationship || e.edgeType || 'employment');
						const isCurrent = e.isCurrent !== false && !/previous|former|prior/i.test(rel);
						const edgeObj: LayoutEdge = {
							id: `${sCrd}:${tCrd}:${rel}`,
							source: sCrd,
							target: tCrd,
							type:
								isCurrent ? rel
								: /previous/i.test(rel) ? rel
								: `previous_${rel}`,
							weight: Number(e.weight) || 1,
						};
						for (const end of [sCrd, tCrd]) {
							const list = edgesByNodeRef.current.get(end) || [];
							if (!list.find((x) => x.id === edgeObj.id || (x.source === sCrd && x.target === tCrd && x.type === edgeObj.type))) {
								list.push(edgeObj);
								edgesByNodeRef.current.set(end, list);
							}
						}
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
			}

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
			setQuery(meta.label || meta.id);
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
				setErrorMessage(`No matches found for "${q}"`);
				setSearchLoading(false);
				return;
			}

			// Single hit → focus as hub (dashboard opens one record).
			if (matches.length === 1) {
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

			// Multi-match → add every hit like dashboard lists all Redis results
			// (cap so the canvas stays usable).
			const capped = matches.slice(0, 100);
			let focused: string | null = null;
			let addedCount = 0;
			for (const hit of capped) {
				const crd = upsertSearchHit(hit);
				if (!crd) continue;
				const wasVisible = visibleIdsRef.current.has(crd);
				const ok = addNodeToCanvas(crd, { withNeighbors: false });
				if (ok && !wasVisible) addedCount++;
				if (!focused) focused = crd;
			}
			if (focused) {
				focusNode(focused, { animate: true, addIfMissing: false });
				setSearchBanner({ query: q, count: Math.max(addedCount, capped.length) });
			} else {
				setErrorMessage(`No graphable matches for "${q}"`);
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

	// Enrich the latest log row with SEC# once panel payload arrives.
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
				if (row.secNumber === sec && row.display.includes(`SEC# ${sec}`)) return row;
				changed = true;
				return {
					...row,
					secNumber: sec,
					display: formatSelectionLogDisplay(row.label, row.crd || crdFromKey, sec),
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
			sigma.getCamera().animatedReset({ duration: 350 });
		} catch {
			// ignore
		}
	}, [attachCameraPin]);

	const handleResetSession = useCallback(() => {
		clearCanvas();
		clearSharedCache();
		setPanelSnapshot(null);
		setSelectionLog([]);
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
									// Connection / owner rows → focus+fetch on the map (person brings firms).
									void activateKeyOnMap(key);
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
								selectionLog={selectionLog}
								onClearSelectionLog={() => {
									setSelectionLog([]);
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
								onSelectKey={(key) => {
									void activateKeyOnMap(key);
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
