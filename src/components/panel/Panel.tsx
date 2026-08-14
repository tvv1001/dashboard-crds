'use client';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { StatusConsoleState, SyncBannerState, SavedPayload } from '../../types';
import { PanelHeader } from './PanelHeader';
import { SyncBanner } from './SyncBanner';
import { GlobalBanner } from './GlobalBanner';
import { StatusConsole } from './StatusConsole';
import { StatusBox } from './StatusBox';
import { LocalNameSearch } from './LocalNameSearch';
import { parseCrdKey } from '../../lib/parseKey';
import { extractNamesFromPayload, getContentBlock, resolveEntityDisplayName } from '../../lib/extractNames';
import { useSelectionLog } from '../../hooks/useSelectionLog';

interface Props {
	activeKey: string;
	payloads: SavedPayload[];
	statusConsole: StatusConsoleState;
	syncBanner: SyncBannerState;
	statusHtml: string;
	detailJson: string | null;
	panelLoading: boolean;
	fetchLog: string[];
	onClearLog: () => void;
	onCrawl: (source: 'finra' | 'sec', crd: string, type: string) => void;
	onDismissSync: () => void;
	globalStatus: { msg: string; visible: boolean; isRateLimit: boolean };
	onCloseGlobal: () => void;
	onResolveRateLimit: () => void;
	savedStatusMsg: string;
	onAnalyze: () => void;
	geminiAnalysis: string | null;
	geminiLoading: boolean;
	nameSearchQuery: string;
	onNameSearchQueryChange: (q: string) => void;
	onNameSearch: () => void;
	nameSearchResults: import('../../types').LocalNameSearchResult[];
	nameSearchTotalMatches?: number;
	nameSearchIndexedCount: number;
	nameSearchSourceMode: 'redis' | 'local';
	redisUniqueCount: number;
	redisHeaderStatus: {
		connected: boolean;
		configured: boolean;
		mode: 'upstash-rest' | 'redis-url' | 'none';
		latencyMs: number | null;
	};
	nameSearched: boolean;
	nameSearchLoading: boolean;
	nameSearchError: string;
	onSelectNameResult: (crd: string, type: string, source?: string, key?: string) => void;
	onCopyNameResults: () => void;
	onSelectKey: (key: string) => void;
}

