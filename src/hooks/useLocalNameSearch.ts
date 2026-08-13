'use client';
import { useState, useCallback, useEffect, useRef } from 'react';
import type { LocalNameSearchResult } from '../types';

export function useLocalNameSearch() {
	const [query, setQuery] = useState('');
	const [results, setResults] = useState<LocalNameSearchResult[]>([]);
	const [totalIndexed, setTotalIndexed] = useState(0);
	const [totalMatches, setTotalMatches] = useState(0);
	const [truncated, setTruncated] = useState(false);
	const [sourceMode, setSourceMode] = useState<'redis' | 'local'>('redis');
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState('');
	const [searched, setSearched] = useState(false);
	const externalSearchTimeout = useRef<NodeJS.Timeout | null>(null);

	useEffect(() => {
		let mounted = true;
		fetch('/api/redis-health')
			.then((r) => r.json())
			.then((json) => {
				if (!mounted) return;
				const mode = String(json?.mode || '').toLowerCase();
				setSourceMode(mode === 'upstash-rest' || mode === 'redis-url' ? 'redis' : 'local');
			})
			.catch(() => {
				if (!mounted) return;
				setSourceMode('local');
			});
		return () => {
			mounted = false;
		};
	}, []);

	const search = useCallback(
		async (q?: string): Promise<LocalNameSearchResult[]> => {
			const searchQ = q !== undefined ? q : query;
			if (!searchQ.trim()) return [];
			setLoading(true);
			setError('');
			setResults([]);
			setTotalMatches(0);
			setTruncated(false);
			setSearched(false);
			try {
				const params = new URLSearchParams({ q: searchQ.trim() });
				const res = await fetch(`/api/redis-search?${params.toString()}`);
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const json = await res.json();
				const found: LocalNameSearchResult[] =
					Array.isArray(json?.matches) ? json.matches
					: Array.isArray(json?.results) ? json.results
					: Array.isArray(json) ? json
					: [];
				setTotalIndexed(Number(json?.totalIndexed) || 0);
				setTotalMatches(Number(json?.totalMatches) || found.length);
				setTruncated(Boolean(json?.truncated));
				setSourceMode(json?.sourceMode === 'redis' ? 'redis' : 'local');
				setResults(found);
				setSearched(true);
				
				// Automatically check external APIs with a debounce to prevent bottlenecking
				if (externalSearchTimeout.current) clearTimeout(externalSearchTimeout.current);
				externalSearchTimeout.current = setTimeout(async () => {
					try {
						// Wait for chart/graph interaction or rapid typing to settle
						const externalRes = await fetch('/api/search-and-crawl', {
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({ query: searchQ.trim(), maxDepth: 1, maxVisits: 5 })
						});
						if (externalRes.ok) {
							// After the external search saves payloads to Redis, update the UI
							const recheckRes = await fetch(`/api/redis-search?${params.toString()}`);
							if (recheckRes.ok) {
								const recheckJson = await recheckRes.json();
								const recheckFound: LocalNameSearchResult[] =
									Array.isArray(recheckJson?.matches) ? recheckJson.matches
									: Array.isArray(recheckJson?.results) ? recheckJson.results
									: Array.isArray(recheckJson) ? recheckJson
									: [];
								setTotalIndexed(Number(recheckJson?.totalIndexed) || 0);
								setTotalMatches(Number(recheckJson?.totalMatches) || recheckFound.length);
								setTruncated(Boolean(recheckJson?.truncated));
								setResults(recheckFound);
							}
						}
					} catch (e) {
						// Silently ignore external fallback failures
					}
				}, 1500);

				return found;
			} catch (err: unknown) {
				setError(err instanceof Error ? err.message : 'Search failed');
				setSearched(true);
				return [];
			} finally {
				setLoading(false);
			}
		},
		[query],
	);

	const copyToClipboard = useCallback(async () => {
		if (!results.length) return;
		const text = results
			.map((r) => {
				const parts: string[] = [r.name || r.key || ''];
				if (r.crd) parts.push(`CRD: ${r.crd}`);
				if (r.source) parts.push(`Source: ${r.source}`);
				return parts.join(' | ');
			})
			.join('\n');
		try {
			await navigator.clipboard.writeText(text);
		} catch {}
	}, [results]);

	const clear = useCallback(() => {
		setQuery('');
		setResults([]);
		setTotalIndexed(0);
		setSourceMode('redis');
		setError('');
		setSearched(false);
	}, []);

	return {
		query,
		setQuery,
		results,
		totalIndexed,
		totalMatches,
		sourceMode,
		loading,
		error,
		searched,
		search,
		copyToClipboard,
		clear,
	};
}
