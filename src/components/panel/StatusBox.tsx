'use client';
import React, { useEffect, useMemo, useState } from 'react';
import { parseCrdKey } from '../../lib/parseKey';
import { bucketConnectionRows, extractConnectionRows, isCurrentConnectionRow } from './connectionData';
import { deriveStatusBadge, deriveTerminatedBadge, type RecordStatusBadge } from '../../lib/statusBadge';
import { toProperCaseName } from '../../lib/format';

/** Most-recent-first node selection row for the Log tab. */
export type SelectionLogEntry = {
	id: string;
	label: string;
	/** `Name :: CRD# n` or `Name :: CRD# n / SEC# m` */
	display: string;
	type?: 'individual' | 'firm' | 'unknown' | string;
	crd?: string;
	secNumber?: string | null;
	key?: string;
	ts?: number;
};

interface Props {
	statusMsg: string;
	statusHtml: string;
	detailJson: string | null;
	panelLoading: boolean;
	activeKey: string;
	fetchLog: string[];
	onClearLog: () => void;
	onSelectKey: (key: string) => void;
	/** Optional structured selection history (newest first). Prefer over plain fetchLog strings. */
	selectionLog?: SelectionLogEntry[];
	onClearSelectionLog?: () => void;
	onFocusSelectionLogEntry?: (entry: SelectionLogEntry) => void;
	hideTabs?: boolean;
	hideJsonTab?: boolean;
}

type DetailTab = 'info' | 'json' | 'log' | null;

function maybeParseJson(value: unknown): unknown {
	if (typeof value !== 'string') return value;
	const text = value.trim();
	if (!text) return null;
	if (!(text.startsWith('{') || text.startsWith('['))) return value;
	try {
		return JSON.parse(text);
	} catch {
		return value;
	}
}

function unwrapRecordPayload(input: unknown): any {
	const parsed = maybeParseJson(input);
	if (parsed == null || typeof parsed !== 'object') return parsed;
	if (Array.isArray(parsed)) return parsed;

	const payload = parsed as Record<string, unknown>;

	if (payload.finraBrokerCheck && typeof payload.finraBrokerCheck === 'object') {
		return unwrapRecordPayload(payload.finraBrokerCheck);
	}
	if (payload.secInvestmentAdvisor && typeof payload.secInvestmentAdvisor === 'object') {
		return unwrapRecordPayload(payload.secInvestmentAdvisor);
	}

	const firstHit = Array.isArray((payload.hits as any)?.hits) ? (payload.hits as any).hits[0] : null;
	if (firstHit && typeof firstHit === 'object') {
		const source = (firstHit as any)._source;
		if (source && typeof source === 'object') {
			if ((source as any).content != null) return unwrapRecordPayload((source as any).content);
			if ((source as any).iacontent != null) return unwrapRecordPayload((source as any).iacontent);
			return unwrapRecordPayload(source);
		}
		if ((firstHit as any).content != null) return unwrapRecordPayload((firstHit as any).content);
		if ((firstHit as any).iacontent != null) return unwrapRecordPayload((firstHit as any).iacontent);
	}

	if ((payload as any)._source && typeof (payload as any)._source === 'object') {
		const source = (payload as any)._source;
		if ((source as any).content != null) return unwrapRecordPayload((source as any).content);
		if ((source as any).iacontent != null) return unwrapRecordPayload((source as any).iacontent);
		return unwrapRecordPayload(source);
	}

	if ((payload as any).content != null) return unwrapRecordPayload((payload as any).content);
	if ((payload as any).iacontent != null) return unwrapRecordPayload((payload as any).iacontent);

	return payload;
}

function toArray(value: unknown): any[] {
	return Array.isArray(value) ? value : [];
}

function toText(value: unknown): string {
	if (value == null) return '';
	if (typeof value === 'string') return value.trim();
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	return '';
}

function normalizeStatusText(value: unknown): string {
	return toText(value)
		.toLowerCase()
		.replace(/[\s_-]+/g, ' ')
		.trim();
}

function formatAddress(value: unknown): string {
	if (!value) return '';
	if (typeof value === 'string') return value.trim();
	if (typeof value !== 'object' || Array.isArray(value)) return '';
	const address = value as Record<string, unknown>;
	const preferredKeys = ['address1', 'address2', 'address3', 'street1', 'street2', 'city', 'state', 'postalCode', 'zipCode', 'zip', 'country'];
	const parts: string[] = [];
	for (const key of preferredKeys) {
		const text = toText(address[key]);
		if (text) parts.push(text);
	}
	if (parts.length > 0) return parts.join(', ');
	return Object.values(address)
		.map((v) => toText(v))
		.filter(Boolean)
		.join(', ');
}

// Individuals don't carry a firm-level office address — their location comes
// from the branch office of their current employment(s). Prefer the branch
// flagged as "located at" (the individual's actual work location) and fall
// back to the first listed branch otherwise.
function extractCurrentBranchOfficeAddress(body: Record<string, any>): string {
	const employments = [...toArray(body?.currentEmployments), ...toArray(body?.currentIAEmployments)];
	for (const employment of employments) {
		const branches = toArray(employment?.branchOfficeLocations);
		const located = branches.find((b) => toText(b?.locatedAtFlag).toUpperCase() === 'Y') || branches[0];
		if (located) {
			const address = formatAddress(located);
			if (address) return address;
		}
	}
	return '';
}

function pickFirstNonEmpty(...values: unknown[]): string {
	for (const value of values) {
		const text = toText(value);
		if (text) return text;
	}
	return '';
}

function dedupeByLabel(items: any[]): any[] {
	const seen = new Set<string>();
	const out: any[] = [];
	for (const item of toArray(items)) {
		const label = [
			pickFirstNonEmpty(item.legalName, item.name, item.individualName, item.fullName, item.firmName, item.organizationName),
			pickFirstNonEmpty(item.position, item.currentRegistration, item.status, item.control),
			pickFirstNonEmpty(item.crdNumber, item.crd, item.firmId, item.firmID),
			pickFirstNonEmpty(item.effectiveDate, item.registrationDate, item.startDate),
		]
			.join('|')
			.trim();
		const key = label || JSON.stringify(item);
		if (!seen.has(key)) {
			seen.add(key);
			out.push(item);
		}
	}
	return out;
}

function normalizeDateForKey(value: unknown): string {
	const text = toText(value);
	if (!text) return '';
	const ms = Date.parse(text);
	return Number.isFinite(ms) ? String(ms) : text.toLowerCase().trim();
}

function buildRowMergeKey(item: any): string {
	// Name/status/jurisdiction are normalized (case + punctuation-insensitive)
	// so the same employment/registration reported by FINRA and SEC with
	// slightly different formatting still collapses into a single row.
	// Dates are normalized to a timestamp so "5/14/2026" vs "05/14/2026"
	// still match, while genuinely different date ranges (e.g. two separate
	// stints at the same firm) remain distinct.
	const label = [
		normalizeComparableText(pickFirstNonEmpty(item.legalName, item.name, item.individualName, item.fullName, item.firmName, item.organizationName)),
		normalizeComparableText(pickFirstNonEmpty(item.position, item.currentRegistration, item.status, item.control)),
		pickFirstNonEmpty(item.crdNumber, item.crd, item.firmId, item.firmID),
		normalizeDateForKey(pickFirstNonEmpty(item.effectiveDate, item.registrationDate, item.startDate, item.registrationBeginDate)),
		normalizeDateForKey(pickFirstNonEmpty(item.registrationEndDate, item.endDate)),
		normalizeComparableText(pickFirstNonEmpty(item.secJurisdiction, item.jurisdiction, item.state, item.sro)),
	]
		.join('|')
		.trim();
	return label || JSON.stringify(item);
}

function toSourceLabel(sources: Set<string>): string {
	const hasFinra = sources.has('FINRA');
	const hasSec = sources.has('SEC');
	if (hasFinra && hasSec) return 'FINRA+SEC';
	if (hasFinra) return 'FINRA';
	if (hasSec) return 'SEC';
	return 'UNKNOWN';
}

function collectOtherNames(...lists: unknown[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const list of lists) {
		for (const item of toArray(list)) {
			const value = toText(item);
			if (!value) continue;
			const normalized = value.toLowerCase();
			if (seen.has(normalized)) continue;
			seen.add(normalized);
			out.push(value);
		}
	}
	return out;
}

function renderOtherNames(names: string[]) {
	if (!names.length) return null;
	return (
		<div className='record-detail-other-names'>
			<span className='record-detail-other-names-label'>Other names</span>
			<div className='record-detail-other-names-list'>
				{names.map((name) => (
					<span
						className='record-detail-other-name'
						key={name}>
						{name}
					</span>
				))}
			</div>
		</div>
	);
}

function sourceTagClass(tag: unknown): string {
	const value = toText(tag).toUpperCase();
	if (value === 'FINRA') return 'record-detail-inline-tag--finra';
	if (value === 'SEC') return 'record-detail-inline-tag--sec';
	if (value === 'FINRA+SEC') return 'record-detail-inline-tag--both';
	return 'record-detail-inline-tag--unknown';
}

function normalizeComparableText(value: string): string {
	return value
		.toLowerCase()
		.replace(/[\s,.-]+/g, ' ')
		.trim();
}

function mergeSourceValues(finraValue: unknown, secValue: unknown): Array<{ value: string; sourceTag: 'FINRA' | 'SEC' | 'FINRA+SEC' }> {
	const finraText = toText(finraValue);
	const secText = toText(secValue);

	if (finraText && secText) {
		if (normalizeComparableText(finraText) === normalizeComparableText(secText)) {
			return [{ value: finraText, sourceTag: 'FINRA+SEC' }];
		}
		return [
			{ value: finraText, sourceTag: 'FINRA' },
			{ value: secText, sourceTag: 'SEC' },
		];
	}

	if (finraText) return [{ value: finraText, sourceTag: 'FINRA' }];
	if (secText) return [{ value: secText, sourceTag: 'SEC' }];
	return [];
}

function mergeWithSourceTag(entries: Array<{ source: 'FINRA' | 'SEC'; rows: any[] }>, labelSelector: (row: any) => string): any[] {
	const map = new Map<string, { row: any; sources: Set<string> }>();
	for (const entry of entries) {
		for (const row of toArray(entry.rows)) {
			const key = buildRowMergeKey(row);
			const existing = map.get(key);
			if (!existing) {
				map.set(key, { row, sources: new Set<string>([entry.source]) });
				continue;
			}
			existing.sources.add(entry.source);
		}
	}

	return Array.from(map.values())
		.map(({ row, sources }) => ({ ...row, __sourceTag: toSourceLabel(sources) }))
		.sort((a, b) => labelSelector(a).localeCompare(labelSelector(b)));
}

function mergeRegistrationRows(...lists: any[][]): any[] {
	const rows = dedupeByLabel(lists.flatMap((list) => toArray(list)));
	return rows.sort((a, b) => {
		const aLabel = pickFirstNonEmpty(a.secJurisdiction, a.jurisdiction, a.state, a.sro, a.status);
		const bLabel = pickFirstNonEmpty(b.secJurisdiction, b.jurisdiction, b.state, b.sro, b.status);
		return aLabel.localeCompare(bLabel);
	});
}

function mergeEmploymentRows(...lists: any[][]): any[] {
	const rows = dedupeByLabel(lists.flatMap((list) => toArray(list)));
	return rows.sort((a, b) => {
		const aLabel = pickFirstNonEmpty(a.legalName, a.name, a.individualName, a.fullName, a.firmName, a.organizationName);
		const bLabel = pickFirstNonEmpty(b.legalName, b.name, b.individualName, b.fullName, b.firmName, b.organizationName);
		return aLabel.localeCompare(bLabel);
	});
}

// Corporate-entity signal words. FINRA/SEC `directOwners`/connection rows use
// the same `legalName` field for both firms and people (e.g. parent
// companies AND directors/officers), so `legalName` alone can't be trusted
// as a "this is a firm" signal — a person's name like "BENDL, JOHN WESLEY"
// would otherwise be misclassified as a firm and link to the wrong CRD type.
const CORPORATE_NAME_SUFFIX_RE =
	/\b(INC|INCORPORATED|CORP|CORPORATION|LLC|LLP|LP|LTD|LIMITED|CO|COMPANY|GROUP|PLC|N\.?A\.?|BANK|TRUST|HOLDINGS?|PARTNERS?|SECURITIES|ADVISORS?|ADVISERS?|CAPITAL|FINANCIAL|ASSOCIATES?)\b\.?/i;

