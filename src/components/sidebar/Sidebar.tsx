'use client';
import React from 'react';
import type { GroupEntry, QueueItem, SortOrder } from '../../types';
import { QueueControl } from './QueueControl';
import { KeyList } from './KeyList';
import { RecentFetched } from './RecentFetched';
import Link from 'next/link';

interface Props {
	// Queue
	searchTerms: string;
	onSearchTermsChange: (v: string) => void;
	onRunQueue: () => void;
	isRunning: boolean;
	queueItems: QueueItem[];

	// Key list
	groups: GroupEntry[];
	seenKeys: Record<string, boolean>;
	activeKey: string;
	filter: string;
	onFilterChange: (f: string) => void;
	sortOrder: SortOrder;
	onSortChange: (s: SortOrder) => void;
	typeFilter: string;
	onTypeFilterChange: (t: string) => void;
	loadedCount: number;
	totalCount: number;
	isPartial: boolean;
	statusMsg: string;
	onSelectKey: (key: string) => void;

	// Unique CRD stats
	uniqueIndividualCrds: number;
	uniqueFirmCrds: number;
	uniqueTotalCrds: number;
	// Session stats
	sessionSaved: number;
	sessionUpdated: number;
}

export function Sidebar(props: Props) {
	const {
		searchTerms,
		onSearchTermsChange,
		onRunQueue,
		isRunning,
		queueItems,
		groups,
		seenKeys,
		activeKey,
		filter,
		onFilterChange,
		sortOrder,
		onSortChange,
		typeFilter,
		onTypeFilterChange,
		loadedCount,
		totalCount,
		isPartial,
		statusMsg,
		onSelectKey,
		uniqueIndividualCrds,
		uniqueFirmCrds,
		uniqueTotalCrds,
		sessionSaved,
		sessionUpdated,
	} = props;

	return (
		<aside className="sidebar" id="sidebar">
			{uniqueTotalCrds > 0 && (
				<div className="crd-stat-bar">
					<div className="crd-stat-item">
						<span className="crd-stat-label">People</span>
						<span className="crd-stat-value">{uniqueIndividualCrds.toLocaleString()}</span>
					</div>
					<div className="crd-stat-divider" />
					<div className="crd-stat-item">
						<span className="crd-stat-label">Firms</span>
						<span className="crd-stat-value">{uniqueFirmCrds.toLocaleString()}</span>
					</div>
					<div className="crd-stat-divider" />
					<div className="crd-stat-item crd-stat-total">
						<span className="crd-stat-label">Unique</span>
						<span className="crd-stat-value">{uniqueTotalCrds.toLocaleString()}</span>
					</div>

					{(sessionSaved > 0 || sessionUpdated > 0) && (
						<>
							<div className="crd-stat-divider" />
							<div className="crd-stat-item crd-stat-saved">
								<span className="crd-stat-label">Saved</span>
								<span className="crd-stat-value">+{sessionSaved.toLocaleString()}</span>
							</div>
							<div className="crd-stat-divider" />
							<div className="crd-stat-item crd-stat-updated">
								<span className="crd-stat-label">Updated</span>
								<span className="crd-stat-value">~{sessionUpdated.toLocaleString()}</span>
							</div>
						</>
					)}
				</div>
			)}
			<QueueControl
				value={searchTerms}
				onChange={onSearchTermsChange}
				onRun={onRunQueue}
				isRunning={isRunning}
				queueItems={queueItems}
			/>
			<KeyList
				groups={groups}
				seenKeys={seenKeys}
				activeKey={activeKey}
				filter={filter}
				onFilterChange={onFilterChange}
				sortOrder={sortOrder}
				onSortChange={onSortChange}
				typeFilter={typeFilter}
				onTypeFilterChange={onTypeFilterChange}
				loadedCount={loadedCount}
				totalCount={totalCount}
				isPartial={isPartial}
				statusMsg={statusMsg}
				uniqueTotalCrds={uniqueTotalCrds}
				onSelectKey={onSelectKey}
			/>
			<div className="sidebar-footer">
				<Link href="/insights" className="ai-qa-sidebar-link insights-link">
					📊 Insights
				</Link>
				<Link href="/ai-qa" className="ai-qa-sidebar-link">
					✨ AI Q&A
				</Link>
				<Link href="/explorer" className="ai-qa-sidebar-link">
					🔌 API
				</Link>
			</div>
		</aside>
	);
}
