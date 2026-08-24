// Read-only firm → employee connections from Redis cache only.
//
// Primary keys (shared Redis writer):
//   finra|sec:firm:{firmId}_brokers:connected   → current people CRDs
//   finra|sec:firm:{firmId}_brokers:previous    → previous people CRDs
// Optional legacy named caches (used only if broker lists are missing):
//   graph:firm-connections:v10|v9:{firmId}
//   graph:firm-emp-adj:v1:{firmId}
//
// Never writes Redis. Never falls back to files, primed bundles, or scans.

import { getCacheValue } from './_lib';
import { toProperCaseName } from '../../src/lib/format';

export type FirmConnectionEntry = {
	individualId: string;
	name: string;
	relationship: string;
	isCurrent: boolean;
	startDate?: string;
	endDate?: string;
	bcScope?: string;
	iaScope?: string;
	address?: string;
	yearsWorked?: string | number;
};

export type FirmConnectionsPayload = {
	currentConnections: FirmConnectionEntry[];
	previousConnections: FirmConnectionEntry[];
	source: 'redis' | 'empty';
};

const REDIS_CACHE_KEYS = (firmId: string) => [
	`graph:firm-connections:v10:${firmId}`,
	`graph:firm-connections:v9:${firmId}`,
	`graph:firm-emp-adj:v1:${firmId}`,
];

function toArray(value: unknown): any[] {
	return Array.isArray(value) ? value : [];
}

function firstNonEmpty(...values: unknown[]): string {
	for (const value of values) {
		const text = String(value ?? '').trim();
		if (text) return text;
	}
	return '';
}

