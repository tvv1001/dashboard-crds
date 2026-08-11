'use client';
import { useState, useCallback, useEffect } from 'react';
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
