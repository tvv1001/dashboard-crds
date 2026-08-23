// Read-only firm → employee connections from Redis cache only.
//
// Keys:
//   graph:firm-emp-adj:v1:{firmId}
//   graph:firm-connections:v9:{firmId}
// Payload:
//   { currentConnections | current, previousConnections | previous }
//   entry: { individualId | personCrd | crd, name, relationship, isCurrent, startDate?, endDate? }
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
};

export type FirmConnectionsPayload = {
	currentConnections: FirmConnectionEntry[];
	previousConnections: FirmConnectionEntry[];
	source: 'redis' | 'empty';
};

const REDIS_CACHE_KEYS = (firmId: string) => [`graph:firm-connections:v10:${firmId}`, `graph:firm-connections:v9:${firmId}`, `graph:firm-emp-adj:v1:${firmId}`];

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

export async function getFirmConnections(firmId: string): Promise<FirmConnectionsPayload> {
	const normalized = String(firmId || '').trim();
	const empty: FirmConnectionsPayload = { currentConnections: [], previousConnections: [], source: 'empty' };
	if (!normalized || !/^\d{1,10}$/.test(normalized)) return empty;

	try {
		const finraConn = await getCacheValue(`finra:firm:${normalized}_brokers:connected`);
		const secConn = await getCacheValue(`sec:firm:${normalized}_brokers:connected`);
		const finraPrev = await getCacheValue(`finra:firm:${normalized}_brokers:previous`);
		const secPrev = await getCacheValue(`sec:firm:${normalized}_brokers:previous`);

		const connectedSet = new Set<string>();
		const previousSet = new Set<string>();

		if (finraConn) toArray(parseMaybeJson(finraConn)).forEach(id => connectedSet.add(String(id)));
		if (secConn) toArray(parseMaybeJson(secConn)).forEach(id => connectedSet.add(String(id)));
		if (finraPrev) toArray(parseMaybeJson(finraPrev)).forEach(id => previousSet.add(String(id)));
		if (secPrev) toArray(parseMaybeJson(secPrev)).forEach(id => previousSet.add(String(id)));

		const currentConnections = Array.from(connectedSet).map(id => ({
			individualId: id,
			name: `CRD ${id}`,
			relationship: 'Current registration',
			isCurrent: true
		}));

		const previousConnections = Array.from(previousSet).map(id => ({
			individualId: id,
			name: `CRD ${id}`,
			relationship: 'Previous registration',
			isCurrent: false
		}));

		if (currentConnections.length || previousConnections.length) {
			return { currentConnections, previousConnections, source: 'redis' };
		}
	} catch (e) {
		// skip on error
	}

	return empty;
}
