'use client';
import React from 'react';
import type { NewCrdItem as NewCrdItemType } from '../../types';

interface Props {
	item: NewCrdItemType;
	activeKey: string;
	onSelect?: (crd: string, source: string, type: string) => void;
}

export function NewCrdItem({ item, activeKey, onSelect }: Props) {
	const { crd, type, sources, name, savedFiles } = item;

	const preferredKey = sources.includes('finra') ? `finra:${type}:${crd}` : `sec:${type}:${crd}`;

	const isActive = activeKey === String(crd) || activeKey === `${type}:${crd}` || activeKey.endsWith(`:${crd}`);

	const rowSelection = (() => {
		if (Array.isArray(savedFiles) && savedFiles.length > 0) {
			const normalized = String(savedFiles[0] || '').replace(/\.json$/i, '');
			const parsed = normalized.match(/^(finra|sec):(individual|firm):(\d+)$/i);
			if (parsed) {
				return {
					source: parsed[1].toLowerCase(),
					type: parsed[2].toLowerCase(),
					crd: parsed[3],
				};
			}
		}
		return {
			source: sources.includes('finra') ? 'finra' : 'sec',
			type,
			crd,
		};
	})();

	return (
		<li
			className={`recent-fetched-item${isActive ? ' rf-active' : ''}`}
			data-key={preferredKey}
			tabIndex={0}
			role='option'
			aria-selected={isActive}
			onClick={() => onSelect?.(rowSelection.crd, rowSelection.source, rowSelection.type)}>
			<div className='rf-top-row'>
				<div className='rf-name'>
					{type === 'individual' ? '👤' : '🏢'} {name || `#${crd}`}
				</div>
				<div className='rf-tags'>
					{sources.map((source) => (
						<span
							key={source}
							className={`source-tag ${source}`}>
							{source.toUpperCase()}
						</span>
					))}
				</div>
			</div>
			<div className='rf-crd'>CRD #{crd}</div>
		</li>
	);
}
