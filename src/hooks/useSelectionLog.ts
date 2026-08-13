import { useState, useEffect, useCallback, useRef } from 'react';
import type { SelectionLogEntry } from '../components/panel/StatusBox';

const STORAGE_KEY = 'global-selection-log';

export function useSelectionLog() {
	const [selectionLog, setSelectionLogState] = useState<SelectionLogEntry[]>(() => {
		if (typeof window === 'undefined') return [];
		try {
			const stored = window.localStorage.getItem(STORAGE_KEY);
			if (stored) {
				const parsed = JSON.parse(stored);
				if (Array.isArray(parsed)) return parsed;
			}
		} catch {}
		return [];
	});
	const [loaded, setLoaded] = useState(false);
	const loadedRef = useRef(false);
	const queuedUpdates = useRef<Array<(prev: SelectionLogEntry[]) => SelectionLogEntry[]>>([]);

	useEffect(() => {
		if (typeof window === 'undefined') return;
		let initial: SelectionLogEntry[] = [];
		try {
			const stored = window.localStorage.getItem(STORAGE_KEY);
			if (stored) {
				const parsed = JSON.parse(stored);
				if (Array.isArray(parsed)) {
					initial = parsed;
				}
			}
		} catch (err) {
			// ignore
		}
		
		for (const update of queuedUpdates.current) {
			initial = update(initial);
		}
		queuedUpdates.current = [];
		
		setSelectionLogState(initial);
		if (initial.length > 0) {
			try {
				window.localStorage.setItem(STORAGE_KEY, JSON.stringify(initial));
			} catch {}
		}
		
		setLoaded(true);
		loadedRef.current = true;

		const onStorage = (e: StorageEvent) => {
			if (e.key === STORAGE_KEY && e.newValue) {
				try {
					const parsed = JSON.parse(e.newValue);
					if (Array.isArray(parsed)) setSelectionLogState(parsed);
				} catch {
					// ignore
				}
			}
		};
		window.addEventListener('storage', onStorage);
		return () => window.removeEventListener('storage', onStorage);
	}, []);

	const setSelectionLog = useCallback((updater: (prev: SelectionLogEntry[]) => SelectionLogEntry[]) => {
		if (!loadedRef.current) {
			queuedUpdates.current.push(updater);
			return;
		}
		setSelectionLogState((prev) => {
			const next = updater(prev);
			if (typeof window !== 'undefined') {
				try {
					window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
				} catch {
					// ignore
				}
			}
			return next;
		});
	}, []);

	const clearSelectionLog = useCallback(() => {
		setSelectionLogState([]);
		if (typeof window !== 'undefined') {
			try {
				window.localStorage.removeItem(STORAGE_KEY);
			} catch {
				// ignore
			}
		}
	}, []);

	const pushSelectionLogEntry = useCallback(
		(entry: SelectionLogEntry) => {
			setSelectionLog((prev) => {
				const without = prev.filter((r) => r.id !== entry.id && r.crd !== entry.crd);
				return [entry, ...without].slice(0, 200);
			});
		},
		[setSelectionLog],
	);

	return { selectionLog, setSelectionLog, clearSelectionLog, pushSelectionLogEntry, loaded };
}
