import Head from 'next/head';
import { useMemo, useState } from 'react';
import { useSharedGraphState } from '../src/hooks/useSharedGraphState';

function stringValue(value: unknown): string | undefined {
	if (typeof value === 'string' && value.trim()) return value.trim();
	return undefined;
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

type GraphNode = {
	id: string;
	label: string;
	kind: 'primary' | 'relation';
};

type GraphLink = {
	source: string;
	target: string;
	label: string;
};

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

function buildGraphData(payload: unknown, fallbackTitle: string) {
	const nodes: GraphNode[] = [{ id: 'primary', label: fallbackTitle, kind: 'primary' }];
	const links: GraphLink[] = [];
	const seenNodeIds = new Set<string>(['primary']);

	const addNode = (id: string, label: string, kind: 'primary' | 'relation') => {
		if (seenNodeIds.has(id)) return;
		seenNodeIds.add(id);
		nodes.push({ id, label, kind });
	};

	const record = getRecordValue(payload);
	if (!record) return { nodes, links };

	const sourcePayload = getRecordValue(record.payload) ?? record;
	const content = getRecordValue(sourcePayload.basicInformation) ? sourcePayload : record;

	const relationArrays = [
		['currentEmployments', 'Employment'],
		['currentIAEmployments', 'Adviser'],
		['directOwners', 'Direct owner'],
		['indirectOwners', 'Indirect owner'],
		['employments', 'Employment'],
	] as const;

	for (const [key, fallbackLabel] of relationArrays) {
		const items = Array.isArray(content[key]) ? content[key] : [];
		for (const [index, item] of items.entries()) {
			const itemRecord = getRecordValue(item);
			if (!itemRecord) continue;
			const nodeLabel = getNameFromItem(itemRecord) || `${fallbackLabel} ${index + 1}`;
			const nodeId = `relation-${key}-${index}`;
			addNode(nodeId, nodeLabel, 'relation');
			links.push({ source: 'primary', target: nodeId, label: fallbackLabel });
		}
	}

	return { nodes, links };
}

export default function NodeGraphPage() {
	const { cache } = useSharedGraphState();

	const activeSnapshot = useMemo(() => {
		return Object.values(cache).sort((a, b) => b.fetchedAt - a.fetchedAt)[0] ?? null;
	}, [cache]);

	const parsedPayload = useMemo(() => readSnapshotPayload(activeSnapshot?.detailJson ?? null), [activeSnapshot]);

	const primaryPayload = useMemo(() => {
		const bundle = (parsedPayload as Record<string, unknown> | null)?.bundle || parsedPayload;
		if (!bundle || typeof bundle !== 'object') return null;
		const record = bundle as Record<string, unknown>;
		return (
			record.sources && typeof record.sources === 'object' ?
				(record.sources as Record<string, unknown>).finra || (record.sources as Record<string, unknown>).sec
			:	null) as Record<string, unknown> | null;
	}, [parsedPayload]);

	const basicInfo = useMemo(() => {
		const source = primaryPayload?.payload || primaryPayload;
		if (!source || typeof source !== 'object') return {} as Record<string, unknown>;
		const record = source as Record<string, unknown>;
		return (record.basicInformation as Record<string, unknown> | undefined) || (record.info as Record<string, unknown> | undefined) || {};
	}, [primaryPayload]);

	const entityTitle = useMemo(() => {
		return (
			stringValue(basicInfo.firmName) ||
			stringValue(basicInfo.orgName) ||
			stringValue(basicInfo.organizationName) ||
			stringValue(basicInfo.displayName) ||
			stringValue(basicInfo.individualName) ||
			stringValue(basicInfo.firstName) ||
			stringValue(basicInfo.lastName) ||
			stringValue(basicInfo.name) ||
			activeSnapshot?.resolvedKey ||
			activeSnapshot?.key ||
			'Shared record'
		);
	}, [activeSnapshot, basicInfo]);

	const entitySubtitle = useMemo(() => {
		const city = stringValue(basicInfo.city);
		const state = stringValue(basicInfo.state);
		const location = city && state ? `${city}, ${state}` : city || state;
		const status = stringValue(basicInfo.status) || stringValue(basicInfo.firmStatus) || stringValue(basicInfo.bcScope);
		const source = activeSnapshot?.resolvedKey || activeSnapshot?.key || 'shared-cache';
		return [location, status].filter(Boolean).join(' • ') || `Loaded from ${source}`;
	}, [activeSnapshot, basicInfo]);

	const cacheCount = Object.keys(cache).length;
	const sharedLabel = activeSnapshot?.source === 'dashboard' ? 'Dashboard shared' : 'Shared cache';
	const [focusedNodeId, setFocusedNodeId] = useState('primary');
	const graphData = useMemo(() => buildGraphData(parsedPayload, entityTitle), [parsedPayload, entityTitle]);
	const graphWidth = 720;
	const graphHeight = 480;
	const graphRadius = Math.min(graphWidth, graphHeight) / 2 - 80;
	const focusedNode = useMemo(() => graphData.nodes.find((node) => node.id === focusedNodeId) ?? graphData.nodes[0], [graphData.nodes, focusedNodeId]);
	const graphPositions = useMemo(() => {
		const positions: Record<string, { x: number; y: number }> = {};
		const total = Math.max(graphData.nodes.length, 1);
		graphData.nodes.forEach((node, index) => {
			if (node.id === focusedNode.id) {
				positions[node.id] = { x: graphWidth / 2, y: graphHeight / 2 };
				return;
			}
			const angle = ((index + 1) / Math.max(total, 1)) * Math.PI * 2 - Math.PI / 2;
			const radius = index === 0 ? 0 : graphRadius * 0.92;
			positions[node.id] = {
				x: graphWidth / 2 + Math.cos(angle) * radius,
				y: graphHeight / 2 + Math.sin(angle) * radius,
			};
		});
		return positions;
	}, [focusedNode.id, graphData.nodes, graphHeight, graphRadius, graphWidth]);
	const focusedSubtitle = useMemo(() => {
		if (!focusedNode) return entitySubtitle;
		return focusedNode.id === 'primary' ? entitySubtitle : `${focusedNode.label} • connected relationship`;
	}, [entitySubtitle, focusedNode]);

	const selectNode = (nodeId: string) => {
		setFocusedNodeId(nodeId);
	};

	return (
		<>
			<Head>
				<title>Node Graph • FINRA / SEC</title>
			</Head>

			<div className='node-graph-page'>
				<header className='node-graph-hero'>
					<div className='node-graph-hero-copy'>
						<p className='node-graph-eyebrow'>Relationship explorer</p>
						<h1>Network graph</h1>
						<p className='node-graph-subtitle'>Trace the firms, individuals, and ownership links behind the selected record without losing context.</p>
					</div>
					<div className='node-graph-actions'>
						<button
							type='button'
							onClick={() => selectNode('primary')}>
							Focus selection
						</button>
						<button
							type='button'
							className='secondary'
							onClick={() => selectNode('primary')}>
							Reset view
						</button>
					</div>
				</header>

				<section className='node-graph-workspace'>
					<aside className='node-graph-card node-graph-sidebar'>
						<div className='card-heading'>
							<p className='card-label'>Selection stack</p>
							<h2>Active path</h2>
						</div>
						<div className='entity-pill'>{entityTitle}</div>
						<ul>
							<li>
								<span className='dot teal' />
								Selected node
							</li>
							<li>
								<span className='dot blue' />
								Connected firm
							</li>
							<li>
								<span className='dot purple' />
								Owner / employee link
							</li>
						</ul>
						<div className='mini-metrics'>
							<div>
								<span>Cached records</span>
								<strong>{cacheCount}</strong>
							</div>
							<div>
								<span>Shared state</span>
								<strong>{sharedLabel}</strong>
							</div>
						</div>
					</aside>

					<main className='node-graph-card node-graph-canvas'>
						<div className='canvas-toolbar'>
							<div className='canvas-toolbar-title'>Interactive graph</div>
							<div className='canvas-toolbar-meta'>
								<span className='status-pill'>Live</span>
								<span className='status-pill muted'>Synced</span>
							</div>
						</div>
						<div className='canvas-surface'>
							<svg
								className='graph-svg'
								viewBox={`0 0 ${graphWidth} ${graphHeight}`}
								role='img'
								aria-label='Relationship graph'>
								{graphData.links.map((link) => {
									const sourcePos = graphPositions[link.source];
									const targetPos = graphPositions[link.target];
									if (!sourcePos || !targetPos) return null;
									return (
										<line
											key={`${link.source}-${link.target}`}
											className='graph-link'
											x1={sourcePos.x}
											y1={sourcePos.y}
											x2={targetPos.x}
											y2={targetPos.y}
										/>
									);
								})}
								{graphData.nodes.map((node) => {
									const position = graphPositions[node.id];
									if (!position) return null;
									return (
										<g key={node.id}>
											<rect
												className={`graph-node ${node.kind}${focusedNodeId === node.id ? ' active' : ''}`}
												x={position.x - (node.kind === 'primary' ? 68 : 53)}
												y={position.y - (node.kind === 'primary' ? 22 : 18)}
												width={node.kind === 'primary' ? 136 : 106}
												height={node.kind === 'primary' ? 44 : 36}
												rx={12}
												ry={12}
												onClick={() => selectNode(node.id)}
												onKeyDown={(event) => {
													if (event.key === 'Enter' || event.key === ' ') {
														event.preventDefault();
														selectNode(node.id);
													}
												}}
												role='button'
												tabIndex={0}
											/>
											<text
												x={position.x}
												y={position.y + 1}
												className={`graph-label${focusedNodeId === node.id ? ' active' : ''}`}
												onClick={() => selectNode(node.id)}>
												{node.label}
											</text>
										</g>
									);
								})}
							</svg>
							<div className='canvas-overlay'>
								<p>{focusedNode.label}</p>
								<span>{focusedSubtitle}</span>
							</div>
						</div>
					</main>

					<aside className='node-graph-card node-graph-details'>
						<div className='card-heading'>
							<p className='card-label'>Selected record</p>
							<h2>Relationship profile</h2>
						</div>
						<div className='detail-card'>
							<div className='detail-pill'>{activeSnapshot?.resolvedKey || 'shared-cache'}</div>
							<h3>{focusedNode.label}</h3>
							<p>{focusedSubtitle}</p>
						</div>
						<div className='detail-list'>
							<div>
								<span>Cache source</span>
								<strong>{sharedLabel}</strong>
							</div>
							<div>
								<span>Cached entries</span>
								<strong>{cacheCount}</strong>
							</div>
						</div>
					</aside>
				</section>
			</div>

			<style
				jsx
				global>{`
				.node-graph-page {
					min-height: 100%;
					padding: 24px 24px 32px;
					background: radial-gradient(circle at top left, rgba(79, 209, 197, 0.16), transparent 30%), linear-gradient(135deg, rgba(10, 16, 28, 0.96), rgba(4, 8, 16, 0.98));
					color: var(--text-primary);
					font-family: var(--font-sans);
				}
				.node-graph-hero {
					display: flex;
					align-items: flex-start;
					justify-content: space-between;
					gap: 16px;
					margin-bottom: 18px;
				}
				.node-graph-eyebrow {
					margin: 0 0 6px;
					font-size: 0.76rem;
					font-weight: 800;
					letter-spacing: 0.16em;
					text-transform: uppercase;
					color: var(--cyan-bright);
				}
				.node-graph-hero h1 {
					margin: 0 0 8px;
					font-size: 1.8rem;
					font-weight: 800;
					letter-spacing: -0.02em;
				}
				.node-graph-subtitle {
					margin: 0;
					max-width: 700px;
					color: var(--text-secondary);
					line-height: 1.58;
				}
				.node-graph-actions {
					display: flex;
					gap: 10px;
				}
				.node-graph-actions button {
					border: 0;
					border-radius: 999px;
					padding: 10px 14px;
					background: linear-gradient(135deg, var(--cyan), var(--violet));
					color: #07111f;
					font-weight: 700;
					cursor: pointer;
				}
				.node-graph-actions button.secondary {
					background: rgba(255, 255, 255, 0.08);
					color: var(--text-primary);
				}
				.node-graph-workspace {
					display: grid;
					grid-template-columns: 240px minmax(0, 1fr) 280px;
					gap: 16px;
					align-items: start;
				}
				.node-graph-card {
					background: rgba(7, 13, 24, 0.88);
					border: 1px solid rgba(255, 255, 255, 0.08);
					border-radius: 20px;
					box-shadow: 0 16px 40px rgba(0, 0, 0, 0.24);
					backdrop-filter: blur(12px);
				}
				.node-graph-sidebar,
				.node-graph-details {
					padding: 16px;
				}
				.card-heading {
					margin-bottom: 12px;
				}
				.card-label {
					margin: 0 0 4px;
					font-size: 0.72rem;
					font-weight: 800;
					letter-spacing: 0.14em;
					text-transform: uppercase;
					color: var(--text-muted);
				}
				.card-heading h2 {
					margin: 0;
					font-size: 1rem;
				}
				.entity-pill {
					display: inline-flex;
					align-items: center;
					padding: 7px 10px;
					border-radius: 999px;
					background: rgba(79, 209, 197, 0.14);
					color: var(--cyan-bright);
					font-size: 0.82rem;
					font-weight: 700;
					margin-bottom: 12px;
				}
				.node-graph-sidebar ul {
					list-style: none;
					padding: 0;
					margin: 0 0 14px;
					display: grid;
					gap: 8px;
					color: var(--text-secondary);
				}
				.dot {
					display: inline-block;
					width: 10px;
					height: 10px;
					border-radius: 999px;
					margin-right: 8px;
					vertical-align: middle;
				}
				.dot.teal {
					background: var(--cyan-bright);
				}
				.dot.blue {
					background: #58a6ff;
				}
				.dot.purple {
					background: var(--violet-bright);
				}
				.mini-metrics {
					display: grid;
					gap: 10px;
				}
				.mini-metrics > div {
					background: rgba(255, 255, 255, 0.04);
					padding: 10px 12px;
					border-radius: 14px;
					display: flex;
					justify-content: space-between;
					align-items: center;
					font-size: 0.82rem;
					color: var(--text-secondary);
				}
				.mini-metrics strong {
					color: var(--text-primary);
					font-size: 0.95rem;
				}
				.node-graph-canvas {
					padding: 14px;
					min-height: 560px;
				}
				.canvas-toolbar {
					display: flex;
					justify-content: space-between;
					align-items: center;
					margin-bottom: 12px;
				}
				.canvas-toolbar-title {
					font-size: 0.95rem;
					font-weight: 700;
				}
				.canvas-toolbar-meta {
					display: flex;
					gap: 8px;
				}
				.status-pill {
					display: inline-flex;
					align-items: center;
					padding: 6px 10px;
					border-radius: 999px;
					font-size: 0.74rem;
					font-weight: 700;
					background: rgba(79, 209, 197, 0.16);
					color: var(--cyan-bright);
				}
				.status-pill.muted {
					background: rgba(255, 255, 255, 0.06);
					color: var(--text-secondary);
				}
				.canvas-surface {
					position: relative;
					background: linear-gradient(135deg, rgba(8, 20, 35, 0.95), rgba(13, 28, 45, 0.95));
					border: 1px solid rgba(255, 255, 255, 0.08);
					border-radius: 18px;
					padding: 10px;
					min-height: 500px;
					display: flex;
					align-items: center;
					justify-content: center;
				}
				.graph-svg {
					width: 100%;
					height: 100%;
					min-height: 460px;
					border-radius: 14px;
				}
				.graph-link {
					stroke: rgba(6, 182, 212, 0.82);
					stroke-width: 2.25;
					stroke-linecap: round;
					stroke-dasharray: 8 6;
				}
				.graph-node {
					stroke: rgba(255, 255, 255, 0.16);
					stroke-width: 1.5;
					cursor: pointer;
					transition:
						transform 180ms ease,
						fill 180ms ease,
						stroke 180ms ease;
					transform-origin: center;
					filter: drop-shadow(0 8px 18px rgba(7, 13, 24, 0.28));
				}
				.graph-node:hover,
				.graph-node:focus {
					transform: translateY(-1px) scale(1.02);
				}
				.graph-node.primary {
					fill: rgba(6, 182, 212, 0.16);
					stroke: rgba(6, 182, 212, 0.6);
				}
				.graph-node.relation {
					fill: rgba(124, 58, 237, 0.16);
					stroke: rgba(139, 92, 246, 0.58);
				}
				.graph-node.active {
					fill: rgba(124, 58, 237, 0.28);
					stroke: rgba(255, 255, 255, 0.8);
				}
				.graph-label {
					fill: var(--text-primary);
					font-size: 11px;
					text-anchor: middle;
					dominant-baseline: middle;
					font-weight: 600;
					paint-order: stroke;
					stroke: rgba(4, 8, 16, 0.9);
					stroke-width: 4px;
					cursor: pointer;
				}
				.graph-label.active {
					fill: #ffffff;
				}
				.canvas-overlay {
					position: absolute;
					left: 20px;
					bottom: 20px;
					padding: 12px 14px;
					border-radius: 14px;
					background: rgba(2, 7, 17, 0.85);
					border: 1px solid rgba(255, 255, 255, 0.08);
					max-width: 240px;
				}
				.canvas-overlay p {
					margin: 0 0 4px;
					font-weight: 700;
				}
				.canvas-overlay span {
					font-size: 0.8rem;
					color: var(--text-secondary);
					line-height: 1.45;
				}
				.detail-card {
					background: linear-gradient(135deg, rgba(79, 209, 197, 0.15), rgba(88, 166, 255, 0.14));
					border: 1px solid rgba(255, 255, 255, 0.1);
					border-radius: 16px;
					padding: 14px;
					margin-bottom: 12px;
				}
				.detail-pill {
					display: inline-block;
					padding: 6px 10px;
					border-radius: 999px;
					background: rgba(79, 209, 197, 0.18);
					color: var(--cyan-bright);
					font-size: 0.78rem;
					font-weight: 700;
					margin-bottom: 10px;
				}
				.detail-card h3 {
					margin: 0 0 8px;
					font-size: 1rem;
				}
				.detail-card p {
					margin: 0;
					line-height: 1.58;
					color: var(--text-secondary);
				}
				.detail-list {
					display: grid;
					gap: 10px;
				}
				.detail-list > div {
					display: flex;
					justify-content: space-between;
					align-items: center;
					padding: 10px 0;
					border-top: 1px solid rgba(255, 255, 255, 0.08);
					font-size: 0.84rem;
					color: var(--text-secondary);
				}
				.detail-list strong {
					color: var(--text-primary);
				}
				@media (max-width: 1120px) {
					.node-graph-workspace {
						grid-template-columns: 1fr;
					}
				}
			`}</style>
		</>
	);
}
