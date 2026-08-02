'use client';
import React from 'react';
import type { NewCrdsState } from '../../types';
import { NewCrdItem } from './NewCrdItem';
interface Props {
	state: NewCrdsState;
	activeKey: string;
	onToggle: () => void;
	onDismiss: () => void;
	onSelect?: (crd: string, source: string, type: string) => void;
}

export function NewCrdsSidebar({ state, activeKey, onToggle, onDismiss, onSelect }: Props) {
	const { visible, error, scanInProgress, redisHighWater } = state;
	const individualItems = Array.isArray(redisHighWater?.sections?.individual) ? redisHighWater.sections.individual : [];
	const firmItems = Array.isArray(redisHighWater?.sections?.firm) ? redisHighWater.sections.firm : [];
	const totalSavedCrds = Number(redisHighWater?.totalSavedCrds || 0);
	const hasAnyItems = individualItems.length > 0 || firmItems.length > 0;

	return (
		<aside
			id='newCrdsSidebar'
			className={`new-crds-sidebar${visible ? ' open' : ''}`}>
			<div className='new-crds-header'>
				<h2>New CRDs</h2>
				<div className='row'>
					<button
						className='button-secondary'
						onClick={onToggle}
						title={visible ? 'Hide' : 'Show'}>
						{visible ? '▶' : '◀'}
					</button>
				</div>
			</div>

			{visible && (
				<div className='new-crds-body'>
					<div className='new-crds-summary'>
						<div className='new-crds-frontier-line'>{totalSavedCrds.toLocaleString()} unique CRDs saved in Redis</div>
					</div>
					{error && (
						<div className='status-error'>
							<h3>New CRDs error</h3>
							<div className='status-details'>{error}</div>
						</div>
					)}
					{scanInProgress && <div className='new-crds-empty'>Checking external APIs for new CRDs in the background…</div>}
					<div className='new-crds-sections'>
						<section className='new-crds-section'>
							<div className='new-crds-section-title'>People</div>
							{individualItems.length > 0 ?
								<ul className='new-crds-section-list'>
									{individualItems.map((item) => (
										<NewCrdItem
											key={item.id}
											item={item}
											activeKey={activeKey}
											onSelect={onSelect}
										/>
									))}
								</ul>
							:	<div className='new-crds-section-empty'>No individual CRDs in Redis.</div>}
						</section>
						<section className='new-crds-section'>
							<div className='new-crds-section-title'>Firms</div>
							{firmItems.length > 0 ?
								<ul className='new-crds-section-list'>
									{firmItems.map((item) => (
										<NewCrdItem
											key={item.id}
											item={item}
											activeKey={activeKey}
											onSelect={onSelect}
										/>
									))}
								</ul>
							:	<div className='new-crds-section-empty'>No firm CRDs in Redis.</div>}
						</section>
					</div>
					{!hasAnyItems && <div className='new-crds-empty'>Redis currently has no CRD rows to show.</div>}
					<button
						className='button-secondary'
						onClick={onDismiss}>
						Hide status
					</button>
				</div>
			)}
		</aside>
	);
}
