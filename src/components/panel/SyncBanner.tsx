'use client';
import React from 'react';
import type { SyncBannerState } from '../../types';

interface Props {
	syncBanner: SyncBannerState;
	onDismiss: () => void;
}

export function SyncBanner({ syncBanner, onDismiss }: Props) {
	const dl = syncBanner.downloaded;
	const up = syncBanner.updated;
	const rp = syncBanner.repaired;
	const uc = syncBanner.unchanged;

	if (dl === 0 && up === 0 && rp === 0 && uc === 0) return null;

	const hasChanges = dl > 0 || up > 0 || rp > 0;
	const cls = `sync-banner ${hasChanges ? 'sync-banner-success' : 'sync-banner-info'}`;

	return (
		<div className={cls}>
			<div className="sync-banner-inner">
				<span className="sync-status-text">
					Local sync: {dl} new &bull; {up} updated &bull; {rp} repaired &bull; {uc} already current
				</span>
				<button className="sync-banner-close" onClick={onDismiss} aria-label="Dismiss">
					&times;
				</button>
			</div>
		</div>
	);
}
