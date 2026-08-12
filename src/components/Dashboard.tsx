'use client';
import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { useSavedPayloads, useSeenKeys } from '../hooks/useSavedPayloads';
import { useQueue, createDefaultSyncBanner } from '../hooks/useQueue';
import { useNewCrds } from '../hooks/useNewCrds';
import { useLocalNameSearch } from '../hooks/useLocalNameSearch';
import { buildGroups } from '../lib/buildGroups';
import { parseCrdKey, parseRequestedSelectionFromUrl } from '../lib/parseKey';
import { writeLastCrdSelection } from '../lib/lastCrdSelection';
import type { SortOrder } from '../types';
import { Panel } from './panel/Panel';
import { NewCrdsSidebar } from './new-crds/NewCrdsSidebar';
import { NewCrdsNotice } from './new-crds/NewCrdsNotice';
import { useSharedGraphState } from '../hooks/useSharedGraphState';

// Persisted client-side so the sidebar's "Selection history" list survives
// page reloads/navigation — cleared only via the explicit Clear button.
const SELECTION_HISTORY_STORAGE_KEY = 'finra-sec-selection-history';

export default function Dashboard() {
	type RedisHeaderStatus = {
		connected: boolean;
		configured: boolean;
		mode: 'upstash-rest' | 'redis-url' | 'none';
		latencyMs: number | null;
	};

	// ── Data layer ────────────────────────────────────────────────────────────
	const {
		payloads,
		setPayloads,
		loading: payloadsLoading,
		statusMsg: savedStatusMsg,
		totalCount,
		truncated: savedPayloadsTruncated,
		uniqueIndividualCrds,
		uniqueFirmCrds,
		uniqueTotalCrds,
		load: loadSaved,
		promoteSaved,
		promoteBySeeds,
		updateStats,
	} = useSavedPayloads();
	const { seenKeys, load: loadSeenKeys, markSeen } = useSeenKeys();

	// ── Queue / crawl ─────────────────────────────────────────────────────────
	const { queueItems, statusConsole, syncBanner, globalStatus, fetchLog, statusHtml, isRunning, hideGlobal, resolveRateLimitRetry, clearLog, runSingleSearchWithSse, runQueue } =
		useQueue({
			onPromoteSaved: promoteSaved,
			onPromoteBySeeds: promoteBySeeds,
			onRefreshSaved: () =>
				loadSaved({
					filter,
					sortOrder,
					typeFilter,
					includeCrds: pendingSelection ? [pendingSelection.crd] : [],
				}),
			onScheduleNewCrdsRefresh: () => newCrds.scheduleRefresh(),
			onUpdateStats: updateStats,
		});

	// ── New CRDs ──────────────────────────────────────────────────────────────
	const newCrds = useNewCrds();

	// ── Local name search ─────────────────────────────────────────────────────
	const nameSearch = useLocalNameSearch();

	// ── UI state ──────────────────────────────────────────────────────────────
	const sharedGraphState = useSharedGraphState();
	const [activeKey, setActiveKey] = useState('');
	const [detailJson, setDetailJson] = useState<string | null>(null);
	const [panelLoading, setPanelLoading] = useState(false);
	const [geminiAnalysis, setGeminiAnalysis] = useState<string | null>(null);
	const [geminiLoading, setGeminiLoading] = useState(false);
	const [searchTerms, setSearchTerms] = useState('');
	const [filter, setFilter] = useState('');
	const [sortOrder, setSortOrder] = useState<SortOrder>('date-desc');
	const [typeFilter, setTypeFilter] = useState('all');
	const [dismissedSync, setDismissedSync] = useState(false);
	const [pendingSelection, setPendingSelection] = useState<import('../types').RequestedSelection | null>(null);
	const [selectionHistory, setSelectionHistory] = useState<string[]>([]);
	// Selection history is loaded from localStorage post-mount (not in the
	// useState initializer) to avoid SSR/CSR hydration mismatches — the server
	// always renders with an empty history since it has no access to
	// localStorage. `historyLoaded` guards the persist effect below so it
	// doesn't stomp the stored value with `[]` before the load effect runs.
	const [historyLoaded, setHistoryLoaded] = useState(false);
	useEffect(() => {
		if (typeof window === 'undefined') return;
		try {
			const stored = window.localStorage.getItem(SELECTION_HISTORY_STORAGE_KEY);
			const parsed = stored ? JSON.parse(stored) : [];
			if (Array.isArray(parsed)) {
				setSelectionHistory(parsed.filter((k): k is string => typeof k === 'string'));
			}
		} catch {
			// ignore malformed/unavailable storage
		} finally {
			setHistoryLoaded(true);
		}
	}, []);
	const [redisHeaderStatus, setRedisHeaderStatus] = useState<RedisHeaderStatus>({
		connected: false,
		configured: false,
		mode: 'none',
		latencyMs: null,
	});

	// Persist selection history to localStorage on every change so it survives
	// reloads/navigation; only cleared explicitly via clearSelectionHistory.
	useEffect(() => {
		if (!historyLoaded || typeof window === 'undefined') return;
		try {
			window.localStorage.setItem(SELECTION_HISTORY_STORAGE_KEY, JSON.stringify(selectionHistory));
		} catch {
			// ignore storage quota/availability errors
		}
	}, [selectionHistory, historyLoaded]);

	const clearSelectionHistory = useCallback(() => {
		setSelectionHistory([]);
		if (typeof window === 'undefined') return;
		try {
			window.localStorage.removeItem(SELECTION_HISTORY_STORAGE_KEY);
		} catch {
			// ignore storage errors
		}
	}, []);

	// ── Derived ───────────────────────────────────────────────────────────────
	const groups = useMemo(() => buildGroups(payloads, sortOrder, typeFilter), [payloads, sortOrder, typeFilter]);

	// ── Sync banner dismiss ───────────────────────────────────────────────────
	const displayedSyncBanner = dismissedSync ? createDefaultSyncBanner() : syncBanner;

	// ── Select a key from the sidebar ────────────────────────────────────────
	const pushSelectionHistory = useCallback((key: string) => {
		if (!key) return;
		const parsed = parseCrdKey(key);
		// Dedupe by CRD+type (not the exact finra/sec key) so switching between
		// a record's FINRA and SEC snapshot doesn't create two history entries.
		const signature = parsed ? `${parsed.type}:${parsed.crd}` : key;
		setSelectionHistory((prev) =>
			[
				key,
				...prev.filter((k) => {
					const p = parseCrdKey(k);
					const s = p ? `${p.type}:${p.crd}` : k;
					return s !== signature;
				}),
			].slice(0, 30),
		);
	}, []);

	const selectKey = useCallback(
		(key: string) => {
			const cached = sharedGraphState.getSnapshot(key);
			const persistSnapshot = (selectionKey: string, resolvedKey: string, detail: string | null) => {
				const normalizedKey = resolvedKey || selectionKey;
				sharedGraphState.setSnapshot(selectionKey, {
					key: selectionKey,
					resolvedKey: normalizedKey,
					detailJson: detail,
					fetchedAt: Date.now(),
					source: 'dashboard',
				});
				if (normalizedKey !== selectionKey) {
					sharedGraphState.setSnapshot(normalizedKey, {
						key: normalizedKey,
						resolvedKey: normalizedKey,
						detailJson: detail,
						fetchedAt: Date.now(),
						source: 'dashboard',
					});
				}
			};

			if (cached?.detailJson) {
				const resolvedKey = cached.resolvedKey || key;
				persistSnapshot(key, resolvedKey, cached.detailJson);
				setActiveKey(resolvedKey);
				setDetailJson(cached.detailJson);
				setPanelLoading(false);
				setGeminiAnalysis(null);
				markSeen(key);
				syncPathForSelection(resolvedKey);
				pushSelectionHistory(resolvedKey);
				return;
			}

			setActiveKey(key);
			setPanelLoading(true);
			setDetailJson(null);
			setGeminiAnalysis(null);
			markSeen(key);
			syncPathForSelection(key);
			pushSelectionHistory(key);
			fetch(`/api/key?name=${encodeURIComponent(key)}`)
				.then(async (r) => {
					const data = await r.json();
					if (!r.ok) {
						throw new Error(String(data?.error || `HTTP ${r.status}`));
					}
					return data;
				})
				.then((data) => {
					const resolvedKey = typeof data?.resolvedKey === 'string' ? data.resolvedKey : key;
					if (resolvedKey !== key) {
						setActiveKey(resolvedKey);
						markSeen(resolvedKey);
						syncPathForSelection(resolvedKey);
						pushSelectionHistory(resolvedKey);
					}
					const detailValue = typeof data?.rawPayload === 'string' ? data.rawPayload : JSON.stringify(data?.payload ?? data ?? null, null, 2);
					setDetailJson(detailValue);
					persistSnapshot(key, resolvedKey, detailValue);
				})
				.catch((err: unknown) => {
					const message = err instanceof Error ? err.message : `Could not load data for ${key}`;
					setDetailJson(`// ${message}`);
				})
				.finally(() => {
					setPanelLoading(false);
				});
		},
		[payloads, markSeen, sharedGraphState],
	);

	// ── Gemini Analysis ──────────────────────────────────────────────────────
	const handleAnalyze = useCallback(() => {
		if (!activeKey) return;
		setGeminiLoading(true);
		setGeminiAnalysis(null);
		fetch(`/api/analyze?name=${encodeURIComponent(activeKey)}`)
			.then((r) => r.json())
			.then((data) => {
				if (data.error) setGeminiAnalysis(`Error: ${data.error}`);
				else setGeminiAnalysis(data.analysis);
			})
			.catch((e) => setGeminiAnalysis(`Error: ${e.message}`))
			.finally(() => setGeminiLoading(false));
	}, [activeKey]);

	// ── Crawl action from ApiStructure ────────────────────────────────────────
	const handleCrawl = useCallback(
		(source: 'finra' | 'sec', crd: string, type: string) => {
			const term = `${crd}`;
			setSearchTerms(term);
			runSingleSearchWithSse(term);
		},
		[runSingleSearchWithSse],
	);

	// ── Run queue / single ────────────────────────────────────────────────────
	const handleRun = useCallback(() => {
		const raw = searchTerms;
		runQueue(raw);
	}, [searchTerms, runQueue]);

	// ── New CRD select ────────────────────────────────────────────────────────
	const handleNewCrdSelect = useCallback(
		(crd: string, source: string, type: string) => {
			// First look for existing key in the current payloads
			const key = payloads.find((p) => {
				const parsed = parseCrdKey(p.key);
				return parsed && parsed.crd === crd && parsed.source === source;
			});
			if (key) {
				selectKey(key.key);
			} else {
				// Construct the key directly if it's not in the main list
				const constructedKey = `${source}:${type}:${crd}`;
				selectKey(constructedKey);
			}
		},
		[payloads, selectKey],
	);

	// ── Local name search → select ────────────────────────────────────────────
	const handleSelectNameResult = useCallback(
		(crd: string, type: string, source?: string, key?: string) => {
			if (key) {
				selectKey(key);
				return;
			}

			const normalizedType = type === 'firm' ? 'firm' : 'individual';
			const normalizedSource = source === 'finra' || source === 'sec' ? source : undefined;

			if (normalizedSource) {
				selectKey(`${normalizedSource}:${normalizedType}:${crd}`);
				return;
			}

			const existing = payloads.find((p) => {
				const parsed = parseCrdKey(p.key);
				return parsed && parsed.crd === crd && parsed.type === normalizedType;
			});

			if (existing) {
				selectKey(existing.key);
				return;
			}

			// Prefer FINRA first — Redis primary for most individuals/firms.
			// Backend /api/key still resolves the alternate source when needed.
			selectKey(`finra:${normalizedType}:${crd}`);
		},
		[payloads, selectKey],
	);

	// ── URL sync ──────────────────────────────────────────────────────────────
	// Pushes a new history entry for each distinct selection (deduped by path)
	// so the browser back/forward buttons step through previously viewed keys.
	// Also notifies the top-nav (Node Graph link) so it can deep-link the same CRD.
	function syncPathForSelection(key: string) {
		const parsed = parseCrdKey(key);
		if (!parsed) return;
		const newPath = `/${parsed.type}/${parsed.crd}`;
		// Remember for Global Map / Node Graph when user is on bare /chart or /graph.
		writeLastCrdSelection({ type: parsed.type, crd: parsed.crd, key });
		if (window.location.pathname === newPath) {
			window.dispatchEvent(
				new CustomEvent('crd-selection-change', {
					detail: { path: newPath, key, type: parsed.type, crd: parsed.crd },
				}),
			);
			return;
		}
		history.pushState({ key }, '', newPath);
		window.dispatchEvent(
			new CustomEvent('crd-selection-change', {
				detail: { path: newPath, key, type: parsed.type, crd: parsed.crd },
			}),
		);
	}

	// ── Initialization ────────────────────────────────────────────────────────
	useEffect(() => {
		const pending = parseRequestedSelectionFromUrl(window.location.href);
		if (pending) setPendingSelection(pending);
		loadSeenKeys().catch(() => {});
		newCrds.load();

		// Fetch Redis health status with retry logic
		let retries = 0;
		const maxRetries = 2;
		const fetchRedisHealth = async () => {
			try {
				const controller = new AbortController();
				const timeout = setTimeout(() => controller.abort(), 5000);
				const r = await fetch('/api/redis-health', { signal: controller.signal });
				clearTimeout(timeout);
				const json = await r.json();
				setRedisHeaderStatus({
					connected: Boolean(json?.ok),
					configured: Boolean(json?.configured),
					mode: json?.mode === 'upstash-rest' || json?.mode === 'redis-url' ? json.mode : 'none',
					latencyMs: Number.isFinite(Number(json?.latencyMs)) ? Number(json.latencyMs) : null,
				});
			} catch (error) {
				// Retry on timeout or network error
				if (retries < maxRetries) {
					retries++;
					setTimeout(fetchRedisHealth, 500 * retries);
				} else {
					setRedisHeaderStatus({
						connected: false,
						configured: false,
						mode: 'none',
						latencyMs: null,
					});
				}
			}
		};

		fetchRedisHealth();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// Handle browser back/forward: re-resolve the selection from the URL the
	// browser navigated to (this reuses the same pendingSelection resolution
	// flow used on first load). syncPathForSelection() is a no-op in that case
	// since the URL already matches, so no extra history entry gets pushed.
	useEffect(() => {
		function handlePopState() {
			const selection = parseRequestedSelectionFromUrl(window.location.href);
			if (selection) setPendingSelection(selection);
		}
		window.addEventListener('popstate', handlePopState);
		return () => window.removeEventListener('popstate', handlePopState);
	}, []);

	useEffect(() => {
		const includeCrds = pendingSelection ? [pendingSelection.crd] : [];
		const delayMs = filter.trim() ? 250 : 0;
		const timer = window.setTimeout(() => {
			loadSaved({
				filter,
				sortOrder,
				typeFilter,
				includeCrds,
			}).catch(() => {});
		}, delayMs);
		return () => window.clearTimeout(timer);
	}, [filter, sortOrder, typeFilter, pendingSelection, loadSaved]);

	// Resolve URL selection once payloads are ready
	useEffect(() => {
		if (!pendingSelection) return;
		const { crd, type, preferredSources } = pendingSelection;

		for (const source of preferredSources) {
			const match = payloads.find((p) => {
				const r = parseCrdKey(p.key);
				return r && r.crd === crd && r.type === type && r.source === source;
			});
			if (match) {
				selectKey(match.key);
				setPendingSelection(null);
				return;
			}
		}
		// Try any source already loaded locally
		const fallback = payloads.find((p) => {
			const r = parseCrdKey(p.key);
			return r && r.crd === crd && r.type === type;
		});
		if (fallback) {
			selectKey(fallback.key);
			setPendingSelection(null);
			return;
		}
		// Wait for the first payloads fetch to finish so we don't miss a local
		// match (e.g. filtered out momentarily) before giving up on it.
		if (payloads.length === 0 && payloadsLoading) return;
		// Not found locally (e.g. filtered out, or only reached via a
		// name/new-CRD search) — construct the key directly and let
		// /api/key resolve the correct source, same as handleNewCrdSelect's
		// fallback. This ensures back/forward navigation always re-fetches
		// and updates the panel, even when the target isn't in `payloads`.
		const constructedKey = `${preferredSources[0]}:${type}:${crd}`;
		selectKey(constructedKey);
		setPendingSelection(null);
	}, [payloads, pendingSelection, selectKey, payloadsLoading]);

	return (
		<>
			{/* Always mounted: mobile CSS pins this as a collapsed strip under the top nav;
			    desktop CSS keeps it as the right column (or hides it when dismissed). */}
			<main className={`dashboard-layout no-left-sidebar ${newCrds.showSidebar ? '' : 'no-new-crds-sidebar'}`.trim()}>
				<NewCrdsSidebar
					state={newCrds.state}
					activeKey={activeKey}
					onToggle={newCrds.toggle}
					onDismiss={newCrds.dismiss}
					onSelect={handleNewCrdSelect}
				/>
				<Panel
					activeKey={activeKey}
					payloads={payloads}
					selectionHistory={selectionHistory}
					onClearSelectionHistory={clearSelectionHistory}
					statusConsole={statusConsole}
					syncBanner={displayedSyncBanner}
					statusHtml={statusHtml}
					detailJson={detailJson}
					panelLoading={panelLoading}
					fetchLog={fetchLog}
					onClearLog={clearLog}
					onCrawl={handleCrawl}
					onDismissSync={() => setDismissedSync(true)}
					globalStatus={globalStatus}
					onCloseGlobal={hideGlobal}
					onResolveRateLimit={resolveRateLimitRetry}
					savedStatusMsg={savedStatusMsg}
					onAnalyze={handleAnalyze}
					geminiAnalysis={geminiAnalysis}
					geminiLoading={geminiLoading}
					nameSearchQuery={nameSearch.query}
					onNameSearchQueryChange={nameSearch.setQuery}
					onNameSearch={nameSearch.search}
					nameSearchResults={nameSearch.results}
					nameSearchTotalMatches={nameSearch.totalMatches}
					nameSearchIndexedCount={nameSearch.totalIndexed || uniqueTotalCrds}
					nameSearchSourceMode={nameSearch.sourceMode}
					redisUniqueCount={uniqueTotalCrds}
					redisHeaderStatus={redisHeaderStatus}
					nameSearched={nameSearch.searched}
					nameSearchLoading={nameSearch.loading}
					nameSearchError={nameSearch.error}
					onSelectNameResult={handleSelectNameResult}
					onCopyNameResults={nameSearch.copyToClipboard}
					onSelectKey={selectKey}
				/>
			</main>
			<NewCrdsNotice
				count={newCrds.notificationCount}
				onOpen={newCrds.reopen}
			/>
		</>
	);
}
