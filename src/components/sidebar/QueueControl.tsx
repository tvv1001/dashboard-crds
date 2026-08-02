'use client';
import React from 'react';
import type { QueueItem } from '../../types';

interface Props {
	value: string;
	onChange: (v: string) => void;
	onRun: () => void;
	isRunning: boolean;
	queueItems: QueueItem[];
}

export function QueueControl({ value, onChange, onRun, isRunning, queueItems }: Props) {
	const statusCounts = queueItems.reduce<Record<string, number>>((acc, item) => {
		acc[item.status] = (acc[item.status] || 0) + 1;
		return acc;
	}, {});

	function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
		if (e.key === 'Enter' && e.ctrlKey) {
			e.preventDefault();
			onRun();
		}
	}

	return (
		<div className="control">
			<div className="stacked-control">
				<textarea
					id="searchTermsInput"
					placeholder="Enter CRD number or search query… (Ctrl+Enter to run)"
					value={value}
					onChange={(e) => onChange(e.target.value)}
					onKeyDown={handleKeyDown}
					spellCheck={false}
					rows={4}
				/>
				<div className="row queue-actions">
					<button className="queue-run-button" onClick={onRun} disabled={isRunning || !value.trim()}>
						{isRunning ? 'Running…' : 'Run Queue'}
					</button>
					{queueItems.length > 0 && (
						<div id="queueSummary" className="queue-summary">
							{Object.entries(statusCounts)
								.map(([status, count]) => `${status}: ${count}`)
								.join(' | ')}
						</div>
					)}
				</div>
			</div>
			{queueItems.length > 0 && (
				<ul id="queueList" className="queue-list">
					{queueItems.map((item, i) => (
						<li key={i} className={`queue-item queue-${item.status}`}>
							<div className="queue-item-main">
								<span className="queue-term">{item.term}</span>
								<span className="queue-status">{item.status}</span>
							</div>
							{item.detail && <span className="queue-detail">{item.detail}</span>}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
