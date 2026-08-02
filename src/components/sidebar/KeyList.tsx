'use client';
import React, { useRef, useEffect, useMemo, useState } from 'react';
import type { GroupEntry, SortOrder } from '../../types';
import { KeyCard } from './KeyCard';
import { filterGroups } from '../../lib/buildGroups';
import { RecentFetched } from './RecentFetched';

const ALWAYS_VISIBLE_RECENT_GROUPS = 25;
const INITIAL_GROUP_RENDER_LIMIT = 250;
const GROUP_RENDER_INCREMENT = 250;

interface Props {
	groups: GroupEntry[];
	seenKeys: Record<string, boolean>;
	activeKey: string;
	filter: string;
	onFilterChange: (f: string) => void;
	sortOrder: SortOrder;
	onSortChange: (s: SortOrder) => void;
	typeFilter: string;
	onTypeFilterChange: (t: string) => void;
	loadedCount: number;
	totalCount: number;
	isPartial: boolean;
	statusMsg: string;
	uniqueTotalCrds: number;
	onSelectKey: (key: string) => void;
}

export function KeyList({
	groups,
	seenKeys,
	activeKey,
	filter,
	onFilterChange,
	sortOrder,
	onSortChange,
	typeFilter,
	onTypeFilterChange,
	loadedCount,
	totalCount,
	isPartial,
	statusMsg,
	uniqueTotalCrds,
	onSelectKey,
}: Props) {
	const containerRef = useRef<HTMLDivElement>(null);
	const [renderLimit, setRenderLimit] = useState(INITIAL_GROUP_RENDER_LIMIT);
	const [isResultsCollapsed, setIsResultsCollapsed] = useState(false);
	const filteredGroups = useMemo(() => filterGroups(groups, filter), [groups, filter]);

	// Reset render limit when filter changes
	useEffect(() => {
		setRenderLimit(INITIAL_GROUP_RENDER_LIMIT);
	}, [filter]);

	const isUnfiltered = filter.trim() === '';
	const recentGroupKeys = useMemo(
		() =>
			new Set(
				[...groups]
					.sort((a, b) => b.latest - a.latest)
					.slice(0, ALWAYS_VISIBLE_RECENT_GROUPS)
					.map((g) => g.groupKey),
			),
		[groups],
	);

	let displayed: GroupEntry[];
	let totalMessage = '';

	if (isUnfiltered) {
		displayed = [];
		totalMessage = '';
	} else {
		const pinned: GroupEntry[] = [];
		const nonPinned: GroupEntry[] = [];

		for (const g of filteredGroups) {
			const hasBeenLookedAt = g.keys.some((k) => seenKeys[k]);
			const isActive = g.keys.includes(activeKey);
			const isPinned = isActive || (recentGroupKeys.has(g.groupKey) && !hasBeenLookedAt);
			if (isPinned) pinned.push(g);
			else nonPinned.push(g);
		}

		const nonPinnedSliced = nonPinned.slice(0, renderLimit);
		displayed = [...pinned, ...nonPinnedSliced];
		totalMessage = `${filteredGroups.length} group${filteredGroups.length !== 1 ? 's' : ''} matching "${filter}"`;
	}

	const canShowResults = displayed.length > 0;
	const showResultsToggle = displayed.length > 0 || isResultsCollapsed;

	function handleFilterFocus() {
		if (canShowResults) setIsResultsCollapsed(false);
	}

	// Keyboard navigation
	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		function getAllFocusable(): HTMLElement[] {
			const root = containerRef.current;
			if (!root) return [];
			return Array.from(root.querySelectorAll<HTMLElement>('[data-key]'));
		}

		function handleKeyDown(e: KeyboardEvent) {
			const target = e.target as HTMLElement;
			const isFocusable = target.hasAttribute('data-key');
			if (!isFocusable) return;

			const all = getAllFocusable();
			const idx = all.indexOf(target);
			if (idx === -1) return;

			if (e.key === 'ArrowDown') {
				e.preventDefault();
				(all[idx + 1] || all[all.length - 1])?.focus();
			} else if (e.key === 'ArrowUp') {
				e.preventDefault();
				(all[idx - 1] || all[0])?.focus();
			} else if (e.key === 'Home') {
				e.preventDefault();
				all[0]?.focus();
			} else if (e.key === 'End') {
				e.preventDefault();
				all[all.length - 1]?.focus();
			} else if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				const key = target.dataset.key;
				if (key) onSelectKey(key);
			}
		}

		container.addEventListener('keydown', handleKeyDown);
		return () => container.removeEventListener('keydown', handleKeyDown);
	}, [onSelectKey]);

	return (
		<div
			className='key-list'
			ref={containerRef}>
			<div className='saved-controls'>
				<div className='sort-control'>
					<select
						className='sort-select'
						value={sortOrder}
						onChange={(e) => onSortChange(e.target.value as SortOrder)}>
						<option value='date-desc'>Newest first</option>
						<option value='crd-asc'>CRD ↑</option>
						<option value='crd-desc'>CRD ↓</option>
					</select>
				</div>
				<div className='visibility-controls'>
					<div className='toggle-row'>
						<select
							className='type-filter-select'
							value={typeFilter}
							onChange={(e) => onTypeFilterChange(e.target.value)}>
							<option value='all'>All types</option>
							<option value='individuals'>Individuals</option>
							<option value='firms'>Firms</option>
						</select>
					</div>
				</div>
			</div>

			{isUnfiltered && (
				<RecentFetched
					activeKey={activeKey}
					onSelectKey={onSelectKey}
					refreshTrigger={loadedCount}
				/>
			)}

			{totalMessage && <div className='key-list-summary'>{totalMessage}</div>}

			{displayed.length > 0 && (
				<div className={`key-list-scroll${isResultsCollapsed ? ' is-collapsed' : ''}`}>
					{displayed.map((entry) => (
						<KeyCard
							key={entry.groupKey}
							entry={entry}
							seenKeys={seenKeys}
							activeKey={activeKey}
							onSelect={onSelectKey}
						/>
					))}

					{!isUnfiltered && filteredGroups.length > displayed.length && (
						<button
							className='load-more-keys'
							onClick={() => setRenderLimit((n) => n + GROUP_RENDER_INCREMENT)}>
							Load more…
						</button>
					)}
				</div>
			)}

			<div className='key-list-footer'>
				{showResultsToggle && (
					<div className='key-list-footer-row'>
						<button
							className='key-list-toggle'
							type='button'
							onClick={() => setIsResultsCollapsed((prev) => !prev)}
							disabled={displayed.length === 0 && !isResultsCollapsed}>
							{isResultsCollapsed ? 'Show cards' : 'Hide cards'}
							<span className='saved-count-badge'>{displayed.length}</span>
						</button>
					</div>
				)}
				<input
					className='key-list-filter'
					type='text'
					placeholder='Filter by CRD or name…'
					value={filter}
					onChange={(e) => onFilterChange(e.target.value)}
					onFocus={handleFilterFocus}
					spellCheck={false}
				/>
			</div>
		</div>
	);
}
