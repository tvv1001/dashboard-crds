import React, { useState, useEffect } from 'react';
import { PanelHeader } from '../panel/PanelHeader';
import { StatusBox, type SelectionLogEntry } from '../panel/StatusBox';

interface FgDrawerProps {
	drawerOpen: boolean;
	setDrawerOpen: React.Dispatch<React.SetStateAction<boolean>>;

	// Search form props

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
	const [statusExpanded, setStatusExpanded] = useState(true);

	useEffect(() => {
		const stored = localStorage.getItem('fgDrawerStatusExpanded');
		if (stored !== null) {
			setStatusExpanded(stored === 'true');
		} else {
			if (window.innerWidth <= 720) {
				setStatusExpanded(false);
			} else {
				setStatusExpanded(true);
			}
		}
	}, []);

	const toggleStatusBox = () => {
		const nextState = !statusExpanded;
		setStatusExpanded(nextState);
		localStorage.setItem('fgDrawerStatusExpanded', String(nextState));
	};

	return (
		<aside className={`node-detail-drawer${drawerOpen ? ' open' : ''}`}>
			<div className='sidebar-header'>
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

				<div className='drawer-status-toggle'>
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
			</div>
		</aside>
	);
}
