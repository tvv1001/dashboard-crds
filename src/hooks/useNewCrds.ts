'use client';
import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import type { NewCrdsState } from '../types';

const hiddenStorageKey = 'new-crds-sidebar-hidden';
const dismissedAtStorageKey = 'new-crds-dismissed-at';

function readStoredHidden() {
	if (typeof window === 'undefined') return false;
	return window.localStorage.getItem(hiddenStorageKey) === 'true';
}

function readStoredDismissedAt() {
	if (typeof window === 'undefined') return null;
	return window.localStorage.getItem(dismissedAtStorageKey);
}

function parseIsoTime(value?: string | null) {
	if (!value) return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

const CACHE_KEY = 'new-crds-cache-v2';
const CACHE_TTL_MS = 5 * 60 * 1000;

function readStoredCache() {
	if (typeof window === 'undefined') return null;
	// Disable cache on localhost for easier local development
	if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') return null;
	
	const str = window.localStorage.getItem(CACHE_KEY);
	if (!str) return null;
	try {
		const parsed = JSON.parse(str);
		if (parsed && typeof parsed === 'object' && parsed.timestamp) {
			if (Date.now() - parsed.timestamp < CACHE_TTL_MS) {
				return parsed.data;
			}
		}
	} catch {}
	return null;
}

export function useNewCrds() {
	const [state, setState] = useState<NewCrdsState>({
		items: [],
		loading: false,
		error: '',
		visible: !readStoredHidden(),
	});
	const [isHidden, setIsHidden] = useState(readStoredHidden);
	const [dismissedAt, setDismissedAt] = useState<string | null>(readStoredDismissedAt);
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		if (typeof window === 'undefined') return;
		window.localStorage.setItem(hiddenStorageKey, String(isHidden));
	}, [isHidden]);

	useEffect(() => {
		if (typeof window === 'undefined') return;
		if (dismissedAt) window.localStorage.setItem(dismissedAtStorageKey, dismissedAt);
		else window.localStorage.removeItem(dismissedAtStorageKey);
	}, [dismissedAt]);

	useEffect(() => {
		return () => {
			if (debounceRef.current) clearTimeout(debounceRef.current);
		};
	}, []);

	const fetch_ = useCallback(
		async (force = false) => {
			if (!force) {
				const cached = readStoredCache();
				if (cached) {
					const items =
						Array.isArray(cached?.items) ? cached.items
						: Array.isArray(cached) ? cached
						: [];
					setState((prev) => ({
						...prev,
						...cached,
						items,
						loading: false,
						error: '',
						visible: Boolean(cached?.redisHighWater) && !isHidden,
					}));
					if (!cached?.redisHighWater) setDismissedAt(null);
					return;
				}
			}

			setState((prev) => ({ ...prev, loading: true, error: '' }));
			try {
				const url = force ? '/api/new-crds?force=true' : '/api/new-crds';
				const res = await fetch(url);
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const json = await res.json();
				
				if (typeof window !== 'undefined' && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
					window.localStorage.setItem(CACHE_KEY, JSON.stringify({ timestamp: Date.now(), data: json }));
				}

				const items =
					Array.isArray(json?.items) ? json.items
					: Array.isArray(json) ? json
					: [];
				setState((prev) => ({
					...prev,
					...json,
					items,
					loading: false,
					error: '',
					visible: Boolean(json?.redisHighWater) && !isHidden,
				}));
				if (!json?.redisHighWater) setDismissedAt(null);
			} catch (err: unknown) {
				setState((prev) => ({
					...prev,
					loading: false,
					error: err instanceof Error ? err.message : 'Failed to load new CRDs',
					visible: Boolean(prev.redisHighWater) && !isHidden,
				}));
			}
		},
		[isHidden],
	);

	// The backend crawls the external APIs slowly and intermittently (throttled server-side).
	// Re-check every few minutes in the background so newly discovered CRDs surface over time
	// without the user needing to manually refresh.
	useEffect(() => {
		const intervalId = setInterval(() => fetch_(false), 5 * 60 * 1000);
		return () => clearInterval(intervalId);
	}, [fetch_]);

	const scheduleRefresh = useCallback(
		(delayMs = 400) => {
			if (debounceRef.current) clearTimeout(debounceRef.current);
			debounceRef.current = setTimeout(fetch_, delayMs);
		},
		[fetch_],
	);

	const reopen = useCallback(() => {
		setIsHidden(false);
		setDismissedAt(null);
		setState((prev) => ({ ...prev, visible: Boolean(prev.redisHighWater) }));
	}, []);

	const toggle = useCallback(() => {
		setIsHidden((prev) => {
			const nextHidden = !prev;
			if (!nextHidden) setDismissedAt(null);
			setState((statePrev) => ({ ...statePrev, visible: Boolean(statePrev.redisHighWater) && !nextHidden }));
			return nextHidden;
		});
	}, []);

	const dismiss = useCallback(() => {
		const nextDismissedAt = new Date().toISOString();
		setDismissedAt(nextDismissedAt);
		setIsHidden(true);
		setState((prev) => ({ ...prev, visible: false }));
	}, []);

	const notificationCount = useMemo(() => {
		if (!isHidden || !state.redisHighWater) return 0;
		const individual = Array.isArray(state.redisHighWater.sections?.individual) ? state.redisHighWater.sections.individual.length : 0;
		const firm = Array.isArray(state.redisHighWater.sections?.firm) ? state.redisHighWater.sections.firm.length : 0;
		return individual + firm;
	}, [isHidden, state.redisHighWater]);

	const showSidebar = Boolean(state.redisHighWater) && !isHidden;

	return { state, load: fetch_, scheduleRefresh, toggle, dismiss, reopen, showSidebar, notificationCount };
}