export function Panel({
	activeKey,
	payloads,
	statusConsole,
	syncBanner,
	statusHtml,
	detailJson,
	panelLoading,
	fetchLog,
	onClearLog,
	onCrawl,
	onDismissSync,
	globalStatus,
	onCloseGlobal,
	onResolveRateLimit,
	savedStatusMsg,
	onAnalyze,
	geminiAnalysis,
	geminiLoading,
	nameSearchQuery,
	onNameSearchQueryChange,
	onNameSearch,
	nameSearchResults,
	nameSearchTotalMatches,
	nameSearchIndexedCount,
	nameSearchSourceMode,
	redisUniqueCount,
	redisHeaderStatus,
	nameSearched,
	nameSearchLoading,
	nameSearchError,
	onSelectNameResult,
	onCopyNameResults,
	onSelectKey,
}: Props) {
	const parsed = activeKey ? parseCrdKey(activeKey) : null;

	const typeSlug = parsed?.type === 'firm' ? 'firm' : 'individual';
	const currentCrd = parsed?.crd || '';
	const finraProfileUrl = parsed ? `https://brokercheck.finra.org/${typeSlug}/summary/${currentCrd}` : '';
	const secProfileUrl = parsed ? `https://adviserinfo.sec.gov/${typeSlug}/summary/${currentCrd}` : '';

	// Prefer the freshly-loaded detail bundle (which reflects any just-in-time
	// cleanup of broken/stub records) over the sidebar's payload list, which is
	// only refreshed periodically and can go stale after a record is removed.
	const bundleSources = useMemo(() => {
		if (!activeKey || !detailJson) return null;
		try {
			const parsedDetail = JSON.parse(detailJson);
			const sources = parsedDetail && typeof parsedDetail === 'object' ? parsedDetail.sources : null;
			if (!sources || typeof sources !== 'object') return null;
			return sources as { finra?: { found?: boolean }; sec?: { found?: boolean } };
		} catch {
			return null;
		}
	}, [activeKey, detailJson]);

	const hasFinraSource =
		bundleSources ? Boolean(bundleSources.finra?.found) : Boolean(parsed && payloads.some((p) => p.key === `finra:${parsed.type}:${parsed.crd}`)) || parsed?.source === 'finra';
	const hasSecSource =
		bundleSources ? Boolean(bundleSources.sec?.found) : Boolean(parsed && payloads.some((p) => p.key === `sec:${parsed.type}:${parsed.crd}`)) || parsed?.source === 'sec';

	const { selectionLog, pushSelectionLogEntry, clearSelectionLog } = useSelectionLog();

	useEffect(() => {
		if (!parsed || !detailJson) return;
		try {
			const payload = JSON.parse(detailJson);
			const name = resolveEntityDisplayName({
				payload,
				type: parsed.type as 'individual' | 'firm',
				crd: parsed.crd,
				source: parsed.source,
			});
			if (name && name !== parsed.crd) {
				pushSelectionLogEntry({
					id: parsed.crd,
					label: name,
					type: parsed.type as 'individual' | 'firm',
					display: `${name} :: CRD# ${parsed.crd}`,
					crd: parsed.crd,
					key: activeKey,
					ts: Date.now(),
				});
			}
		} catch {
			// ignore unparsable detail JSON
		}
	}, [parsed?.type, parsed?.crd, parsed?.source, detailJson, activeKey, pushSelectionLogEntry]);

	// Draggable resize handle between the details pane and the Redis Search box.
	// The box starts small (just header + input + button) and slides up to the
	// expanded/draggable height once a search turns up results.
	const COLLAPSED_SEARCH_HEIGHT = 168;
	const [searchPanelHeight, setSearchPanelHeight] = useState(480);
	const [isResizing, setIsResizing] = useState(false);
	const hasSearchResults = Boolean(nameSearched && !nameSearchLoading && nameSearchResults.length > 0);
	const effectiveSearchPanelHeight = hasSearchResults ? searchPanelHeight : COLLAPSED_SEARCH_HEIGHT;
	const resizeStateRef = useRef<{ startY: number; startHeight: number } | null>(null);

	const handleResizeMove = useCallback((e: MouseEvent) => {
		const state = resizeStateRef.current;
		if (!state) return;
		const delta = state.startY - e.clientY;
		const next = Math.min(Math.max(state.startHeight + delta, 220), Math.round(window.innerHeight * 0.85));
		setSearchPanelHeight(next);
	}, []);

	const handleResizeEnd = useCallback(() => {
		resizeStateRef.current = null;
		setIsResizing(false);
		document.body.style.cursor = '';
		window.removeEventListener('mousemove', handleResizeMove);
		window.removeEventListener('mouseup', handleResizeEnd);
	}, [handleResizeMove]);

	const handleResizeStart = useCallback(
		(e: React.MouseEvent) => {
			if (!hasSearchResults) return;
			e.preventDefault();
			resizeStateRef.current = { startY: e.clientY, startHeight: searchPanelHeight };
			setIsResizing(true);
			document.body.style.cursor = 'row-resize';
			window.addEventListener('mousemove', handleResizeMove);
			window.addEventListener('mouseup', handleResizeEnd);
		},
		[hasSearchResults, searchPanelHeight, handleResizeMove, handleResizeEnd],
	);

	/*
	const activeEntityLabel = useMemo(() => {
		if (!parsed) return '';
		const payload =
			detailJson ?
				(() => {
					try {
						return JSON.parse(detailJson);
					} catch {
						return null;
					}
				})()
			:	null;
		const orphanName =
			payload && typeof payload === 'object' && payload.orphan && typeof payload.orphan === 'object' && typeof payload.orphan.name === 'string' ? payload.orphan.name : '';
		if (orphanName) return orphanName;
		const content = payload ? getContentBlock(payload, parsed.source, parsed.type) : null;
		const names = content ? extractNamesFromPayload(content, parsed.type as 'individual' | 'firm') : null;
		return names?.primary || '';
	}, [detailJson, parsed]);
	*/

	return (
		<section
			className='panel'
			id='panel'>
			<div className='panel-scroll-shell'>
				<div className='panel-scroll-content'>
					<GlobalBanner
						msg={globalStatus.msg}
						visible={globalStatus.visible}
						isRateLimit={globalStatus.isRateLimit}
						onClose={onCloseGlobal}
						onResolveRateLimit={onResolveRateLimit}
					/>

					<PanelHeader
						activeKey={activeKey}
						payloads={payloads}
						detailJson={detailJson}
						onSelectKey={onSelectKey}
					/>

					<SyncBanner
						syncBanner={syncBanner}
						onDismiss={onDismissSync}
					/>

					<StatusConsole status={statusConsole} />

					{geminiAnalysis && (
						<div className='gemini-analysis-box'>
							<div className='gemini-analysis-header'>
								<h3>Gemini Analysis</h3>
							</div>
							<div className='gemini-analysis-content'>
								{geminiAnalysis.split('\n').map((line, i) => (
									<p key={i}>{line}</p>
								))}
							</div>
						</div>
					)}

					<div className='record-workspace-wrapper'>
						<div className='record-workspace'>
							<StatusBox
								statusMsg={savedStatusMsg}
								statusHtml={statusHtml}
								detailJson={detailJson}
								panelLoading={panelLoading}
								activeKey={activeKey}
								fetchLog={fetchLog}
								onClearLog={onClearLog}
								onSelectKey={onSelectKey}
							/>

							<aside className='record-side-panel'>
								<div className='record-side-header'>
									<h3 className='record-side-title'>Log list</h3>
									{selectionLog.length > 0 && (
										<span className='record-side-header-actions'>
											<span className='record-side-badges'>{selectionLog.length}</span>
											<button
												type='button'
												className='record-side-history-clear'
												onClick={() => {
													clearSelectionLog();
												}}
												title='Clear selection history'>
												Clear
											</button>
										</span>
									)}
								</div>
								{selectionLog.length > 0 ?
									<div className='record-side-history-list'>
										{selectionLog.map((entry, idx) => {
											const isActive = Boolean(entry.crd && activeKey && activeKey.endsWith(`:${entry.crd}`)) || entry.id === activeKey.split(':').pop();
											return (
												<button
													type='button'
													key={`${entry.id}-${entry.ts || idx}-${idx}`}
													className={`record-side-history-item ${isActive ? 'active' : ''}`.trim()}
													onClick={() => entry.key && onSelectKey(entry.key)}
													title={entry.display}>
													<span className={`record-side-badge ${entry.type === 'firm' ? 'firm' : 'individual'}`}>{entry.type === 'firm' ? 'FIRM' : 'IND'}</span>
													<span className='record-side-history-label'>{entry.label}</span>
													<span className='record-side-history-crd'>{entry.crd}</span>
												</button>
											);
										})}
									</div>
								:	<div className='record-side-empty'>Selected CRDs will appear here.</div>}
							</aside>
						</div>
					</div>
				</div>

				<div
					className={`local-name-search-resizable${hasSearchResults ? ' has-results' : ' is-collapsed'}${isResizing ? ' is-resizing' : ''}`}
					style={{ height: effectiveSearchPanelHeight }}>
					{hasSearchResults && (
						<div
							className='panel-resize-handle'
							onMouseDown={handleResizeStart}
							role='separator'
							aria-orientation='horizontal'
							aria-label='Resize Redis Search panel'
							title='Drag to resize'
						/>
					)}
					<LocalNameSearch
						query={nameSearchQuery}
						onQueryChange={onNameSearchQueryChange}
						onSearch={onNameSearch}
						results={nameSearchResults}
						totalMatches={nameSearchTotalMatches}
						totalIndexed={nameSearchIndexedCount}
						sourceMode={nameSearchSourceMode}
						redisUniqueCount={redisUniqueCount}
						redisHeaderStatus={redisHeaderStatus}
						searched={nameSearched}
						loading={nameSearchLoading}
						error={nameSearchError}
						onSelectResult={onSelectNameResult}
						onCopyResults={onCopyNameResults}
					/>
				</div>
			</div>
		</section>
	);
}
