/**
 * Build a precomputed global graph layout for WebGL (Sigma) rendering.
 *
 * Reads data/derived/network-index.json, keeps a weighted firm/broker subset,
 * runs d3-force offline (weighted links + charge + collide), optionally
 * soft-orbits children around firm parents, and writes the layout artifact
 * for /api/global-graph and /global-graph.
 *
 * Usage:
 *   pnpm exec tsx scripts/build-global-graph-layout.ts
 *   pnpm exec tsx scripts/build-global-graph-layout.ts --max-nodes 8000 --iterations 300
 *   pnpm exec tsx scripts/build-global-graph-layout.ts --firms-only
 */
import { promises as fs } from 'fs';
import path from 'path';
import Graph from 'graphology';
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force';

type NetworkEdge = {
	to: string;
	type?: string;
	detail?: string;
	weight?: number;
};

type NetworkIndex = {
	metadata: Record<string, { name?: string; type?: string }>;
	graph: Record<string, NetworkEdge[]>;
};

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

function parseArgs(argv: string[]) {
	const out = {
		maxNodes: 16000,
		maxEdges: 120000,
		iterations: 400,
		firmsOnly: false,
		minDegree: 1,
		outPath: path.resolve(process.cwd(), 'data', 'derived', 'global-graph-layout.json'),
		inPath: path.resolve(process.cwd(), 'data', 'derived', 'network-index.json'),
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = argv[i + 1];
		if (a === '--max-nodes' && next) {
			out.maxNodes = Math.max(100, Number(next) || out.maxNodes);
			i++;
		} else if (a === '--max-edges' && next) {
			out.maxEdges = Math.max(1000, Number(next) || out.maxEdges);
			i++;
		} else if (a === '--iterations' && next) {
			out.iterations = Math.max(10, Number(next) || out.iterations);
			i++;
		} else if (a === '--min-degree' && next) {
			out.minDegree = Math.max(0, Number(next) || out.minDegree);
			i++;
		} else if (a === '--firms-only') {
			out.firmsOnly = true;
		} else if (a === '--out' && next) {
			out.outPath = path.resolve(process.cwd(), next);
			i++;
		} else if (a === '--in' && next) {
			out.inPath = path.resolve(process.cwd(), next);
			i++;
		}
	}
	return out;
}

/** US state / territory → layout region group. */
const STATE_TO_GROUP: Record<string, string> = {
	CT: 'Northeast',
	ME: 'Northeast',
	MA: 'Northeast',
	NH: 'Northeast',
	RI: 'Northeast',
	VT: 'Northeast',
	NJ: 'Northeast',
	NY: 'Northeast',
	PA: 'Northeast',
	IL: 'Midwest',
	IN: 'Midwest',
	MI: 'Midwest',
	OH: 'Midwest',
	WI: 'Midwest',
	IA: 'Midwest',
	KS: 'Midwest',
	MN: 'Midwest',
	MO: 'Midwest',
	NE: 'Midwest',
	ND: 'Midwest',
	SD: 'Midwest',
	DE: 'South',
	FL: 'South',
	GA: 'South',
	MD: 'South',
	NC: 'South',
	SC: 'South',
	VA: 'South',
	DC: 'South',
	WV: 'South',
	AL: 'South',
	KY: 'South',
	MS: 'South',
	TN: 'South',
	AR: 'South',
	LA: 'South',
	OK: 'South',
	TX: 'South',
	AZ: 'West',
	CO: 'West',
	ID: 'West',
	MT: 'West',
	NV: 'West',
	NM: 'West',
	UT: 'West',
	WY: 'West',
	AK: 'West',
	CA: 'West',
	HI: 'West',
	OR: 'West',
	WA: 'West',
	PR: 'Territories',
	VI: 'Territories',
	GU: 'Territories',
	AS: 'Territories',
	MP: 'Territories',
};

const REGION_GROUP_ANGLE: Record<string, number> = {
	Northeast: -0.35,
	Midwest: -1.9,
	South: 0.85,
	West: 2.6,
	Territories: 1.9,
	International: 3.5,
	Unknown: 0.15,
};

const REGION_GROUP_COLOR: Record<string, string> = {
	Northeast: '#22d3ee',
	Midwest: '#34d399',
	South: '#fbbf24',
	West: '#a78bfa',
	Territories: '#fb7185',
	International: '#94a3b8',
	Unknown: '#0891b2',
};

function normalizeState(raw: unknown): string | undefined {
	if (raw == null) return undefined;
	const s = String(raw).trim();
	if (!s) return undefined;
	if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
	const lower = s.toLowerCase();
	const names: Record<string, string> = {
		'alabama': 'AL',
		'alaska': 'AK',
		'arizona': 'AZ',
		'arkansas': 'AR',
		'california': 'CA',
		'colorado': 'CO',
		'connecticut': 'CT',
		'delaware': 'DE',
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
		'district of columbia': 'DC',
		'puerto rico': 'PR',
	};
	return names[lower];
}

function regionGroupFor(state?: string, country?: string): string {
	if (state && STATE_TO_GROUP[state]) return STATE_TO_GROUP[state];
	const c = String(country || '').toLowerCase();
	if (c && !c.includes('united states') && c !== 'usa' && c !== 'us' && c !== 'u.s.') {
		return 'International';
	}
	return 'Unknown';
}

function nodeColor(type: string, _degree: number, regionGroup?: string): string {
	if (type === 'firm') {
		return REGION_GROUP_COLOR[regionGroup || 'Unknown'] || REGION_GROUP_COLOR.Unknown;
	}
	if (type === 'individual') {
		if (_degree > 40) return '#fde68a';
		if (_degree > 10) return '#fbbf24';
		return '#d97706';
	}
	return '#94a3b8';
}

