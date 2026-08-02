'use client';
import React, { useEffect, useState, useCallback } from 'react';
import type { RecentFetchedItem } from '../../../pages/api/recent-fetched';
import { formatRelativeTime } from '../../lib/format';

interface Props {
	activeKey: string;
	onSelectKey: (key: string) => void;
	refreshTrigger?: number;
}

function scopeClass(scope: string | null): string {
	if (!scope) return '';
	const s = scope.toLowerCase();
	if (s === 'active') return 'scope-active';
	if (s === 'inactive') return 'scope-inactive';
	if (s === 'expanded') return 'scope-expanded';
	if (s === 'notinscope') return 'scope-notinscope';
	if (s.startsWith('legacy')) return 'scope-legacy';
	return '';
}

export function RecentFetched({ activeKey, onSelectKey, refreshTrigger }: Props) {
	const [items, setItems] = useState<RecentFetchedItem[]>([]);
	const [loading, setLoading] = useState(true);

	const refresh = useCallback(() => {
		setLoading(true);
		fetch('/api/recent-fetched?limit=100')
			.then((r) => r.json())
			.then((data) => {
				if (Array.isArray(data.items)) setItems(data.items);
			})
			.catch(() => {})
			.finally(() => setLoading(false));
	}, []);

	useEffect(() => {
		refresh();
	}, [refresh, refreshTrigger]);

	if (loading && items.length === 0) {
		return (
			<div className='recent-fetched-section'>
				<div className='recent-fetched-title'>Recently Fetched</div>
				<div className='recent-fetched-empty'>Loading…</div>
			</div>
		);
	}

	return (
		<div className='recent-fetched-section'>
			<div className='recent-fetched-header'>
				<span className='recent-fetched-title'>Recently Fetched</span>
				<button className='recent-fetched-refresh' onClick={refresh} title='Refresh'>↺</button>
			</div>
			{items.length === 0 ? (
				<div className='recent-fetched-empty'>No records yet.</div>
			) : (
				<ul className='recent-fetched-list'>
					{items.map((item) => {
						const preferredKey = item.sources.includes('finra')
							? `finra:${item.type}:${item.crd}`
							: `sec:${item.type}:${item.crd}`;
						const isActive = item.sources.some(
							(src) => activeKey === `${src}:${item.type}:${item.crd}`,
						);
						return (
							<li
								key={`${item.type}:${item.crd}`}
								className={`recent-fetched-item${isActive ? ' rf-active' : ''}`}
								data-key={preferredKey}
								tabIndex={0}
								role='option'
								aria-selected={isActive}
								onClick={() => onSelectKey(preferredKey)}>
								<div className='rf-name'>
									{item.type === 'individual' ? '👤' : '🏢'} {item.name} <span className="rf-crd">#{item.crd}</span>
								</div>
								<div className='rf-bottom-row'>
									<div className='rf-tags'>
										{item.sources.map((src) => {
											const sourceKey = `${src}:${item.type}:${item.crd}`;
											const isSourceActive = activeKey === sourceKey;
											return (
												<span
													key={src}
													className={`source-badge ${src}${isSourceActive ? ' active' : ''}`}
													title={`Select ${src.toUpperCase()} record`}
													onClick={(e) => {
														e.stopPropagation();
														onSelectKey(sourceKey);
													}}>
													{src.toUpperCase()}
												</span>
											);
										})}
									</div>
									<span className="rf-date">
										{item.mtime ? formatRelativeTime(new Date(item.mtime).toISOString()) : '—'}
									</span>
								</div>
							</li>
						);
					})}
				</ul>
			)}
		</div>
	);
}
