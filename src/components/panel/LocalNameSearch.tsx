'use client';
import React, { useState } from 'react';
import type { LocalNameSearchResult } from '../../types';
import { highlightTerms } from '../../lib/html';

interface Props {
	query: string;
	onQueryChange: (q: string) => void;
	onSearch: () => void;
	results: LocalNameSearchResult[];
	totalMatches?: number;
	totalIndexed: number;
	sourceMode: 'redis' | 'local';
	redisUniqueCount: number;
	redisHeaderStatus: {
		connected: boolean;
		configured: boolean;
		mode: 'upstash-rest' | 'redis-url' | 'none';
		latencyMs: number | null;
	};
	searched: boolean;
	loading: boolean;
	error: string;
	onSelectResult?: (crd: string, type: string, source?: string, key?: string) => void;
	onCopyResults?: () => void;
}

export function LocalNameSearch({
	query,
	onQueryChange,
	onSearch,
	results,
	totalMatches,
	totalIndexed,
	sourceMode,
	redisUniqueCount,
	redisHeaderStatus,
	searched,
	loading,
	error,
	onSelectResult,
	onCopyResults,
}: Props) {
	const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle');

	function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
		if (e.key === 'Enter') onSearch();
	}

	async function handleCopyResults() {
		if (!onCopyResults) return;
		await Promise.resolve(onCopyResults());
		setCopyState('copied');
		window.setTimeout(() => setCopyState('idle'), 1200);
	}

	// Extract query terms for highlight
	const terms = query.trim().split(/\s+/).filter(Boolean);
	const formattedRedisUnique = Number(redisUniqueCount || 0).toLocaleString();
	const modeLabel = sourceMode === 'redis' ? 'Redis' : 'Local cache fallback';
	const redisModeLabel =
		redisHeaderStatus.mode === 'upstash-rest' ? 'Upstash REST'
		: redisHeaderStatus.mode === 'redis-url' ? 'Redis URL'
		: 'Not Configured';
	const isLocalhost = typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
	const redisBadgeText = redisHeaderStatus.connected ? (isLocalhost ? 'Local Redis Connected' : 'Redis Connected') : 'Redis Disconnected';
	const redisBadgeTitle = `${redisModeLabel}${redisHeaderStatus.latencyMs != null ? ` • ${Math.round(redisHeaderStatus.latencyMs)}ms` : ''}`;
	const redisBadgeClass = `redis-health-badge ${redisHeaderStatus.connected ? 'connected' : 'disconnected'}`;

	const resultCount = typeof totalMatches === 'number' ? totalMatches : results.length;

	return (
		<div className='local-name-search-panel'>
			<div className='local-name-search-header'>
				<h3>
					Redis Search
					{searched && !loading && !error && <span className='local-name-search-count'> ({resultCount.toLocaleString()})</span>}
				</h3>
				<div className='local-name-search-summary'>
					<div className='local-name-search-compare'>Redis CRDs: {formattedRedisUnique}</div>
				</div>
			</div>
			<input
				type='text'
				className='local-name-search-input'
				placeholder='Search Redis-saved records by name…'
				value={query}
				onChange={(e) => onQueryChange(e.target.value)}
				onKeyDown={handleKeyDown}
				spellCheck={false}
			/>
			<div className='local-name-search-status-row'>
				<a
					href='/api/redis-health'
					target='_blank'
					rel='noopener noreferrer'
					className={redisBadgeClass}
					title={`${redisBadgeTitle} • Open health details`}
					aria-label='Open Redis health details'>
					{redisBadgeText}
				</a>
			</div>
			<div className='row'>
				<button
					className={`button-secondary local-name-search-button${loading ? ' is-loading' : ''}`}
					onClick={() => onSearch()}
					disabled={loading || !query.trim()}
					aria-busy={loading}>
					<span className='local-name-search-button-label'>{loading ? 'Fetching…' : 'Search Redis'}</span>
				</button>
				{results.length > 0 && (
					<button
						className={`copy-all-btn ${copyState === 'copied' ? 'is-copied' : ''}`}
						onClick={handleCopyResults}
						title='Copy results to clipboard'>
						{copyState === 'copied' ? 'Copied ✓' : 'Copy results'}
					</button>
				)}
			</div>

			{error && (
				<div className='status-error'>
					<h3>Search error</h3>
					<div className='status-details'>{error}</div>
				</div>
			)}

			{searched && !loading && !error && results.length === 0 && <div className='status-empty'>No results found for &ldquo;{query.trim()}&rdquo;.</div>}

			{searched && results.length > 0 && (
				<div className='local-name-search-results'>
					<table className='local-name-search-table'>
						<thead>
							<tr>
								<th>Name</th>
								<th>Details</th>
							</tr>
						</thead>
						<tbody>
							{results.map((match, i) => {
								// Collect extra matched snippets (location/street/other identifiers) that
								// aren't already shown via name/aliases/currentAddress, so the search panel
								// surfaces exactly what matched the query.
								const shownValues = [match.name, match.key, ...(match.aliases || []), match.currentAddress].filter(Boolean).map((v) => String(v).toLowerCase());
								const extraMatches = (match.matchedValues || []).filter((value) => value && !shownValues.some((shown) => shown.includes(value.toLowerCase())));

								return (
									<tr
										className='local-name-search-row'
										key={i}
										onClick={() => onSelectResult?.(match.crd, match.type, match.source, match.key)}
										role='button'>
										<td>
											<div
												className='local-name-primary'
												dangerouslySetInnerHTML={{ __html: highlightTerms(match.name || match.key || '', terms) }}
											/>
											{match.aliases && match.aliases.length > 0 && (
												<div className='local-name-matches'>
													{match.aliases.map((alias, idx) => (
														<span
															key={`${alias}-${idx}`}
															className='local-name-match-line'
															dangerouslySetInnerHTML={{ __html: highlightTerms(alias, terms) }}
														/>
													))}
												</div>
											)}
										</td>
										<td>
											<div>
												{match.type} &bull;{' '}
												<button
													type='button'
													className='local-name-crd-link'
													onClick={(e) => {
														e.stopPropagation();
														onSelectResult?.(match.crd, match.type, match.source, match.key);
													}}>
													CRD {match.crd}
												</button>
											</div>
											{match.source && <span className={`source-badge ${match.source}`}>{match.source.toUpperCase()}</span>}
											{match.currentAddress && (
												<div
													className='local-name-aliases'
													dangerouslySetInnerHTML={{ __html: highlightTerms(match.currentAddress, terms) }}
												/>
											)}
											{extraMatches.length > 0 && (
												<div className='local-name-extra-matches'>
													{extraMatches.map((value, idx) => (
														<span
															key={`${value}-${idx}`}
															className='local-name-match-line local-name-match-extra'
															dangerouslySetInnerHTML={{ __html: highlightTerms(value, terms) }}
														/>
													))}
												</div>
											)}
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
}
