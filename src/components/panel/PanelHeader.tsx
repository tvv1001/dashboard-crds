'use client';
import React, { useMemo } from 'react';
import { parseCrdKey } from '../../lib/parseKey';
import { extractNamesFromPayload, getContentBlock } from '../../lib/extractNames';
import { deriveStatusBadge, deriveTerminatedBadge, type RecordStatusBadge } from '../../lib/statusBadge';

interface Props {
	activeKey: string;
	payloads: { key: string }[];
	detailJson: string | null;
	onSelectKey: (key: string) => void;
}

export function PanelHeader({ activeKey, payloads, detailJson, onSelectKey }: Props) {
	const nameInfo = useMemo(() => {
		if (!activeKey || !detailJson) return null;
		const parsed = parseCrdKey(activeKey);
		if (!parsed) return null;
		try {
			const payload = JSON.parse(detailJson);
			if (payload && typeof payload === 'object' && payload.orphan && typeof payload.orphan === 'object') {
				const orphanName = typeof payload.orphan.name === 'string' ? payload.orphan.name : '';
				return { primary: orphanName, aliases: [] };
			}
			const content = getContentBlock(payload, parsed.source, parsed.type);
			return extractNamesFromPayload(content ?? payload, parsed.type as 'individual' | 'firm');
		} catch (e) {
			return null;
		}
	}, [activeKey, detailJson]);

	const statusBadgesBySource = useMemo(() => {
		if (!activeKey || !detailJson) return null;
		const parsed = parseCrdKey(activeKey);
		if (!parsed) return null;
		try {
			const payload = JSON.parse(detailJson);
			const sources = payload && typeof payload === 'object' ? payload.sources : null;
			const results: Array<{ source: 'FINRA' | 'SEC'; terminatedBadge: RecordStatusBadge; statusBadge: RecordStatusBadge }> = [];
			const deriveForContent = (content: Record<string, any>, source: 'finra' | 'sec') => {
				const bi = content?.basicInformation ?? {};
				const terminatedBadge = deriveTerminatedBadge([bi.firmStatus, bi.firmStatusDate], [content?.firmStatus, content?.firmStatusDate]);
				// Only use the scope field that actually belongs to this source —
				// bcScope (FINRA broker) and iaScope (SEC investment adviser) are
				// independent and often both present on the same basicInformation
				// block (e.g. a FINRA-only broker still has an iaScope of
				// "NotInScope"), so mixing them together would incorrectly mark an
				// Active FINRA broker as Inactive just because they're not SEC-
				// registered, or vice versa.
				const statusBadge = deriveStatusBadge(source === 'sec' ? bi.iaScope : bi.bcScope, content?.status, content?.currentStatus);
				return { terminatedBadge, statusBadge };
			};
			if (sources && typeof sources === 'object') {
				// Combined bundle: derive status separately per source so each pill can
				// be labeled with the source it actually came from.
				(['finra', 'sec'] as const).forEach((key) => {
					const sourceEntry = sources[key];
					const sourcePayload = sourceEntry?.payload ?? (typeof sourceEntry?.rawPayload === 'string' ? sourceEntry.rawPayload : null);
					if (sourcePayload == null) return;
					const content = (getContentBlock(sourcePayload, key, parsed.type) ?? sourcePayload) as Record<string, any>;
					const { terminatedBadge, statusBadge } = deriveForContent(content, key);
					if (terminatedBadge || statusBadge) results.push({ source: key.toUpperCase() as 'FINRA' | 'SEC', terminatedBadge, statusBadge });
				});
			} else {
				const content = (getContentBlock(payload, parsed.source, parsed.type) ?? payload) as Record<string, any>;
				const { terminatedBadge, statusBadge } = deriveForContent(content, parsed.source === 'sec' ? 'sec' : 'finra');
				if (terminatedBadge || statusBadge) results.push({ source: parsed.source.toUpperCase() as 'FINRA' | 'SEC', terminatedBadge, statusBadge });
			}
			return results;
		} catch {
			return null;
		}
	}, [activeKey, detailJson]);

	// Overall banner tint: gray when every source resolves to inactive/
	// terminated, yellow when sources disagree (e.g. active on FINRA but
	// terminated on SEC, or vice versa). Left as the default styling when
	// everything is active or no status could be derived.
	const bannerStatusVariant = useMemo(() => {
		if (!statusBadgesBySource || statusBadgesBySource.length === 0) return '';
		const resolved = statusBadgesBySource
			.map((entry) => {
				if (entry.terminatedBadge) return 'inactive';
				if (entry.statusBadge?.label === 'Active') return 'active';
				if (entry.statusBadge?.label === 'Inactive') return 'inactive';
				return '';
			})
			.filter(Boolean);
		if (!resolved.length) return '';
		const hasActive = resolved.includes('active');
		const hasInactive = resolved.includes('inactive');
		if (hasActive && hasInactive) return 'mixed';
		if (hasInactive && !hasActive) return 'inactive';
		return '';
	}, [statusBadgesBySource]);

	if (!activeKey) {
		return null;
	}

	const parsed = parseCrdKey(activeKey);
	if (!parsed) return null;
	const { type, crd } = parsed;

	return (
		<>
			<div className={`current-crd-banner ${bannerStatusVariant ? `current-crd-banner--${bannerStatusVariant}` : ''}`.trim()}>
				<div className='banner-context-row'>
					<span className={`record-side-badge ${type === 'firm' ? 'firm' : 'individual'}`}>{type.toUpperCase()}</span>
					<span className='banner-context-meta'>
						<span className='banner-context-meta-item'>
							<span className='banner-context-meta-label'>CRD</span>
							<span className='banner-context-meta-value'>{crd}</span>
						</span>
					</span>
					{statusBadgesBySource && statusBadgesBySource.length > 0 && (
						<span className='banner-context-status-tags'>
							{statusBadgesBySource.map((entry) => (
								<React.Fragment key={entry.source}>
									{entry.terminatedBadge && (
										<span className={`record-pill ${entry.terminatedBadge.className}`}>
											{entry.source}: {entry.terminatedBadge.label}
										</span>
									)}
									{entry.statusBadge && (
										<span className={`record-pill ${entry.statusBadge.className}`}>
											{entry.source}: {entry.statusBadge.label}
										</span>
									)}
								</React.Fragment>
							))}
						</span>
					)}
				</div>
				<div className='current-crd-label banner-header-row'>
					<div className='banner-title-stack'>
						<div className='current-crd-text'>
							<div className='current-crd-name-block'>
								<div className='current-crd-main-name'>{nameInfo?.primary || (type === 'individual' ? '' : '')}</div>
								{nameInfo?.primary && nameInfo.aliases[0] && (
									<div className='current-crd-meta-line'>
										<span className='crd-sub-label'>{nameInfo.aliases[0]}</span>
									</div>
								)}
							</div>
						</div>
					</div>
				</div>
			</div>
		</>
	);
}
