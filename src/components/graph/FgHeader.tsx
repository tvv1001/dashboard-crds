import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

interface FgHeaderProps {
	focusLabel?: string | null;
	focusCrd?: string | null;
	showFocusReadout: boolean;

	showDrawerToggle: boolean;
	drawerOpen: boolean;
	setDrawerOpen: React.Dispatch<React.SetStateAction<boolean>>;

	errorMessage?: string | null;
	searchBanner?: { query: string; count: number } | null;
	setSearchBanner: (val: null) => void;
	
	// Search form props
	searchQuery?: string;
	onSearchQueryChange?: (q: string) => void;
	onSearchSubmit?: (e: React.FormEvent) => void;
	searchDisabled?: boolean;
	searchLoading?: boolean;
}

export function FgHeader({ 
	focusLabel, focusCrd, showFocusReadout, showDrawerToggle, drawerOpen, setDrawerOpen, 
	errorMessage, searchBanner, setSearchBanner,
	searchQuery = '', onSearchQueryChange, onSearchSubmit, searchDisabled, searchLoading
}: FgHeaderProps) {
	const [portalContainer, setPortalContainer] = useState<Element | null>(null);

	useEffect(() => {
		setPortalContainer(document.getElementById('top-nav-search-portal'));
	}, []);

	const searchForm = onSearchSubmit ? (
		<form
			className='fg-search'
			style={{ display: 'flex', width: '300px', margin: 0 }}
			onSubmit={onSearchSubmit}>
			<input
				className='fg-search-input'
				style={{ flex: 1, minWidth: 0, padding: '4px 8px', fontSize: '0.8rem', background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border)', borderRadius: '4px' }}
				type='search'
				placeholder='Search firm, person, CRD/SEC#'
				value={searchQuery}
				onChange={(e) => onSearchQueryChange?.(e.target.value)}
				aria-label='Search firm, person, or CRD'
				autoComplete='off'
				disabled={searchDisabled}
			/>
			<button
				type='submit'
				className='fg-send-btn'
				aria-label='Search'
				disabled={searchDisabled || searchLoading}
				style={{ padding: '4px 8px', background: 'var(--cyan)', color: '#000', border: 'none', borderRadius: '4px', marginLeft: '4px', cursor: 'pointer', fontSize: '0.8rem' }}>
				➤
			</button>
		</form>
	) : null;

	return (
		<header className='fg-header'>
			{portalContainer && searchForm ? createPortal(searchForm, portalContainer) : null}
			<div className='fg-header-bar'>
				<div className='fg-header-controls'></div>

				<div className={`fg-focus-readout${showFocusReadout ? ' fg-focus-readout--visible' : ''}`}>
					{focusLabel ?
						<>
							<span className='fg-focus-readout__name'>{focusLabel}</span>
							{focusCrd && <span className='fg-focus-readout__crd'>CRD {focusCrd}</span>}
						</>
					:	null}
				</div>

				<div className='fg-header-right-controls'>
					{showDrawerToggle && (
						<button
							type='button'
							onClick={() => setDrawerOpen((open) => !open)}
							className={`fg-hamburger-btn${drawerOpen ? ' active' : ''}`}
							aria-label='Toggle details panel'
							aria-expanded={drawerOpen}>
							☰
						</button>
					)}
				</div>
			</div>
			{searchBanner && (
				<div className='fg-search-banner'>
					<span>
						Added {searchBanner.count} node{searchBanner.count === 1 ? '' : 's'} for &quot;{searchBanner.query}&quot;
					</span>
					<button
						type='button'
						className='fg-search-banner-close'
						onClick={() => setSearchBanner(null)}
						aria-label='Dismiss'>
						✕
					</button>
				</div>
			)}
		</header>
	);
}