/** Size from composite weight (firms) or degree (brokers). ~50% of prior scale. */
function nodeSize(degree: number, type: string, weight?: number): number {
	const w = weight != null && Number.isFinite(weight) ? weight : degree;
	const leaf = type === 'firm' ? 3.0 : 2.7;
	const scale = type === 'firm' ? 0.52 : 0.48;
	return Math.min(21, leaf + Math.sqrt(Math.max(0, w)) * scale);
}

/** Deterministic 0..1 hash for stable orbit angles. */
function hash01(s: string): number {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return (h >>> 0) / 4294967295;
}

/**
 * Place individuals on staggered rings around their primary firm parent.
 * Firm hubs stay put (region FA2 positions). Multi-firm brokers pick the
 * highest-weight firm neighbor still in the graph.
 */
function orbitChildrenAroundParents(graph: Graph, opts?: { padding?: number }): { parented: number; unparented: number } {
	const padding = opts?.padding ?? 2.5;
	const firmIds: string[] = [];
	const individualIds: string[] = [];
	graph.forEachNode((id, attrs) => {
		const t = String(attrs.nodeType || '');
		if (t === 'firm') firmIds.push(id);
		else if (t === 'individual') individualIds.push(id);
	});

	const childrenByFirm = new Map<string, string[]>();
	const assigned = new Set<string>();

	for (const ind of individualIds) {
		const firmNeighbors: { id: string; score: number }[] = [];
		graph.forEachNeighbor(ind, (nid, nattrs) => {
			if (String(nattrs.nodeType || '') !== 'firm') return;
			const w = Number(nattrs.weight) || Number(nattrs.degree) || 1;
			firmNeighbors.push({ id: nid, score: w });
		});
		if (!firmNeighbors.length) continue;
		firmNeighbors.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
		const parent = firmNeighbors[0].id;
		if (!childrenByFirm.has(parent)) childrenByFirm.set(parent, []);
		childrenByFirm.get(parent)!.push(ind);
		assigned.add(ind);
	}

	let parented = 0;
	for (const firmId of firmIds) {
		const kids = childrenByFirm.get(firmId);
		if (!kids?.length) continue;
		kids.sort((a, b) => a.localeCompare(b));

		const fx = Number(graph.getNodeAttribute(firmId, 'x')) || 0;
		const fy = Number(graph.getNodeAttribute(firmId, 'y')) || 0;
		const firmSize = Number(graph.getNodeAttribute(firmId, 'size')) || 3;
		const firmDeg = Number(graph.getNodeAttribute(firmId, 'degree')) || kids.length;

		const ringCount =
			kids.length > 400 ? 8
			: kids.length > 200 ? 7
			: kids.length > 80 ? 6
			: kids.length > 30 ? 5
			: kids.length > 12 ? 4
			: 3;

		// Pack rings so disks don't overlap: circumference ≥ n * (2r + gap).
		const sampleChildR = (() => {
			let sum = 0;
			for (const k of kids.slice(0, Math.min(40, kids.length))) {
				sum += Number(graph.getNodeAttribute(k, 'size')) || 2.7;
			}
			return sum / Math.min(40, kids.length) || 2.7;
		})();
		const childDisk = sampleChildR + padding;
		const orbitBase = firmSize + childDisk + 8 + Math.min(80, Math.sqrt(Math.max(firmDeg, 1)) * 2.2);
		const ringStep = Math.max(childDisk * 2.4, 10 + Math.min(28, firmDeg * 0.08));

		// Pre-bucket by ring for equal angular spacing within each ring.
		const byRing: string[][] = Array.from({ length: ringCount }, () => []);
		kids.forEach((child, i) => {
			byRing[i % ringCount].push(child);
		});

		for (let ring = 0; ring < ringCount; ring++) {
			const group = byRing[ring];
			if (!group.length) continue;
			// Grow radius if this ring is too crowded for non-overlap.
			const minCircumference = group.length * (2 * childDisk + padding);
			const minR = minCircumference / (2 * Math.PI);
			const r = Math.max(orbitBase + ring * ringStep, minR + firmSize * 0.15);
			const angle0 = hash01(firmId + ':r' + ring) * Math.PI * 2;
			for (let i = 0; i < group.length; i++) {
				const child = group[i];
				const jitter = ((hash01(firmId + '|' + child) - 0.5) * (Math.PI * 2)) / Math.max(group.length * 8, 16);
				const ang = angle0 + (i / group.length) * Math.PI * 2 + jitter;
				const cr = Number(graph.getNodeAttribute(child, 'size')) || sampleChildR;
				// Slight radial jitter by child size so different radii don't stack perfectly.
				const rj = (hash01(child + ':rad') - 0.5) * Math.min(4, childDisk * 0.35);
				graph.setNodeAttribute(child, 'x', fx + Math.cos(ang) * (r + rj));
				graph.setNodeAttribute(child, 'y', fy + Math.sin(ang) * (r + rj));
				graph.setNodeAttribute(child, 'parentId', firmId);
				graph.setNodeAttribute(child, 'orbitRing', ring);
				// Tiny size nudge unused; keep for debug
				void cr;
				parented++;
			}
		}
	}

	// Unparented individuals: small halo near graph centroid (or keep FA2 pos).
	let unparented = 0;
	for (const ind of individualIds) {
		if (assigned.has(ind)) continue;
		unparented++;
	}

	console.log(`Orbit placement: ${parented} children on firm rings, ${unparented} unparented`);
	return { parented, unparented };
}

