'use client';
import React from 'react';

interface Props {
	count: number;
	onOpen: () => void;
}

export function NewCrdsNotice({ count, onOpen }: Props) {
	if (count <= 0) return null;

	return (
		<button className="new-crds-notice" type="button" onClick={onOpen}>
			<span className="new-crds-notice-label">New CRDs</span>
			<span className="new-crds-notice-count">{count}</span>
		</button>
	);
}
