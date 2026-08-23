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
		mode: 'upstash-rest' | 'redis-url' | 'local-redis' | 'none';
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
		redisHeaderStatus.mode === 'local-redis' ? 'Local Redis'
		: redisHeaderStatus.mode === 'upstash-rest' ? 'Upstash REST'
		: redisHeaderStatus.mode === 'redis-url' ? 'Redis URL'
		: 'Not Configured';
	const redisBadgeText =
		redisHeaderStatus.connected ?
			redisHeaderStatus.mode === 'local-redis' ? 'Local Redis Connected'
			: 'Connected to Redis Cache'
		: 'Redis Disconnected';
	const redisBadgeTitle = `${redisModeLabel}${redisHeaderStatus.latencyMs != null ? ` • ${Math.round(redisHeaderStatus.latencyMs)}ms` : ''}`;
	const redisBadgeClass = `redis-health-badge ${redisHeaderStatus.connected ? 'connected' : 'disconnected'}`;

	const resultCount = typeof totalMatches === 'number' ? totalMatches : results.length;

	return (
		<div className='local-name-search-panel'>
			<div className='local-name-search-header-row' style={{ display: 'flex', alignItems: 'center', gap: '15px', flexWrap: 'wrap' }}>
				<h3 style={{ margin: 0, whiteSpace: 'nowrap' }}>
					Redis Search
					{searched && !loading && !error && <span className='local-name-search-count'> ({resultCount.toLocaleString()})</span>}
				</h3>

				<div className='row' style={{ flex: 1, minWidth: '300px', margin: 0 }}>
					<input
						type='text'
						className='local-name-search-input'
						style={{ flex: 1, minWidth: 0, height: '32px' }}
						placeholder='Search Redis-saved records by name…'
						value={query}
						onChange={(e) => onQueryChange(e.target.value)}
						onKeyDown={handleKeyDown}
						spellCheck={false}
					/>
					<button
						className={`button-secondary local-name-search-button${loading ? ' is-loading' : ''}`}
						onClick={() => onSearch()}
						disabled={loading || !query.trim()}
						aria-busy={loading}
						style={{ height: '32px', minWidth: '90px', padding: '0 12px' }}>
						<span className='local-name-search-button-label'>{loading ? 'Fetching…' : 'Search'}</span>
					</button>
				</div>

				<div
					className='local-name-search-filters'
					style={{ display: 'flex', gap: '15px', fontSize: '13px', alignItems: 'center' }}>
					<label style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
						<input type='checkbox' defaultChecked /> Firm
					</label>
					<label style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
						<input type='checkbox' defaultChecked /> Person
					</label>
					<label style={{ display: 'flex', alignItems: 'center', gap: '4px', marginLeft: '5px' }}>
						Zip:{' '}
						<input
							type='text'
							placeholder='Zip'
							style={{ width: '50px', padding: '2px 4px', fontSize: '12px' }}
						/>
					</label>
					<label style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
						Radius:
						<select style={{ padding: '2px 4px', fontSize: '12px' }}>
							<option value='10'>10 mi</option>
							<option value='25'>25 mi</option>
							<option value='50'>50 mi</option>
							<option value='100'>100 mi</option>
						</select>
					</label>
					<div className='local-name-search-status-row' style={{ marginLeft: 'auto' }}>
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
				</div>
			</div>

			{results.length > 0 && (
				<div className='row'>
					<button
						className={`copy-all-btn ${copyState === 'copied' ? 'is-copied' : ''}`}
						onClick={handleCopyResults}
						title='Copy results to clipboard'>
						{copyState === 'copied' ? 'Copied ✓' : 'Copy results'}
					</button>
				</div>
			)}

			{error && (
				<div className='status-error'>
					<h3>Search error</h3>
					<div className='status-details'>{error}</div>
				</div>
			)}

			{searched && !loading && !error && results.length === 0 && <div className='status-empty'>No results found for &ldquo;{query.trim()}&rdquo;.</div>}

			{searched && results.length > 0 && (
				<div className='local-name-search-results' style={{ display: 'flex', flexDirection: 'column', gap: '4px', padding: '10px', background: 'transparent', border: 'none' }}>
					{results.map((match, i) => {
						const shownValues = [match.name, match.key, ...(match.aliases || []), match.currentAddress].filter(Boolean).map((v) => String(v).toLowerCase());
						const extraMatches = (match.matchedValues || []).filter((value) => value && !shownValues.some((shown) => shown.includes(value.toLowerCase())));

						return (
							<div
								className='local-name-search-row-flat'
								key={i}
								onClick={() => onSelectResult?.(match.crd, match.type, match.source, match.key)}
								role='button'
								style={{ 
									display: 'flex', 
									alignItems: 'center', 
									gap: '12px', 
									padding: '8px 12px', 
									background: 'var(--midnight)', 
									border: '1px solid var(--border)', 
									borderRadius: '6px', 
									cursor: 'pointer',
									transition: 'background-color 0.15s ease'
								}}
								onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(124, 58, 237, 0.12)')}
								onMouseLeave={(e) => (e.currentTarget.style.background = 'var(--midnight)')}
							>
									<div style={{ flex: 1.5, display: 'flex', flexDirection: 'column', gap: '2px', overflow: 'hidden' }}>
										<div
											className='local-name-primary'
											style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
											dangerouslySetInnerHTML={{ __html: highlightTerms(match.name || match.key || '', terms) }}
										/>
										{(match.aliases && match.aliases.length > 0) && (() => {
											const matchedAlias = match.aliases.find(a => terms.some(t => a.toLowerCase().includes(t.toLowerCase()))) || match.aliases[0];
											const hiddenCount = match.aliases.length - 1;
											return (
												<div style={{ fontSize: '11px', color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={match.aliases.join(', ')}>
													aka <span dangerouslySetInnerHTML={{ __html: highlightTerms(matchedAlias, terms) }} />
													{hiddenCount > 0 ? ` (+${hiddenCount})` : ''}
												</div>
											);
										})()}
									</div>
									
									<div style={{ flex: 2, display: 'flex', flexDirection: 'column', gap: '2px', overflow: 'hidden', borderLeft: '1px solid var(--border)', paddingLeft: '12px' }}>
										{match.type === 'individual' && match.currentFirm ? (
											<div style={{ fontSize: '12px', color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
												<span style={{ color: 'var(--cyan)' }}>Firm:</span> <span dangerouslySetInnerHTML={{ __html: highlightTerms(match.currentFirm, terms) }} /> {match.currentFirmCrd ? `(CRD: ${match.currentFirmCrd})` : ''}
											</div>
										) : <div style={{ fontSize: '12px', color: 'transparent' }}>-</div>}
										{match.currentAddress ? (
											<div 
												style={{ fontSize: '11px', color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
												dangerouslySetInnerHTML={{ __html: highlightTerms(match.currentAddress, terms) }}
											/>
										) : <div style={{ fontSize: '11px', color: 'transparent' }}>-</div>}
									</div>

									<div style={{ color: 'var(--text-secondary)', fontSize: '12px', whiteSpace: 'nowrap', width: '90px' }}>
										CRD: <span style={{ color: 'var(--cyan)', fontWeight: 600 }}>{match.crd}</span>
									</div>
								
								<div style={{ color: 'var(--text-muted)', fontSize: '12px', width: '70px', textAlign: 'right', textTransform: 'capitalize' }}>
									{match.type}
								</div>

								{match.source && <span className={`source-badge ${match.source}`} style={{ margin: 0 }}>{match.source.toUpperCase()}</span>}
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}
