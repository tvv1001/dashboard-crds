'use client';
import React from 'react';
import type { GroupEntry } from '../../types';
import { formatRelativeTime } from '../../lib/format';

interface Props {
	entry: GroupEntry;
	seenKeys: Record<string, boolean>;
	activeKey: string;
	onSelect: (key: string) => void;
}

function sourceLabel(key: string): string {
	const src = key.split(':')[0]?.toUpperCase() ?? key;
	return src === 'FINRA' ? 'FINRA' : src === 'SEC' ? 'SEC' : src;
}

export function KeyCard({ entry, seenKeys, activeKey, onSelect }: Props) {
	const { groupKey, type, crd, displayType, keys, sortLabel, industryDate, hasWarning, warningText } = entry;
	const isGroupActive = keys.includes(activeKey);

	return (
		<li
			className={`recent-fetched-item${isGroupActive ? ' active' : ''}`}
			data-crd={crd}
			data-type={entry.type}
			data-key={activeKey || keys[0]}
			tabIndex={0}
			role='option'
			aria-selected={isGroupActive}
			onClick={() => onSelect(activeKey && keys.includes(activeKey) ? activeKey : keys[0])}>
			
			<div className='rf-name'>
				{type === 'individual' ? '👤' : '🏢'} {sortLabel || 'Unknown'} <span className="rf-crd">#{crd}</span>
				{hasWarning && (
					<span className='card-warning-badge' title={warningText}>⚠️</span>
				)}
			</div>

			<div className='rf-bottom-row'>
				<div className='rf-tags'>
					{keys.map((key) => {
						const isSeen = Boolean(seenKeys[key]);
						const isActive = key === activeKey;
						const src = key.split(':')[0] ?? '';
						const cls = ['source-badge', src, !isSeen ? 'unseen' : '', isActive ? 'active' : ''].filter(Boolean).join(' ');
						return (
							<span
								key={key}
								className={cls}
								data-key={key}
								role='option'
								aria-selected={isActive}
								onClick={(e) => {
									e.stopPropagation();
									onSelect(key);
								}}>
								{sourceLabel(key)}
							</span>
						);
					})}
				</div>
				<span className="rf-date">
					{entry.latest ? formatRelativeTime(new Date(entry.latest).toISOString()) : '—'}
				</span>
			</div>
		</li>
	);
}