/**
 * Pull HQ state from local BrokerCheck firm JSON dumps when available.
 */
async function loadFirmRegions(firmIds: string[]): Promise<Map<string, { state?: string; country?: string; city?: string }>> {
	const out = new Map<string, { state?: string; country?: string; city?: string }>();
	const roots = [
		path.resolve(process.cwd(), 'data', 'raw'),
		path.resolve(process.cwd(), '..', 'newwest-new-data-vis', 'data', 'raw'),
		path.resolve(process.cwd(), '..', 'finra-data-chart-next-01', 'data', 'raw'),
		path.resolve(process.cwd(), '..', 'finra-data-large-view', 'data', 'raw'),
		'/home/lenny/Dev/webDev/newwest-new-data-vis/data/raw',
		'/home/lenny/Dev/webDev/finra-data-chart-next-01/data/raw',
	];
	const existingRoots: string[] = [];
	for (const r of roots) {
		try {
			await fs.access(r);
			existingRoots.push(r);
		} catch {
			// skip
		}
	}
	if (!existingRoots.length) {
		console.log('No firm raw dirs found — region weights fall back to Unknown');
		return out;
	}
	console.log(`Loading firm regions from ${existingRoots[0]} (+${Math.max(0, existingRoots.length - 1)} fallbacks)…`);
	let hit = 0;
	let miss = 0;
	for (const id of firmIds) {
		let found = false;
		for (const root of existingRoots) {
			const fp = path.join(root, `finra:firm:${id}.json`);
			try {
				const txt = await fs.readFile(fp, 'utf-8');
				const doc = JSON.parse(txt) as Record<string, unknown>;
				const content = (doc.content || doc) as Record<string, unknown>;
				const fad = content.firmAddressDetails as Record<string, unknown> | undefined;
				const iad = content.iaFirmAddressDetails as Record<string, unknown> | undefined;
				const addr =
					(fad?.officeAddress as Record<string, unknown> | undefined) ||
					(iad?.officeAddress as Record<string, unknown> | undefined) ||
					(fad?.mailingAddress as Record<string, unknown> | undefined);
				const a = addr || {};
				const state = normalizeState(a.state);
				const country = a.country != null ? String(a.country) : undefined;
				const city = a.city != null ? String(a.city) : undefined;
				if (state || country || city) {
					out.set(id, { state, country, city });
					hit++;
					found = true;
					break;
				}
			} catch {
				// try next root
			}
		}
		if (!found) miss++;
	}
	console.log(`Firm regions: ${hit} resolved, ${miss} missing`);
	return out;
}

/**
 * Hard non-overlap using each node's display `size` as disk radius (graph units).
 * Full pair correction each pass; expands globally if jammed. Stops at 0 overlaps.
 */
