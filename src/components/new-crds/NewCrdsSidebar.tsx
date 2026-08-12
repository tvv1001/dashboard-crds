'use client';
import React, { useState } from 'react';
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
	const { error, scanInProgress, loading, redisHighWater } = state;
	const individualItems = Array.isArray(redisHighWater?.sections?.individual) ? redisHighWater.sections.individual : [];
	const firmItems = Array.isArray(redisHighWater?.sections?.firm) ? redisHighWater.sections.firm : [];
	const totalSavedCrds = Number(redisHighWater?.totalSavedCrds || 0);
	const hasAnyItems = individualItems.length > 0 || firmItems.length > 0;
	const itemCount = individualItems.length + firmItems.length;

	// Mobile accordion: collapsed by default.
	const [mobileOpen, setMobileOpen] = useState(false);

	const handleMobileToggle = () => {
		setMobileOpen((open) => !open);
	};

	const handleSelect = (crd: string, source: string, type: string) => {
		onSelect?.(crd, source, type);
		// Collapse after pick so the record panel has room on small screens.
		setMobileOpen(false);
	};

	return (
		<aside
			id='newCrdsSidebar'
			className={`new-crds-sidebar${mobileOpen ? ' open' : ''}`}>
			<div className='new-crds-header'>
				<button
					type='button'
					className='new-crds-mobile-toggle'
					onClick={handleMobileToggle}
					aria-expanded={mobileOpen}
					aria-controls='newCrdsBody'>
					<span className='new-crds-mobile-toggle-label'>
						<span className='new-crds-mobile-title'>New CRDs</span>
						{itemCount > 0 && <span className='new-crds-count-badge'>{itemCount}</span>}
						{loading && !hasAnyItems && <span className='new-crds-loading-hint'>Loading…</span>}
					</span>
					<span
						className='new-crds-chevron'
						aria-hidden='true'>
						{mobileOpen ? '▲' : '▼'}
					</span>
				</button>

				<div className='new-crds-desktop-header'>
					<h2>New CRDs</h2>
					<div className='row'>
						<button
							type='button'
							className='button-secondary'
							onClick={onToggle}
							title='Hide'>
							▶
						</button>
					</div>
				</div>
			</div>

			<div
				id='newCrdsBody'
				className='new-crds-body'>
				<div className='new-crds-summary'>
					<div className='new-crds-frontier-line'>
						{loading && !redisHighWater ?
							'Loading Redis CRDs…'
						:	`${totalSavedCrds.toLocaleString()} unique CRDs saved in Redis`}
					</div>
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
										onSelect={handleSelect}
									/>
								))}
							</ul>
						:	<div className='new-crds-section-empty'>{loading ? 'Loading…' : 'No individual CRDs in Redis.'}</div>}
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
										onSelect={handleSelect}
									/>
								))}
							</ul>
						:	<div className='new-crds-section-empty'>{loading ? 'Loading…' : 'No firm CRDs in Redis.'}</div>}
					</section>
				</div>
				{!loading && !hasAnyItems && <div className='new-crds-empty'>Redis currently has no CRD rows to show.</div>}
				<button
					type='button'
					className='button-secondary new-crds-dismiss-btn'
					onClick={onDismiss}>
					Hide status
				</button>
			</div>
		</aside>
	);
}
