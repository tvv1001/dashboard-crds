'use client';
import React from 'react';
import type { StatusConsoleState } from '../../types';
import { formatConsoleElapsed, formatConsoleTime } from '../../lib/format';
import { useEffect, useState } from 'react';

const IDLE_PHASES = new Set(['Idle', 'Complete', 'Complete with errors', 'Error']);

interface Props {
	status: StatusConsoleState;
}

export function StatusConsole({ status }: Props) {
	const [, tick] = useState(0);

	useEffect(() => {
		if (IDLE_PHASES.has(status.phase)) return;
		const id = setInterval(() => tick((n) => n + 1), 1000);
		return () => clearInterval(id);
	}, [status.phase]);

	// When idle, the old compact record-info bar ("last fetched") has been
	// removed — that information now lives in the top record-details row.
	if (IDLE_PHASES.has(status.phase)) {
		if (status.phase === 'Error' && status.lastError) {
			return (
				<div className='status-idle-bar'>
					<span className='status-idle-error'>{status.lastError}</span>
				</div>
			);
		}
		return null;
	}

	// Active crawl — show full console output
	const elapsed = formatConsoleElapsed(status.startedAt);
	const updatedTime = formatConsoleTime(status.updatedAt);
	const dl = status.downloaded;
	const up = status.updated;
	const rp = status.repaired;
	const uc = status.unchanged;

	const lines = [
		`last ${status.lastEvent}`,
		`match F:${status.finraMatches} S:${status.secMatches} | seeds ${status.seeds} | saved ${status.savedFiles} | sync +${dl}/~${up}/!${rp}/=${uc} | err ${status.errors}`,
		`target ${status.term} | crd ${status.currentCrd} | updated ${updatedTime}`,
		`> ${status.phase} | ${status.mode} | queue ${status.queue} | elapsed ${elapsed}`,
	];

	return <pre className="status-console">{lines.join('\n')}</pre>;
}
