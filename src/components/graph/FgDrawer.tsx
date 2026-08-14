import React, { useState, useEffect } from 'react';
import { PanelHeader } from '../panel/PanelHeader';
import { StatusBox, type SelectionLogEntry } from '../panel/StatusBox';

interface FgDrawerProps {
	drawerOpen: boolean;
	setDrawerOpen: React.Dispatch<React.SetStateAction<boolean>>;

	// Search form props
	searchQuery: string;
	onSearchQueryChange: (q: string) => void;
	onSearchSubmit: (e: React.FormEvent) => void;
	searchDisabled: boolean;
	searchLoading: boolean;

	// Title / Roles
	showTitleAndRoles: boolean;
	panelTitle: string | null;
	panelRoleRows: string[];
	panelError?: string | null;

	// Panel Content
	panelActiveKey: string | null;
	panelDetailJson: any;
	panelLoading: boolean;

	// Callbacks
	onSelectKey: (key: string) => void;

	// Optional Selection Log props (used by chart)
	selectionLog?: SelectionLogEntry[];
	onClearSelectionLog?: () => void;
	onFocusSelectionLogEntry?: (entry: SelectionLogEntry) => void;
}

export function FgDrawer({
	drawerOpen,
	setDrawerOpen,
	searchQuery,
	onSearchQueryChange,
	onSearchSubmit,
	searchDisabled,
	searchLoading,
	showTitleAndRoles,
	panelTitle,
	panelRoleRows,
	panelError,
	panelActiveKey,
	panelDetailJson,
	panelLoading,
	onSelectKey,
	selectionLog,
	onClearSelectionLog,
	onFocusSelectionLogEntry,
}: FgDrawerProps) {

	return (
		<aside className={`node-detail-drawer${drawerOpen ? ' open' : ''}`}>
			<div className='sidebar-header'>
				<form
					className='fg-search'
					style={{ display: 'flex', width: '100%' }}
					onSubmit={onSearchSubmit}>
					<input
						className='fg-search-input'
						style={{ flex: 1, minWidth: 0 }}
						type='search'
						placeholder='firm, person, CRD/SEC#'
						value={searchQuery}
						onChange={(e) => onSearchQueryChange(e.target.value)}
						aria-label='Search firm, person, or CRD'
						autoComplete='off'
						disabled={searchDisabled}
					/>
					<button
						type='submit'
						className='fg-send-btn'
						aria-label='Search'
						disabled={searchDisabled || searchLoading}>
						➤
					</button>
				</form>

				{panelRoleRows.length > 0 && (
					<div className='role-rows'>
						{panelRoleRows.map((row) => (
							<div
								key={row}
								className='role-row'>
								<span className='role-dot' />
								{row}
							</div>
						))}
					</div>
				)}

				{panelError ?
					<p className='fg-panel-error'>{panelError}</p>
				:	null}
			</div>

			<div className='sidebar-content'>
				<PanelHeader
					activeKey={panelActiveKey || ''}
					payloads={[]}
					detailJson={panelDetailJson}
					onSelectKey={onSelectKey}
				/>

				<div className='drawer-status-content'>
					<StatusBox
							statusMsg={panelError || ''}
							statusHtml=''
							detailJson={panelDetailJson}
							panelLoading={panelLoading}
							activeKey={panelActiveKey || ''}
							fetchLog={[]}
							onClearLog={() => {}}
							onSelectKey={onSelectKey}
							selectionLog={selectionLog}
							onClearSelectionLog={onClearSelectionLog}
							onFocusSelectionLogEntry={onFocusSelectionLogEntry}
						/>
				</div>
			</div>
		</aside>
	);
}
