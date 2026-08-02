import React, { useState, useEffect, useCallback } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useLocalNameSearch } from '../../hooks/useLocalNameSearch';
import { useSharedGraphState } from '../../hooks/useSharedGraphState';

type NodeInfo = {
	crd: string;
	name: string;
	type: 'individual' | 'firm';
	source: string;
	location?: string;
	status?: string;
	address?: string;
	established?: string;
	statusBadges?: { source: 'FINRA' | 'SEC'; status: 'Active' | 'Inactive' | 'Terminated' }[];
};

type Connection = {
	targetCrd: string;
	targetName: string;
	type: string;
	role?: string;
	dates?: string;
	source?: 'FINRA' | 'SEC';
	status?: 'Active' | 'Inactive' | 'Terminated';
};

type OwnerReference = {
	parentType: 'firm';
	parentCrd: string;
	name: string;
	position: string;
	firmName?: string;
	phone?: string;
};

type AnalysisResult = {
	info: NodeInfo;
	connections: Connection[];
	ascii: string;
	analysis: string;
	// Present when this CRD has no live record of its own — it only exists
	// as a directOwners/indirectOwners reference scraped from the parent
	// firm's own detail payload (mirrors the dashboard's orphan bundle).
	orphan?: OwnerReference;
};

type TrailEntry = {
	info: NodeInfo;
	connections: Connection[];
};

type AmbiguousOption = {
	crd: string;
	type: 'individual' | 'firm';
	name: string;
	source: string;
};

type AsciiLine = {
	key: string;
	indent: number;
	// Rendered as: prefix (plain) + detail (optionally colored) + midfix (plain)
	// + entity (colored by entityType) + suffix (plain)
	prefix: string;
	detail?: string;
	detailCurrent?: boolean;
	midfix?: string;
	entity?: string;
	entityType?: 'individual' | 'firm';
	suffix?: string;
	// When set, the entity span refers to a node already present in the
	// trail (crd/entityCrd) and can be clicked to jump back to that spot.
	entityCrd?: string;
	// True for the entity span representing the currently selected (last)
	// node in the trail — rendered with extra emphasis.
	isCurrent?: boolean;
};

// Builds an ever-growing chain across the full navigation trail: only the
// node that was actually clicked into at each step is shown (sibling
// connections that weren't selected are omitted), so the map stays a clean
// path of just the selected nodes rather than every available branch. Firms
// and individuals are tagged with an entityType so the caller can render
// each bracketed entity in a distinct color. Connections always link an
// individual to a firm (employments) or a firm to an individual
// (directOwners), so the target's type is always the opposite of the
// current entry's type.
// Matches the dashboard's Panel.tsx badge convention (FIRM / IND).
function shortTypeLabel(type: string): string {
	return type === 'firm' ? 'FIRM' : 'IND';
}

// Bakes an entire drill-down trail into the URL as repeated type/crd
// segments (e.g. /insights/firm/821/individual/1278905/firm/13109) so the
// exact drilled-down view can be bookmarked, shared, or replayed via
// browser Back/Forward.
function trailToPath(pairs: { crd: string; type: 'individual' | 'firm' }[]): string {
	return `/insights/${pairs.map((p) => `${p.type}/${p.crd}`).join('/')}`;
}

function buildTrailAsciiLines(trail: TrailEntry[]): AsciiLine[] {
	if (!trail.length) return [];
	const lines: AsciiLine[] = [];

	// Only the root (first) node gets a standalone "[ Name (CRD) ]" header
	// line. Every later node's name/CRD already appears as the target of the
	// connection line leading to it, so giving it a second header line would
	// just duplicate the same entity — instead the tree grows straight down
	// from each connection arrow.
	const root = trail[0];
	lines.push({
		key: 'header-0',
		indent: 0,
		prefix: '[ ',
		entity: `${root.info.name} (CRD ${root.info.crd})`,
		entityType: root.info.type,
		entityCrd: root.info.crd,
		isCurrent: trail.length === 1,
		suffix: ' ]',
	});

	trail.forEach((entry, i) => {
		const targetType: 'individual' | 'firm' = entry.info.type === 'individual' ? 'firm' : 'individual';

		const next = trail[i + 1];
		if (!next) {
			// Current (last) node — nothing selected past it yet. Point to the
			// Detailed Connections list below instead of listing every branch.
			const count = entry.connections.length;
			lines.push({ key: `pipe-${i}`, indent: i, prefix: '   |' });
			lines.push({
				key: `hint-${i}`,
				indent: i,
				prefix: count ? `   +-- (${count} connection${count === 1 ? '' : 's'} available — see Detailed Connections below)` : '   +-- (No known connections in cache)',
			});
			return;
		}

		const selectedConn = entry.connections.find((c) => c.targetCrd === next.info.crd);
		let detail = selectedConn ? `(${selectedConn.type}${selectedConn.role ? `: ${selectedConn.role}` : ''})` : '(SELECTED)';
		if (selectedConn?.dates) detail += ` [${selectedConn.dates}]`;
		const detailCurrent = selectedConn?.type === 'CURRENT';

		lines.push({ key: `pipe-conn-${i}`, indent: i, prefix: '   |' });
		lines.push({
			key: `conn-${i}`,
			indent: i,
			prefix: '   +-- ',
			detail,
			detailCurrent,
			midfix: ' ==> [ ',
			entity: `${next.info.name} (CRD ${next.info.crd})`,
			entityType: targetType,
			entityCrd: next.info.crd,
			isCurrent: i === trail.length - 2,
			suffix: ' ]',
		});
	});

	return lines;
}