function parseMaybeJson(raw: unknown): unknown {
	if (raw == null) return null;
	if (typeof raw !== 'string') return raw;
	const text = raw.trim();
	if (!text) return null;
	if (!(text.startsWith('{') || text.startsWith('['))) return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function mapConnectionEntry(entry: any, isCurrentDefault: boolean): FirmConnectionEntry | null {
	if (!entry || typeof entry !== 'object') return null;
	const individualId = firstNonEmpty(entry.individualId, entry.personCrd, entry.crd, entry.crdNumber);
	if (!individualId || !/^\d{1,10}$/.test(individualId)) return null;
	const isCurrent = entry.isCurrent != null ? Boolean(entry.isCurrent) : isCurrentDefault;
	const name = toProperCaseName(firstNonEmpty(entry.name, entry.personName, entry.individualName, entry.label, entry.fullName)) || individualId;
	const startDate = firstNonEmpty(entry.startDate, entry.registrationBeginDate, entry.fromDate, entry.effectiveDate) || undefined;
	const endDate = firstNonEmpty(entry.endDate, entry.registrationEndDate, entry.toDate) || undefined;
	return {
		individualId,
		name,
		relationship: firstNonEmpty(entry.relationship) || (isCurrent ? 'Current registration' : 'Previous registration'),
		isCurrent,
		startDate,
		endDate,
		bcScope: firstNonEmpty(entry.bcScope) || undefined,
		iaScope: firstNonEmpty(entry.iaScope) || undefined,
	};
}

export function parseFirmConnectionsPayload(raw: unknown): FirmConnectionsPayload | null {
	const data = parseMaybeJson(raw) ?? raw;
	if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
	const record = data as Record<string, unknown>;
	const hasCurrent = 'currentConnections' in record || 'current' in record;
	const hasPrevious = 'previousConnections' in record || 'previous' in record;
	if (!hasCurrent && !hasPrevious) return null;

	const current = toArray(record.currentConnections ?? record.current)
		.map((entry) => mapConnectionEntry(entry, true))
		.filter((entry): entry is FirmConnectionEntry => Boolean(entry));
	const previous = toArray(record.previousConnections ?? record.previous)
		.map((entry) => mapConnectionEntry(entry, false))
		.filter((entry): entry is FirmConnectionEntry => Boolean(entry));

	return { currentConnections: current, previousConnections: previous, source: 'redis' };
}

function collectBrokerIds(raw: unknown, into: Set<string>) {
	const parsed = parseMaybeJson(raw);
	for (const id of toArray(parsed)) {
		const text = String(id ?? '').trim();
		if (/^\d{1,10}$/.test(text)) into.add(text);
	}
}

function extractNameFromSavedIndividual(raw: string | null): { name?: string; address?: string; yearsWorked?: string | number } {
	if (!raw) return {};
	let text = raw.trim();
	if (!text) return {};
	// Saved payloads may be brotli-prefixed; getCacheValue already decompresses.
	let payload: any = parseMaybeJson(text);
	if (!payload || typeof payload !== 'object') return {};

	// Unwrap common envelope shapes without pulling the full combined-bundle loader.
	if (payload.finraBrokerCheck && typeof payload.finraBrokerCheck === 'object') payload = payload.finraBrokerCheck;
	else if (payload.secInvestmentAdvisor && typeof payload.secInvestmentAdvisor === 'object') payload = payload.secInvestmentAdvisor;
	if (payload.hits?.hits?.[0]?._source) payload = payload.hits.hits[0]._source;
	if (typeof payload.content === 'string') {
		const inner = parseMaybeJson(payload.content);
		if (inner) payload = inner;
	} else if (payload.content && typeof payload.content === 'object') {
		payload = payload.content;
	} else if (typeof payload.iacontent === 'string') {
		const inner = parseMaybeJson(payload.iacontent);
		if (inner) payload = inner;
	} else if (payload.iacontent && typeof payload.iacontent === 'object') {
		payload = payload.iacontent;
	} else if (typeof payload.bccontent === 'string') {
		const inner = parseMaybeJson(payload.bccontent);
		if (inner) payload = inner;
	} else if (payload.bccontent && typeof payload.bccontent === 'object') {
		payload = payload.bccontent;
	}

	const basic = payload.basicInformation && typeof payload.basicInformation === 'object' ? payload.basicInformation : {};
	const name = [basic.firstName, basic.middleName, basic.lastName, basic.suffix].filter(Boolean).join(' ').trim();
	const yearsWorked = basic.yearsExperience ?? undefined;

	const employments = [
		...toArray(payload.currentEmployments),
		...toArray(payload.currentIAEmployments),
		...toArray(payload.ind_current_employments),
		...toArray(payload.ind_ia_current_employments),
	];
	const emp = employments.find((e: any) => e?.city && e?.state) || employments[0];
	const address = emp?.city && emp?.state ? `${emp.city}, ${emp.state}` : '';

	return {
		name: name ? toProperCaseName(name) : undefined,
		address: address || undefined,
		yearsWorked,
	};
}

async function enrichNamesLight(entries: FirmConnectionEntry[], firmId: string): Promise<FirmConnectionEntry[]> {
	if (!entries.length) return entries;
	const CHUNK = 40;
	const out = entries.slice();
	for (let i = 0; i < out.length; i += CHUNK) {
		const slice = out.slice(i, i + CHUNK);
		await Promise.all(
			slice.map(async (entry, offset) => {
				const idx = i + offset;
				try {
					const finraRaw = await getCacheValue(`finra:individual:${entry.individualId}`);
					const secRaw = finraRaw ? null : await getCacheValue(`sec:individual:${entry.individualId}`);
					const meta = extractNameFromSavedIndividual(finraRaw ?? secRaw);
					if (!meta.name && !meta.address && meta.yearsWorked == null) return;
					out[idx] = {
						...entry,
						name: meta.name || entry.name,
						address: meta.address,
						yearsWorked: meta.yearsWorked,
					};
				} catch {
					// Keep CRD placeholder on enrichment failure.
				}
			}),
		);
	}
	void firmId;
	return out;
}

export async function getFirmConnections(firmId: string): Promise<FirmConnectionsPayload> {
	const normalized = String(firmId || '').trim();
	const empty: FirmConnectionsPayload = { currentConnections: [], previousConnections: [], source: 'empty' };
	if (!normalized || !/^\d{1,10}$/.test(normalized)) return empty;

	try {
		// 1) Primary: shared broker ID lists (finra/sec …_brokers:connected|previous).
		const [finraConn, secConn, finraPrev, secPrev] = await Promise.all([
			getCacheValue(`finra:firm:${normalized}_brokers:connected`),
			getCacheValue(`sec:firm:${normalized}_brokers:connected`),
			getCacheValue(`finra:firm:${normalized}_brokers:previous`),
			getCacheValue(`sec:firm:${normalized}_brokers:previous`),
		]);

		const connectedSet = new Set<string>();
		const previousSet = new Set<string>();
		collectBrokerIds(finraConn, connectedSet);
		collectBrokerIds(secConn, connectedSet);
		collectBrokerIds(finraPrev, previousSet);
		collectBrokerIds(secPrev, previousSet);

		// Prefer "current" when an ID appears in both lists.
		for (const id of connectedSet) previousSet.delete(id);

		if (connectedSet.size || previousSet.size) {
			let currentConnections: FirmConnectionEntry[] = Array.from(connectedSet).map((id) => ({
				individualId: id,
				name: `CRD ${id}`,
				relationship: 'Current registration',
				isCurrent: true,
			}));
			let previousConnections: FirmConnectionEntry[] = Array.from(previousSet).map((id) => ({
				individualId: id,
				name: `CRD ${id}`,
				relationship: 'Previous registration',
				isCurrent: false,
			}));

			// Light name enrichment only — never call loadCombinedSavedPayloadBundle here
			// (that path was timing out firm pages with hundreds of people).
			[currentConnections, previousConnections] = await Promise.all([
				enrichNamesLight(currentConnections, normalized),
				enrichNamesLight(previousConnections, normalized),
			]);

			return { currentConnections, previousConnections, source: 'redis' };
		}

		// 2) Legacy named caches only when broker lists are absent.
		for (const key of REDIS_CACHE_KEYS(normalized)) {
			const raw = await getCacheValue(key);
			const parsed = parseFirmConnectionsPayload(raw);
			if (parsed && (parsed.currentConnections.length > 0 || parsed.previousConnections.length > 0)) {
				return parsed;
			}
		}

		return empty;
	} catch {
		return empty;
	}
}