// Matches a "LASTNAME, FIRST MIDDLE" style personal name — a single leading
// word (the surname) followed by a comma and one to four short given-name
// words/initials, with no corporate suffix anywhere in the string.
function looksLikePersonalName(value: string): boolean {
	const text = value.trim();
	if (!text || CORPORATE_NAME_SUFFIX_RE.test(text)) return false;
	const match = text.match(/^([A-Za-z'-]+),\s*([A-Za-z][A-Za-z'.\-]*(?:\s+[A-Za-z][A-Za-z'.\-]*){0,3})$/);
	return Boolean(match);
}

// FINRA `directOwners`/`indirectOwners`/connection rows store personal names
// as "LASTNAME, FIRST MIDDLE" (all caps). Reorder those to "First Middle
// Last" (Title Case) to match how the rest of the app displays individuals
// (see extractNamesFromPayload, which builds names from
// firstName/middleName/lastName in that order). Corporate names are left in
// their original word order, just Title Cased.
function formatDisplayName(value: string): string {
	const text = value.trim();
	if (!text) return text;
	if (looksLikePersonalName(text)) {
		const match = text.match(/^([A-Za-z'-]+),\s*(.+)$/);
		if (match) return toProperCaseName(`${match[2]} ${match[1]}`);
	}
	return toProperCaseName(text);
}

function inferRowType(item: any, fallbackType: 'individual' | 'firm'): 'individual' | 'firm' {
	if (!item || typeof item !== 'object') return fallbackType;
	const explicitType = String(item.ownerType || item.entityType || item.type || '')
		.trim()
		.toLowerCase();
	if (explicitType === 'individual' || explicitType === 'ind' || explicitType === 'person') return 'individual';
	if (explicitType === 'firm' || explicitType === 'entity' || explicitType === 'organization' || explicitType === 'corporate') return 'firm';

	if (pickFirstNonEmpty(item.individualName, item.fullName, item.firstName, item.lastName, item.personCrd)) return 'individual';

	const nameCandidate = pickFirstNonEmpty(item.ownerName, item.legalName, item.name, item.organizationName, item.firmName);
	if (nameCandidate && looksLikePersonalName(nameCandidate)) return 'individual';

	if (item.firmName && !looksLikePersonalName(item.firmName)) return 'firm';
	if (item.organizationName && !looksLikePersonalName(item.organizationName)) return 'firm';

	return fallbackType;
}

// Sorts connection/owner rows A→Z by whichever display-name field is
// present, so "Current connections"/"Previous connections" lists render in
// alphabetical order rather than upstream API order.
function sortRowsByLabel(rows: any[]): any[] {
	return [...rows].sort((a, b) => {
		const aLabel = pickFirstNonEmpty(a.individualName, a.legalName, a.name, a.fullName, a.firmName, a.organizationName);
		const bLabel = pickFirstNonEmpty(b.individualName, b.legalName, b.name, b.fullName, b.firmName, b.organizationName);
		return aLabel.localeCompare(bLabel);
	});
}

function toDateMs(value: unknown): number {
	const text = toText(value);
	if (!text) return 0;
	const ms = Date.parse(text);
	return Number.isFinite(ms) ? ms : 0;
}

// Employment rows (currentEmployments/currentIAEmployments/previous*) carry
// their office location in branchOfficeLocations and their tenure in
// registrationBeginDate/registrationEndDate, distinct from the generic
// connection/registration fields used elsewhere in this file.
function getEmploymentAddress(item: any): string {
	const locations = Array.isArray(item?.branchOfficeLocations) ? item.branchOfficeLocations : [];
	const primary = locations.find((loc: any) => loc?.locatedAtFlag === 'Y') || locations[0];
	const fromLocation = formatAddress(primary);
	if (fromLocation) return fromLocation;
	return formatAddress({ city: item?.city, state: item?.state, country: item?.country });
}

function getEmploymentDateRangeText(item: any): string {
	// Match finra-data-chart-next-02 individual sidebar: "start → present".
	const start = pickFirstNonEmpty(item.registrationBeginDate, item.effectiveDate, item.startDate, item.start);
	const end = pickFirstNonEmpty(item.registrationEndDate, item.endDate, item.end);
	if (start && end) return `${start} → ${end}`;
	if (start) return `${start} → present`;
	if (end) return `– → ${end}`;
	return '';
}

function getEmploymentScopeTags(item: any): string[] {
	const tags: string[] = [];
	const role = pickFirstNonEmpty(item.role, item.regScope, item.scope, item.iaOnlyFlag === 'Y' ? 'IA' : '', item.bdOnlyFlag === 'Y' ? 'BD' : '');
	if (role) tags.push(role);
	const status = pickFirstNonEmpty(item.employmentStatus, item.status, item.currentRegistration);
	if (status && !/^(active|current|approved)$/i.test(status)) tags.push(status);
	const position = pickFirstNonEmpty(item.position, item.title);
	if (position && !tags.some((t) => t.toLowerCase() === position.toLowerCase())) tags.push(position);
	return tags;
}

function getEmploymentSortMs(item: any): number {
	const endMs = toDateMs(item.registrationEndDate) || toDateMs(item.endDate) || toDateMs(item.end);
	if (endMs) return endMs;
	return toDateMs(item.registrationBeginDate) || toDateMs(item.effectiveDate) || toDateMs(item.startDate) || toDateMs(item.start);
}

// Adds an address + date subtitle to each employment row and orders the list
// most-recent-first (by end date, falling back to start date for open-ended/
// current employments). Mirrors reference timeline: dates, office, scope tags.
function decorateEmploymentItems(rows: any[]): any[] {
	return rows
		.map((row) => {
			const address = getEmploymentAddress(row);
			const dateText = getEmploymentDateRangeText(row);
			const scopeTags = getEmploymentScopeTags(row);
			const parts = [dateText, address, scopeTags.length ? scopeTags.join(' · ') : ''].filter(Boolean);
			return {
				...row,
				// Prefer firmName so person employment rows show the firm, not a person name field.
				firmName: pickFirstNonEmpty(row.firmName, row.organizationName, row.legalName, row.name),
				__subtitleOverride: parts.join(' · '),
				__employmentSortMs: getEmploymentSortMs(row),
			};
		})
		.sort((a, b) => b.__employmentSortMs - a.__employmentSortMs);
}

// Firm payloads (from the FINRA/SEC APIs) never include a reverse list of
// their employees — that relationship only exists by scanning every saved
// individual payload's employment history (see pages/api/_graphIndex.ts).
// Fetch it here via the read-only graph-expansion endpoint so firm detail
// views can show current/previous person connections.
function connectionRowFromEntry(entry: any): any {
	const crd = pickFirstNonEmpty(entry?.individualId, entry?.personCrd, entry?.crd, entry?.crdNumber);
	const name = pickFirstNonEmpty(entry?.name, entry?.personName, entry?.individualName, entry?.label);
	const startDate = pickFirstNonEmpty(entry?.startDate, entry?.registrationBeginDate);
	const endDate = pickFirstNonEmpty(entry?.endDate, entry?.registrationEndDate);
	const dateText = startDate && endDate ? `${startDate} – ${endDate}` : startDate || endDate;
	return {
		individualName: name,
		name,
		crd,
		crdNumber: crd,
		individualId: crd,
		relationship: entry?.relationship,
		__subtitleOverride: pickFirstNonEmpty(entry?.__subtitleOverride, dateText, entry?.relationship),
	};
}

// Keys that are internal UI/booking flags rather than human-readable disclosure
// narrative content, so they're excluded from the rendered detail card.
const DISCLOSURE_DETAIL_SKIP_KEYS = new Set(['DisplayAAOLinkIfExists', 'part2ExemptFlag']);

function humanizeDisclosureDetailKey(key: string): string {
	// Already-spaced labels (e.g. "Damage Amount Requested") are left as-is;
	// camelCase-ish keys (e.g. "arbitrationDocketNumber") get spaced out.
	if (/\s/.test(key)) return key;
	return key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
}

function formatDisclosureDetailValue(value: unknown): string[] {
	if (Array.isArray(value)) return value.map((v) => toText(v)).filter(Boolean);
	const text = toText(value);
	return text ? [text] : [];
}

function extractDisclosureDetailEntries(detail: unknown): Array<{ label: string; values: string[] }> {
	if (!detail || typeof detail !== 'object') return [];
	return Object.entries(detail as Record<string, unknown>)
		.filter(([key]) => !DISCLOSURE_DETAIL_SKIP_KEYS.has(key))
		.map(([key, value]) => ({ label: humanizeDisclosureDetailKey(key), values: formatDisclosureDetailValue(value) }))
		.filter((entry) => entry.values.length > 0);
}

// Renders full disclosure narratives (allegations, damage/settlement amounts,
// broker comments, etc.) from FINRA and/or SEC in orange-highlighted cards,
// since the summary counts elsewhere don't surface this detail content. When a
// disclosure carries no narrative detail, the card body shows a link to the
// official Detailed Report (FINRA) or AdvisorInfo Summary (SEC) instead of a
// dead-end "no info" message, so there's a single unified card rather than a
// separate follow-up note.
function DisclosureDetailCards({
	title,
	items,
	crd,
	type,
	hasFinra,
	hasSec,
}: {
	title: string;
	items: any[];
	crd?: string;
	type?: 'individual' | 'firm';
	hasFinra?: boolean;
	hasSec?: boolean;
}) {
	if (!items.length) return null;
	const reportUrl = crd && type ? `https://files.brokercheck.finra.org/${type}/${type}_${crd}.pdf` : '';
	const secSummaryUrl = crd && type ? `https://adviserinfo.sec.gov/${type}/summary/${crd}` : '';
	const secAdvReportUrl = crd && type === 'firm' ? `https://reports.adviserinfo.sec.gov/reports/ADV/${crd}/PDF/${crd}.pdf` : '';
	const footerNote =
		hasFinra && reportUrl ?
			<>
				For details of these disclosures as well as disclosures involving non-registered affiliated entities refer to the Detailed Report{' '}
				<a
					className='disclosure-detail-footer-link'
					href={reportUrl}
					target='_blank'
					rel='noopener noreferrer'>
					↗ FINRA Detailed Report (PDF)
				</a>
				. For disclosures involving registered affiliated entities visit the BrokerCheck page for those firms.
			</>
		: !hasFinra && hasSec && secSummaryUrl ?
			<>
				For disclosure details, open the{' '}
				<a
					className='disclosure-detail-footer-link'
					href={secSummaryUrl}
					target='_blank'
					rel='noopener noreferrer'>
					↗ SEC AdvisorInfo Summary
				</a>
				{secAdvReportUrl ?
					<>
						{' '}
						or the{' '}
						<a
							className='disclosure-detail-footer-link'
							href={secAdvReportUrl}
							target='_blank'
							rel='noopener noreferrer'>
							↗ Latest Form ADV filed (PDF)
						</a>
					</>
				:	null}{' '}
				for this record.
			</>
		:	null;
	let footerRendered = false;
	return (
		<section className='record-detail-section'>
			<h4 className='record-detail-section-title'>{title}</h4>
			<div className='disclosure-detail-list'>
				{items.map((item, index) => {
					const entries = extractDisclosureDetailEntries(item.disclosureDetail);
					const showFooterHere = entries.length === 0 && footerNote && !footerRendered;
					if (showFooterHere) footerRendered = true;
					return (
						<div
							className='disclosure-detail-card disclosure-card-item'
							key={`disclosure-detail-${index}-${item.eventDate || ''}-${item.disclosureType || ''}`}>
							<div className='disclosure-detail-card-header'>
								<span className='disclosure-detail-card-title'>{pickFirstNonEmpty(item.disclosureType, `Disclosure ${index + 1}`)}</span>
							</div>
							<div className='disclosure-detail-card-meta'>
								{item.eventDate ?
									<span>Event date: {String(item.eventDate)}</span>
								:	null}
								{item.disclosureResolution ?
									<span>Resolution: {String(item.disclosureResolution)}</span>
								:	null}
							</div>
							{entries.length ?
								<div className='disclosure-detail-card-body'>
									{entries.map((entry, entryIndex) => (
										<div
											className='disclosure-detail-field'
											key={`disclosure-detail-${index}-field-${entryIndex}`}>
											<span className='disclosure-detail-field-label'>{entry.label}: </span>
											<span className='disclosure-detail-field-value'>{entry.values.join(' — ')}</span>
										</div>
									))}
								</div>
							: showFooterHere ?
								<div className='disclosure-detail-card-body disclosure-detail-card-footer-note'>{footerNote}</div>
							:	null}
						</div>
					);
				})}
			</div>
		</section>
	);
}

function isEmptyRawValue(value: unknown): boolean {
	if (value === null || value === undefined) return true;
	if (typeof value === 'string') return value.trim() === '';
	if (Array.isArray(value)) return value.length === 0;
	if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length === 0;
	return false;
}

// Top-level (and basicInformation-nested) keys that already have a dedicated,
// curated rendering elsewhere on the page. Everything else falls through to
// the generic "Additional details" section below so no field silently
// disappears from view.
const RAW_TOP_LEVEL_SKIP_KEYS = new Set([
	'basicInformation',
	'firmAddressDetails',
	'iaFirmAddressDetails',
	'disclosures',
	'directOwners',
	'registrationStatus',
	'registeredSROs',
	'registeredStates',
	'registrations',
	'currentConnections',
	'noticeFilings',
	'accountantSurpriseExams',
	'previousConnections',
	'currentEmployments',
	'currentIAEmployments',
	'previousEmployments',
	'previousIAEmployments',
	'otherNames',
	'aliases',
	'firstNm',
	'lastNm',
	'midNm',
	'sufNm',
	'indvlNm',
	'name',
	'fullName',
	'individualName',
	'firstName',
	'middleName',
	'lastName',
	'nameSuffix',
	'orgScopeStatusFlags',
	'compilationData',
	'brochures',
	'bdDisclosureFlag',
	'iaDisclosureFlag',
	'stateExamCategory',
	'productExamCategory',
	'principalExamCategory',
	'stateExams',
	'productExams',
	'principalExams',
	'exams',
	'brokerDetails',
	'hasBCComments',
	'hasBcComments',
	'hasIAComments',
	'hasIaComments',
	'bcComments',
	'iaComments',
	'legacyReportStatusDescription',
	'legacyReportStatusDesc',
]);

const RAW_BASIC_INFO_SKIP_KEYS = new Set([
	'firmId',
	'individualId',
	'firmName',
	'iaFirmName',
	'fullName',
	'individualName',
	'otherNames',
	'aliases',
	'firstNm',
	'lastNm',
	'midNm',
	'sufNm',
	'indvlNm',
	'name',
	'firstName',
	'middleName',
	'lastName',
	'nameSuffix',
	'formedDate',
	'firmType',
	'regulator',
	'districtName',
	'fiscalMonthEndCode',
	'legacyReportStatus',
	'iaSECNumber',
	'bdSECNumber',
	'iaSECNumberType',
	'crdNumber',
	'bcScope',
	'iaScope',
	'isLegacy',
	'finraRegistered',
	'formedState',
	'firmStatus',
	'firmStatusDate',
	'bdDisclosureFlag',
	'iaDisclosureFlag',
	'advFilingDate',
	'hasPdf',
	'brokerDetails',
	'hasBCComments',
	'hasBcComments',
	'hasIAComments',
	'hasIaComments',
	'bcComments',
	'iaComments',
	'legacyReportStatusDescription',
	'legacyReportStatusDesc',
]);

// Renders any object/array field generically as a "label: value" row (or a
// nested grid/card set for objects/arrays-of-objects), so fields that don't
// have a curated section (e.g. noticeFilings, compilationData,
// exemptReportingAdvisers, orgScopeStatusFlags, brochures) still surface.
function RawFieldRow({ label, value, compact = false }: { label: string; value: unknown; compact?: boolean }) {
	if (isEmptyRawValue(value)) return null;
	const labelLower = label.toLowerCase();
	const isStateExam = labelLower.includes('state exam');
	const isProductExam = labelLower.includes('product exam');
	const isPrincipalExam = labelLower.includes('principal exam');
	const isExamGroup = labelLower.includes('exam');

	const cardVariantClass =
		isStateExam ? 'exam-card-state'
		: isProductExam ? 'exam-card-product'
		: isPrincipalExam ? 'exam-card-principal'
		: isExamGroup ? 'exam-card-generic'
		: '';

	if (Array.isArray(value)) {
		const isObjectArray = value.some((v) => v && typeof v === 'object' && !Array.isArray(v));
		if (!isObjectArray) {
			return compact ?
					<div className='raw-field-list-item'>
						<span className='raw-field-list-label'>{label}:</span>
						<span className='raw-field-list-value'>
							{value
								.map((v) => toText(v))
								.filter(Boolean)
								.join(', ')}
						</span>
					</div>
				:	<div>
						<strong>{label}:</strong>{' '}
						{value
							.map((v) => toText(v))
							.filter(Boolean)
							.join(', ')}
					</div>;
		}
		return compact ?
				<div className='raw-field-list-group'>
					<div className='raw-field-list-item'>
						<span className='raw-field-list-label'>{label}:</span>
					</div>
					{value.map((item, index) => {
						const entries = extractDisclosureDetailEntries(item);
						return (
							<div
								className='raw-field-list-item'
								key={`${label}-${index}`}>
								<span className='raw-field-list-value'>
									{entries.length ? entries.map((entry, entryIndex) => `${entry.label}: ${entry.values.join(' — ')}`).join(' • ') : toText(item)}
								</span>
							</div>
						);
					})}
				</div>
			:	<div className='raw-field-group'>
					<div className='raw-field-group-label'>{label}</div>
					<div className={`disclosure-detail-list ${label === 'Notice Filings' || isExamGroup ? 'disclosure-detail-list-compact' : ''}`}>
						{value.map((item, index) => {
							const entries = extractDisclosureDetailEntries(item);
							return (
								<div
									className={`disclosure-detail-card ${cardVariantClass}`.trim()}
									key={`${label}-${index}`}>
									<div className='disclosure-detail-card-body'>
										{entries.length ?
											entries.map((entry, entryIndex) => (
												<div
													className='disclosure-detail-field'
													key={`${label}-${index}-${entryIndex}`}>
													<span className='disclosure-detail-field-label'>{entry.label}: </span>
													<span className='disclosure-detail-field-value'>{entry.values.join(' — ')}</span>
												</div>
											))
										:	toText(item)}
									</div>
								</div>
							);
						})}
					</div>
				</div>;
	}
	if (typeof value === 'object') {
		const entries = extractDisclosureDetailEntries(value);
		if (!entries.length) return null;
		return compact ?
				<div className='raw-field-list-group'>
					{entries.map((entry, index) => (
						<div
							className='raw-field-list-item'
							key={`${label}-${index}`}>
							<span className='raw-field-list-label'>{entry.label}:</span>
							<span className='raw-field-list-value'>{entry.values.join(', ')}</span>
						</div>
					))}
				</div>
			:	<div className='raw-field-group'>
					<div className='raw-field-group-label'>{label}</div>
					<div className='record-detail-grid'>
						{entries.map((entry, index) => (
							<div key={`${label}-${index}`}>
								<strong>{entry.label}:</strong> {entry.values.join(', ')}
							</div>
						))}
					</div>
				</div>;
	}
	const text = toText(value);
	if (!text) return null;
	return compact ?
			<div className='raw-field-list-item'>
				<span className='raw-field-list-label'>{label}:</span>
				<span className='raw-field-list-value'>{text}</span>
			</div>
		:	<div>
				<strong>{label}:</strong> {text}
			</div>;
}

// Surfaces every remaining field from a source payload that isn't already
function AccountantSurpriseExamsSection({ exams }: { exams: any[] }) {
	if (!exams || !exams.length) return null;
	return (
		<section className='record-detail-section record-detail-section--sec'>
			<h4 className='record-detail-section-title'>
				Accountant Surprise Exams ({exams.length})<span className='record-detail-inline-tag record-detail-inline-tag--sec'>SEC</span>
			</h4>
			<div className='disclosure-detail-list'>
				{exams.map((exam, index) => (
					<div
						className='disclosure-detail-card disclosure-card-item'
						key={`exam-${index}`}>
						<div className='disclosure-detail-card-header'>
							<span className='disclosure-detail-card-title'>{exam.accountantFirmName || 'Unknown Accountant Firm'}</span>
						</div>
						<div className='disclosure-detail-card-meta'>
							{exam.filingDate ?
								<span>Filing Date: {exam.filingDate}</span>
							:	null}
							{exam.fileStatus ?
								<span>File Status: {exam.fileStatus}</span>
							:	null}
							{exam.encryptedFilingID ?
								<span>Encrypted ID: {exam.encryptedFilingID}</span>
							:	null}
						</div>
					</div>
				))}
			</div>
		</section>
	);
}

function NoticeFilingsSection({ filings }: { filings: any[] }) {
	if (!filings || !filings.length) return null;
	return (
		<section className='record-detail-section record-detail-section--sec'>
			<h4 className='record-detail-section-title'>
				Notice Filings ({filings.length})<span className='record-detail-inline-tag record-detail-inline-tag--sec'>SEC</span>
			</h4>
			<div className='disclosure-detail-list'>
				{filings.map((filing, index) => (
					<div
						className='disclosure-detail-card disclosure-card-item'
						key={`notice-filing-${index}`}>
						<div className='disclosure-detail-card-header'>
							<span className='disclosure-detail-card-title'>{filing.jurisdiction || 'Unknown Jurisdiction'}</span>
						</div>
						<div className='disclosure-detail-card-meta'>
							{filing.status ?
								<span>Status: {filing.status}</span>
							:	null}
							{filing.effectiveDate ?
								<span>Effective: {filing.effectiveDate}</span>
							:	null}
						</div>
					</div>
				))}
			</div>
		</section>
	);
}

// covered by a curated section, so nothing in the raw FINRA/SEC JSON is
// silently hidden from the UI (e.g. noticeFilings, compilationData,
// exemptReportingAdvisers, orgScopeStatusFlags, brochures, accountantSurpriseExams).
function RawFieldGroups({ title, body, source }: { title: string; body: Record<string, any> | undefined; source?: 'finra' | 'sec' }) {
	if (!body || typeof body !== 'object') return null;
	const basic = body.basicInformation && typeof body.basicInformation === 'object' ? body.basicInformation : {};
	const basicEntries = Object.entries(basic).filter(([key, value]) => !RAW_BASIC_INFO_SKIP_KEYS.has(key) && !isEmptyRawValue(value));
	const topEntries = Object.entries(body).filter(([key, value]) => !RAW_TOP_LEVEL_SKIP_KEYS.has(key) && !isEmptyRawValue(value));
	if (!basicEntries.length && !topEntries.length) return null;
	const sourceClass = source ? `record-detail-section--${source}` : '';
	return (
		<section className={`record-detail-section ${sourceClass}`.trim()}>
			<h4 className='record-detail-section-title'>
				{title}
				{source ?
					<span className={`record-detail-inline-tag ${sourceTagClass(source === 'finra' ? 'FINRA' : 'SEC')}`}>{source === 'finra' ? 'FINRA' : 'SEC'}</span>
				:	null}
			</h4>
			<div className='raw-field-list'>
				{basicEntries.map(([key, value]) => (
					<RawFieldRow
						key={`raw-basic-${key}`}
						label={humanizeDisclosureDetailKey(key)}
						value={value}
						compact
					/>
				))}
				{topEntries.map(([key, value]) => (
					<RawFieldRow
						key={`raw-top-${key}`}
						label={humanizeDisclosureDetailKey(key)}
						value={value}
						compact
					/>
				))}
			</div>
		</section>
	);
}

function DetailList({
	title,
	items,
	onSelectKey,
	fallbackType,
	hideSourceTag,
	muted,
}: {
	title: string;
	items: any[];
	onSelectKey?: (key: string) => void;
	fallbackType: 'individual' | 'firm';
	hideSourceTag?: boolean;
	muted?: boolean;
}) {
	if (!items.length) return null;
	return (
		<section className={`record-detail-section ${muted ? 'record-detail-section-muted' : ''}`}>
			<h4 className='record-detail-section-title'>{title}</h4>
			<div className='record-detail-list'>
				{items.map((item, index) => {
					// Employment rows: firm name first (reference timeline). People rows keep person name first.
					const rawTitleText =
						fallbackType === 'firm' ?
							pickFirstNonEmpty(item.firmName, item.organizationName, item.legalName, item.name, item.individualName, item.fullName, item.disclosureType)
						:	pickFirstNonEmpty(item.legalName, item.name, item.individualName, item.fullName, item.firmName, item.organizationName, item.disclosureType);
					const titleText = rawTitleText ? formatDisplayName(rawTitleText) : rawTitleText;
					const crd = pickFirstNonEmpty(item.crdNumber, item.crd, item.individualId, item.personCrd, item.firmId, item.firmID, item.firmCrd);
					const secNo = pickFirstNonEmpty(item.bdSecNumber, item.bdSECNumber, item.iaSECNumber, item.secNumber);
					const subtitle =
						item.__subtitleOverride || pickFirstNonEmpty(item.position, item.currentRegistration, item.status, item.control, item.effectiveDate, item.disclosureCount);
					const currentEmployer = pickFirstNonEmpty(item.currentEmployer, item.currentFirmName);
					const rowType = inferRowType(item, fallbackType);
					const canSelect = Boolean(crd && onSelectKey);
					// Prefer finra: keys — matches dashboard/chart activate paths and BrokerCheck CRDs.
					const selectionKey = canSelect ? `finra:${rowType}:${crd}` : '';
					return (
						<div
							className={`record-detail-item ${muted ? 'record-detail-item--previous' : ''} ${canSelect ? 'record-detail-item-clickable' : ''}`}
							key={`${title}-${index}-${titleText}-${crd}`}
							onClick={() => {
								if (!canSelect || !onSelectKey) return;
								onSelectKey(selectionKey);
							}}
							onKeyDown={(e) => {
								if (!canSelect || !onSelectKey) return;
								if (e.key === 'Enter' || e.key === ' ') {
									e.preventDefault();
									onSelectKey(selectionKey);
								}
							}}
							role={canSelect ? 'button' : undefined}
							tabIndex={canSelect ? 0 : undefined}
							aria-label={canSelect ? `Open CRD ${crd}` : undefined}>
							<div className='record-detail-item-title'>
								{titleText || 'Record'}
								{crd ?
									<button
										type='button'
										className='record-detail-inline-tag record-detail-inline-tag-button'
										onClick={(e) => {
											e.stopPropagation();
											if (!onSelectKey) return;
											onSelectKey(selectionKey);
										}}>
										{rowType === 'firm' ? 'Firm CRD#' : 'Individual CRD#'}
										{crd}
									</button>
								:	null}
								{secNo ?
									<span className='record-detail-inline-tag record-detail-inline-tag--sec'>SEC#{secNo}</span>
								:	null}
								{!hideSourceTag && item.__sourceTag ?
									<span className={`record-detail-inline-tag ${sourceTagClass(item.__sourceTag)}`}>{String(item.__sourceTag)}</span>
								:	null}
							</div>
							{subtitle ?
								<div className='record-detail-item-subtitle'>{String(subtitle)}</div>
							:	null}
							{currentEmployer ?
								<div className='record-detail-item-subtitle record-detail-item-subtitle--employer'>Now at {formatDisplayName(currentEmployer)}</div>
							:	null}
						</div>
					);
				})}
			</div>
		</section>
	);
}

// Simple chip/tag list section — used for flat string lists (e.g. registered
// states, registered SROs) that don't need the full clickable
// record-detail-item card treatment DetailList provides.
function TagListSection({ title, tags }: { title: string; tags: string[] }) {
	if (!tags.length) return null;
	return (
		<section className='record-detail-section'>
			<h4 className='record-detail-section-title'>{title}</h4>
			<div className='record-detail-tag-list'>
				{tags.map((tag) => (
					<span
						className='record-detail-inline-tag'
						key={tag}>
						{tag}
					</span>
				))}
			</div>
		</section>
	);
}

function ExamCategoryCardsSection({ title, items, variant }: { title: string; items: any[]; variant: 'state' | 'product' | 'principal' | 'generic' }) {
	if (!items || !items.length) return null;
	const variantClass =
		variant === 'state' ? 'exam-card-state'
		: variant === 'product' ? 'exam-card-product'
		: variant === 'principal' ? 'exam-card-principal'
		: 'exam-card-generic';

	const variantBadgeClass =
		variant === 'state' ? 'exam-badge-state'
		: variant === 'product' ? 'exam-badge-product'
		: variant === 'principal' ? 'exam-badge-principal'
		: 'exam-badge-generic';

	const icon =
		variant === 'state' ? '🏛️'
		: variant === 'product' ? '📜'
		: variant === 'principal' ? '⭐'
		: '🎓';

	return (
		<section className='record-detail-section'>
			<h4 className='record-detail-section-title'>
				<span className='exam-section-icon'>{icon}</span> {title} ({items.length})
			</h4>
			<div className='disclosure-detail-list disclosure-detail-list-compact'>
				{items.map((item, index) => {
					const code = pickFirstNonEmpty(item.examCategory, item.examCode, item.category, item.examName);
					const name = pickFirstNonEmpty(item.examName, item.description, item.categoryName);
					const date = pickFirstNonEmpty(item.examTakenDate, item.dateTaken, item.takenDate, item.date);
					const scope = pickFirstNonEmpty(item.examScope, item.scope);

					return (
						<div
							className={`disclosure-detail-card ${variantClass}`}
							key={`exam-${title}-${index}`}>
							<div className='disclosure-detail-card-header'>
								<span className={`exam-category-pill ${variantBadgeClass}`}>{code || 'Exam'}</span>
								{date ?
									<span className='exam-card-date'>📅 {String(date)}</span>
								:	null}
							</div>
							{name && name !== code ?
								<div className='exam-card-name'>{String(name)}</div>
							:	null}
							{scope ?
								<div className='exam-card-scope'>Scope: {String(scope)}</div>
							:	null}
						</div>
					);
				})}
			</div>
		</section>
	);
}

// Rendered when a CRD has no live BrokerCheck/SEC record of its own — it was
// only ever seen as a directOwners/indirectOwners entry scraped from a
// firm's own detail payload (see findOwnerReference in pages/api/_graphIndex.ts).
// FINRA/SEC "profile" links point at the parent firm's summary page instead
// of a dead individual/summary/<crd> URL, since none exists upstream.
function OrphanRecordView({
	crd,
	orphan,
	onSelectKey,
}: {
	crd: string;
	orphan: {
		name: string;
		position?: string;
		parentType: 'firm' | 'individual';
		parentCrd: string;
		firmName?: string;
		officeAddress?: unknown;
		mailingAddress?: unknown;
		phone?: string;
		city?: string;
		state?: string;
	};
	onSelectKey: (key: string) => void;
}) {
	const officeAddress = formatAddress(orphan.officeAddress) || (orphan.city && orphan.state ? `${orphan.city}, ${orphan.state}` : '');
	const mailingAddress = formatAddress(orphan.mailingAddress);
	const phone = String(orphan.phone || '').trim();
	const employmentItems =
		orphan.parentType === 'firm' ?
			[
				{
					firmName: orphan.firmName || `Firm CRD#${orphan.parentCrd}`,
					crdNumber: orphan.parentCrd,
					position: orphan.position,
				},
			]
		:	[
				{
					individualName: orphan.name || `Individual CRD#${orphan.parentCrd}`,
					crdNumber: orphan.parentCrd,
				},
			];
	return (
		<div className='record-detail-wrapper'>
			<div className='record-detail-view'>
				{officeAddress || mailingAddress || phone ?
					<section className='record-detail-hero'>
						<div className='record-detail-grid'>
							{officeAddress ?
								<div>
									<strong>Main Address:</strong> {officeAddress}
								</div>
							:	null}
							{mailingAddress && mailingAddress !== officeAddress ?
								<div>
									<strong>Mailing:</strong> {mailingAddress}
								</div>
							:	null}
							{phone ?
								<div>
									<strong>Phone:</strong> {phone}
								</div>
							:	null}
						</div>
					</section>
				:	<section className='record-detail-hero'></section>}
				<section className='record-detail-section'>
					<h4 className='record-detail-section-title'>Profile links</h4>
					<div className='banner-context-links profile-links-section'>
						<a
							className='profile-link finra-link'
							href={
								orphan.parentType === 'individual' ?
									`https://brokercheck.finra.org/individual/summary/${orphan.parentCrd}`
								:	`https://brokercheck.finra.org/firm/summary/${orphan.parentCrd}`
							}
							target='_blank'
							rel='noopener noreferrer'>
							FINRA profile ↗
						</a>
						<a
							className='profile-link sec-link'
							href={
								orphan.parentType === 'individual' ?
									`https://adviserinfo.sec.gov/individual/summary/${orphan.parentCrd}`
								:	`https://adviserinfo.sec.gov/firm/summary/${orphan.parentCrd}`
							}
							target='_blank'
							rel='noopener noreferrer'>
							SEC profile ↗
						</a>
					</div>
				</section>
				<section className='record-detail-section'>
					<h4 className='record-detail-section-title'>General information</h4>
					<div className='record-detail-grid'>
						{orphan.name ?
							<div>
								<strong>{orphan.parentType === 'individual' ? 'Parent Name:' : 'Name:'}</strong> {orphan.name}
							</div>
						:	null}
						<div>
							<strong>{orphan.parentType === 'individual' ? 'Firm CRD:' : 'Individual CRD:'}</strong> {crd}
						</div>
						{orphan.position ?
							<div>
								<strong>Position:</strong> {orphan.position}
							</div>
						:	null}
						{orphan.firmName ?
							<div>
								<strong>{orphan.parentType === 'individual' ? 'Firm Name:' : 'Affiliated Firm:'}</strong> {orphan.firmName}
							</div>
						:	null}
						{orphan.parentCrd ?
							<div>
								<strong>{orphan.parentType === 'individual' ? 'Parent Individual CRD:' : 'Parent Firm CRD:'}</strong>{' '}
								<button
									type='button'
									className='record-detail-inline-tag record-detail-inline-tag-button'
									onClick={() => onSelectKey(`finra:${orphan.parentType}:${orphan.parentCrd}`)}>
									{orphan.parentType === 'individual' ? `Individual #${orphan.parentCrd}` : `Firm #${orphan.parentCrd}`}
								</button>
							</div>
						:	null}
					</div>
				</section>
				<DetailList
					title={orphan.parentType === 'individual' ? `Employment reference (1)` : `Current registration (1)`}
					items={employmentItems}
					onSelectKey={onSelectKey}
					fallbackType={orphan.parentType === 'individual' ? 'individual' : 'firm'}
				/>
				<section className='record-detail-section'>
					<div className='record-detail-empty'>
						No independent BrokerCheck/SEC record exists for CRD {crd}. This {orphan.parentType === 'individual' ? 'firm' : 'person'} was scraped from{' '}
						<button
							type='button'
							className='record-detail-inline-tag record-detail-inline-tag-button'
							onClick={() => onSelectKey(`finra:${orphan.parentType}:${orphan.parentCrd}`)}>
							{orphan.parentType === 'individual' ? `Individual CRD#${orphan.parentCrd}` : `Firm CRD#${orphan.parentCrd}`}
						</button>
						's own detail record{orphan.position ? ` as "${orphan.position}"` : ''}, and has no live CRD of its own.
					</div>
				</section>
			</div>
		</div>
	);
}

function RecordInfoView({
	activeKey,
	detailJson,
	sourceTagOverride,
	onSelectKey,
}: {
	activeKey: string;
	detailJson: string;
	sourceTagOverride?: string;
	onSelectKey: (key: string) => void;
}) {
	const parsedKey = parseCrdKey(activeKey);
	const rawPayload = maybeParseJson(detailJson);
	const combinedBundle = rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload) ? (rawPayload as Record<string, any>) : null;

	const brokersConnected = (combinedBundle?.brokersConnected as string[]) || [];
	const brokersPrevious = (combinedBundle?.brokersPrevious as string[]) || [];

	const seedFromBrokers = (connected: string[], previous: string[]) => ({
		current: connected.map((crd) => ({ crd, name: `CRD ${crd}` })),
		previous: previous.map((crd) => ({ crd, name: `CRD ${crd}` })),
	});

	const [employeeConnections, setEmployeeConnections] = useState<{ loading: boolean; current: any[]; previous: any[] }>({
		loading: false,
		...seedFromBrokers(brokersConnected, brokersPrevious),
	});

	useEffect(() => {
		const seeded = seedFromBrokers(brokersConnected, brokersPrevious);
		if (seeded.current.length || seeded.previous.length) {
			setEmployeeConnections((prev) => (prev.current.length || prev.previous.length ? prev : { loading: prev.loading, ...seeded }));
		}
	}, [brokersConnected.join(','), brokersPrevious.join(',')]);

	useEffect(() => {
		const isFirmRecord =
			parsedKey?.type === 'firm' || Boolean(combinedBundle?.basicInformation?.firmName || combinedBundle?.basicInformation?.iaFirmName || combinedBundle?.basicInformation?.firmId);
		if (!isFirmRecord || !parsedKey?.crd) return;

		let active = true;
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 60000);
		// Keep any seeded broker lists visible while the named enrichment loads.
		setEmployeeConnections((prev) => ({ ...prev, loading: true }));

		const mapConnectionCard = (c: any) => ({
			...c,
			crd: c.individualId || c.crd,
			currentEmployer: c.currentEmployer || c.currentFirmName || undefined,
			__subtitleOverride: [c.address, c.yearsWorked != null && String(c.yearsWorked).trim() !== '' ? `${c.yearsWorked} yrs` : null].filter(Boolean).join(' • ') || c.relationship,
		});

		fetch(`/api/finra/firm/${parsedKey.crd}/connections`, { signal: controller.signal })
			.then((r) => r.json())
			.then((data) => {
				if (!active) return;
				if (data.currentConnections || data.previousConnections) {
					setEmployeeConnections({
						loading: false,
						current: (data.currentConnections || []).map(mapConnectionCard),
						previous: (data.previousConnections || []).map(mapConnectionCard),
					});
				} else {
					setEmployeeConnections((prev) => ({ ...prev, loading: false }));
				}
			})
			.catch(() => {
				if (active) setEmployeeConnections((prev) => ({ ...prev, loading: false }));
			})
			.finally(() => clearTimeout(timeout));

		return () => {
			active = false;
			clearTimeout(timeout);
			controller.abort();
		};
	}, [parsedKey?.crd, parsedKey?.type, combinedBundle?.basicInformation]);

	// Only treat as orphan when there is no live FINRA/SEC source payload.
	// Some records appear both as firm owner refs and as full BrokerCheck people;
	// a stale/cached orphan flag must not hide the real Redis detail.
	const isFinraReal = combinedBundle?.sources?.finra?.found && !combinedBundle?.sources?.finra?.payload?.orphan;
	const isSecReal = combinedBundle?.sources?.sec?.found && !combinedBundle?.sources?.sec?.payload?.orphan;
	const hasLiveSourcePayload = Boolean(
		isFinraReal ||
		isSecReal ||
		(typeof combinedBundle?.sources?.finra?.rawPayload === 'string' && combinedBundle.sources.finra.rawPayload.trim() && !combinedBundle.sources.finra.rawPayload.includes('"orphan":')) ||
		(typeof combinedBundle?.sources?.sec?.rawPayload === 'string' && combinedBundle.sources.sec.rawPayload.trim() && !combinedBundle.sources.sec.rawPayload.includes('"orphan":'))
	);
	if (combinedBundle?.orphan && typeof combinedBundle.orphan === 'object' && !hasLiveSourcePayload) {
		const crd = typeof combinedBundle.crd === 'string' ? combinedBundle.crd : parsedKey?.crd || 'N/A';
		return (
			<OrphanRecordView
				crd={crd}
				orphan={combinedBundle.orphan}
				onSelectKey={onSelectKey}
			/>
		);
	}
	if (combinedBundle?.sources && typeof combinedBundle.sources === 'object') {
		const finraRaw = typeof combinedBundle.sources.finra?.rawPayload === 'string' ? combinedBundle.sources.finra.rawPayload : '';
		const secRaw = typeof combinedBundle.sources.sec?.rawPayload === 'string' ? combinedBundle.sources.sec.rawPayload : '';
		const finraPayload = combinedBundle.sources.finra?.payload;
		const secPayload = combinedBundle.sources.sec?.payload;
		const finraFound = Boolean(combinedBundle.sources.finra?.found || finraPayload != null || finraRaw);
		const secFound = Boolean(combinedBundle.sources.sec?.found || secPayload != null || secRaw);
		const finraContent =
			finraPayload != null ? unwrapRecordPayload(finraPayload)
			: finraRaw ? unwrapRecordPayload(maybeParseJson(finraRaw))
			: null;
		const secContent =
			secPayload != null ? unwrapRecordPayload(secPayload)
			: secRaw ? unwrapRecordPayload(maybeParseJson(secRaw))
			: null;
		const finraBody = finraContent && typeof finraContent === 'object' ? (finraContent as Record<string, any>) : {};
		const secBody = secContent && typeof secContent === 'object' ? (secContent as Record<string, any>) : {};
		const finraBasic = finraBody.basicInformation && typeof finraBody.basicInformation === 'object' ? (finraBody.basicInformation as Record<string, any>) : {};
		const secBasic = secBody.basicInformation && typeof secBody.basicInformation === 'object' ? (secBody.basicInformation as Record<string, any>) : {};
		// Some legacy saved "sec" records are actually mislabeled copies of the
		// FINRA payload (no genuine SEC/IA markers) — a known data-quality bug
		// where BrokerCheck-only content was mistakenly cached under a sec:*
		// key. Treat those as if there's no real SEC content so SEC-only
		// links/badges (which would 404 or mislabel data) aren't shown.
		const hasGenuineSecContent = Boolean(
			secRaw &&
			[
				secBasic.iaScope,
				secBasic.isIAFirm,
				secBasic.iaSECNumber,
				secBody.iaFirmAddressDetails,
				secBody.iaDisclosureFlag,
				secBasic.advFilingDate,
				secBasic.hasPdf,
				secBody.registrationStatus,
				secBody.noticeFilings,
				secBody.orgScopeStatusFlags,
			].some((value) => {
				if (value == null) return false;
				if (typeof value === 'string') {
					const trimmed = value.trim();
					return trimmed !== '' && trimmed.toLowerCase() !== 'notinscope';
				}
				if (typeof value === 'number') return true;
				if (typeof value === 'boolean') return true;
				if (Array.isArray(value)) return value.length > 0;
				if (typeof value === 'object') return Object.keys(value).length > 0;
				return false;
			}),
		);
		const sourceSummary = toSourceLabel(new Set<string>([finraFound || finraContent ? 'FINRA' : '', hasGenuineSecContent ? 'SEC' : ''].filter(Boolean)));
		const crd = typeof combinedBundle.crd === 'string' ? combinedBundle.crd : parsedKey?.crd || 'N/A';
		const type = typeof combinedBundle.type === 'string' ? combinedBundle.type : parsedKey?.type || 'firm';

		const personNameFromParts = (...basics: Record<string, any>[]) => {
			for (const basic of basics) {
				const parts = [basic?.firstName, basic?.middleName, basic?.lastName, basic?.suffix].map((part) => String(part || '').trim()).filter(Boolean);
				if (parts.length) return parts.join(' ');
			}
			return '';
		};
		// BrokerCheck individuals usually only have first/middle/last parts — not
		// individualName/fullName. Falling back only to firm-style fields made
		// legitimate people look like empty/orphan cards in the combined view.
		const mergedNames = mergeSourceValues(
			pickFirstNonEmpty(personNameFromParts(finraBasic), finraBasic.fullName, finraBasic.individualName, finraBasic.iaFirmName, finraBasic.firmName),
			pickFirstNonEmpty(personNameFromParts(secBasic), secBasic.fullName, secBasic.individualName, secBasic.iaFirmName, secBasic.firmName),
		);
		const mergedSecNumber = mergeSourceValues(pickFirstNonEmpty(finraBasic.iaSECNumber, finraBasic.bdSECNumber), pickFirstNonEmpty(secBasic.iaSECNumber, secBasic.bdSECNumber));
		const mergedFormedDate = mergeSourceValues(finraBasic.formedDate, secBasic.formedDate);
		const mergedFirmType = mergeSourceValues(finraBasic.firmType, secBasic.firmType);
		const mergedRegulator = mergeSourceValues(finraBasic.regulator, secBasic.regulator);
		const mergedDistrict = mergeSourceValues(finraBasic.districtName, secBasic.districtName);
		const mergedFiscalMonthEnd = mergeSourceValues(finraBasic.fiscalMonthEndCode, secBasic.fiscalMonthEndCode);
		const mergedReportStatus = mergeSourceValues(finraBasic.legacyReportStatus, secBasic.legacyReportStatus);

		const mergedOfficeAddress = mergeSourceValues(
			formatAddress(finraBody.iaFirmAddressDetails?.officeAddress) || formatAddress(finraBody.firmAddressDetails?.officeAddress) || extractCurrentBranchOfficeAddress(finraBody),
			formatAddress(secBody.iaFirmAddressDetails?.officeAddress) || formatAddress(secBody.firmAddressDetails?.officeAddress) || extractCurrentBranchOfficeAddress(secBody),
		);
		const mergedMailingAddress = mergeSourceValues(formatAddress(finraBody.firmAddressDetails?.mailingAddress), formatAddress(secBody.firmAddressDetails?.mailingAddress));
		const mergedPhone = mergeSourceValues(
			pickFirstNonEmpty(finraBody.firmAddressDetails?.businessPhoneNumber, finraBody.iaFirmAddressDetails?.businessPhoneNumber),
			pickFirstNonEmpty(secBody.firmAddressDetails?.businessPhoneNumber, secBody.iaFirmAddressDetails?.businessPhoneNumber),
		);
		const otherNames = collectOtherNames(
			finraBasic.otherNames,
			secBasic.otherNames,
			mergedNames.slice(1).map((item) => item.value),
		);
		const combinedConnectionRows = mergeWithSourceTag(
			[
				{ source: 'FINRA', rows: extractConnectionRows(finraBody) },
				{ source: 'SEC', rows: extractConnectionRows(secBody) },
			],
			(row) => pickFirstNonEmpty(row.legalName, row.name, row.individualName, row.fullName, row.firmName, row.organizationName, row.position),
		);
		const combinedConnectionBuckets = bucketConnectionRows(combinedConnectionRows);
		const combinedCurrentEmployment = mergeWithSourceTag(
			[
				{
					source: 'FINRA',
					rows: combinedConnectionBuckets.current.filter((row: any) => row.__sourceTag !== 'SEC'),
				},
				{
					source: 'SEC',
					rows: combinedConnectionBuckets.current.filter((row: any) => row.__sourceTag !== 'FINRA'),
				},
			],
			(row) => pickFirstNonEmpty(row.legalName, row.name, row.individualName, row.fullName, row.firmName, row.organizationName, row.position),
		);
		const combinedPreviousEmployment = mergeWithSourceTag(
			[
				{
					source: 'FINRA',
					rows: combinedConnectionBuckets.previous.filter((row: any) => row.__sourceTag !== 'SEC'),
				},
				{
					source: 'SEC',
					rows: combinedConnectionBuckets.previous.filter((row: any) => row.__sourceTag !== 'FINRA'),
				},
			],
			(row) => pickFirstNonEmpty(row.legalName, row.name, row.individualName, row.fullName, row.firmName, row.organizationName, row.position),
		);
		const currentEmploymentDisplay = decorateEmploymentItems(combinedCurrentEmployment);
		const previousEmploymentDisplay = decorateEmploymentItems(combinedPreviousEmployment);
		const combinedDisclosures = mergeWithSourceTag(
			[
				{ source: 'FINRA', rows: toArray(finraBody.disclosures) },
				{ source: 'SEC', rows: toArray(secBody.disclosures) },
			],
			(row) => pickFirstNonEmpty(row.disclosureType, row.disclosureCount),
		);
		const combinedOwners = mergeWithSourceTag(
			[
				{ source: 'FINRA', rows: toArray(finraBody.directOwners) },
				{ source: 'SEC', rows: toArray(secBody.directOwners) },
			],
			(row) => pickFirstNonEmpty(row.legalName, row.name, row.individualName, row.fullName, row.firmName, row.organizationName),
		);
		const combinedStateExams = toArray(finraBody.stateExamCategory)
			.concat(toArray(secBody.stateExamCategory))
			.concat(toArray(finraBody.stateExams))
			.concat(toArray(secBody.stateExams));
		const combinedProductExams = toArray(finraBody.productExamCategory)
			.concat(toArray(secBody.productExamCategory))
			.concat(toArray(finraBody.productExams))
			.concat(toArray(secBody.productExams));
		const combinedPrincipalExams = toArray(finraBody.principalExamCategory)
			.concat(toArray(secBody.principalExamCategory))
			.concat(toArray(finraBody.principalExams))
			.concat(toArray(secBody.principalExams));

		const registeredStateTags = Array.from(
			new Set(
				toArray(finraBody.registeredStates)
					.map((row: any) => String(row?.state || '').trim())
					.filter(Boolean),
			),
		).sort((a, b) => a.localeCompare(b));
		const registeredSroTags = Array.from(
			new Set(
				toArray(finraBody.registeredSROs)
					.map((row: any) => String(row?.sro || '').trim())
					.filter(Boolean),
			),
		).sort((a, b) => a.localeCompare(b));
		const headlineName = mergedNames[0]?.value || crd;
		const linkedFallbackType: 'individual' | 'firm' = type === 'individual' ? 'firm' : 'individual';
		const isFirmRecord = type === 'firm';
		// Individual hero stats — same fields as finra-data-chart-next-02 sidebar.
		const yearsExperience = pickFirstNonEmpty(finraBody.yearsExperience, finraBasic.yearsExperience, secBody.yearsExperience);
		const daysInIndustry = pickFirstNonEmpty(finraBody.daysInIndustry, finraBasic.daysInIndustry);
		const firmCountDerived = currentEmploymentDisplay.length + previousEmploymentDisplay.length;
		const firmCountAllTime = pickFirstNonEmpty(finraBody.firmCount, finraBasic.firmCount, firmCountDerived > 0 ? firmCountDerived : null);
		const licenseCount = pickFirstNonEmpty(
			finraBody.registrationCount?.approvedStateRegistrationCount,
			finraBody.registrations?.approvedStateRegistrationCount,
			registeredStateTags.length || null,
		);
		const disclosureCountHero = combinedDisclosures.reduce((sum: number, row: any) => sum + Number(row?.disclosureCount || 0), 0);
		const primaryOfficeHero = mergedOfficeAddress[0]?.value || getEmploymentAddress(currentEmploymentDisplay[0]) || '';
		return (
			<div className='record-detail-wrapper'>
				<div className='record-detail-view combined-record-detail-view'>
					<section className='record-detail-hero'>
						<div className='record-detail-subline'>
							{mergedSecNumber[0]?.value ?
								<span>
									CRD#: {crd}/SEC#: {mergedSecNumber[0].value}
								</span>
							:	<span>CRD#: {crd}</span>}
						</div>
						{!isFirmRecord ?
							<div className='record-detail-grid record-detail-hero-stats'>
								{yearsExperience ?
									<div>
										<strong>Years of Experience:</strong> {yearsExperience}
									</div>
								: daysInIndustry ?
									<div>
										<strong>Days in Industry:</strong> {Number(daysInIndustry).toLocaleString?.() || daysInIndustry}
									</div>
								:	null}
								{firmCountAllTime ?
									<div>
										<strong>Firms (all time):</strong> {firmCountAllTime}
									</div>
								:	null}
								{licenseCount ?
									<div>
										<strong>State Licenses:</strong> {licenseCount}
									</div>
								:	null}
								<div>
									<strong>Disclosures:</strong> {disclosureCountHero}
								</div>
								{primaryOfficeHero ?
									<div className='record-detail-hero-stat-wide'>
										<strong>Primary Office:</strong> {primaryOfficeHero}
									</div>
								:	null}
							</div>
						:	null}
						{mergedOfficeAddress.length || mergedMailingAddress.length || mergedPhone.length ?
							<div className='record-detail-grid'>
								{isFirmRecord &&
									mergedOfficeAddress.map((item, index) => (
										<div key={`combined-office-${index}`}>
											<strong>Main Address:</strong> {item.value}
										</div>
									))}
								{mergedMailingAddress.map((item, index) => (
									<div key={`combined-mailing-${index}`}>
										<strong>Mailing:</strong> {item.value}
									</div>
								))}
								{mergedPhone.map((item, index) => (
									<div key={`combined-phone-${index}`}>
										<strong>Phone:</strong> {item.value}
									</div>
								))}
							</div>
						:	null}
						{renderOtherNames(otherNames)}
					</section>

					<section className='record-detail-section'>
						<h4 className='record-detail-section-title'>Profile links</h4>
						<div className='banner-context-links profile-links-section'>
							{(finraFound || finraContent) && (
								<a
									className='profile-link finra-link'
									href={`https://brokercheck.finra.org/${type === 'individual' ? 'individual' : 'firm'}/summary/${crd}`}
									target='_blank'
									rel='noopener noreferrer'>
									FINRA profile ↗
								</a>
							)}
							{!isFirmRecord && (finraFound || finraContent) && (
								<a
									className='profile-link finra-link'
									href={`https://files.brokercheck.finra.org/individual/individual_${crd}.pdf`}
									target='_blank'
									rel='noopener noreferrer'>
									FINRA Detailed Report (PDF) ↗
								</a>
							)}
							{hasGenuineSecContent && (
								<a
									className='profile-link sec-link'
									href={`https://adviserinfo.sec.gov/${type === 'individual' ? 'individual' : 'firm'}/summary/${crd}`}
									target='_blank'
									rel='noopener noreferrer'>
									SEC profile ↗
								</a>
							)}
							{isFirmRecord && hasGenuineSecContent && (
								<>
									<a
										className='profile-link sec-link'
										href={`https://reports.adviserinfo.sec.gov/reports/ADV/${crd}/PDF/${crd}.pdf`}
										target='_blank'
										rel='noopener noreferrer'>
										Latest Form ADV filed ↗
									</a>
									<a
										className='profile-link sec-link'
										href={`https://adviserinfo.sec.gov/firm/brochure/${crd}`}
										target='_blank'
										rel='noopener noreferrer'>
										SEC firm brochure ↗
									</a>
									<a
										className='profile-link sec-link'
										href={`https://reports.adviserinfo.sec.gov/crs/crs_${crd}.pdf`}
										target='_blank'
										rel='noopener noreferrer'>
										SEC Form CRS ↗
									</a>
								</>
							)}
						</div>
					</section>
					{isFirmRecord ?
						<section className='record-detail-section'>
							<h4 className='record-detail-section-title'>Profile</h4>
							<div className='record-detail-grid'>
								{mergedFormedDate.map((item, index) => (
									<div key={`combined-formed-${index}`}>
										<strong>Established:</strong> {item.value}
									</div>
								))}
								{mergedFirmType.map((item, index) => (
									<div key={`combined-type-${index}`}>
										<strong>Type:</strong> {item.value}
									</div>
								))}
								{mergedRegulator.map((item, index) => (
									<div key={`combined-reg-${index}`}>
										<strong>Regulator:</strong> {item.value}
									</div>
								))}
								{mergedDistrict.map((item, index) => (
									<div key={`combined-district-${index}`}>
										<strong>FINRA district:</strong> {item.value}
									</div>
								))}
								{mergedFiscalMonthEnd.map((item, index) => (
									<div key={`combined-fiscal-${index}`}>
										<strong>Fiscal year end:</strong> {item.value}
									</div>
								))}
								{mergedReportStatus.map((item, index) => (
									<div key={`combined-report-status-${index}`}>
										<strong>Reporting status:</strong> {item.value}
									</div>
								))}
							</div>
						</section>
					:	null}

					{!isFirmRecord ?
						<>
							<DetailList
								title={`Current Registrations (${currentEmploymentDisplay.length})`}
								items={currentEmploymentDisplay}
								onSelectKey={onSelectKey}
								fallbackType={linkedFallbackType}
								hideSourceTag
							/>
							<DetailList
								title={`Previous Registrations (${previousEmploymentDisplay.length})`}
								items={previousEmploymentDisplay}
								onSelectKey={onSelectKey}
								fallbackType={linkedFallbackType}
								hideSourceTag
								muted
							/>
						</>
					:	null}
					<DetailList
						title={`Direct owners & executive officers (${combinedOwners.length})`}
						items={combinedOwners}
						onSelectKey={onSelectKey}
						fallbackType={linkedFallbackType}
					/>
					<DisclosureDetailCards
						title={`Disclosure details (${combinedDisclosures.length})`}
						items={combinedDisclosures}
						crd={crd}
						type={type as 'individual' | 'firm'}
						hasFinra={Boolean(finraRaw)}
						hasSec={hasGenuineSecContent}
					/>
					{!isFirmRecord ?
						<>
							<ExamCategoryCardsSection
								title='State Exam Category'
								items={combinedStateExams}
								variant='state'
							/>
							<ExamCategoryCardsSection
								title='Product Exam Category'
								items={combinedProductExams}
								variant='product'
							/>
							<ExamCategoryCardsSection
								title='Principal Exam Category'
								items={combinedPrincipalExams}
								variant='principal'
							/>
						</>
					:	null}
					<RawFieldGroups
						title='Additional FINRA details'
						body={finraBody}
						source='finra'
					/>
					{hasGenuineSecContent && secBody?.noticeFilings && Array.isArray(secBody.noticeFilings) && secBody.noticeFilings.length > 0 && (
						<NoticeFilingsSection filings={secBody.noticeFilings} />
					)}
					{hasGenuineSecContent && secBody?.accountantSurpriseExams && Array.isArray(secBody.accountantSurpriseExams) && secBody.accountantSurpriseExams.length > 0 && (
						<AccountantSurpriseExamsSection exams={secBody.accountantSurpriseExams} />
					)}
					{hasGenuineSecContent && (
						<RawFieldGroups
							title='Additional SEC details'
							body={secBody}
							source='sec'
						/>
					)}
					{!isFirmRecord ?
						<>
							<TagListSection
								title={`Registered states (${registeredStateTags.length})`}
								tags={registeredStateTags}
							/>
							<TagListSection
								title={`Registered SROs (${registeredSroTags.length})`}
								tags={registeredSroTags}
							/>
						</>
					:	null}
					{isFirmRecord && employeeConnections ?
						<>
							{employeeConnections.loading && !(employeeConnections.current.length || employeeConnections.previous.length) ?
								<div
									className='record-detail-empty'
									style={{ marginTop: '1rem', color: '#888', fontStyle: 'italic' }}>
									Loading connections...
								</div>
							:	null}
							{employeeConnections.current.length > 0 || employeeConnections.previous.length > 0 ?
								<>
									<DetailList
										title={`Current connections (${employeeConnections.current.length})`}
										items={employeeConnections.current}
										onSelectKey={onSelectKey}
										fallbackType='individual'
									/>
									<DetailList
										title={`Previous connections (${employeeConnections.previous.length})`}
										items={employeeConnections.previous}
										onSelectKey={onSelectKey}
										fallbackType='individual'
										muted
									/>
								</>
							:	null}
						</>
					:	null}
				</div>
			</div>
		);
	}
	const content = unwrapRecordPayload(rawPayload);
	const plainDetailMessage = (() => {
		if (typeof detailJson !== 'string') return '';
		const trimmed = detailJson.trim();
		if (!trimmed) return '';
		if (trimmed.startsWith('//')) return trimmed.replace(/^\/\/\s*/, '');
		if (trimmed.startsWith('{') || trimmed.startsWith('[')) return '';
		return trimmed;
	})();

	if (plainDetailMessage) {
		return (
			<div className='record-detail-empty'>
				<strong>Record unavailable:</strong> {plainDetailMessage}
			</div>
		);
	}

	if (!content || typeof content !== 'object') {
		return <div className='record-detail-empty'>No structured fields were found for this CRD payload yet.</div>;
	}

	const body = content as Record<string, any>;
	const basic = body.basicInformation && typeof body.basicInformation === 'object' ? body.basicInformation : {};
	const registrations = body.registrations && typeof body.registrations === 'object' ? body.registrations : {};
	const registrationStatus = toArray(body.registrationStatus);
	const disclosures = toArray(body.disclosures);
	const currentConnections = toArray(body.currentConnections);
	const previousConnections = toArray(body.previousConnections);
	const directOwners = toArray(body.directOwners);
	const affiliateDisclosures = body.affiliateDisclosures && typeof body.affiliateDisclosures === 'object' ? body.affiliateDisclosures : {};
	// Explicit employment arrays (BrokerCheck individual shape) — same as reference sidebar.
	const currentEmploymentRows = decorateEmploymentItems(
		mergeEmploymentRows(toArray(body.currentEmployments), toArray(body.currentIAEmployments), toArray(body.ind_current_employments), toArray(body.ind_ia_current_employments)),
	);
	const previousEmploymentRows = decorateEmploymentItems(
		mergeEmploymentRows(toArray(body.previousEmployments), toArray(body.previousIAEmployments), toArray(body.ind_previous_employments), toArray(body.ind_ia_previous_employments)),
	);

	const name =
		pickFirstNonEmpty(basic.iaFirmName, basic.firmName, basic.fullName, basic.individualName, basic.orgName, (body as any)?.orphan?.name) || (parsedKey ? parsedKey.crd : '');
	const crd = pickFirstNonEmpty(basic.firmId, basic.individualId, basic.crdNumber, parsedKey?.crd);
	const secNumber = pickFirstNonEmpty(basic.iaSECNumber, basic.bdSECNumber);
	const officeAddress = formatAddress(body.iaFirmAddressDetails?.officeAddress) || formatAddress(body.firmAddressDetails?.officeAddress) || extractCurrentBranchOfficeAddress(body);
	const mailingAddress = formatAddress(body.firmAddressDetails?.mailingAddress);
	const phone = pickFirstNonEmpty(body.firmAddressDetails?.businessPhoneNumber, body.iaFirmAddressDetails?.businessPhoneNumber);
	const otherNames = collectOtherNames(basic.otherNames, body.otherNames, basic.aliases, body.aliases).filter((alias) => normalizeStatusText(alias) !== normalizeStatusText(name));
	const secRegistrationStatus = toArray(body.registrationStatus);
	const secNoticeFilings = toArray(body.noticeFilings);
	const secOrgScopeFlags = body.orgScopeStatusFlags && typeof body.orgScopeStatusFlags === 'object' ? body.orgScopeStatusFlags : {};
	const secHasProfile = Boolean(parsedKey?.source === 'sec' || basic.iaSECNumber || basic.isIAFirm || basic.firmId);
	const secFirmStatusText = pickFirstNonEmpty(basic.iaScope, basic.legacyReportStatus, secOrgScopeFlags?.isSECRegistered);
	const secFirmStatusLabel = secFirmStatusText ? String(secFirmStatusText) : 'Active';

	const approvedFinra = pickFirstNonEmpty(registrations.approvedFinraRegistrationCount, body.registrationCount?.approvedFinraRegistrationCount);
	const approvedSec = pickFirstNonEmpty(registrations.approvedSECRegistrationCount);
	const stateCount = pickFirstNonEmpty(registrations.approvedStateRegistrationCount, body.registrationCount?.approvedStateRegistrationCount);
	const sroCount = pickFirstNonEmpty(registrations.approvedSRORegistrationCount, body.registrationCount?.approvedSRORegistrationCount);

	const stateExams = toArray(body.stateExamCategory).concat(toArray(body.stateExams));
	const productExams = toArray(body.productExamCategory).concat(toArray(body.productExams));
	const principalExams = toArray(body.principalExamCategory).concat(toArray(body.principalExams));

	const totalDisclosureCount = disclosures.reduce((sum, row) => sum + Number(row?.disclosureCount || 0), 0);
	const nonRegisteredAffiliateDisclosureCount = Number(affiliateDisclosures.nonRegisteredAffiliateDisclosureCount || 0);

	const sourceTag = sourceTagOverride || (parsedKey ? `${parsedKey.source.toUpperCase()} • ${parsedKey.type.toUpperCase()}` : 'Selected source');
	const linkedFallbackType: 'individual' | 'firm' = parsedKey?.type === 'individual' ? 'firm' : 'individual';
	const fallbackConnectionBucketsRaw = bucketConnectionRows([...currentConnections, ...previousConnections, ...directOwners]);
	const fallbackConnectionBuckets = {
		current: sortRowsByLabel(fallbackConnectionBucketsRaw.current),
		previous: sortRowsByLabel(fallbackConnectionBucketsRaw.previous),
		owner: fallbackConnectionBucketsRaw.owner,
	};
	const isFirmRecord = parsedKey?.type === 'firm' || Boolean(basic.firmName || basic.iaFirmName || basic.firmId);
	const yearsExperience = pickFirstNonEmpty(body.yearsExperience, basic.yearsExperience);
	const daysInIndustry = pickFirstNonEmpty(body.daysInIndustry, basic.daysInIndustry);
	const firmCountDerivedSingle = currentEmploymentRows.length + previousEmploymentRows.length;
	const firmCountAllTime = pickFirstNonEmpty(body.firmCount, basic.firmCount, firmCountDerivedSingle > 0 ? firmCountDerivedSingle : null);
	const registeredStateTagsSingle = Array.from(
		new Set(
			toArray(body.registeredStates)
				.map((row: any) => String(row?.state || row || '').trim())
				.filter(Boolean),
		),
	).sort((a, b) => a.localeCompare(b));
	const licenseCount = pickFirstNonEmpty(stateCount, registeredStateTagsSingle.length || null);
	const primaryOfficeSingle = officeAddress || getEmploymentAddress(currentEmploymentRows[0]) || '';

	return (
		<div className='record-detail-view'>
			<section className='record-detail-hero'>
				<div className='record-detail-name-row'>
					<div className='record-detail-pills'>
						{basic.firmSize ?
							<span className='record-pill'>{String(basic.firmSize)}</span>
						:	null}
						<span className='record-pill'>Disclosures {totalDisclosureCount || nonRegisteredAffiliateDisclosureCount}</span>
					</div>
				</div>
				<div className='record-detail-subline'>
					{secNumber ?
						<span>
							CRD#: {crd}/SEC#: {secNumber}
						</span>
					:	<span>CRD#: {crd}</span>}
				</div>
				{!isFirmRecord ?
					<div className='record-detail-grid record-detail-hero-stats'>
						{yearsExperience ?
							<div>
								<strong>Years of Experience:</strong> {yearsExperience}
							</div>
						: daysInIndustry ?
							<div>
								<strong>Days in Industry:</strong> {Number(daysInIndustry).toLocaleString?.() || daysInIndustry}
							</div>
						:	null}
						{firmCountAllTime ?
							<div>
								<strong>Firms (all time):</strong> {firmCountAllTime}
							</div>
						:	null}
						{licenseCount ?
							<div>
								<strong>State Licenses:</strong> {licenseCount}
							</div>
						:	null}
						<div>
							<strong>Disclosures:</strong> {totalDisclosureCount || nonRegisteredAffiliateDisclosureCount || 0}
						</div>
						{primaryOfficeSingle ?
							<div className='record-detail-hero-stat-wide'>
								<strong>Primary Office:</strong> {primaryOfficeSingle}
							</div>
						:	null}
					</div>
				:	null}
				{isFirmRecord && (officeAddress || mailingAddress || phone) ?
					<div className='record-detail-grid'>
						{officeAddress ?
							<div>
								<strong>Main Address:</strong> {officeAddress}
							</div>
						:	null}
						{mailingAddress ?
							<div>
								<strong>Mailing:</strong> {mailingAddress}
							</div>
						:	null}
						{phone ?
							<div>
								<strong>Phone:</strong> {phone}
							</div>
						:	null}
					</div>
				:	null}
				{renderOtherNames(otherNames)}
			</section>

			{isFirmRecord ?
				<section className='record-detail-section'>
					<h4 className='record-detail-section-title'>General information</h4>
					<div className='record-detail-grid'>
						{basic.formedDate ?
							<div>
								<strong>Established:</strong> {String(basic.formedDate)}
							</div>
						:	null}
						{basic.firmType ?
							<div>
								<strong>Type:</strong> {String(basic.firmType)}
							</div>
						:	null}
						{basic.regulator ?
							<div>
								<strong>Regulator:</strong> {String(basic.regulator)}
							</div>
						:	null}
						{basic.districtName ?
							<div>
								<strong>FINRA district:</strong> {String(basic.districtName)}
							</div>
						:	null}
						{basic.fiscalMonthEndCode ?
							<div>
								<strong>Fiscal year end:</strong> {String(basic.fiscalMonthEndCode)}
							</div>
						:	null}
						{basic.legacyReportStatus ?
							<div>
								<strong>Reporting status:</strong> {String(basic.legacyReportStatus)}
							</div>
						:	null}
					</div>
				</section>
			:	null}

			<section className='record-detail-section'>
				<h4 className='record-detail-section-title'>Registration</h4>
				<div className='record-detail-grid'>
					{approvedFinra ?
						<div>
							<strong>FINRA:</strong> {approvedFinra}
						</div>
					:	null}
					{approvedSec ?
						<div>
							<strong>SEC:</strong> {approvedSec}
						</div>
					:	null}
					{stateCount ?
						<div>
							<strong>States:</strong> {stateCount}
						</div>
					:	null}
					{sroCount ?
						<div>
							<strong>SRO:</strong> {sroCount}
						</div>
					:	null}
				</div>
				{registrationStatus.length ?
					<div className='record-detail-other-names-list'>
						{registrationStatus.map((row, index) => (
							<span
								key={`registration-status-${index}`}
								className='record-registration-tag'
								title={row.effectiveDate ? `Effective ${row.effectiveDate}` : undefined}>
								{pickFirstNonEmpty(row.secJurisdiction, 'Jurisdiction')}
							</span>
						))}
					</div>
				:	null}
			</section>

			{!isFirmRecord ?
				<>
					<ExamCategoryCardsSection
						title='State Exam Category'
						items={stateExams}
						variant='state'
					/>
					<ExamCategoryCardsSection
						title='Product Exam Category'
						items={productExams}
						variant='product'
					/>
					<ExamCategoryCardsSection
						title='Principal Exam Category'
						items={principalExams}
						variant='principal'
					/>
				</>
			:	null}

			{secHasProfile ?
				<section className='record-detail-section'>
					<h4 className='record-detail-section-title'>Profile links</h4>
					<div className='banner-context-links profile-links-section'>
						<a
							className='profile-link sec-link'
							href={`https://adviserinfo.sec.gov/${isFirmRecord ? 'firm' : 'individual'}/summary/${crd}`}
							target='_blank'
							rel='noopener noreferrer'>
							SEC profile ↗
						</a>
						{isFirmRecord ?
							<>
								<a
									className='profile-link sec-link'
									href={`https://reports.adviserinfo.sec.gov/reports/ADV/${crd}/PDF/${crd}.pdf`}
									target='_blank'
									rel='noopener noreferrer'>
									Latest Form ADV filed ↗
								</a>
								<a
									className='profile-link sec-link'
									href={`https://adviserinfo.sec.gov/firm/brochure/${crd}`}
									target='_blank'
									rel='noopener noreferrer'>
									SEC firm brochure ↗
								</a>
							</>
						:	null}
					</div>
				</section>
			:	null}

			<section className='record-detail-section'>
				<h4 className='record-detail-section-title'>Disclosures</h4>
				<div className='record-detail-grid'>
					{disclosures.map((item, index) => (
						<div key={`disclosure-${index}`}>
							<strong>{pickFirstNonEmpty(item.disclosureType, `Disclosure ${index + 1}`)}:</strong> {pickFirstNonEmpty(item.disclosureCount, 0)}
						</div>
					))}
					{nonRegisteredAffiliateDisclosureCount > 0 ?
						<div>
							<strong>Affiliate disclosure (non-registered):</strong> {nonRegisteredAffiliateDisclosureCount}
						</div>
					:	null}
					{!disclosures.length && nonRegisteredAffiliateDisclosureCount === 0 ?
						<div>No disclosure records listed in this source payload.</div>
					:	null}
				</div>
			</section>

			<DisclosureDetailCards
				title={`Disclosure details (${disclosures.length})`}
				items={disclosures}
				crd={crd}
				type={isFirmRecord ? 'firm' : 'individual'}
				hasFinra={parsedKey?.source === 'finra'}
				hasSec={parsedKey?.source === 'sec'}
			/>

			{!isFirmRecord && currentEmploymentRows.length ?
				<DetailList
					title={`Current Employment (${currentEmploymentRows.length})`}
					items={currentEmploymentRows}
					onSelectKey={onSelectKey}
					fallbackType='firm'
					hideSourceTag
				/>
			:	null}
			{!isFirmRecord && previousEmploymentRows.length ?
				<DetailList
					title={`Previous Employment (${previousEmploymentRows.length})`}
					items={previousEmploymentRows}
					onSelectKey={onSelectKey}
					fallbackType='firm'
					hideSourceTag
					muted
				/>
			:	null}

			<DetailList
				title={`Direct owners & executive officers (${fallbackConnectionBuckets.owner.length})`}
				items={fallbackConnectionBuckets.owner}
				onSelectKey={onSelectKey}
				fallbackType={linkedFallbackType}
			/>
			{/* Generic connection buckets only when employment arrays weren't present (non-firm / orphan shapes). */}
			{!isFirmRecord && !currentEmploymentRows.length && !previousEmploymentRows.length ?
				<>
					<DetailList
						title={`Current connections (${fallbackConnectionBuckets.current.length})`}
						items={fallbackConnectionBuckets.current}
						onSelectKey={onSelectKey}
						fallbackType={linkedFallbackType}
					/>
					<DetailList
						title={`Previous connections (${fallbackConnectionBuckets.previous.length})`}
						items={fallbackConnectionBuckets.previous}
						onSelectKey={onSelectKey}
						fallbackType={linkedFallbackType}
						muted
					/>
				</>
			:	null}
			{!isFirmRecord && registeredStateTagsSingle.length ?
				<TagListSection
					title={`Registered States (${registeredStateTagsSingle.length})`}
					tags={registeredStateTagsSingle}
				/>
			:	null}
			<RawFieldGroups
				title='Additional details'
				body={body}
			/>
			{isFirmRecord && employeeConnections ?
				<>
					{employeeConnections.loading && !(employeeConnections.current.length || employeeConnections.previous.length) ?
						<div
							className='record-detail-empty'
							style={{ marginTop: '1rem', color: '#888', fontStyle: 'italic' }}>
							Loading connections...
						</div>
					:	null}
					{employeeConnections.current.length > 0 || employeeConnections.previous.length > 0 ?
						<>
							<DetailList
								title={`Current connections (${employeeConnections.current.length})`}
								items={employeeConnections.current}
								onSelectKey={onSelectKey}
								fallbackType='individual'
							/>
							<DetailList
								title={`Previous connections (${employeeConnections.previous.length})`}
								items={employeeConnections.previous}
								onSelectKey={onSelectKey}
								fallbackType='individual'
								muted
							/>
						</>
					:	null}
				</>
			:	null}
		</div>
	);
}

export function StatusBox({
	statusMsg,
	statusHtml,
	detailJson,
	panelLoading,
	activeKey,
	fetchLog,
	onClearLog,
	onSelectKey,
	selectionLog = [],
	onClearSelectionLog,
	onFocusSelectionLogEntry,
	hideTabs,
	hideJsonTab,
}: Props) {
	const [jsonCopied, setJsonCopied] = useState(false);
	const [activeTab, setActiveTab] = useState<DetailTab>('info');

	useEffect(() => {
		const saved = localStorage.getItem('statusBoxActiveTab');
		if (saved !== null) {
			setActiveTab(saved === 'null' ? null : (saved as DetailTab));
		} else if (window.innerWidth < 768) {
			setActiveTab(null);
		}
	}, []);

	const handleTabClick = (tab: DetailTab) => {
		const next = activeTab === tab ? null : tab;
		setActiveTab(next);
		localStorage.setItem('statusBoxActiveTab', String(next));
	};
	const [logFilter, setLogFilter] = useState('');
	const [logCopied, setLogCopied] = useState(false);

	const hasSelectionLog = selectionLog.length > 0;
	const displayTab = hideTabs ? 'info' : activeTab;

	const filteredSelectionLog = useMemo(() => {
		const q = logFilter.trim().toLowerCase();
		if (!q) return selectionLog;
		return selectionLog.filter((row) => {
			const hay = `${row.display} ${row.label} ${row.crd || ''} ${row.secNumber || ''} ${row.id} ${row.type || ''}`.toLowerCase();
			return hay.includes(q);
		});
	}, [logFilter, selectionLog]);

	async function handleCopyJson() {
		if (!detailJson) return;
		try {
			await navigator.clipboard.writeText(detailJson);
			setJsonCopied(true);
			setTimeout(() => setJsonCopied(false), 2000);
		} catch (err) {
			console.error('Failed to copy detail JSON:', err);
		}
	}

	async function handleCopySelectionLog() {
		const text = (filteredSelectionLog.length ? filteredSelectionLog : selectionLog).map((r) => r.display).join('\n');
		if (!text) return;
		try {
			await navigator.clipboard.writeText(text);
			setLogCopied(true);
			window.setTimeout(() => setLogCopied(false), 1200);
		} catch {
			setLogCopied(false);
		}
	}

	function handleActivateLogEntry(entry: SelectionLogEntry) {
		if (onFocusSelectionLogEntry) {
			onFocusSelectionLogEntry(entry);
			return;
		}
		const key = entry.key || (entry.crd ? `finra:${entry.type === 'firm' ? 'firm' : 'individual'}:${entry.crd}` : '');
		if (key) onSelectKey(key);
	}

	// Hide the empty details shell on mobile so Redis Search can sit in that space.
	const isEmpty = !panelLoading && !detailJson && fetchLog.length === 0 && !hasSelectionLog;

	const showLogTab = Boolean(detailJson) || hasSelectionLog || fetchLog.length > 0;

	return (
		<div className={`status-box${isEmpty ? ' is-empty' : ''}`.trim()}>
			<div className='status-box-header'>
				<div className='status-box-header-left'>
					{statusMsg && <div className='status-msg'>{statusMsg}</div>}
					{showLogTab && !hideTabs && (
						<div className='record-detail-tabs'>
							<button
								type='button'
								className={`record-detail-tab ${displayTab === 'info' ? 'active' : ''}`}
								onClick={() => handleTabClick('info')}>
								Info
							</button>
							{!hideJsonTab && (
								<button
									type='button'
									className={`record-detail-tab ${displayTab === 'json' ? 'active' : ''}`}
									onClick={() => handleTabClick('json')}>
									JSON
								</button>
							)}
							<button
								type='button'
								className={`record-detail-tab ${displayTab === 'log' ? 'active' : ''}`}
								onClick={() => handleTabClick('log')}>
								Log{hasSelectionLog ? ` (${selectionLog.length})` : ''}
							</button>
						</div>
					)}
				</div>
				<div className='status-box-header-actions'>
					{displayTab === 'log' && hasSelectionLog && (
						<button
							type='button'
							className='clear-log-btn'
							onClick={() => (onClearSelectionLog ? onClearSelectionLog() : onClearLog())}
							title='Clear selection log'>
							Clear
						</button>
					)}
					{displayTab === 'json' && fetchLog.length > 0 && (
						<button
							className='clear-log-btn'
							onClick={onClearLog}
							title='Clear terminal logs'>
							Clear
						</button>
					)}
				</div>
			</div>

			{displayTab === 'json' && fetchLog.length > 0 && <pre className='terminal-output'>{[...fetchLog].reverse().join('\n')}</pre>}

			{panelLoading && displayTab === 'info' && (
				<div
					className='panel-loading-state'
					role='status'
					aria-live='polite'>
					<div className='panel-loading-spinner' />
					<div className='panel-loading-copy'>
						<div className='panel-loading-title'>Loading record details…</div>
						<div className='panel-loading-subtitle'>Fetching the selected CRD payload</div>
					</div>
				</div>
			)}

			{detailJson && displayTab === 'info' && !panelLoading && (
				<RecordInfoView
					activeKey={activeKey}
					detailJson={detailJson}
					onSelectKey={onSelectKey}
				/>
			)}

			{displayTab === 'log' && hasSelectionLog && (
				<div className='selection-log'>
					<div className='selection-log-toolbar'>
						<span className='selection-log-title'>Selection Log</span>
						<div className='selection-log-actions'>
							<button
								type='button'
								className='selection-log-btn'
								onClick={handleCopySelectionLog}
								title='Copy visible log lines'>
								{logCopied ? 'Copied' : 'Copy All'}
							</button>
							<button
								type='button'
								className='selection-log-btn'
								onClick={() => (onClearSelectionLog ? onClearSelectionLog() : onClearLog())}
								title='Clear selection log'>
								Clear
							</button>
						</div>
					</div>
					<input
						type='search'
						className='selection-log-filter'
						value={logFilter}
						onChange={(e) => setLogFilter(e.target.value)}
						placeholder='Filter log…'
						aria-label='Filter selection log'
					/>
					<ul className='selection-log-list'>
						{filteredSelectionLog.length === 0 ?
							<li className='selection-log-empty'>No matches for “{logFilter.trim()}”</li>
						:	filteredSelectionLog.map((entry, idx) => {
								const isActive = Boolean(entry.crd && activeKey && activeKey.endsWith(`:${entry.crd}`)) || entry.id === activeKey.split(':').pop();
								const colorClass =
									entry.type === 'firm' ? 'is-firm'
									: entry.type === 'individual' ? 'is-individual'
									: 'is-unknown';
								return (
									<li
										key={`${entry.id}-${entry.ts || idx}-${idx}`}
										className={`selection-log-item ${colorClass}${isActive ? ' is-active' : ''}`}>
										<button
											type='button'
											className='selection-log-main'
											onClick={() => handleActivateLogEntry(entry)}
											title={entry.display}>
											<span className='selection-log-label'>{entry.display}</span>
										</button>
										<div className='selection-log-item-actions'>
											<button
												type='button'
												className='selection-log-icon-btn'
												title='Focus on map'
												aria-label={`Focus ${entry.label}`}
												onClick={() => handleActivateLogEntry(entry)}>
												+
											</button>
											<button
												type='button'
												className='selection-log-icon-btn'
												title='Copy line'
												aria-label={`Copy ${entry.label}`}
												onClick={async () => {
													try {
														await navigator.clipboard.writeText(entry.display);
													} catch {
														// ignore
													}
												}}>
												⧉
											</button>
										</div>
									</li>
								);
							})
						}
					</ul>
				</div>
			)}

			{detailJson && displayTab === 'json' && !panelLoading && (
				<div className='code-sample-wrap'>
					<button
						type='button'
						className={`code-copy-btn ${jsonCopied ? 'is-copied' : ''}`}
						onClick={handleCopyJson}
						title={jsonCopied ? 'Copied!' : 'Copy code sample'}
						aria-label={jsonCopied ? 'Code sample copied' : 'Copy code sample'}>
						{jsonCopied ? '✓' : '⧉'}
					</button>
					<pre className='terminal-output json-detail'>{detailJson}</pre>
				</div>
			)}

			{!detailJson && statusHtml && displayTab === 'info' && (
				<div
					className='status-html-content'
					dangerouslySetInnerHTML={{ __html: statusHtml }}
				/>
			)}
		</div>
	);
}
