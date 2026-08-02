'use client';
import React from 'react';

interface Props {
	msg: string;
	visible: boolean;
	isRateLimit: boolean;
	onClose: () => void;
	onResolveRateLimit: () => void;
}

export function GlobalBanner({ msg, visible, isRateLimit, onClose, onResolveRateLimit }: Props) {
	if (!visible) return null;

	function handleClose() {
		if (isRateLimit) onResolveRateLimit();
		else onClose();
	}

	return (
		<div className="global-banner" role="alert">
			<div className="global-banner-inner">
				<span className="global-status-text">{msg}</span>
				<button className="button-secondary" onClick={handleClose}>
					&times; Close
				</button>
			</div>
		</div>
	);
}
