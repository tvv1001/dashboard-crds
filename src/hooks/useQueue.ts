'use client';
import { useState, useCallback, useRef } from 'react';
import type { QueueItem, StatusConsoleState, SyncBannerState } from '../types';
import { splitSearchTerms } from '../lib/parseKey';

export function createDefaultStatusConsole(): StatusConsoleState {
	return {
		phase: 'Idle',
		mode: '-',
		term: '-',
		queue: '-',
		currentCrd: '-',
		finraMatches: 0,
		secMatches: 0,
		seeds: 0,
		savedFiles: 0,
		downloaded: 0,
		updated: 0,
		repaired: 0,
		unchanged: 0,
		errors: 0,
		rateLimited: false,
		lastEvent: '-',
		lastError: '',
		startedAt: 0,
		updatedAt: 0,
	};
}

export function createDefaultSyncBanner(): SyncBannerState {
	return {
		downloaded: 0,
		updated: 0,
		repaired: 0,
		unchanged: 0,
	};
}

const fallbackRateLimitDelayMs = 3 * 60 * 1000;

function parseRetryAfterMs(value: string | null) {
	const seconds = Number(value);
	if (!Number.isFinite(seconds) || seconds <= 0) return fallbackRateLimitDelayMs;
	return Math.round(seconds * 1000);
}

interface UseQueueOptions {
	onPromoteSaved: (names: string[]) => void;
	onPromoteBySeeds: (seeds: string[]) => void;
	onRefreshSaved: () => Promise<void>;
	onScheduleNewCrdsRefresh: () => void;
	onUpdateStats: (stats: any) => void;
}

