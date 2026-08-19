import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export type SharedNodeSnapshot = {
	key: string;
	resolvedKey: string;
	detailJson: string | null;
	fetchedAt: number;
	source: 'dashboard' | 'insights' | 'shared';
};

const STORAGE_KEY = 'finra-sec-shared-node-cache';
const MAX_ENTRIES = 2000;

function readStorage(): Record<string, SharedNodeSnapshot> {
	if (typeof window === 'undefined') return {};
	try {
		const stored = window.localStorage.getItem(STORAGE_KEY);
		if (!stored) return {};
		const parsed = JSON.parse(stored);
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function writeStorage(entries: Record<string, SharedNodeSnapshot>) {
	if (typeof window === 'undefined') return;
	try {
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
	} catch {
		// ignore storage issues
	}
}

export function useSharedGraphState() {
	const [cache, setCache] = useState<Record<string, SharedNodeSnapshot>>({});
	const initialized = useRef(false);

	useEffect(() => {
		if (initialized.current) return;
		initialized.current = true;
		setCache(readStorage());
	}, []);

	useEffect(() => {
		if (!initialized.current) return;
		writeStorage(cache);
	}, [cache]);

	const setSnapshot = useCallback((key: string, snapshot: SharedNodeSnapshot) => {
		setCache((prev) => {
			const next = { ...prev, [key]: snapshot };
			const entries = Object.entries(next).sort((a, b) => b[1].fetchedAt - a[1].fetchedAt);
			const trimmed = entries.slice(0, MAX_ENTRIES).reduce<Record<string, SharedNodeSnapshot>>((acc, [k, v]) => {
				acc[k] = v;
				return acc;
			}, {});
			return trimmed;
		});
	}, []);

	const getSnapshot = useCallback((key: string) => cache[key] ?? null, [cache]);

	const removeSnapshot = useCallback((key: string) => {
		setCache((prev) => {
			if (!(key in prev)) return prev;
			const next = { ...prev };
			delete next[key];
			return next;
		});
	}, []);

	const clear = useCallback(() => {
		setCache({});
		if (typeof window !== 'undefined') {
			try {
				window.localStorage.removeItem(STORAGE_KEY);
			} catch {
				// ignore
			}
		}
	}, []);

	return useMemo(
		() => ({
			cache,
			setSnapshot,
			getSnapshot,
			removeSnapshot,
			clear,
		}),
		[cache, setSnapshot, getSnapshot, removeSnapshot, clear],
	);
}