function separateOverlappingNodes(graph: Graph, opts?: { iterations?: number; padding?: number; sizeScale?: number }) {
	const maxIterations = opts?.iterations ?? 500;
	const padding = opts?.padding ?? 1.5;
	const sizeScale = opts?.sizeScale ?? 1.05;
	const nodes = graph.nodes();
	const n = nodes.length;
	if (n < 2) return;

	type Pt = { id: string; x: number; y: number; r: number; mass: number };
	const pts: Pt[] = nodes.map((id) => {
		const deg = Number(graph.getNodeAttribute(id, 'degree')) || 0;
		const size = Number(graph.getNodeAttribute(id, 'size')) || 2;
		const isFirm = String(graph.getNodeAttribute(id, 'nodeType') || '') === 'firm';
		// Firms are heavy anchors; leaves slide out of the way during collision.
		const mass = isFirm ? 8 + Math.sqrt(Math.max(0, deg)) * 1.2 : 1 + Math.sqrt(Math.max(0, deg)) * 0.25;
		return {
			id,
			x: Number(graph.getNodeAttribute(id, 'x')) || 0,
			y: Number(graph.getNodeAttribute(id, 'y')) || 0,
			r: size * sizeScale + padding,
			mass,
		};
	});

	const sortedR = [...pts.map((p) => p.r)].sort((a, b) => a - b);
	const cell = Math.max(4, sortedR[Math.floor(sortedR.length * 0.5)] * 2.1);
	const key = (cx: number, cy: number) => `${cx},${cy}`;

	for (let iter = 0; iter < maxIterations; iter++) {
		const grid = new Map<string, number[]>();
		for (let i = 0; i < n; i++) {
			const p = pts[i];
			const k = key(Math.floor(p.x / cell), Math.floor(p.y / cell));
			const bucket = grid.get(k);
			if (bucket) bucket.push(i);
			else grid.set(k, [i]);
		}

		let moves = 0;
		const overshoot =
			iter < 30 ? 1.1
			: iter < 100 ? 1.03
			: 1.0;
		for (let i = 0; i < n; i++) {
			const a = pts[i];
			const cx = Math.floor(a.x / cell);
			const cy = Math.floor(a.y / cell);
			for (let ox = -1; ox <= 1; ox++) {
				for (let oy = -1; oy <= 1; oy++) {
					const bucket = grid.get(key(cx + ox, cy + oy));
					if (!bucket) continue;
					for (const j of bucket) {
						if (j <= i) continue;
						const b = pts[j];
						let dx = b.x - a.x;
						let dy = b.y - a.y;
						let dist = Math.hypot(dx, dy);
						const minDist = a.r + b.r;
						if (dist >= minDist - 1e-9) continue;
						moves++;
						if (dist < 1e-9) {
							const ang = ((i * 73 + j * 19) % 360) * (Math.PI / 180);
							dx = Math.cos(ang);
							dy = Math.sin(ang);
							dist = 1e-9;
						}
						const push = ((minDist - dist) * overshoot) / dist;
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
		if (iter % 25 === 0 || iter === maxIterations - 1 || moves === 0) {
			console.log(`  collide ${iter + 1}/${maxIterations} overlaps≈${moves}`);
		}
		if (moves === 0) {
			console.log(`  collide resolved at ${iter + 1} (zero overlaps)`);
			break;
		}
		if (moves > 0 && iter > 0 && iter % 50 === 0) {
			let sx = 0;
			let sy = 0;
			for (const p of pts) {
				sx += p.x;
				sy += p.y;
			}
			sx /= n;
			sy /= n;
			const factor = 1.15;
			for (const p of pts) {
				p.x = sx + (p.x - sx) * factor;
				p.y = sy + (p.y - sy) * factor;
			}
			console.log(`  collide expand ×${factor} at iter ${iter + 1}`);
		}
	}

	for (const p of pts) {
		graph.setNodeAttribute(p.id, 'x', p.x);
		graph.setNodeAttribute(p.id, 'y', p.y);
	}
}

function undirectedKey(a: string, b: string): string {
	return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** Lightweight connected-component labels for multilevel / LOD coloring. */
function assignClusters(nodeIds: string[], edges: { source: string; target: string }[]): Map<string, number> {
	const parent = new Map<string, string>();
	const find = (x: string): string => {
		let p = parent.get(x) || x;
		if (p !== x) {
			p = find(p);
			parent.set(x, p);
		}
		return p;
	};
	const union = (a: string, b: string) => {
		const ra = find(a);
		const rb = find(b);
		if (ra !== rb) parent.set(ra, rb);
	};
	for (const id of nodeIds) parent.set(id, id);
	for (const e of edges) {
		if (parent.has(e.source) && parent.has(e.target)) union(e.source, e.target);
	}
	const rootToCluster = new Map<string, number>();
	const out = new Map<string, number>();
	let next = 0;
	for (const id of nodeIds) {
		const r = find(id);
		if (!rootToCluster.has(r)) rootToCluster.set(r, next++);
		out.set(id, rootToCluster.get(r)!);
	}
	return out;
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	const started = Date.now();
	console.log('Loading network index…', opts.inPath);
	const raw = await fs.readFile(opts.inPath, 'utf-8');
	const index = JSON.parse(raw) as NetworkIndex;
	const metadata = index.metadata || {};
	const adj = index.graph || {};

	// Connectivity metrics
	const degree = new Map<string, number>();
	const brokerCount = new Map<string, number>();
	const firmNeighbors = new Map<string, Map<string, number>>();
	const bump = (id: string, n = 1) => degree.set(id, (degree.get(id) || 0) + n);
	const bumpFirmLink = (a: string, b: string, w = 1) => {
		if (a === b) return;
		const x = a < b ? a : b;
		const y = a < b ? b : a;
		if (!firmNeighbors.has(x)) firmNeighbors.set(x, new Map());
		const m = firmNeighbors.get(x)!;
		m.set(y, (m.get(y) || 0) + w);
	};

	const indFirms = new Map<string, string[]>();

	for (const [src, edges] of Object.entries(adj)) {
		if (!Array.isArray(edges)) continue;
		bump(src, edges.length);
		const srcType = metadata[src]?.type;
		for (const e of edges) {
			const tgt = e?.to != null ? String(e.to) : '';
			if (!tgt) continue;
			bump(tgt, 1);
			const tgtType = metadata[tgt]?.type;
			if (srcType === 'firm' && tgtType === 'firm') {
				const w = typeof e.weight === 'number' && Number.isFinite(e.weight) ? e.weight : 1;
				bumpFirmLink(src, tgt, w);
			}
			if (srcType === 'firm' && tgtType === 'individual') {
				if (!indFirms.has(tgt)) indFirms.set(tgt, []);
				indFirms.get(tgt)!.push(src);
			} else if (srcType === 'individual' && tgtType === 'firm') {
				if (!indFirms.has(src)) indFirms.set(src, []);
				indFirms.get(src)!.push(tgt);
			}
		}
	}

	{
		const firmBrokers = new Map<string, Set<string>>();
		for (const [ind, firms] of indFirms) {
			const uniq = Array.from(new Set(firms));
			indFirms.set(ind, uniq);
			for (const f of uniq) {
				if (!firmBrokers.has(f)) firmBrokers.set(f, new Set());
				firmBrokers.get(f)!.add(ind);
			}
			if (uniq.length >= 2) {
				for (let i = 0; i < uniq.length; i++) {
					for (let j = i + 1; j < uniq.length; j++) {
						bumpFirmLink(uniq[i], uniq[j], 1);
					}
				}
			}
		}
		for (const [f, set] of firmBrokers) brokerCount.set(f, set.size);
	}

	const firmLinkCount = new Map<string, number>();
	for (const [a, m] of firmNeighbors) {
		firmLinkCount.set(a, (firmLinkCount.get(a) || 0) + m.size);
		for (const b of m.keys()) {
			firmLinkCount.set(b, (firmLinkCount.get(b) || 0) + 1);
		}
	}

	const allFirmIds = Object.keys(metadata).filter((id) => metadata[id]?.type === 'firm');
	const firmRegion = await loadFirmRegions(allFirmIds);

	const regionFirmCounts = new Map<string, number>();
	for (const id of allFirmIds) {
		const fr = firmRegion.get(id);
		const g = regionGroupFor(fr?.state, fr?.country);
		regionFirmCounts.set(g, (regionFirmCounts.get(g) || 0) + 1);
	}
	const maxRegionCount = Math.max(1, ...Array.from(regionFirmCounts.values()));

	const firmWeight = new Map<string, number>();
	for (const id of allFirmIds) {
		const brokers = brokerCount.get(id) || 0;
		const fl = firmLinkCount.get(id) || 0;
		const fr = firmRegion.get(id);
		const g = regionGroupFor(fr?.state, fr?.country);
		const regionBoost = 0.35 * Math.sqrt((regionFirmCounts.get(g) || 1) / maxRegionCount) * 100;
		const w = brokers * 1.0 + fl * 4.5 + regionBoost + Math.sqrt(degree.get(id) || 0) * 0.25;
		firmWeight.set(id, w);
	}

	console.log(`Firm metrics: brokers=${brokerCount.size}, firm-pairs=${firmNeighbors.size}, regions=${JSON.stringify(Object.fromEntries(regionFirmCounts))}`);

	let candidates = Object.keys(metadata);
	for (const id of degree.keys()) {
		if (!metadata[id]) candidates.push(id);
	}
	candidates = Array.from(new Set(candidates));
	if (opts.firmsOnly) {
		candidates = candidates.filter((id) => (metadata[id]?.type || '') === 'firm');
	}
	candidates = candidates.filter((id) => (degree.get(id) || 0) >= opts.minDegree);
	const scoreOf = (id: string) => {
		if (metadata[id]?.type === 'firm') return firmWeight.get(id) || degree.get(id) || 0;
		return degree.get(id) || 0;
	};

	// Balanced pick: firms by composite weight, individuals by degree.
	// Pure global sort by firm weight floods the graph with firms only.
	const keptIds: string[] = [];
	if (opts.firmsOnly) {
		const firms = candidates.filter((id) => (metadata[id]?.type || '') === 'firm').sort((a, b) => scoreOf(b) - scoreOf(a));
		keptIds.push(...firms.slice(0, opts.maxNodes));
	} else {
		const firms = candidates.filter((id) => (metadata[id]?.type || '') === 'firm').sort((a, b) => scoreOf(b) - scoreOf(a));
		const individuals = candidates.filter((id) => (metadata[id]?.type || '') === 'individual').sort((a, b) => scoreOf(b) - scoreOf(a));
		const other = candidates
			.filter((id) => {
				const t = metadata[id]?.type || '';
				return t !== 'firm' && t !== 'individual';
			})
			.sort((a, b) => scoreOf(b) - scoreOf(a));
		// Prefer a majority of firms (region/weight story) but keep brokers for employment edges.
		const firmSlots = Math.max(200, Math.floor(opts.maxNodes * 0.55));
		const indSlots = Math.max(200, Math.floor(opts.maxNodes * 0.4));
		const takeFirms = firms.slice(0, Math.min(firmSlots, firms.length));
		const takeInd = individuals.slice(0, Math.min(indSlots, individuals.length));
		keptIds.push(...takeFirms, ...takeInd);
		const seen = new Set(keptIds);
		for (const id of [...other, ...firms, ...individuals]) {
			if (keptIds.length >= opts.maxNodes) break;
			if (seen.has(id)) continue;
			seen.add(id);
			keptIds.push(id);
		}
	}
	const kept = new Set(keptIds);
	const firmKept = keptIds.filter((id) => metadata[id]?.type === 'firm').length;
	const indKept = keptIds.filter((id) => metadata[id]?.type === 'individual').length;
	console.log(`Selected ${kept.size} nodes (max ${opts.maxNodes}, firms=${firmKept}, individuals=${indKept}, firmsOnly=${opts.firmsOnly})`);

	type EdgeAcc = { source: string; target: string; type: string; weight: number };
	const edgeMap = new Map<string, EdgeAcc>();
	// Single undirected edge per pair (graphology multi:false). Prefer employment;
	// firm_link only when no employment, or bumps weight on firm–firm pairs.
	const addEdge = (source: string, target: string, type: string, weight: number) => {
		if (!kept.has(source) || !kept.has(target) || source === target) return;
		const key = undirectedKey(source, target);
		const [s, tg] = key.split('|');
		const prev = edgeMap.get(key);
		if (!prev) {
			edgeMap.set(key, { source: s, target: tg, type, weight });
			return;
		}
		if (type === 'firm_link' && prev.type !== 'firm_link') {
			// Keep structural type; let firm co-employment strengthen the pull.
			prev.weight = Math.max(prev.weight, weight) + Math.min(12, weight * 0.25);
			return;
		}
		if (prev.type === 'firm_link' && type !== 'firm_link') {
			edgeMap.set(key, {
				source: s,
				target: tg,
				type,
				weight: Math.max(weight, prev.weight) + Math.min(12, prev.weight * 0.25),
			});
			return;
		}
		if (weight > prev.weight) {
			prev.weight = weight;
			if (typeRank(type) <= typeRank(prev.type)) prev.type = type;
		}
	};
	const typeRank = (t: string) =>
		t === 'employment' || !t ? 0
		: t === 'ownership' || t === 'succession' || t === 'location' ? 1
		: t === 'firm_link' ? 2
		: 3;

	for (const src of keptIds) {
		const edges = adj[src];
		if (!Array.isArray(edges)) continue;
		for (const e of edges) {
			const tgt = String(e?.to || '');
			if (!tgt || !kept.has(tgt) || tgt === src) continue;
			const weight = typeof e.weight === 'number' && Number.isFinite(e.weight) ? e.weight : 1;
			addEdge(src, tgt, String(e.type || 'employment'), weight);
		}
	}

	// Cap firm–firm co-employment links so they don't wipe employment edges under maxEdges.
	const firmLinkBudget = Math.max(2000, Math.floor(opts.maxEdges * 0.28));
	const firmLinkCandidates: { a: string; b: string; w: number }[] = [];
	for (const [a, m] of firmNeighbors) {
		if (!kept.has(a)) continue;
		for (const [b, w] of m) {
			if (!kept.has(b)) continue;
			firmLinkCandidates.push({ a, b, w });
		}
	}
	firmLinkCandidates.sort((x, y) => y.w - x.w);
	for (const fl of firmLinkCandidates.slice(0, firmLinkBudget)) {
		addEdge(fl.a, fl.b, 'firm_link', Math.min(80, 2 + Math.log2(1 + fl.w) * 6));
	}

	let edgeList = Array.from(edgeMap.values());
	// Prefer employment / structural edges first, then firm_link, by weight within type.
	edgeList.sort((a, b) => typeRank(a.type) - typeRank(b.type) || b.weight - a.weight || b.source.localeCompare(a.source));
	if (edgeList.length > opts.maxEdges) {
		console.log(`Truncating edges ${edgeList.length} → ${opts.maxEdges}`);
		edgeList = edgeList.slice(0, opts.maxEdges);
	}
	const typeCountsPreview: Record<string, number> = {};
	for (const e of edgeList) typeCountsPreview[e.type] = (typeCountsPreview[e.type] || 0) + 1;
	console.log(`Edges in layout: ${edgeList.length}`, typeCountsPreview);

	const graph = new Graph({ type: 'undirected', multi: false, allowSelfLoops: false });
	for (const id of keptIds) {
		const meta = metadata[id] || {};
		const t = meta.type === 'firm' || meta.type === 'individual' ? meta.type : 'unknown';
		const deg = degree.get(id) || 0;
		const fr = t === 'firm' ? firmRegion.get(id) : undefined;
		const state = fr?.state;
		const rGroup = t === 'firm' ? regionGroupFor(state, fr?.country) : undefined;
		const brokers = t === 'firm' ? brokerCount.get(id) || 0 : 0;
		const fl = t === 'firm' ? firmLinkCount.get(id) || 0 : 0;
		const weight = t === 'firm' ? firmWeight.get(id) || deg : deg;
		const h = Number(id) || id.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
		const baseAng = rGroup != null ? (REGION_GROUP_ANGLE[rGroup] ?? 0) : (h % 360) * (Math.PI / 180);
		const jitter = ((h % 50) - 25) * 0.012;
		const angle = baseAng + jitter;
		// Wide region seed — d3 charge expands further from here.
		const radius = t === 'firm' ? 900 + Math.min(2200, Math.sqrt(weight) * 28) + (h % 180) : 500 + (deg % 400) + (h % 120);
		graph.addNode(id, {
			x: Math.cos(angle) * radius + ((h % 97) - 48) * 3,
			y: Math.sin(angle) * radius + ((h % 89) - 44) * 3,
			size: nodeSize(deg, t, weight),
			label: String(meta.name || id).slice(0, 80),
			nodeType: t,
			degree: deg,
			weight,
			region: state || '',
			regionGroup: rGroup || '',
			brokerCount: brokers,
			firmLinkCount: fl,
			color: nodeColor(t, deg, rGroup),
		});
	}

	let edgesAdded = 0;
	for (const e of edgeList) {
		if (!graph.hasNode(e.source) || !graph.hasNode(e.target)) continue;
		if (graph.hasEdge(e.source, e.target)) continue;
		try {
			graph.addEdge(e.source, e.target, {
				weight: e.weight,
				edgeType: e.type,
				size: Math.min(2.5, 0.2 + e.weight * 0.12),
				color:
					e.type === 'firm_link' ? 'rgba(167,139,250,0.28)'
					: e.type === 'ownership' ? 'rgba(167,139,250,0.35)'
					: 'rgba(148,163,184,0.18)',
			});
			edgesAdded++;
		} catch {
			// ignore
		}
	}
	console.log(`Graphology nodes=${graph.order} edges=${graph.size} (added ${edgesAdded})`);

	// --- d3-force weighted layout (open spread like classic force graphs) ---
	type SimNode = SimulationNodeDatum & {
		id: string;
		nodeType: string;
		degree: number;
		weight: number;
		size: number;
		regionGroup: string;
	};
	type SimLink = SimulationLinkDatum<SimNode> & {
		weight: number;
		edgeType: string;
	};

	const simNodes: SimNode[] = graph.nodes().map((id) => {
		const attrs = graph.getNodeAttributes(id);
		return {
			id,
			x: Number(attrs.x) || 0,
			y: Number(attrs.y) || 0,
			nodeType: String(attrs.nodeType || 'unknown'),
			degree: Number(attrs.degree) || 0,
			weight: Number(attrs.weight) || Number(attrs.degree) || 1,
			size: Number(attrs.size) || 3,
			regionGroup: String(attrs.regionGroup || ''),
		};
	});
	const nodeById = new Map(simNodes.map((n) => [n.id, n]));
	const simLinks: SimLink[] = [];
	graph.forEachEdge((_eid, attrs, source, target) => {
		const s = nodeById.get(source);
		const t = nodeById.get(target);
		if (!s || !t) return;
		simLinks.push({
			source: s,
			target: t,
			weight: Number(attrs.weight) || 1,
			edgeType: String(attrs.edgeType || 'employment'),
		});
	});

	const nCount = simNodes.length;
	const dense = nCount > 8000;
	const mid = nCount > 3000;
	// Strong repulsion → open clouds; longer employment spokes.
	const chargeBase =
		dense ? -2800
		: mid ? -3600
		: -4800;
	const linkDistEmp =
		dense ? 140
		: mid ? 180
		: 240;
	const linkDistFirm =
		dense ? 320
		: mid ? 420
		: 560;
	const collidePad =
		dense ? 10
		: mid ? 14
		: 18;

	const linkDistance = (l: SimLink) => {
		const w = Math.max(0.5, l.weight || 1);
		if (l.edgeType === 'firm_link' || l.edgeType === 'ownership') {
			// Heavier firm ties → slightly shorter, still long enough to breathe.
			return linkDistFirm / Math.sqrt(1 + Math.log2(1 + w));
		}
		// Employment: short-ish weighted spokes (children near parents, not glued).
		return linkDistEmp / Math.pow(w, 0.15) + Math.min(80, Math.sqrt(w) * 4);
	};
	const linkStrength = (l: SimLink) => {
		const w = Math.max(0.5, l.weight || 1);
		if (l.edgeType === 'firm_link') return Math.min(0.55, 0.12 + Math.log2(1 + w) * 0.06);
		if (l.edgeType === 'ownership') return 0.35;
		// Employment pulls children to firm; weight soft-boosts.
		return Math.min(0.85, 0.45 + Math.log2(1 + w) * 0.08);
	};
	const manyBodyStrength = (d: SimNode) => {
		const w = Math.max(1, d.weight || d.degree || 1);
		// Weighted hubs push harder so big firms own more space.
		const hubBoost = d.nodeType === 'firm' ? 1.65 + Math.min(2.8, Math.sqrt(w) * 0.04) : 1;
		return chargeBase * hubBoost * (0.55 + Math.min(1.8, Math.sqrt(w) * 0.03));
	};
	const collideRadius = (d: SimNode) => {
		const base = (d.size || 3) * 2.2 + collidePad;
		const hubHalo = d.nodeType === 'firm' ? Math.min(120, 24 + Math.sqrt(Math.max(d.weight, 1)) * 1.8) : 0;
		return base + hubHalo;
	};

	// Soft region gravity: keep regional firm clusters loosely in angular sectors.
	const regionTarget = (rg: string): { x: number; y: number } => {
		const ang = REGION_GROUP_ANGLE[rg] ?? 0;
		const R = 1600;
		return { x: Math.cos(ang) * R, y: Math.sin(ang) * R };
	};

	console.log(`Running d3-force iterations=${opts.iterations} (weighted charge/link/collide)…`);
	const faStart = Date.now();
	const simulation = forceSimulation<SimNode>(simNodes)
		.force(
			'link',
			forceLink<SimNode, SimLink>(simLinks)
				.id((d) => d.id)
				.distance(linkDistance)
				.strength(linkStrength)
				.iterations(dense ? 1 : 2),
		)
		.force(
			'charge',
			forceManyBody<SimNode>()
				.strength(manyBodyStrength)
				.distanceMin(8)
				.distanceMax(dense ? 4200 : 7000)
				.theta(0.85),
		)
		.force(
			'collide',
			forceCollide<SimNode>()
				.radius(collideRadius)
				.strength(0.85)
				.iterations(dense ? 2 : 3),
		)
		.force('center', forceCenter(0, 0).strength(0.02))
		.force(
			'x',
			forceX<SimNode>((d) => (d.nodeType === 'firm' && d.regionGroup ? regionTarget(d.regionGroup).x : 0)).strength((d) =>
				d.nodeType === 'firm' && d.regionGroup && d.regionGroup !== 'Unknown' ? 0.035 : 0.008,
			),
		)
		.force(
			'y',
			forceY<SimNode>((d) => (d.nodeType === 'firm' && d.regionGroup ? regionTarget(d.regionGroup).y : 0)).strength((d) =>
				d.nodeType === 'firm' && d.regionGroup && d.regionGroup !== 'Unknown' ? 0.035 : 0.008,
			),
		)
		.velocityDecay(0.28)
		.alphaDecay(1 - Math.pow(0.001, 1 / Math.max(80, opts.iterations)))
		.alphaMin(0.001)
		.stop();

	const tickChunk = Math.max(20, Math.min(50, Math.floor(opts.iterations / 6)));
	let done = 0;
	while (done < opts.iterations) {
		const step = Math.min(tickChunk, opts.iterations - done);
		for (let i = 0; i < step; i++) simulation.tick();
		done += step;
		const elapsed = ((Date.now() - faStart) / 1000).toFixed(1);
		const a = simulation.alpha();
		console.log(`  d3-force ${done}/${opts.iterations} alpha=${a.toFixed(4)} (${elapsed}s)`);
	}
	console.log(`d3-force done in ${((Date.now() - faStart) / 1000).toFixed(1)}s`);

	// Write positions back.
	for (const n of simNodes) {
		graph.setNodeAttribute(n.id, 'x', n.x ?? 0);
		graph.setNodeAttribute(n.id, 'y', n.y ?? 0);
	}

	// Mild global expand so Sigma pan/zoom has air (d3 already spreads; keep modest).
	const BAKE_EXPAND = 1.85;
	{
		let sx = 0;
		let sy = 0;
		const ids = graph.nodes();
		for (const id of ids) {
			sx += Number(graph.getNodeAttribute(id, 'x')) || 0;
			sy += Number(graph.getNodeAttribute(id, 'y')) || 0;
		}
		const nn = ids.length || 1;
		sx /= nn;
		sy /= nn;
		for (const id of ids) {
			const x = Number(graph.getNodeAttribute(id, 'x')) || 0;
			const y = Number(graph.getNodeAttribute(id, 'y')) || 0;
			graph.setNodeAttribute(id, 'x', sx + (x - sx) * BAKE_EXPAND);
			graph.setNodeAttribute(id, 'y', sy + (y - sy) * BAKE_EXPAND);
		}
		console.log(`Applied bake expand ×${BAKE_EXPAND}`);
	}

	// Soft parent bias (not hard rings): nudge individuals toward their firm parent
	// while keeping d3 cloud structure. Skip hard re-orbit so layout stays organic.
	console.log('Soft parent pull (children toward primary firm)…');
	{
		const pull = 0.42; // blend toward parent-relative orbit seed
		graph.forEachNode((id, attrs) => {
			if (String(attrs.nodeType) !== 'individual') return;
			const firmNeighbors: { id: string; score: number }[] = [];
			graph.forEachNeighbor(id, (nid, nattrs) => {
				if (String(nattrs.nodeType || '') !== 'firm') return;
				firmNeighbors.push({
					id: nid,
					score: Number(nattrs.weight) || Number(nattrs.degree) || 1,
				});
			});
			if (!firmNeighbors.length) return;
			firmNeighbors.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
			const parentId = firmNeighbors[0].id;
			const px = Number(graph.getNodeAttribute(parentId, 'x')) || 0;
			const py = Number(graph.getNodeAttribute(parentId, 'y')) || 0;
			const cx = Number(attrs.x) || 0;
			const cy = Number(attrs.y) || 0;
			let dx = cx - px;
			let dy = cy - py;
			let dist = Math.hypot(dx, dy);
			const parentSize = Number(graph.getNodeAttribute(parentId, 'size')) || 3;
			const childSize = Number(attrs.size) || 2.7;
			const minOrbit = parentSize + childSize + 28;
			const maxOrbit = minOrbit + 220 + Math.min(280, Math.sqrt(Number(graph.getNodeAttribute(parentId, 'degree')) || 1) * 6);
			if (dist < 1e-6) {
				const ang = hash01(id) * Math.PI * 2;
				dx = Math.cos(ang);
				dy = Math.sin(ang);
				dist = 1;
			}
			const targetDist = Math.min(maxOrbit, Math.max(minOrbit, dist));
			const tx = px + (dx / dist) * targetDist;
			const ty = py + (dy / dist) * targetDist;
			graph.setNodeAttribute(id, 'x', cx + (tx - cx) * pull);
			graph.setNodeAttribute(id, 'y', cy + (ty - cy) * pull);
			graph.setNodeAttribute(id, 'parentId', parentId);
		});
	}

	console.log('Hard non-overlap (display size disks)…');
	const collStart = Date.now();
	separateOverlappingNodes(graph, { iterations: 500, padding: 1.6, sizeScale: 1.15 });
	console.log(`Collision done in ${((Date.now() - collStart) / 1000).toFixed(1)}s`);

	const edges: LayoutEdge[] = [];
	const edgeTypeCounts: Record<string, number> = {};
	graph.forEachEdge((edgeId, attrs, source, target) => {
		const type = String(attrs.edgeType || 'link');
		edgeTypeCounts[type] = (edgeTypeCounts[type] || 0) + 1;
		edges.push({
			id: edgeId,
			source,
			target,
			type,
			weight: Number(attrs.weight) || 1,
		});
	});

	const clusterOf = assignClusters(
		graph.nodes(),
		edges.map((e) => ({ source: e.source, target: e.target })),
	);
	const clusterCount = new Set(clusterOf.values()).size;
	console.log(`Clusters (connected components): ${clusterCount}`);

	const nodes: LayoutNode[] = [];
	graph.forEachNode((id, attrs) => {
		nodes.push({
			id,
			label: String(attrs.label || id),
			type: (attrs.nodeType as LayoutNode['type']) || 'unknown',
			x: Number(attrs.x) || 0,
			y: Number(attrs.y) || 0,
			size: Number(attrs.size) || 2,
			color: String(attrs.color || '#94a3b8'),
			degree: Number(attrs.degree) || 0,
			weight: Number(attrs.weight) || Number(attrs.degree) || 0,
			region: attrs.region ? String(attrs.region) : undefined,
			regionGroup: attrs.regionGroup ? String(attrs.regionGroup) : undefined,
			brokerCount: Number(attrs.brokerCount) || 0,
			firmLinkCount: Number(attrs.firmLinkCount) || 0,
			cluster: clusterOf.get(id) ?? 0,
		});
	});

	const payload = {
		version: 5,
		generatedAt: new Date().toISOString(),
		source: path.relative(process.cwd(), opts.inPath),
		params: {
			maxNodes: opts.maxNodes,
			maxEdges: opts.maxEdges,
			iterations: opts.iterations,
			firmsOnly: opts.firmsOnly,
			minDegree: opts.minDegree,
			weighting: 'd3-force+region+brokers+firm_links',
			engine: 'd3-force',
		},
		stats: {
			nodeCount: nodes.length,
			edgeCount: edges.length,
			firmCount: nodes.filter((n) => n.type === 'firm').length,
			individualCount: nodes.filter((n) => n.type === 'individual').length,
			clusterCount,
			edgeTypes: edgeTypeCounts,
			regionGroups: Object.fromEntries(regionFirmCounts),
			buildMs: Date.now() - started,
		},
		nodes,
		edges,
	};

	await fs.mkdir(path.dirname(opts.outPath), { recursive: true });
	await fs.writeFile(opts.outPath, JSON.stringify(payload));
	console.log(`Wrote ${opts.outPath} (${(JSON.stringify(payload).length / (1024 * 1024)).toFixed(2)} MB)`);
	console.log('stats', payload.stats);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
