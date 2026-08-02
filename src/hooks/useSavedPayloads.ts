'use client';
import { useState, useEffect, useCallback, useRef } from 'react';
import type { SavedPayload, SortOrder } from '../types';
import { parseKey } from '../lib/parseKey';

function dedupe(items: SavedPayload[]): SavedPayload[] {
	const seen = new Set<string>();
	const out: SavedPayload[] = [];
	for (const it of items) {
		const k = parseKey(it);
		if (!seen.has(k)) {
			seen.add(k);
			out.push(it);
		}
	}
	return out;
}

export function useSavedPayloads() {
	const [payloads, setPayloads] = useState<SavedPayload[]>([]);
	const [loading, setLoading] = useState(false);
	const [statusMsg, setStatusMsg] = useState('');
	const [totalCount, setTotalCount] = useState(0);
	const [matchedCount, setMatchedCount] = useState(0);
	const [truncated, setTruncated] = useState(false);
	const [uniqueIndividualCrds, setUniqueIndividualCrds] = useState(0);
	const [uniqueFirmCrds, setUniqueFirmCrds] = useState(0);
	const [uniqueTotalCrds, setUniqueTotalCrds] = useState(0);
	const requestIdRef = useRef(0);
	const queryRef = useRef<{
		filter: string;
		sortOrder: SortOrder;
		typeFilter: string;
	}>({
		filter: '',
		sortOrder: 'date-desc',
		typeFilter: 'all',
	});

	const load = useCallback(
		async (
			query: {
				filter: string;
				sortOrder: SortOrder;
				typeFilter: string;
				includeCrds?: string[];
			} = {
				filter: '',
				sortOrder: 'date-desc',
				typeFilter: 'all',
			},
		) => {
			const {
				filter,
				sortOrder,
				typeFilter,
				includeCrds = [],
			} = query;
			queryRef.current = { filter, sortOrder, typeFilter };
			const requestId = ++requestIdRef.current;
			setLoading(true);
			setStatusMsg('Loading saved keys...');
			try {
				const params = new URLSearchParams();
				const trimmedFilter = filter.trim();
				if (trimmedFilter) params.set('filter', trimmedFilter);
				params.set('sort', sortOrder);
				if (typeFilter === 'individuals') params.set('type', 'individual');
				else if (typeFilter === 'firms') params.set('type', 'firm');
				else params.set('type', 'all');
				params.set('limit', trimmedFilter ? '2000' : '1000');
				const exactCrds = includeCrds.filter((value) => /^[0-9]+$/.test(String(value || '').trim()));
				if (exactCrds.length) params.set('includeCrds', exactCrds.join(','));
				const res = await fetch(`/api/keys?${params.toString()}`);
				const json = await res.json();
				if (requestId !== requestIdRef.current) return;
				const keys: SavedPayload[] = Array.isArray(json.keys) ? json.keys : [];
				const deduped = dedupe(keys);
				const total = Number(json.totalCount) || deduped.length;
				const matched = Number(json.matchedCount) || deduped.length;
				const isTruncated = Boolean(json.truncated);
				setPayloads(deduped);
				setTotalCount(total);
				setMatchedCount(matched);
				setTruncated(isTruncated);
				if (json.uniqueIndividualCrds != null) setUniqueIndividualCrds(Number(json.uniqueIndividualCrds));
				if (json.uniqueFirmCrds != null) setUniqueFirmCrds(Number(json.uniqueFirmCrds));
				if (json.uniqueTotalCrds != null) setUniqueTotalCrds(Number(json.uniqueTotalCrds));
				if (trimmedFilter) {
					setStatusMsg(
						isTruncated ?
							`Showing ${deduped.length.toLocaleString()} of ${matched.toLocaleString()} matching saved files for "${trimmedFilter}".`
						:	`Showing ${deduped.length.toLocaleString()} matching saved files for "${trimmedFilter}".`,
					);
				} else {
					setStatusMsg(
						isTruncated ?
							''
						:	total === 0 ?
							'No saved payloads found yet.'
						:	`Loaded ${deduped.length.toLocaleString()} saved files.`,
					);
				}
			} catch (err: unknown) {
				if (requestId !== requestIdRef.current) return;
				setStatusMsg(`Error loading keys:\n${err instanceof Error ? err.message : String(err)}`);
			} finally {
				if (requestId === requestIdRef.current) {
					setLoading(false);
				}
			}
		},
		[],
	);

	const includeCrds = useCallback(
		(crds: string[]) => {
			const exactCrds = crds.filter((value) => /^[0-9]+$/.test(String(value || '').trim()));
			if (!exactCrds.length) return;
			void load({ ...queryRef.current, includeCrds: exactCrds });
		},
		[load],
	);

	const promoteSaved = useCallback((names: string[]) => {
		if (!names.length) return;
		setPayloads((prev) => {
			const byKey = new Map(prev.map((it) => [parseKey(it), it]));
			const promoted: SavedPayload[] = [];
			const added = new Set<string>();
			for (const name of names) {
				if (byKey.has(name)) {
					promoted.push(byKey.get(name)!);
				} else {
					promoted.push({ key: name, mtime: Date.now() });
				}
				added.add(name);
			}
			for (const it of prev) {
				const k = parseKey(it);
				if (!added.has(k)) promoted.push(it);
			}
			return dedupe(promoted);
		});
	}, []);

	const promoteBySeeds = useCallback(
		(seeds: string[]) => {
			if (!seeds.length) return;
			let foundAny = false;
			setPayloads((prev) => {
				const promoted: SavedPayload[] = [];
				const added = new Set<string>();
				for (const seed of seeds) {
					for (const it of prev) {
						const k = parseKey(it);
						const m = k.match(/^(?:finra|sec):([^:]+):(\d+)(?:\.json)?$/i);
						if (m && m[2] === seed && !added.has(k)) {
							promoted.push(it);
							added.add(k);
							foundAny = true;
						}
					}
				}
				for (const it of prev) {
					const k = parseKey(it);
					if (!added.has(k)) promoted.push(it);
				}
				return dedupe(promoted);
			});
			if (!foundAny) {
				includeCrds(seeds);
			}
		},
		[includeCrds],
	);

	const updateStats = useCallback((stats: { uniqueIndividualCrds: number; uniqueFirmCrds: number; uniqueTotalCrds: number }) => {
		if (stats.uniqueIndividualCrds != null) setUniqueIndividualCrds(stats.uniqueIndividualCrds);
		if (stats.uniqueFirmCrds != null) setUniqueFirmCrds(stats.uniqueFirmCrds);
		if (stats.uniqueTotalCrds != null) setUniqueTotalCrds(stats.uniqueTotalCrds);
	}, []);

	return {
		payloads,
		setPayloads,
		loading,
		statusMsg,
		totalCount,
		matchedCount,
		truncated,
		uniqueIndividualCrds,
		uniqueFirmCrds,
		uniqueTotalCrds,
		load,
		includeCrds,
		promoteSaved,
		promoteBySeeds,
		updateStats,
	};
}

export function useSeenKeys() {
	const [seenKeys, setSeenKeys] = useState<Record<string, boolean>>({});
	const loaded = useRef(false);

	const load = useCallback(async () => {
		if (loaded.current) return;
		loaded.current = true;
		try {
			const res = await fetch('/api/seen-keys');
			if (!res.ok) return;
			const json = await res.json();
			const serverKeys: Record<string, boolean> = json.keys || {};
			let local: Record<string, boolean> = {};
			try {
				local = JSON.parse(localStorage.getItem('seenKeys') || '{}');
			} catch {}
			const merged = { ...local, ...serverKeys };
			setSeenKeys(merged);
			try {
				localStorage.setItem('seenKeys', JSON.stringify(merged));
			} catch {}
		} catch {}
	}, []);

	const markSeen = useCallback((key: string) => {
		setSeenKeys((prev) => {
			const next = { ...prev, [key]: true };
			try {
				localStorage.setItem('seenKeys', JSON.stringify(next));
			} catch {}
			return next;
		});
		fetch('/api/seen-keys', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ key }),
		}).catch(() => {});
	}, []);

	return { seenKeys, load, markSeen };
}
