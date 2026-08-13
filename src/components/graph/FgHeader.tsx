import React from 'react';

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
}

export function FgHeader({
	focusLabel,
	focusCrd,
	showFocusReadout,
	showDrawerToggle,
	drawerOpen,
	setDrawerOpen,
	errorMessage,
	searchBanner,
	setSearchBanner
}: FgHeaderProps) {
	return (
		<header className='fg-header'>
			<div className='fg-header-bar'>
				<div className='fg-header-controls'>
					{/* Search moved to details panel */}
				</div>

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
			{errorMessage && <div className='fg-search-error'>{errorMessage}</div>}
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