function AsciiConnectionMap({ trail, onJumpTo }: { trail: TrailEntry[]; onJumpTo: (crd: string, type: 'individual' | 'firm') => void }) {
	const lines = buildTrailAsciiLines(trail);
	return (
		<div className='ascii-output'>
			{lines.map((line) => (
				<div
					key={line.key}
					style={{ paddingLeft: `${line.indent * 1.6}em` }}>
					{line.prefix}
					{line.detail && <span className={line.detailCurrent ? 'ascii-detail-current' : 'ascii-detail'}>{line.detail}</span>}
					{line.midfix}
					{line.entity && (
						<span
							className={`ascii-entity ascii-entity-${line.entityType} ascii-entity-clickable${line.isCurrent ? ' ascii-entity-current' : ''}`}
							onClick={() => onJumpTo(line.entityCrd!, line.entityType!)}
							title={`Jump back to ${line.entity}`}>
							{line.entity}
						</span>
					)}
					{line.suffix}
				</div>
			))}
		</div>
	);
}

export default function InsightsView() {
	const router = useRouter();
	const sharedGraphState = useSharedGraphState();
	const { query, setQuery, results, loading: searchLoading, search, searched, clear } = useLocalNameSearch();
	const [selectedNode, setSelectedNode] = useState<AnalysisResult | null>(null);
	const [trail, setTrail] = useState<TrailEntry[]>([]);
	const [analysisLoading, setAnalysisLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// A bare CRD number can coincide with both an individual and a firm
	// record. When the API can't tell which one was meant, it returns an
	// `ambiguous` response instead of guessing — we stash the two options
	// here so the user can pick one explicitly.
	const [ambiguousOptions, setAmbiguousOptions] = useState<AmbiguousOption[] | null>(null);

	const fetchInsightNode = useCallback(
		async (crd: string, type?: 'individual' | 'firm') => {
			const key = `${type || 'unknown'}:${crd}`;
			const cached = sharedGraphState.getSnapshot(key);
			if (cached?.detailJson) {
				return { cached: true, detailJson: cached.detailJson };
			}
			const res = await fetch(`/api/insights?crd=${crd}${type ? `&type=${type}` : ''}`);
			const data = await res.json();
			if (!res.ok || data?.error) return data;
			if (data?.info) {
				sharedGraphState.setSnapshot(key, {
					key,
					resolvedKey: `${type || data.info.type}:${crd}`,
					detailJson: JSON.stringify({ info: data.info, connections: data.connections, ascii: data.ascii || '', analysis: data.analysis || '' }),
					fetchedAt: Date.now(),
					source: 'insights',
				});
			}
			return data;
		},
		[sharedGraphState],
	);

	// /insights/<crd> — a bare, type-less CRD. Type is unknown up front, so
	// let /api/insights resolve it (or report ambiguity between an individual
	// and a firm sharing the same CRD number) rather than trying to build a
	// multi-hop trail out of it.
	const loadSingleNode = useCallback(
		async (crd: string) => {
			setAnalysisLoading(true);
			setError(null);
			setAmbiguousOptions(null);
			try {
				const data = await fetchInsightNode(crd);
				if (data.cached && data.detailJson) {
					try {
						const parsed = JSON.parse(data.detailJson);
						const info = parsed?.info ?? null;
						const connections = parsed?.connections ?? [];
						if (info) {
							setSelectedNode({ info, connections, ascii: '', analysis: '' });
							setTrail([{ info, connections }]);
							return;
						}
					} catch {
						// fall through to fetch normally
					}
				}
				if (data.ambiguous) {
					setSelectedNode(null);
					setTrail([]);
					setAmbiguousOptions(data.options);
				} else if (data.error) {
					setError(data.error);
					setSelectedNode(null);
					setTrail([]);
				} else {
					setSelectedNode(data);
					setTrail([{ info: data.info, connections: data.connections }]);
				}
			} catch (e: any) {
				setError(e.message);
				setSelectedNode(null);
			} finally {
				setAnalysisLoading(false);
			}
		},
		[fetchInsightNode],
	);

	// /insights/<type>/<crd>/<type>/<crd>/... — the full drill-down trail is
	// baked into the URL itself (one type/crd pair per hop), so it can be
	// bookmarked, shared, or replayed via browser Back/Forward. Loads every
	// hop in order and rebuilds the same trail state selecting a connection
	// card or ASCII entity would have produced.
	const loadTrailFromPairs = useCallback(
		async (pairs: { crd: string; type: 'individual' | 'firm' }[]) => {
			setAnalysisLoading(true);
			setError(null);
			setAmbiguousOptions(null);
			const builtTrail: TrailEntry[] = [];
			let lastData: AnalysisResult | null = null;
			try {
				for (const pair of pairs) {
					const data = await fetchInsightNode(pair.crd, pair.type);
					if (data.ambiguous || data.error) {
						if (builtTrail.length === 0) {
							// Couldn't resolve even the first hop — surface it directly.
							if (data.ambiguous) setAmbiguousOptions(data.options);
							else setError(data.error || `CRD ${pair.crd} not found`);
							setSelectedNode(null);
							setTrail([]);
							return;
						}
						// A later hop in a shared/bookmarked URL no longer resolves
						// (e.g. the underlying cache changed) — keep whatever DID
						// load and stop there instead of failing the whole trail.
						break;
					}
					builtTrail.push({ info: data.info, connections: data.connections });
					lastData = data;
				}
				if (lastData) {
					setTrail(builtTrail);
					setSelectedNode(lastData);
				}
			} catch (e: any) {
				if (builtTrail.length === 0) {
					setError(e.message);
					setSelectedNode(null);
				} else {
					setTrail(builtTrail);
					setSelectedNode(lastData);
				}
			} finally {
				setAnalysisLoading(false);
			}
		},
		[fetchInsightNode],
	);

	// Sync state with URL on initial load and browser navigation (Back / Forward / Bookmarks)
	useEffect(() => {
		if (!router.isReady) return;

		// Path shapes: /insights (no slug), /insights/<crd> (slug: [crd],
		// type unknown/ambiguous), /insights/<type>/<crd>/<type>/<crd>/...
		// (slug: an even-length sequence of type/crd pairs — the full
		// drill-down trail) — see [[...slug]].tsx.
		const slug = Array.isArray(router.query.slug) ? router.query.slug : [];
		const queryQ = typeof router.query.q === 'string' ? router.query.q : '';

		if (slug.length === 0) {
			if (queryQ) {
				setSelectedNode(null);
				setTrail([]);
				if (query !== queryQ || !searched) {
					setQuery(queryQ);
					search(queryQ);
				}
			} else {
				setSelectedNode(null);
				setTrail([]);
				clear();
			}
			return;
		}

		if (slug.length === 1) {
			const queryCrd = slug[0];
			if (!selectedNode || trail.length !== 1 || trail[0].info.crd !== queryCrd) {
				loadSingleNode(queryCrd);
			}
			return;
		}

		if (slug.length % 2 !== 0) return; // malformed URL, ignore
		const pairs: { crd: string; type: 'individual' | 'firm' }[] = [];
		for (let i = 0; i < slug.length; i += 2) {
			const t = slug[i];
			const c = slug[i + 1];
			if ((t === 'individual' || t === 'firm') && /^[0-9]+$/.test(c)) {
				pairs.push({ crd: c, type: t as 'individual' | 'firm' });
			} else {
				return; // malformed segment, leave current state as-is
			}
		}

		const currentPairs = trail.map((t) => ({ crd: t.info.crd, type: t.info.type }));
		const alreadyLoaded = currentPairs.length === pairs.length && currentPairs.every((p, i) => p.crd === pairs[i].crd && p.type === pairs[i].type);
		if (alreadyLoaded) return;

		loadTrailFromPairs(pairs);
	}, [router.isReady, router.asPath]);

	const handleSearch = (e: React.FormEvent) => {
		e.preventDefault();
		if (!query.trim()) return;
		search();
		router.push({ pathname: '/insights', query: { q: query.trim() } }, undefined, { shallow: true });
	};

	const selectNode = (crd: string, isFromTrail = false, type?: 'individual' | 'firm') => {
		if (!type) {
			// Type-less selection (rare — only reachable before any node has
			// been resolved) falls back to the bare-CRD ambiguity-resolving URL.
			router.push(`/insights/${crd}`);
			return;
		}
		const currentPairs = trail.map((t) => ({ crd: t.info.crd, type: t.info.type }));
		let nextPairs: { crd: string; type: 'individual' | 'firm' }[];
		if (isFromTrail) {
			const idx = currentPairs.findIndex((p) => p.crd === crd && p.type === type);
			nextPairs = idx !== -1 ? currentPairs.slice(0, idx + 1) : [...currentPairs, { crd, type }];
		} else {
			nextPairs = [...currentPairs, { crd, type }];
		}
		router.push(trailToPath(nextPairs));
	};

	const resetAnalysis = () => {
		setSelectedNode(null);
		setTrail([]);
		clear();
		router.push('/insights', undefined, { shallow: true });
	};

	const byName = (a: { name?: string; crd?: string }, b: { name?: string; crd?: string }) => {
		const aName = (a.name || '').trim().toLowerCase();
		const bName = (b.name || '').trim().toLowerCase();
		if (aName < bName) return -1;
		if (aName > bName) return 1;
		return String(a.crd || '').localeCompare(String(b.crd || ''), undefined, { numeric: true });
	};
	const sortedResults = [...results].sort(byName);
	const individuals = sortedResults.filter((r) => (r.type || '').toLowerCase() === 'individual');
	const firms = sortedResults.filter((r) => (r.type || '').toLowerCase() === 'firm');
	const sortedAmbiguousOptions = [...(ambiguousOptions || [])].sort(byName);

	return (
		<div className='insights-page'>
			<Head>
				<title>Node Analysis - FINRA / SEC Dashboard</title>
			</Head>

			<header className='insights-header'>
				<div className='header-left'>
					<h1>🔬 Node Analysis</h1>
				</div>

				{trail.length > 0 && (
					<nav className='analysis-trail'>
						{trail.map((t, i) => (
							<React.Fragment key={t.info.crd}>
								<span
									className={`trail-item ${i === trail.length - 1 ? 'is-active' : ''}`}
									onClick={() => selectNode(t.info.crd, true, t.info.type)}>
									{t.info.name}
								</span>
								{i < trail.length - 1 && <span className='trail-separator'>→</span>}
							</React.Fragment>
						))}
					</nav>
				)}

				<form
					className='search-container'
					onSubmit={handleSearch}>
					<input
						type='text'
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder='Search Name or CRD...'
						className='search-input'
					/>
					<button
						type='submit'
						className='search-button'
						disabled={searchLoading}>
						{searchLoading ? 'Searching...' : 'Search'}
					</button>
				</form>
			</header>

			<main className='insights-main'>
				{!searched && !selectedNode && !analysisLoading && !error && !ambiguousOptions && (
					<div className='welcome-state'>
						<div className='welcome-icon'>🔬</div>
						<h2>Node &amp; Relationship Intelligence</h2>
						<p>Search by individual advisor name, firm name, or CRD number above to explore entity networks and relationships.</p>
					</div>
				)}

				{searched && results.length > 0 && !selectedNode && (
					<div className='search-results-overlay'>
						<div className='results-columns'>
							<div className='results-column'>
								<h3>Individuals ({individuals.length})</h3>
								<div className='results-list'>
									{individuals.length === 0 && <p className='empty-column'>No individuals found.</p>}
									{individuals.map((r) => (
										<div
											key={`${r.crd}-${r.key || ''}`}
											className='search-result-card'
											onClick={() => selectNode(r.crd, false, 'individual')}>
											<div className='result-card-header'>
												<span className='result-type-badge individual'>INDIVIDUAL</span>
												{r.source && <span className='result-source-badge'>{r.source.toUpperCase()}</span>}
											</div>
											<div className='result-name'>{r.name}</div>
											<div className='result-details-row'>
												<span className='result-crd-badge'>CRD #{r.crd}</span>
												{r.secNumber && <span className='result-sec-badge'>SEC #{r.secNumber}</span>}
											</div>
											{r.currentAddress && <div className='result-address'>📍 {r.currentAddress}</div>}
											<div className='result-card-action'>Analyze Node →</div>
										</div>
									))}
								</div>
							</div>
							<div className='results-column'>
								<h3>Firms ({firms.length})</h3>
								<div className='results-list'>
									{firms.length === 0 && <p className='empty-column'>No firms found.</p>}
									{firms.map((r) => (
										<div
											key={`${r.crd}-${r.key || ''}`}
											className='search-result-card'
											onClick={() => selectNode(r.crd, false, 'firm')}>
											<div className='result-card-header'>
												<span className='result-type-badge firm'>FIRM</span>
												{r.source && <span className='result-source-badge'>{r.source.toUpperCase()}</span>}
											</div>
											<div className='result-name'>{r.name}</div>
											<div className='result-details-row'>
												<span className='result-crd-badge'>CRD #{r.crd}</span>
												{r.secNumber && <span className='result-sec-badge'>SEC #{r.secNumber}</span>}
											</div>
											{r.currentAddress && <div className='result-address'>📍 {r.currentAddress}</div>}
											<div className='result-card-action'>Analyze Node →</div>
										</div>
									))}
								</div>
							</div>
						</div>
					</div>
				)}

				{searched && results.length === 0 && !selectedNode && (
					<div className='empty-state'>
						<h3>No records found matching "{query}"</h3>
						<p>Try searching by a different name or CRD number.</p>
					</div>
				)}

				{analysisLoading && (
					<div
						className='panel-loading-state'
						role='status'
						aria-live='polite'>
						<div className='panel-loading-spinner' />
						<div className='panel-loading-copy'>
							<div className='panel-loading-title'>Loading record details…</div>
							<div className='panel-loading-subtitle'>Fetching the selected CRD payload</div>
						</div>
					</div>
				)}

				{error && (
					<div className='error-state'>
						<h3>Error</h3>
						<p>{error}</p>
					</div>
				)}

				{ambiguousOptions && (
					<div className='ambiguous-state'>
						<h3>CRD {ambiguousOptions[0]?.crd} matches more than one record</h3>
						<p>This CRD number is shared by both an individual and a firm record. Choose which one you meant:</p>
						<div className='ambiguous-options'>
							{sortedAmbiguousOptions.map((opt) => (
								<div
									key={opt.type}
									className='search-result-card'
									onClick={() => selectNode(opt.crd, false, opt.type)}>
									<div className='result-card-header'>
										<span className={`result-type-badge ${opt.type}`}>{opt.type.toUpperCase()}</span>
										{opt.source && <span className='result-source-badge'>{opt.source.toUpperCase()}</span>}
									</div>
									<div className='result-name'>{opt.name}</div>
									<div className='result-details-row'>
										<span className='result-crd-badge'>CRD #{opt.crd}</span>
									</div>
									<div className='result-card-action'>Analyze Node →</div>
								</div>
							))}
						</div>
					</div>
				)}

				{selectedNode && (
					<div className='analysis-container'>
						<div className='analysis-sidebar'>
							<div className='node-card'>
								<div className={`node-card-accent node-card-accent--${selectedNode.info.type}`} />
								<span className={`record-side-badge ${selectedNode.info.type}`}>{shortTypeLabel(selectedNode.info.type)}</span>
								<h2>{selectedNode.info.name}</h2>
								<div className='node-stat'>
									<strong>CRD:</strong> {selectedNode.info.crd}
								</div>
								<div className='node-stat'>
									<strong>Source:</strong> {selectedNode.info.source.toUpperCase()}
								</div>
								{selectedNode.info.statusBadges && selectedNode.info.statusBadges.length > 0 && (
									<div className='node-status-tags'>
										{selectedNode.info.statusBadges.map((b) => {
											const cls =
												b.status === 'Active' ? 'record-pill--status-active'
												: b.status === 'Terminated' ? 'record-pill--status-terminated'
												: 'record-pill--status-inactive';
											return (
												<span
													key={b.source}
													className={`record-pill ${cls}`}>
													{b.source}: {b.status}
												</span>
											);
										})}
									</div>
								)}
								{selectedNode.info.status && (
									<div className='node-stat'>
										<strong>Status:</strong> {selectedNode.info.status}
									</div>
								)}
								{selectedNode.info.address && (
									<div className='node-stat'>
										<strong>Address:</strong> {selectedNode.info.address}
									</div>
								)}
								{!selectedNode.info.address && selectedNode.info.location && (
									<div className='node-stat'>
										<strong>Location:</strong> {selectedNode.info.location}
									</div>
								)}
								{selectedNode.info.established && (
									<div className='node-stat'>
										<strong>Established:</strong> {selectedNode.info.established}
									</div>
								)}

								<button
									className='reset-button'
									onClick={resetAnalysis}>
									Analyze Another Node
								</button>
							</div>

							{selectedNode.orphan && (
								<div className='orphan-notice'>
									<h3>No live CRD</h3>
									<p>
										This person has no FINRA/SEC record of their own. They appear only as a <strong>{selectedNode.orphan.position || 'listed'}</strong> reference scraped from{' '}
										<strong>{selectedNode.orphan.firmName || `firm CRD ${selectedNode.orphan.parentCrd}`}</strong>'s own detail record.
									</p>
								</div>
							)}

							<div className='analysis-text-card'>
								<h3>Automated Summary</h3>
								<p>{selectedNode.analysis}</p>
							</div>
						</div>

						<div className='analysis-content'>
							<div className='ascii-card'>
								<div className='card-header'>
									<h3>Connection Map</h3>
									<span className='format-badge'>ASCII STRUCTURE</span>
								</div>
								<AsciiConnectionMap
									trail={trail}
									onJumpTo={(crd, type) => selectNode(crd, true, type)}
								/>
							</div>

							{(() => {
								const targetType: 'individual' | 'firm' = selectedNode.info.type === 'individual' ? 'firm' : 'individual';
								const byName = (a: Connection, b: Connection) => a.targetName.localeCompare(b.targetName, undefined, { sensitivity: 'base' });
								const owners = selectedNode.connections.filter((c) => c.type === 'OWNER/EXEC').sort(byName);
								const current = selectedNode.connections.filter((c) => c.type === 'CURRENT').sort(byName);
								const previous = selectedNode.connections.filter((c) => c.type === 'PREVIOUS').sort(byName);
								// Prefer the connection's own source (a person can have a FINRA
								// broker employment and a SEC IA employment at once) and only
								// fall back to the analyzed node's source when it's unknown
								// (e.g. firm employee connections from the graph index).
								const fallbackSource = selectedNode.info.source.toUpperCase();

								const renderItem = (c: Connection, i: number) => {
									// If this connection points back to a node already in the
									// trail (e.g. the node we navigated here from), jump back
									// to that spot instead of appending a duplicate trail entry.
									const existingInTrail = trail.find((t) => t.info.crd === c.targetCrd && t.info.type === targetType);
									const isCurrentNode = selectedNode.info.crd === c.targetCrd && selectedNode.info.type === targetType;
									const sourceLabel = c.source || fallbackSource;
									const statusPillClass =
										c.status === 'Active' ? 'record-pill--status-active'
										: c.status === 'Inactive' ? 'record-pill--status-inactive'
										: c.status === 'Terminated' ? 'record-pill--status-terminated'
										: '';
									// Cards for entities already logged in the ASCII trail get a
									// highlight matching that entity's ascii-entity color (yellow
									// for the current node, blue/green for individual/firm) so the
									// two views visually agree on "you've already seen this one".
									const trailHighlightClass =
										existingInTrail ?
											isCurrentNode ? 'connection-item--trail-current'
											:	`connection-item--trail-${targetType}`
										:	'';
									return (
										<div
											key={i}
											className={`connection-item ${trailHighlightClass}`.trim()}
											onClick={() => (existingInTrail ? selectNode(c.targetCrd, true, targetType) : selectNode(c.targetCrd, false, targetType))}>
											<div className='conn-info'>
												{/* Mirrors the dashboard's top record banner (FIRM/IND badge,
												    CRD value, "<SOURCE>: <status>" pill) so each card reads
												    the same way as that entity's own record banner — the
												    status reflects the target's real live status, not the
												    current/previous relationship type. */}
												<div className='banner-context-row conn-status-row'>
													<span className={`record-side-badge ${targetType}`}>{shortTypeLabel(targetType)}</span>
													<span className='banner-context-meta'>
														<span className='banner-context-meta-item'>
															<span className='banner-context-meta-label'>CRD</span>
															<span className='banner-context-meta-value'>{c.targetCrd}</span>
														</span>
													</span>
													{c.status && (
														<span className='banner-context-status-tags'>
															<span className={`record-pill ${statusPillClass}`}>
																{sourceLabel}: {c.status}
															</span>
														</span>
													)}
												</div>
												<div className='conn-target'>{c.targetName}</div>
												<div className='conn-type'>
													{c.role && `${c.role}`} {c.dates && `• ${c.dates}`}
												</div>
											</div>
										</div>
									);
								};

								const group = (title: string, list: Connection[]) =>
									list.length > 0 && (
										<div className='connections-list'>
											<h3>
												{title} ({list.length})
											</h3>
											<div className='connections-grid'>{list.map(renderItem)}</div>
										</div>
									);

								return (
									<>
										{group('Direct Owners & Executive Officers', owners)}
										{group('Current Connections', current)}
										{group('Previous Connections', previous)}
										{selectedNode.connections.length === 0 && (
											<div className='connections-list'>
												<p className='no-connections'>No connection details available.</p>
											</div>
										)}
									</>
								);
							})()}
						</div>
					</div>
				)}
			</main>

			<style jsx>{`
				.insights-page {
					height: 100vh;
					overflow-y: auto;
					background: #05050f;
					color: #f1f1ff;
					font-family:
						'Inter',
						-apple-system,
						sans-serif;
				}
				.insights-header {
					padding: 14px 32px;
					border-bottom: 1px solid rgba(120, 80, 255, 0.14);
					background: #0d0d22;
					display: flex;
					align-items: center;
					gap: 24px;
					position: sticky;
					top: 0;
					z-index: 100;
					backdrop-filter: blur(12px);
				}
				.header-left {
					display: flex;
					align-items: center;
					gap: 16px;
					flex-shrink: 0;
				}
				h1 {
					margin: 0;
					font-size: 1.15rem;
					font-weight: 800;
					letter-spacing: -0.02em;
					white-space: nowrap;
					background: linear-gradient(135deg, #ffffff, #22d3ee);
					-webkit-background-clip: text;
					-webkit-text-fill-color: transparent;
				}

				.analysis-trail {
					display: flex;
					align-items: center;
					gap: 10px;
					flex: 1;
					min-width: 0;
					overflow-x: auto;
					mask-image: linear-gradient(to right, black 85%, transparent);
				}
				.trail-item {
					color: #94a3b8;
					font-size: 0.85rem;
					font-weight: 600;
					cursor: pointer;
					white-space: nowrap;
					transition: all 0.2s;
					padding: 2px 8px;
					border-radius: 7px;
				}
				.trail-item:hover {
					color: #22d3ee;
					background: #181832;
				}
				.trail-item.is-active {
					color: #f1f1ff;
					background: #1e1e3e;
					cursor: default;
				}
				.trail-separator {
					color: rgba(120, 80, 255, 0.35);
					font-size: 0.75rem;
				}

				.search-container {
					display: flex;
					gap: 8px;
					width: 360px;
					flex-shrink: 0;
				}
				.search-input {
					flex: 1;
					background: #12122a;
					border: 1px solid rgba(120, 80, 255, 0.35);
					border-radius: 7px;
					padding: 8px 14px;
					color: #f1f1ff;
					font-size: 0.88rem;
					font-family: inherit;
					outline: none;
					transition: all 0.2s ease;
				}
				.search-input:focus {
					border-color: #22d3ee;
					box-shadow: 0 0 0 3px rgba(6, 182, 212, 0.2);
					background: #181832;
				}
				.search-button {
					background: linear-gradient(135deg, #7c3aed, #8b5cf6);
					color: #ffffff;
					border: none;
					border-radius: 7px;
					padding: 8px 18px;
					font-size: 0.85rem;
					font-weight: 700;
					cursor: pointer;
					transition: all 0.2s ease;
					white-space: nowrap;
					box-shadow: 0 2px 8px rgba(124, 58, 237, 0.35);
				}
				.search-button:hover:not(:disabled) {
					transform: translateY(-1px);
					box-shadow: 0 4px 14px rgba(124, 58, 237, 0.5);
				}
				.search-button:disabled {
					opacity: 0.6;
					cursor: not-allowed;
				}

				.insights-main {
					display: block;
					grid-template-columns: none;
					height: auto;
					overflow: visible;
					width: 100%;
					max-width: 1800px;
					margin: 0 auto;
					padding: 24px 32px 64px 32px;
					min-height: calc(100vh - 72px);
				}

				.welcome-state {
					text-align: center;
					margin-top: 60px;
					padding: 48px 24px;
					background: #0d0d22;
					border: 1px solid rgba(120, 80, 255, 0.14);
					border-radius: 0;
					max-width: 580px;
					margin-left: auto;
					margin-right: auto;
				}
				.welcome-icon {
					font-size: 3.5rem;
					margin-bottom: 16px;
					opacity: 0.8;
				}
				.welcome-state h2 {
					color: #f1f1ff;
					margin-bottom: 10px;
					font-size: 1.4rem;
					font-weight: 700;
				}
				.welcome-state p {
					color: #94a3b8;
					font-size: 0.92rem;
					line-height: 1.5;
					margin: 0;
				}

				.search-results-overlay {
					width: 100%;
				}
				.results-columns {
					display: grid;
					grid-template-columns: 1fr 1fr;
					gap: 24px;
					width: 100%;
					align-items: start;
				}
				.results-column {
					width: 100%;
					display: flex;
					flex-direction: column;
					background: #0d0d22;
					border: 1px solid rgba(120, 80, 255, 0.18);
					border-radius: 0;
					padding: 20px;
				}
				.results-column h3 {
					font-size: 0.95rem;
					font-weight: 800;
					color: #a78bfa;
					margin-top: 0;
					margin-bottom: 14px;
					border-bottom: 1px solid rgba(120, 80, 255, 0.25);
					padding-bottom: 10px;
					text-transform: uppercase;
					letter-spacing: 0.08em;
				}
				.results-list {
					display: grid;
					grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
					gap: 16px;
					width: 100%;
				}
				.empty-column {
					color: #64748b;
					font-style: italic;
					font-size: 0.88rem;
					padding: 16px;
					background: rgba(18, 18, 42, 0.5);
					border: 1px dashed rgba(120, 80, 255, 0.14);
					border-radius: 0;
					grid-column: 1 / -1;
				}
				.search-result-card {
					padding: 16px 18px;
					background: #12122a;
					border: 1px solid rgba(120, 80, 255, 0.18);
					border-radius: 0;
					cursor: pointer;
					transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
					display: flex;
					flex-direction: column;
					gap: 8px;
					position: relative;
				}
				.search-result-card:hover {
					border-color: #22d3ee;
					background: #181832;
					transform: translateY(-2px);
					box-shadow:
						0 6px 20px rgba(6, 182, 212, 0.15),
						0 2px 6px rgba(0, 0, 0, 0.4);
				}
				.result-card-header {
					display: flex;
					align-items: center;
					justify-content: space-between;
					gap: 8px;
				}
				.result-type-badge {
					font-size: 0.65rem;
					font-weight: 800;
					padding: 3px 8px;
					border-radius: 4px;
					letter-spacing: 0.06em;
					text-transform: uppercase;
				}
				.result-type-badge.individual {
					background: rgba(6, 182, 212, 0.15);
					color: #22d3ee;
					border: 1px solid rgba(6, 182, 212, 0.3);
				}
				.result-type-badge.firm {
					background: rgba(16, 185, 129, 0.15);
					color: #34d399;
					border: 1px solid rgba(16, 185, 129, 0.3);
				}
				.result-source-badge {
					font-size: 0.65rem;
					font-weight: 700;
					font-family: 'JetBrains Mono', monospace;
					color: #94a3b8;
					background: #1e1e3e;
					padding: 2px 6px;
					border-radius: 4px;
				}
				.result-name {
					font-size: 1.1rem;
					font-weight: 700;
					color: #f1f1ff;
					letter-spacing: -0.01em;
				}
				.result-details-row {
					display: flex;
					align-items: center;
					gap: 10px;
					flex-wrap: wrap;
				}
				.result-crd-badge {
					font-family: 'JetBrains Mono', monospace;
					font-size: 0.8rem;
					font-weight: 600;
					color: #10b981;
					background: rgba(16, 185, 129, 0.1);
					padding: 2px 8px;
					border-radius: 4px;
					border: 1px solid rgba(16, 185, 129, 0.2);
				}
				.result-sec-badge {
					font-family: 'JetBrains Mono', monospace;
					font-size: 0.8rem;
					color: #f59e0b;
					background: rgba(245, 158, 11, 0.1);
					padding: 2px 8px;
					border-radius: 4px;
					border: 1px solid rgba(245, 158, 11, 0.2);
				}
				.result-address {
					font-size: 0.82rem;
					color: #94a3b8;
					display: flex;
					align-items: center;
					gap: 4px;
				}
				.result-card-action {
					font-size: 0.78rem;
					font-weight: 700;
					color: #22d3ee;
					margin-top: auto;
					padding-top: 6px;
					opacity: 0.7;
					transition:
						opacity 0.2s,
						transform 0.2s;
					display: flex;
					align-items: center;
					gap: 4px;
				}
				.search-result-card:hover .result-card-action {
					opacity: 1;
					transform: translateX(4px);
				}

				.empty-state {
					text-align: center;
					padding: 60px 24px;
					background: #0d0d22;
					border: 1px solid rgba(120, 80, 255, 0.14);
					border-radius: 0;
					color: #94a3b8;
				}
				.empty-state h3 {
					color: #f1f1ff;
					margin-bottom: 8px;
					font-size: 1.2rem;
				}
				.empty-state p {
					margin: 0;
					font-size: 0.9rem;
				}

				.analysis-container {
					display: grid;
					grid-template-columns: 320px 1fr;
					gap: 24px;
					align-items: start;
				}
				.node-card {
					background: linear-gradient(160deg, rgba(24, 24, 50, 0.95), #0d0d22 60%);
					border: 1px solid rgba(120, 80, 255, 0.22);
					border-radius: 0;
					padding: 26px 24px 24px;
					position: sticky;
					top: 100px;
					box-shadow:
						0 12px 32px rgba(0, 0, 0, 0.35),
						inset 0 1px 0 rgba(255, 255, 255, 0.04);
					overflow: hidden;
				}
				.node-card-accent {
					position: absolute;
					inset: 0 0 auto 0;
					height: 3px;
				}
				.node-card-accent--individual {
					background: linear-gradient(90deg, #3b82f6, #22d3ee);
				}
				.node-card-accent--firm {
					background: linear-gradient(90deg, #10b981, #34d399);
				}
				.node-card .record-side-badge {
					margin-bottom: 14px;
				}
				.node-card h2 {
					font-size: 1.4rem;
					margin-bottom: 16px;
					color: #f1f1ff;
					font-weight: 700;
				}
				.node-stat {
					font-size: 0.88rem;
					margin-bottom: 8px;
					color: #94a3b8;
				}
				.node-stat strong {
					color: #cbd5e1;
				}
				.node-status-tags {
					display: flex;
					flex-wrap: wrap;
					gap: 6px;
					margin-bottom: 12px;
				}
				.reset-button {
					width: 100%;
					margin-top: 24px;
					padding: 10px;
					background: rgba(120, 80, 255, 0.1);
					border: 1px solid rgba(120, 80, 255, 0.3);
					color: #22d3ee;
					border-radius: 7px;
					cursor: pointer;
					font-weight: 600;
					transition: all 0.2s ease;
				}
				.reset-button:hover {
					background: rgba(120, 80, 255, 0.25);
					color: #ffffff;
				}

				.orphan-notice {
					margin-top: 24px;
					padding: 16px 20px;
					background: rgba(234, 179, 8, 0.08);
					border: 1px solid rgba(234, 179, 8, 0.3);
					border-radius: 0;
					font-size: 0.85rem;
					line-height: 1.6;
					color: #cbd5e1;
				}
				.orphan-notice h3 {
					font-size: 0.85rem;
					color: #eab308;
					margin: 0 0 8px;
					text-transform: uppercase;
					letter-spacing: 0.05em;
				}
				.orphan-notice p {
					margin: 0;
				}
				.orphan-notice strong {
					color: #f1f5f9;
				}

				.analysis-text-card {
					margin-top: 24px;
					padding: 20px;
					background: rgba(34, 211, 238, 0.05);
					border: 1px solid rgba(34, 211, 238, 0.2);
					border-radius: 0;
					font-size: 0.9rem;
					line-height: 1.6;
					color: #cbd5e1;
				}
				.analysis-text-card h3 {
					font-size: 0.9rem;
					color: #22d3ee;
					margin-bottom: 8px;
					text-transform: uppercase;
					letter-spacing: 0.05em;
				}

				.ascii-card {
					background: #070718;
					border: 1px solid rgba(120, 80, 255, 0.18);
					border-radius: 0;
					overflow: hidden;
					margin-bottom: 32px;
				}
				.card-header {
					padding: 16px 24px;
					background: #0d0d22;
					border-bottom: 1px solid rgba(120, 80, 255, 0.14);
					display: flex;
					justify-content: space-between;
					align-items: center;
				}
				.format-badge {
					font-size: 0.65rem;
					font-weight: 800;
					color: #22d3ee;
					border: 1px solid rgba(34, 211, 238, 0.3);
					padding: 2px 6px;
					border-radius: 4px;
				}
				:global(.ascii-output) {
					padding: 28px 32px;
					margin: 0;
					font-family: 'JetBrains Mono', monospace;
					font-size: 0.92rem;
					line-height: 1.6;
					color: #64748b;
					white-space: pre;
					overflow-x: auto;
				}
				:global(.ascii-entity) {
					font-weight: 700;
				}
				:global(.ascii-entity-clickable) {
					cursor: pointer;
					text-decoration: underline dotted;
					text-underline-offset: 3px;
				}
				:global(.ascii-entity-clickable:hover) {
					filter: brightness(1.3);
				}
				:global(.ascii-entity-current) {
					color: #eab308;
				}
				:global(.ascii-detail) {
					color: #93c5fd;
				}
				:global(.ascii-detail-current) {
					color: #eab308;
					font-weight: 700;
				}
				:global(.ascii-entity-individual) {
					color: #22d3ee;
				}
				:global(.ascii-entity-firm) {
					color: #34d399;
				}

				.connections-list h3 {
					font-size: 1.05rem;
					margin-bottom: 16px;
					color: #f1f1ff;
					font-weight: 700;
				}
				.connections-list {
					background: #070718;
					border: 1px solid rgba(120, 80, 255, 0.18);
					border-radius: 0;
					padding: 24px;
					margin-bottom: 24px;
				}
				.connections-grid {
					display: grid;
					grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
					gap: 16px;
					width: 100%;
				}
				.connection-item {
					display: flex;
					align-items: flex-start;
					gap: 16px;
					padding: 12px 16px;
					background: #0d0d22;
					border: 1px solid rgba(120, 80, 255, 0.18);
					border-left: 3px solid rgba(120, 80, 255, 0.4);
					border-radius: 0;
					cursor: pointer;
					transition: all 0.2s ease;
					height: 100%;
				}
				.connection-item:hover {
					border-color: #22d3ee;
					background: #181832;
					transform: translateY(-2px);
				}
				.connection-item--trail-individual {
					border-color: rgba(34, 211, 238, 0.45);
					border-left-color: #22d3ee;
					background: rgba(34, 211, 238, 0.06);
				}
				.connection-item--trail-firm {
					border-color: rgba(52, 211, 153, 0.45);
					border-left-color: #34d399;
					background: rgba(52, 211, 153, 0.06);
				}
				.connection-item--trail-current {
					border-color: rgba(234, 179, 8, 0.5);
					border-left-color: #eab308;
					background: rgba(234, 179, 8, 0.08);
				}
				.conn-info {
					flex: 1;
					min-width: 0;
				}
				.conn-status-row {
					padding-bottom: 0;
					margin-bottom: 6px;
					border-bottom: none;
				}
				.conn-target {
					font-weight: 700;
					color: #f1f1ff;
					margin-bottom: 2px;
				}
				.conn-type {
					font-size: 0.8rem;
					color: #94a3b8;
				}

				.error-state {
					padding: 24px;
					background: rgba(244, 63, 94, 0.1);
					border: 1px solid rgba(244, 63, 94, 0.25);
					border-radius: 0;
					color: #f43f5e;
				}
				.ambiguous-state {
					width: 100%;
					padding: 24px;
					background: rgba(167, 139, 250, 0.08);
					border: 1px solid rgba(167, 139, 250, 0.3);
					border-radius: 0;
				}
				.ambiguous-state h3 {
					margin-top: 0;
					color: #a78bfa;
				}
				.ambiguous-state p {
					color: #94a3b8;
					margin-bottom: 18px;
				}
				.ambiguous-options {
					display: grid;
					grid-template-columns: 1fr 1fr;
					gap: 20px;
				}
				.no-connections {
					color: #64748b;
					font-style: italic;
				}

				/* API-style dark maroon treatment */
				.insights-page {
					background: linear-gradient(180deg, #14080c 0%, #060306 100%);
					color: #f8ebef;
				}
				.insights-header {
					background: rgba(16, 8, 10, 0.96);
					border-bottom: 1px solid rgba(146, 34, 70, 0.35);
					box-shadow: 0 12px 32px rgba(0, 0, 0, 0.25);
				}
				h1 {
					background: linear-gradient(135deg, #fff2f6 0%, #ff9eb4 50%, #b0274b 100%);
					-webkit-background-clip: text;
					background-clip: text;
					-webkit-text-fill-color: transparent;
				}
				.search-input {
					background: #12070b;
					border-color: rgba(146, 34, 70, 0.35);
					color: #f8ebef;
				}
				.search-input:focus {
					border-color: #d94a72;
					box-shadow: 0 0 0 3px rgba(217, 74, 114, 0.18);
					background: #180a10;
				}
				.search-button {
					background: linear-gradient(135deg, #8f2244 0%, #b12d54 100%);
					box-shadow: 0 10px 24px rgba(145, 27, 66, 0.25);
				}
				.search-button:hover:not(:disabled) {
					box-shadow: 0 12px 28px rgba(145, 27, 66, 0.35);
				}
				.welcome-state,
				.empty-state,
				.results-column,
				.connections-list,
				.ascii-card,
				.node-card,
				.analysis-text-card,
				.ambiguous-state,
				.orphan-notice {
					background: linear-gradient(180deg, rgba(30, 6, 15, 0.96) 0%, rgba(12, 5, 8, 0.98) 100%);
					border: 1px solid rgba(146, 34, 70, 0.28);
					box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.025);
				}
				.search-result-card,
				.connection-item {
					background: #12070b;
					border-color: rgba(146, 34, 70, 0.24);
				}
				.search-result-card:hover,
				.connection-item:hover {
					background: #180a10;
					border-color: rgba(217, 74, 114, 0.45);
					box-shadow: 0 10px 24px rgba(0, 0, 0, 0.28);
				}
				.result-type-badge.individual {
					background: rgba(217, 74, 114, 0.16);
					color: #ff9cb1;
					border-color: rgba(217, 74, 114, 0.3);
				}
				.result-type-badge.firm {
					background: rgba(132, 91, 33, 0.18);
					color: #ffbf7a;
					border-color: rgba(132, 91, 33, 0.3);
				}
				.result-crd-badge {
					color: #ffb4c5;
					background: rgba(146, 34, 70, 0.16);
					border-color: rgba(146, 34, 70, 0.28);
				}
				.result-sec-badge {
					color: #ffcc7a;
					background: rgba(194, 120, 41, 0.14);
					border-color: rgba(194, 120, 41, 0.22);
				}
				.result-card-action,
				.format-badge {
					color: #ff9cb1;
				}
				:global(.ascii-output) {
					color: #b5949f;
				}
				:global(.ascii-entity-individual) {
					color: #ff9cb1;
				}
				:global(.ascii-entity-firm) {
					color: #ffbf7a;
				}
				:global(.ascii-detail) {
					color: #d99ca6;
				}
				:global(.ascii-detail-current) {
					color: #ffc66b;
				}
			`}</style>
		</div>
	);
}