export function useQueue({ onPromoteSaved, onPromoteBySeeds, onRefreshSaved, onScheduleNewCrdsRefresh, onUpdateStats }: UseQueueOptions) {
	const [queueItems, setQueueItems] = useState<QueueItem[]>([]);
	const [statusConsole, setStatusConsoleState] = useState<StatusConsoleState>(createDefaultStatusConsole());
	const [syncBanner, setSyncBanner] = useState<SyncBannerState>(createDefaultSyncBanner());
	const [globalStatus, setGlobalStatus] = useState<{ msg: string; visible: boolean; isRateLimit: boolean }>({
		msg: '',
		visible: false,
		isRateLimit: false,
	});
	const [fetchLog, setFetchLog] = useState<string[]>([]);
	const [statusHtml, setStatusHtml] = useState('');
	const [isRunning, setIsRunning] = useState(false);

	const rateLimitRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const rateLimitResolverRef = useRef<(() => void) | null>(null);
	const progressTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const runStartRef = useRef(0);
	const syncBannerRefs = useRef({
		downloaded: new Set<string>(),
		updated: new Set<string>(),
		repaired: new Set<string>(),
		unchanged: new Set<string>(),
	});

	const setStatusConsole = useCallback((patch: Partial<StatusConsoleState> | ((prev: StatusConsoleState) => StatusConsoleState)) => {
		if (typeof patch === 'function') {
			setStatusConsoleState(patch);
		} else {
			setStatusConsoleState((prev) => ({ ...prev, ...patch, updatedAt: Date.now() }));
		}
	}, []);

	const resetStatusConsole = useCallback((patch: Partial<StatusConsoleState> = {}) => {
		setStatusConsoleState({ ...createDefaultStatusConsole(), ...patch, updatedAt: Date.now() });
	}, []);

	const appendLog = useCallback((line: string) => {
		setFetchLog((prev) => [...prev.slice(-199), line]);
	}, []);

	const clearLog = useCallback(() => setFetchLog([]), []);

	const showGlobal = useCallback((msg: string, isRateLimit = false) => {
		setGlobalStatus({ msg, visible: true, isRateLimit });
	}, []);

	const hideGlobal = useCallback(() => {
		setGlobalStatus((prev) => ({ ...prev, visible: false }));
	}, []);

	const showRateLimit = useCallback(
		(msg?: string) => {
			showGlobal(msg || 'Rate limited — close this banner to retry the current search term.', true);
		},
		[showGlobal],
	);

	const resetSyncBanner = useCallback(() => {
		syncBannerRefs.current = {
			downloaded: new Set<string>(),
			updated: new Set<string>(),
			repaired: new Set<string>(),
			unchanged: new Set<string>(),
		};
		setSyncBanner(createDefaultSyncBanner());
	}, []);

	const recordSyncStatus = useCallback((status: string, filename: string) => {
		if (!status || !filename) return;
		const key = status as keyof SyncBannerState;
		if (!(key in syncBannerRefs.current)) return;
		const bucket = syncBannerRefs.current[key];
		bucket.add(String(filename));
		setSyncBanner({
			downloaded: syncBannerRefs.current.downloaded.size,
			updated: syncBannerRefs.current.updated.size,
			repaired: syncBannerRefs.current.repaired.size,
			unchanged: syncBannerRefs.current.unchanged.size,
		});
	}, []);

	const applySyncSummary = useCallback(
		(summary: Record<string, string[]> | undefined | null) => {
			if (!summary || typeof summary !== 'object') return;
			for (const status of ['downloaded', 'updated', 'repaired', 'unchanged']) {
				const list = Array.isArray(summary[status]) ? summary[status] : [];
				for (const filename of list) {
					recordSyncStatus(status, filename);
				}
			}
		},
		[recordSyncStatus],
	);

	const updateQueueItem = useCallback((index: number, patch: Partial<QueueItem>) => {
		setQueueItems((prev) => {
			if (index < 0 || index >= prev.length) return prev;
			const next = [...prev];
			next[index] = { ...next[index], ...patch };
			return next;
		});
	}, []);

	const stopProgressTimer = useCallback(() => {
		if (progressTimerRef.current) {
			clearInterval(progressTimerRef.current);
			progressTimerRef.current = null;
		}
		runStartRef.current = 0;
	}, []);

	const startProgressTimer = useCallback(() => {
		stopProgressTimer();
		runStartRef.current = Date.now();
		progressTimerRef.current = setInterval(() => {
			setQueueItems((prev) => {
				const runningIndex = prev.findIndex((item) => item.status === 'running');
				if (runningIndex < 0) return prev;
				const elapsedMs = Date.now() - runStartRef.current;
				const elapsedMin = Math.floor(elapsedMs / 60000);
				const elapsedSec = Math.floor((elapsedMs % 60000) / 1000);
				const elapsedText = elapsedMin > 0 ? `${elapsedMin}m ${elapsedSec}s` : `${elapsedSec}s`;
				const current = prev[runningIndex];
				const waitingHint = elapsedMs >= 20000 ? ' — still running; if rate-limited, retry is queued after a short backoff.' : '';
				const next = [...prev];
				next[runningIndex] = {
					...current,
					status: 'running',
					detail: `${current.term} • running ${elapsedText}${waitingHint}`,
				};
				return next;
			});
		}, 5000);
	}, [stopProgressTimer]);

	const armRateLimitRetry = useCallback((delayMs = fallbackRateLimitDelayMs): Promise<void> => {
		return new Promise<void>((resolve) => {
			rateLimitResolverRef.current = resolve;
			rateLimitRetryRef.current = setTimeout(() => {
				rateLimitRetryRef.current = null;
				rateLimitResolverRef.current = null;
				resolve();
			}, delayMs);
		});
	}, []);

	const resolveRateLimitRetry = useCallback(() => {
		if (rateLimitRetryRef.current) {
			clearTimeout(rateLimitRetryRef.current);
			rateLimitRetryRef.current = null;
		}
		if (rateLimitResolverRef.current) {
			rateLimitResolverRef.current();
			rateLimitResolverRef.current = null;
		}
		hideGlobal();
	}, [hideGlobal]);

	const runSearchTermViaPost = useCallback(
		async (
			q: string,
			opts: { queueIndex?: number; sourceLabel?: string } = {},
		): Promise<{
			ok: boolean;
			hasContent: boolean;
			savedCount?: number;
			seedCount?: number;
			logs: string[];
			seeds: string[];
			rateLimited?: boolean;
			retryDelayMs?: number;
			matchSummary?: Record<string, string[]> | null;
		}> => {
			const queueIndex = typeof opts.queueIndex === 'number' ? opts.queueIndex : -1;
			const sourceLabel = opts.sourceLabel || null;
			resetSyncBanner();
			resetStatusConsole({
				phase: 'Searching',
				mode: sourceLabel || 'Single',
				term: q,
				queue: queueIndex >= 0 ? `${queueIndex + 1}/?` : '-',
				currentCrd: /^[0-9]+$/.test(q) ? q : '-',
				seeds: /^[0-9]+$/.test(q) ? 1 : 0,
				lastEvent: `Starting search for "${q}"`,
				startedAt: Date.now(),
			});
			if (queueIndex >= 0) updateQueueItem(queueIndex, { status: 'running', detail: 'Searching…' });

			const body: Record<string, unknown> = { maxDepth: 1, maxVisits: 100 };
			if (/^[0-9]+$/.test(q)) body.crd = q;
			else body.query = q;

			const response = await fetch('/api/search-and-crawl', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			});

			if (response.status === 429) {
				const retryDelayMs = parseRetryAfterMs(response.headers.get('retry-after'));
				const retryMinutes = Math.max(1, Math.round(retryDelayMs / 60000));
				const message = `Rate limited (429) — retrying in about ${retryMinutes} minute${retryMinutes === 1 ? '' : 's'}.`;
				appendLog(`Search failed: HTTP 429 ${response.statusText}`);
				appendLog(message);
				showRateLimit();
				if (queueIndex >= 0)
					updateQueueItem(queueIndex, { status: 'running', detail: `Rate limited — retrying this term in about ${retryMinutes} minute${retryMinutes === 1 ? '' : 's'}.` });
				return { ok: false, hasContent: false, logs: [message], seeds: [], rateLimited: true, retryDelayMs };
			}

			let json: Record<string, unknown> | null = null;
			try {
				json = await response.json();
			} catch {
				setStatusHtml(`<pre>HTTP ${response.status} ${response.statusText}</pre>`);
				if (queueIndex >= 0) updateQueueItem(queueIndex, { status: 'error', detail: `HTTP ${response.status}` });
				return { ok: false, hasContent: false, logs: [], seeds: [] };
			}

			if (!response.ok) {
				const errMsg = (json?.error as string) || JSON.stringify(json, null, 2);
				setStatusHtml(`<pre>${errMsg}</pre>`);
				appendLog(`Search failed: HTTP ${response.status} ${response.statusText}`);
				if (Array.isArray(json?.logs)) (json.logs as string[]).forEach((l) => appendLog(l));
				if (queueIndex >= 0) updateQueueItem(queueIndex, { status: 'error', detail: (json?.error as string) || `HTTP ${response.status}` });
				return { ok: false, hasContent: false, logs: Array.isArray(json?.logs) ? (json.logs as string[]) : [], seeds: [] };
			}

			const logsArr: string[] = Array.isArray(json?.logs) ? (json.logs as string[]) : [];
			const savedCount = Array.isArray(json?.savedFiles) ? (json.savedFiles as string[]).length : 0;
			const seedCount = Array.isArray(json?.seeds) ? (json.seeds as string[]).length : 0;
			const errorCount = Array.isArray(json?.errors) ? (json.errors as unknown[]).length : 0;

			if (json?.matchSummary && typeof json.matchSummary === 'object') {
				for (const [source, crds] of Object.entries(json.matchSummary as Record<string, unknown>)) {
					if (source === 'finra') setStatusConsole({ finraMatches: Array.isArray(crds) ? crds.length : 0 });
					if (source === 'sec') setStatusConsole({ secMatches: Array.isArray(crds) ? crds.length : 0 });
				}
			}

			applySyncSummary(json?.syncSummary as Record<string, string[]>);
			const errorLines = logsArr.filter((l) => /error|too many requests|rate limit|blocked|access denied|captcha/i.test(l));
			setStatusConsole({
				phase: errorLines.length ? 'Complete with errors' : 'Complete',
				savedFiles: savedCount,
				seeds: seedCount,
				errors: errorCount,
				rateLimited: logsArr.some((l) => /too many requests|rate limit/i.test(l)),
				lastEvent: `Finished ${sourceLabel ? sourceLabel.toLowerCase() : 'search'} for "${q}"`,
				lastError: errorLines.length ? errorLines[0] : '',
			});

			if (errorLines.length) {
				setStatusHtml(`<pre class="pre-wrap">${[...logsArr].reverse().join('\n')}</pre>`);
				appendLog('Search completed with errors:');
				logsArr.forEach((l) => appendLog(l));
				if (logsArr.some((l) => /too many requests|rate limit/i.test(l))) showRateLimit();
			} else {
				const reversedLogs = [...logsArr].reverse();
				const summary = [`Crawl finished — seeds: ${seedCount}, saved files: ${savedCount}`, ''];
				if (savedCount === 0) summary.push('No files were saved. Check logs for errors or rate-limiting.');
				setStatusHtml(`<pre class="pre-wrap">${[...summary, ...reversedLogs].join('\n')}</pre>`);
				if (logsArr.length) logsArr.forEach((l) => appendLog(l));
			}

			if (Array.isArray(json?.seeds) && (json.seeds as string[]).length) {
				onPromoteBySeeds(json.seeds as string[]);
			}
			if (queueIndex >= 0) {
				const hasContent = savedCount > 0 || seedCount > 0;
				updateQueueItem(queueIndex, {
					status: hasContent ? 'complete' : 'pending',
					detail: hasContent ? `${savedCount} saved, ${seedCount} seeds` : 'No content found',
				});
			}

			await onRefreshSaved();
			if (Array.isArray(json?.savedFiles) && (json.savedFiles as string[]).length) {
				onPromoteSaved(json.savedFiles as string[]);
			}

			return {
				ok: true,
				hasContent: (Array.isArray(json?.savedFiles) && (json.savedFiles as string[]).length > 0) || (Array.isArray(json?.seeds) && (json.seeds as string[]).length > 0),
				savedCount,
				seedCount,
				logs: logsArr,
				seeds: Array.isArray(json?.seeds) ? (json.seeds as string[]) : [],
				matchSummary: (json?.matchSummary as Record<string, string[]>) ?? null,
			};
		},
		[appendLog, applySyncSummary, onPromoteBySeeds, onPromoteSaved, onRefreshSaved, resetStatusConsole, setStatusConsole, showRateLimit, updateQueueItem],
	);

	const runSingleSearchWithSse = useCallback(
		async (q: string) => {
			setIsRunning(true);
			clearLog();
			resetSyncBanner();
			resetStatusConsole({
				phase: 'Searching',
				mode: 'Single',
				term: q,
				queue: '-',
				currentCrd: /^[0-9]+$/.test(q) ? q : '-',
				seeds: /^[0-9]+$/.test(q) ? 1 : 0,
				lastEvent: `Starting search for "${q}"`,
				startedAt: Date.now(),
			});

			const params = new URLSearchParams({ maxDepth: '1', maxVisits: '100' });
			if (/^[0-9]+$/.test(q)) params.set('crd', q);
			else params.set('query', q);

			appendLog(`Starting search-and-crawl for: ${q}`);
			const sseUrl = `/api/search-and-crawl-stream?${params.toString()}`;

			try {
				const es = new EventSource(sseUrl);
				appendLog(`Using live stream: ${sseUrl}`);

				es.addEventListener('log', (ev) => {
					appendLog(ev.data);
					if (/rate limited \(429\)|too many requests/i.test(String(ev.data || ''))) {
						showRateLimit(String(ev.data || 'Rate limited — close this banner to retry the current search term.'));
					}
					if (/handling seed crd/i.test(String(ev.data || ''))) {
						setStatusConsole({ phase: 'Crawling' });
					}
				});

				es.addEventListener('rate-limit', (ev) => {
					try {
						const payload = JSON.parse(ev.data || '{}');
						appendLog(payload?.message ? `Rate limited: ${payload.message}` : 'Rate limited');
						showRateLimit(payload?.message ? `Rate limited — ${payload.message}` : 'Rate limited — close this banner to retry the current search term.');
					} catch {
						appendLog('Rate limited');
						showRateLimit();
					}
				});

				es.addEventListener('saved', (ev) => {
					try {
						const obj = JSON.parse(ev.data || '{}');
						if (obj?.filename) {
							appendLog(`Saved file: ${obj.filename}`);
							setStatusConsole((prev) => ({
								...prev,
								phase: 'Crawling',
								savedFiles: prev.savedFiles + 1,
								lastEvent: `Saved ${obj.filename}`,
								updatedAt: Date.now(),
							}));
							onPromoteSaved([obj.filename]);
							onScheduleNewCrdsRefresh();
						}
					} catch {
						appendLog('Saved event received');
					}
				});

				es.addEventListener('aggregate-stats', (ev) => {
					try {
						const stats = JSON.parse(ev.data || '{}');
						onUpdateStats(stats);
					} catch {}
				});

				es.addEventListener('sync-status', (ev) => {
					try {
						const payload = JSON.parse(ev.data || '{}');
						recordSyncStatus(payload.status, payload.filename);
						if (payload?.status === 'downloaded' && payload?.filename) {
							onPromoteSaved([payload.filename]);
							onScheduleNewCrdsRefresh();
						}
					} catch {}
				});

				es.addEventListener('matches', (ev) => {
					try {
						const payload = JSON.parse(ev.data || '{}');
						if (payload.source === 'finra') setStatusConsole({ finraMatches: Array.isArray(payload.crds) ? payload.crds.length : 0 });
						if (payload.source === 'sec') setStatusConsole({ secMatches: Array.isArray(payload.crds) ? payload.crds.length : 0 });
					} catch {}
				});

				es.addEventListener('done', async (ev) => {
					try {
						const payload = JSON.parse(ev.data || '{}');
						applySyncSummary(payload?.syncSummary);
						setStatusConsole({
							phase: 'Complete',
							seeds: Array.isArray(payload?.seeds) ? payload.seeds.length : 0,
							lastEvent: 'Stream finished',
						});
						appendLog('Stream finished');
						await onRefreshSaved();
						if (Array.isArray(payload?.seeds)) onPromoteBySeeds(payload.seeds);
					} catch {}
					es.close();
					setIsRunning(false);
				});

				es.addEventListener('error', () => {
					appendLog('Stream disconnected');
					setStatusConsole({
						phase: 'Error',
						lastEvent: 'Stream disconnected',
						lastError: 'Stream disconnected before completion',
					});
					es.close();
					setIsRunning(false);
				});
			} catch {
				// fallback to POST if EventSource unavailable
				await runSearchTermViaPost(q);
				setIsRunning(false);
			}
		},
		[
			appendLog,
			applySyncSummary,
			clearLog,
			onPromoteBySeeds,
			onPromoteSaved,
			onRefreshSaved,
			onScheduleNewCrdsRefresh,
			recordSyncStatus,
			resetStatusConsole,
			resetSyncBanner,
			runSearchTermViaPost,
			setStatusConsole,
			showRateLimit,
		],
	);

	const runQueue = useCallback(
		async (rawInput: string) => {
			const terms = splitSearchTerms(rawInput);
			if (!terms.length) return;
			if (rateLimitRetryRef.current) {
				clearTimeout(rateLimitRetryRef.current);
				rateLimitRetryRef.current = null;
			}
			rateLimitResolverRef.current = null;
			setQueueItems(terms.map((term) => ({ term, status: 'pending', detail: '' })));
			setIsRunning(true);
			startProgressTimer();

			for (let i = 0; i < terms.length; ) {
				const term = terms[i];
				updateQueueItem(i, { status: 'running', detail: 'Processing…' });
				try {
					const result = await runSearchTermViaPost(term, { queueIndex: i, sourceLabel: 'Queue' });
					if (result?.rateLimited) {
						const retryMinutes = Math.max(1, Math.round((result.retryDelayMs || fallbackRateLimitDelayMs) / 60000));
						updateQueueItem(i, { status: 'running', detail: `Rate limited — retrying this term in about ${retryMinutes} minute${retryMinutes === 1 ? '' : 's'}.` });
						await armRateLimitRetry(result.retryDelayMs);
						updateQueueItem(i, { status: 'running', detail: 'Retrying…' });
						continue;
					}
					if (result?.savedCount && result.savedCount > 0) {
						updateQueueItem(i, { status: 'complete', detail: `${result.savedCount} saved, ${result.seedCount} seeds` });
					} else if (result?.ok) {
						updateQueueItem(i, { status: 'no-content', detail: `Completed with no raw files (${result.seedCount || 0} seeds)` });
					} else {
						updateQueueItem(i, { status: 'error', detail: 'Failed' });
					}
					i += 1;
				} catch (error: unknown) {
					updateQueueItem(i, { status: 'error', detail: error instanceof Error ? error.message : 'Failed' });
					i += 1;
				}
			}

			stopProgressTimer();
			setIsRunning(false);
		},
		[armRateLimitRetry, runSearchTermViaPost, startProgressTimer, stopProgressTimer, updateQueueItem],
	);

	return {
		queueItems,
		statusConsole,
		syncBanner,
		globalStatus,
		fetchLog,
		statusHtml,
		isRunning,
		setStatusConsole,
		showGlobal,
		hideGlobal,
		showRateLimit,
		resolveRateLimitRetry,
		rateLimitResolverRef,
		appendLog,
		clearLog,
		runSingleSearchWithSse,
		runQueue,
	};
}
