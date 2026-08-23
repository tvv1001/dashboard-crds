import type { NextApiRequest, NextApiResponse } from 'next';
import { promises as fs } from 'fs';
import path from 'path';
import { spawn, type ChildProcessByStdio } from 'child_process';
import type { Readable } from 'stream';
import { formatErrorMessage, getCacheValue, getRedisConnectionMode, getRedisDbSize, listSavedKeysWithStats, loadSavedPayload, setCacheValue, getTopCrdsFromZset, extractDisplayNameFromContent, getContentBlock } from './_lib';
import { resolveNameFromLocalIndex } from '../../src/lib/localSearch';

type SavedSummaryGroup = {
	id: string;
	type: 'individual' | 'firm';
	crd: string;
	latestMtime: number;
	sources: Set<'finra' | 'sec'>;
	savedFiles: string[];
};

type NewCrdItem = {
	id: string;
	type: 'individual' | 'firm';
	crd: string;
	name: string;
	foundAt: string | null;
	sourceDates?: Partial<Record<'finra' | 'sec', string | null>>;
	sources: Array<'finra' | 'sec'>;
	savedFiles: string[];
};

type NewCrdsState = {
	initializedAt: string;
	lastCheckedAt: string | null;
	nextCheckAt: string | null;
	lastRecordedMaxes: {
		individual: number;
		firm: number;
	};
	items: NewCrdItem[];
	lastRun: {
		status: 'idle' | 'running' | 'complete' | 'error' | 'interrupted';
		startedAt: string | null;
		completedAt: string | null;
		exitCode: number | null;
		message: string;
		logTail: string[];
	};
	manualCooldownUntil: string | null;
};

const isServerlessRuntime = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
// On Vercel the deploy FS is read-only under /var/task; prefer Redis, then /tmp.
const derivedDir =
	isServerlessRuntime ? path.join('/tmp', 'dashboard-crds', 'data', 'derived') : path.resolve(process.cwd(), 'data', 'derived');
const highWaterReportPath = path.join(derivedDir, 'query-high-water-crds-report.json');
const highWaterFrontierPath = path.join(derivedDir, 'query-high-water-crds-frontier.json');
const newCrdsDashboardPath = path.join(derivedDir, 'new-crds-dashboard.json');
const newCrdsStateRedisKey = 'dashboard:new-crds-state';
const newCrdsCheckIntervalMs = 24 * 60 * 60 * 1000;
const newCrdsManualCooldownMs = 15 * 60 * 1000;
// External-API frontier scans are intentionally slow/intermittent — don't kick one off on
// every page load/refresh, only once this much time has passed since the last one finished.
const newCrdsAutoScanIntervalMs = 15 * 60 * 1000;
const newCrdsLogTailLimit = 40;

let newCrdScanProcess: ChildProcessByStdio<null, Readable, Readable> | null = null;

function canSpawnBackgroundScan() {
	// Serverless cannot run long-lived local tsx child processes.
	return !isServerlessRuntime;
}

function parseSavedKeyInfo(entry: string | { key?: string; mtime?: number }) {
	const key =
		typeof entry === 'string' ? entry
		: entry && typeof entry === 'object' && entry.key ? entry.key
		: '';
	const mtime = typeof entry === 'object' && entry && entry.mtime ? Number(entry.mtime) || 0 : 0;
	const match = String(key || '').match(/^(finra|sec):(individual|firm):(\d+)(?:\.json)?$/i);
	if (!match) return null;
	return {
		key,
		source: match[1].toLowerCase() as 'finra' | 'sec',
		type: match[2].toLowerCase() as 'individual' | 'firm',
		crd: match[3],
		mtime,
	};
}

function parseIsoTime(value: unknown) {
	const timestamp = Date.parse(String(value || ''));
	return Number.isFinite(timestamp) ? timestamp : 0;
}

function sanitizePositiveInt(value: unknown) {
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

async function collectRedisHighWaterSummary() {
	const mode = getRedisConnectionMode();
	const configured = mode !== 'none';
	const checkedAt = new Date().toISOString();
	if (!configured) {
		return {
			configured,
			mode,
			checkedAt,
			totalSavedCrds: 0,
			sections: { individual: [], firm: [] },
			message: 'Redis is not configured.',
		};
	}

	const topIndividualCrds = await getTopCrdsFromZset('individual', 20);
	const topFirmCrds = await getTopCrdsFromZset('firm', 20);
	const allTopCrds = [...topIndividualCrds, ...topFirmCrds];

	let indexKeys = [];
	if (allTopCrds.length > 0) {
		const result = await listSavedKeysWithStats({ limit: 0, includeCrds: allTopCrds });
		indexKeys = result.keys;
	} else {
		// Fallback to full DB scan if cronjob hasn't populated zsets
		const result = await listSavedKeysWithStats({ limit: 0, sort: 'crd-desc' });
		indexKeys = result.keys;
	}

	const uniqueTotalCrds = await getRedisDbSize();
	const grouped = new Map<string, NewCrdItem>();

	for (const entry of indexKeys) {
		const crd = sanitizePositiveInt(entry.crd);
		if (!crd) continue;
		// If we're using ZSETs, forcefully ignore everything else!
		if (allTopCrds.length > 0 && !allTopCrds.includes(String(crd))) continue;

		const id = `${entry.type}:${entry.crd}`;
		const foundAt = entry.mtime ? new Date(entry.mtime).toISOString() : checkedAt;
		const existing = grouped.get(id);
		if (existing) {
			const existingSources = new Set(existing.sources);
			existingSources.add(entry.source);
			const savedFiles = new Set(existing.savedFiles || []);
			savedFiles.add(entry.key);
			grouped.set(id, {
				...existing,
				sources: Array.from(existingSources),
				savedFiles: Array.from(savedFiles),
				foundAt: existing.foundAt || foundAt,
			});
			continue;
		}
		grouped.set(id, {
			id,
			type: entry.type,
			crd: entry.crd,
			name: entry.displayName || `#${entry.crd}`,
			foundAt,
			sources: [entry.source],
			savedFiles: [entry.key],
		});
	}

	// Ensure all top CRDs have a proper name, falling back to loading their payload if missing or generic
	
	for (const crd of topIndividualCrds) {
		const id = `individual:${crd}`;
		const existing = grouped.get(id);
		if (!existing || existing.name.startsWith('#')) {
			const sources = ['finra', 'sec'] as const;
			let resolvedName: string | null = null;
			for (const source of sources) {
				try {
					const rawKey = `${source}:individual:${crd}`;
					const payload = await loadSavedPayload(rawKey);
					if (payload) {
						const content = getContentBlock(rawKey, payload);
						resolvedName = extractDisplayNameFromContent(rawKey, content);
						if (resolvedName) break;
					} else {
						// Fallback to sidecar flatfile
						resolvedName = await resolveNameFromLocalIndex(source, 'individual', crd);
						if (resolvedName) break;
					}
				} catch (err) {}
			}
			const finalName = resolvedName || `#${crd}`;
			if (existing) {
				existing.name = finalName;
			} else {
				grouped.set(id, { id, type: 'individual', crd, name: finalName, foundAt: checkedAt, sources: ['finra'], savedFiles: [] });
			}
		}
	}

	for (const crd of topFirmCrds) {
		const id = `firm:${crd}`;
		const existing = grouped.get(id);
		if (!existing || existing.name.startsWith('#')) {
			const sources = ['finra', 'sec'] as const;
			let resolvedName: string | null = null;
			for (const source of sources) {
				try {
					const rawKey = `${source}:firm:${crd}`;
					const payload = await loadSavedPayload(rawKey);
					if (payload) {
						const content = getContentBlock(rawKey, payload);
						resolvedName = extractDisplayNameFromContent(rawKey, content);
						if (resolvedName) break;
					} else {
						// Fallback to sidecar flatfile
						resolvedName = await resolveNameFromLocalIndex(source, 'firm', crd);
						if (resolvedName) break;
					}
				} catch (err) {}
			}
			const finalName = resolvedName || `#${crd}`;
			if (existing) {
				existing.name = finalName;
			} else {
				grouped.set(id, { id, type: 'firm', crd, name: finalName, foundAt: checkedAt, sources: ['finra'], savedFiles: [] });
			}
		}
	}

	const sortByCrdDesc = (left: NewCrdItem, right: NewCrdItem) => Number(right.crd) - Number(left.crd) || String(right.foundAt || '').localeCompare(String(left.foundAt || ''));
	const maxItems = 20;
	const sections = {
		individual: Array.from(grouped.values()).filter((item) => item.type === 'individual').sort(sortByCrdDesc).slice(0, maxItems),
		firm: Array.from(grouped.values()).filter((item) => item.type === 'firm').sort(sortByCrdDesc).slice(0, maxItems),
	};

	return {
		configured,
		mode,
		checkedAt,
		totalSavedCrds: uniqueTotalCrds,
		sections,
		message: uniqueTotalCrds > 0 ? 'Showing the highest CRD numbers currently saved in Redis, split by person and firm.' : 'No CRDs are currently saved in Redis.',
	};
}

function parseCalendarDateValue(value: unknown) {
	const text = typeof value === 'string' ? value.trim() : '';
	if (!text) return null;
	let match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
	if (match) {
		const month = Number(match[1]);
		const day = Number(match[2]);
		const year = Number(match[3]);
		if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
			return {
				key: year * 10000 + month * 100 + day,
				iso: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
			};
		}
	}
	match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (match) {
		const year = Number(match[1]);
		const month = Number(match[2]);
		const day = Number(match[3]);
		if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
			return {
				key: year * 10000 + month * 100 + day,
				iso: `${match[1]}-${match[2]}-${match[3]}`,
			};
		}
	}
	return null;
}

function pickEarliestCalendarDate(values: unknown[]) {
	let best: { key: number; iso: string } | null = null;
	for (const value of values) {
		const parsed = parseCalendarDateValue(value);
		if (!parsed) continue;
		if (!best || parsed.key < best.key) {
			best = parsed;
		}
	}
	return best ? best.iso : null;
}

function pickLatestCalendarDate(values: unknown[]) {
	let best: { key: number; iso: string } | null = null;
	for (const value of values) {
		const parsed = parseCalendarDateValue(value);
		if (!parsed) continue;
		if (!best || parsed.key > best.key) {
			best = parsed;
		}
	}
	return best ? best.iso : null;
}

function collectObjectDateValues(entries: unknown, key: string) {
	if (!Array.isArray(entries)) return [];
	return entries.map((entry) => (entry && typeof entry === 'object' ? (entry as Record<string, unknown>)[key] : null)).filter(Boolean);
}

function unwrapSavedPayloadContent(payload: unknown) {
	if (payload && typeof payload === 'object') {
		const typed = payload as { finraBrokerCheck?: unknown; secInvestmentAdvisor?: unknown; content?: unknown; iacontent?: unknown };
		if (typed.finraBrokerCheck && typeof typed.finraBrokerCheck === 'object') return typed.finraBrokerCheck as Record<string, unknown>;
		if (typed.secInvestmentAdvisor && typeof typed.secInvestmentAdvisor === 'object') return typed.secInvestmentAdvisor as Record<string, unknown>;
		if (typed.content && typeof typed.content === 'object') return typed.content as Record<string, unknown>;
		if (typed.iacontent && typeof typed.iacontent === 'object') return typed.iacontent as Record<string, unknown>;
		return payload as Record<string, unknown>;
	}
	return null;
}

function getSavedFileSource(savedFile: string) {
	const match = String(savedFile || '').match(/^(finra|sec):/i);
	return match ? match[1].toLowerCase() : '';
}

function extractFinraIndustryDate(payload: unknown) {
	const content = unwrapSavedPayloadContent(payload);
	if (!content) return null;
	const basicInformation = content.basicInformation && typeof content.basicInformation === 'object' ? (content.basicInformation as Record<string, unknown>) : {};
	return pickLatestCalendarDate([basicInformation.daysInIndustryCalculatedDate]);
}

function extractSecIndustryDate(payload: unknown) {
	const content = unwrapSavedPayloadContent(payload);
	if (!content) return null;
	const basicInformation = content.basicInformation && typeof content.basicInformation === 'object' ? (content.basicInformation as Record<string, unknown>) : {};
	return pickLatestCalendarDate([basicInformation.daysInIndustryCalculatedDateIAPD]);
}

function normalizeSourceDates(value: unknown): Partial<Record<'finra' | 'sec', string | null>> {
	if (!value || typeof value !== 'object') return {};
	const typed = value as Record<string, unknown>;
	const sourceDates: Partial<Record<'finra' | 'sec', string | null>> = {};
	for (const source of ['finra', 'sec'] as const) {
		const parsed = parseCalendarDateValue(typed[source]);
		if (parsed) sourceDates[source] = parsed.iso;
	}
	return sourceDates;
}

async function resolveNewCrdSourceDates(savedFiles: string[], type: 'individual' | 'firm') {
	if (type !== 'individual' || !Array.isArray(savedFiles) || !savedFiles.length) return {};
	const entries = await Promise.all(
		savedFiles.map(async (savedFile) => {
			try {
				return {
					source: getSavedFileSource(savedFile),
					payload: await loadSavedPayload(savedFile),
				};
			} catch (e) {
				console.warn(`Could not load payload for ${savedFile} during new-crds resolution: ${formatErrorMessage(e)}`);
				return null;
			}
		}),
	);
	const validEntries = entries.filter((e): e is { source: string; payload: any } => e !== null);
	const sourceDates: Partial<Record<'finra' | 'sec', string | null>> = {};
	const finraDate = pickLatestCalendarDate(validEntries.filter((entry) => entry.source === 'finra').map((entry) => extractFinraIndustryDate(entry.payload)));
	if (finraDate) sourceDates.finra = finraDate;
	const secDate = pickLatestCalendarDate(validEntries.filter((entry) => entry.source === 'sec').map((entry) => extractSecIndustryDate(entry.payload)));
	if (secDate) sourceDates.sec = secDate;
	return sourceDates;
}

function createEmptyNewCrdsState(savedMaxes: Partial<Record<'individual' | 'firm', number>> = {}): NewCrdsState {
	const now = new Date().toISOString();
	return {
		initializedAt: now,
		lastCheckedAt: null,
		nextCheckAt: null,
		lastRecordedMaxes: {
			individual: sanitizePositiveInt(savedMaxes.individual),
			firm: sanitizePositiveInt(savedMaxes.firm),
		},
		items: [],
		lastRun: {
			status: 'idle',
			startedAt: null,
			completedAt: null,
			exitCode: null,
			message: 'Waiting for the first high-water CRD check.',
			logTail: [],
		},
		manualCooldownUntil: null,
	};
}

async function ensureDerivedDir() {
	try {
		await fs.mkdir(derivedDir, { recursive: true });
		return true;
	} catch (error) {
		// Serverless/read-only deploy FS — Redis is the source of truth for state.
		console.warn(`new-crds: could not ensure derived dir ${derivedDir}: ${formatErrorMessage(error)}`);
		return false;
	}
}

async function readNewCrdsStateRaw(): Promise<string | null> {
	if (getRedisConnectionMode() !== 'none') {
		try {
			const fromRedis = await getCacheValue(newCrdsStateRedisKey);
			if (fromRedis) return fromRedis;
		} catch (error) {
			console.warn(`new-crds: redis state read failed: ${formatErrorMessage(error)}`);
		}
	}
	try {
		return await fs.readFile(newCrdsDashboardPath, 'utf-8');
	} catch (error: unknown) {
		const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: string }).code || '') : '';
		if (code === 'ENOENT') return null;
		throw error;
	}
}

async function collectSavedCrdGroups() {
	const { keys: entries } = await listSavedKeysWithStats({ limit: 0 });
	const groups = new Map<string, SavedSummaryGroup>();
	const maxes = { individual: 0, firm: 0 };
	for (const entry of entries) {
		const parsed = parseSavedKeyInfo(entry);
		if (!parsed) continue;
		const groupKey = `${parsed.type}:${parsed.crd}`;
		if (!groups.has(groupKey)) {
			groups.set(groupKey, {
				id: groupKey,
				type: parsed.type,
				crd: parsed.crd,
				latestMtime: 0,
				sources: new Set(),
				savedFiles: [],
			});
		}
		const group = groups.get(groupKey)!;
		group.latestMtime = Math.max(group.latestMtime, parsed.mtime);
		group.sources.add(parsed.source);
		if (!group.savedFiles.includes(parsed.key)) group.savedFiles.push(parsed.key);
		const crdValue = sanitizePositiveInt(parsed.crd);
		if (crdValue > maxes[parsed.type]) {
			maxes[parsed.type] = crdValue;
		}
	}
	for (const group of groups.values()) {
		group.savedFiles.sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' }));
	}
	return { groups: Array.from(groups.values()), maxes };
}

function normalizeNewCrdItem(item: unknown): NewCrdItem | null {
	if (!item || typeof item !== 'object') return null;
	const typed = item as Partial<NewCrdItem>;
	const type =
		typed.type === 'firm' ? 'firm'
		: typed.type === 'individual' ? 'individual'
		: null;
	const crd = String(typed.crd || '').trim();
	if (!type || !/^\d+$/.test(crd)) return null;
	const sources =
		Array.isArray(typed.sources) ?
			Array.from(new Set(typed.sources.map((source) => String(source || '').toLowerCase()).filter((source): source is 'finra' | 'sec' => source === 'finra' || source === 'sec')))
		:	[];
	const savedFiles = Array.isArray(typed.savedFiles) ? Array.from(new Set(typed.savedFiles.map((file) => String(file || '').trim()).filter(Boolean))) : [];
	const foundAt = parseIsoTime(typed.foundAt) ? new Date(String(typed.foundAt)).toISOString() : null;
	return {
		id: `${type}:${crd}`,
		type,
		crd,
		name: String(typed.name || '').trim() || `#${crd}`,
		foundAt,
		sourceDates: normalizeSourceDates(typed.sourceDates),
		sources,
		savedFiles,
	};
}

function compareNewCrdItems(left: NewCrdItem, right: NewCrdItem) {
	return (
		parseIsoTime(right.foundAt) - parseIsoTime(left.foundAt) ||
		Number(right.crd) - Number(left.crd) ||
		left.id.localeCompare(right.id, undefined, { numeric: true, sensitivity: 'base' })
	);
}

function buildNewCrdItemFromGroup(group: SavedSummaryGroup, existingItem: NewCrdItem | null = null): NewCrdItem {
	return {
		id: group.id,
		type: group.type,
		crd: group.crd,
		name: existingItem?.name || `#${group.crd}`,
		foundAt:
			existingItem && parseIsoTime(existingItem.foundAt) ? existingItem.foundAt
			: group.latestMtime ? new Date(group.latestMtime).toISOString()
			: new Date().toISOString(),
		sources: Array.from(group.sources).sort((left, right) => left.localeCompare(right)),
		savedFiles: group.savedFiles.slice(),
	};
}

async function writeNewCrdsState(state: NewCrdsState) {
	const payload = JSON.stringify(state, null, 2);
	let wroteSomewhere = false;
	if (getRedisConnectionMode() !== 'none') {
		try {
			await setCacheValue(newCrdsStateRedisKey, payload);
			wroteSomewhere = true;
		} catch (error) {
			console.warn(`new-crds: redis state write failed: ${formatErrorMessage(error)}`);
		}
	}
	const dirOk = await ensureDerivedDir();
	if (dirOk) {
		try {
			await fs.writeFile(newCrdsDashboardPath, payload, 'utf-8');
			wroteSomewhere = true;
		} catch (error) {
			console.warn(`new-crds: disk state write failed: ${formatErrorMessage(error)}`);
		}
	}
	if (!wroteSomewhere) {
		// Still allow the request to succeed; redisHighWater does not depend on this file.
		console.warn('new-crds: state was not persisted (no Redis and no writable disk).');
	}
}

async function loadNewCrdsState(savedSummary: Awaited<ReturnType<typeof collectSavedCrdGroups>> | null = null, options: { preserveRunning?: boolean } = {}) {
	const summary = savedSummary || (await collectSavedCrdGroups());
	const defaultState = createEmptyNewCrdsState(summary.maxes);
	try {
		const raw = await readNewCrdsStateRaw();
		if (!raw) {
			await writeNewCrdsState(defaultState);
			return defaultState;
		}
		const parsed = JSON.parse(raw) as Partial<NewCrdsState>;
		const state: NewCrdsState = {
			initializedAt: parseIsoTime(parsed?.initializedAt) ? new Date(String(parsed.initializedAt)).toISOString() : defaultState.initializedAt,
			lastCheckedAt: parseIsoTime(parsed?.lastCheckedAt) ? new Date(String(parsed.lastCheckedAt)).toISOString() : null,
			nextCheckAt: parseIsoTime(parsed?.nextCheckAt) ? new Date(String(parsed.nextCheckAt)).toISOString() : null,
			lastRecordedMaxes: {
				individual: sanitizePositiveInt(parsed?.lastRecordedMaxes?.individual),
				firm: sanitizePositiveInt(parsed?.lastRecordedMaxes?.firm),
			},
			items:
				Array.isArray(parsed?.items) ?
					parsed.items
						.map(normalizeNewCrdItem)
						.filter((item): item is NewCrdItem => !!item)
						.sort(compareNewCrdItems)
				:	[],
			lastRun: {
				status: parsed?.lastRun?.status && ['idle', 'running', 'complete', 'error', 'interrupted'].includes(parsed.lastRun.status) ? parsed.lastRun.status : 'idle',
				startedAt: parseIsoTime(parsed?.lastRun?.startedAt) ? new Date(String(parsed?.lastRun?.startedAt)).toISOString() : null,
				completedAt: parseIsoTime(parsed?.lastRun?.completedAt) ? new Date(String(parsed?.lastRun?.completedAt)).toISOString() : null,
				exitCode: Number.isInteger(parsed?.lastRun?.exitCode) ? parsed!.lastRun!.exitCode : null,
				message: typeof parsed?.lastRun?.message === 'string' && parsed.lastRun.message ? parsed.lastRun.message : defaultState.lastRun.message,
				logTail:
					Array.isArray(parsed?.lastRun?.logTail) ?
						parsed.lastRun.logTail
							.map((line) => String(line || ''))
							.filter(Boolean)
							.slice(-newCrdsLogTailLimit)
					:	[],
			},
			manualCooldownUntil: parseIsoTime(parsed?.manualCooldownUntil) ? new Date(String(parsed.manualCooldownUntil)).toISOString() : null,
		};
		if (!options.preserveRunning && !newCrdScanProcess && state.lastRun.status === 'running') {
			state.lastRun.status = 'interrupted';
			state.lastRun.completedAt = new Date().toISOString();
			state.lastRun.message = 'The previous high-water CRD check was interrupted before completion.';
		}
		return state;
	} catch (error: unknown) {
		const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: string }).code || '') : '';
		if (code === 'ENOENT') {
			await writeNewCrdsState(defaultState);
			return defaultState;
		}
		console.warn(`new-crds: load state failed, using defaults: ${formatErrorMessage(error)}`);
		return defaultState;
	}
}

async function reconcileAndSaveNewCrdsState(state: NewCrdsState, savedSummary: Awaited<ReturnType<typeof collectSavedCrdGroups>> | null = null) {
	const summary = savedSummary || (await collectSavedCrdGroups());
	const nextState: NewCrdsState = {
		...state,
		lastRecordedMaxes: {
			individual: sanitizePositiveInt(state?.lastRecordedMaxes?.individual),
			firm: sanitizePositiveInt(state?.lastRecordedMaxes?.firm),
		},
		items: Array.isArray(state?.items) ? state.items.map(normalizeNewCrdItem).filter((item): item is NewCrdItem => !!item) : [],
	};
	const previousMaxes = {
		individual: nextState.lastRecordedMaxes.individual,
		firm: nextState.lastRecordedMaxes.firm,
	};
	const itemsById = new Map(nextState.items.map((item) => [item.id, item]));
	for (const group of summary.groups) {
		const existingItem = itemsById.get(group.id) || null;
		const crdValue = sanitizePositiveInt(group.crd);
		const isNewAboveTrackedMax = crdValue > previousMaxes[group.type];
		if (!existingItem && !isNewAboveTrackedMax) continue;
		itemsById.set(group.id, buildNewCrdItemFromGroup(group, existingItem));
	}
	nextState.items = await Promise.all(
		Array.from(itemsById.values())
			.sort(compareNewCrdItems)
			.map(async (item) => ({
				...item,
				sourceDates: await resolveNewCrdSourceDates(item.savedFiles, item.type),
			})),
	);
	nextState.lastRecordedMaxes = {
		individual: Math.max(previousMaxes.individual, sanitizePositiveInt(summary.maxes.individual)),
		firm: Math.max(previousMaxes.firm, sanitizePositiveInt(summary.maxes.firm)),
	};
	await writeNewCrdsState(nextState);
	return nextState;
}

async function loadHighWaterFrontierSummary() {
	try {
		const parsed = JSON.parse(await fs.readFile(highWaterFrontierPath, 'utf-8')) as {
			frontiers?: Record<string, { baselineMaxCrd?: number; nextCrd?: number; misses?: Record<string, unknown> }>;
		};
		const summary: Record<string, { baselineMaxCrd: number; nextCrd: number; missCount: number }> = {};
		for (const type of ['individual', 'firm'] as const) {
			const frontier = parsed?.frontiers?.[type];
			if (!frontier || typeof frontier !== 'object') continue;
			summary[type] = {
				baselineMaxCrd: sanitizePositiveInt(frontier.baselineMaxCrd),
				nextCrd: sanitizePositiveInt(frontier.nextCrd),
				missCount: frontier.misses && typeof frontier.misses === 'object' ? Object.keys(frontier.misses).length : 0,
			};
		}
		return summary;
	} catch (error: unknown) {
		const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: string }).code || '') : '';
		if (code === 'ENOENT') return {};
		throw error;
	}
}

async function loadHighWaterReportSummary() {
	try {
		const parsed = JSON.parse(await fs.readFile(highWaterReportPath, 'utf-8')) as {
			startedAt?: string;
			completedAt?: string;
			processedCrds?: number;
			lastProcessed?: { type?: string; crd?: string; outcome?: string; at?: string };
		};
		return {
			startedAt: parseIsoTime(parsed?.startedAt) ? new Date(String(parsed.startedAt)).toISOString() : null,
			completedAt: parseIsoTime(parsed?.completedAt) ? new Date(String(parsed.completedAt)).toISOString() : null,
			processedCrds: sanitizePositiveInt(parsed?.processedCrds),
			lastProcessed:
				parsed?.lastProcessed && typeof parsed.lastProcessed === 'object' ?
					{
						type:
							parsed.lastProcessed.type === 'firm' ? 'firm'
							: parsed.lastProcessed.type === 'individual' ? 'individual'
							: null,
						crd: /^\d+$/.test(String(parsed.lastProcessed.crd || '')) ? String(parsed.lastProcessed.crd) : null,
						outcome: typeof parsed.lastProcessed.outcome === 'string' ? parsed.lastProcessed.outcome : null,
						at: parseIsoTime(parsed.lastProcessed.at) ? new Date(String(parsed.lastProcessed.at)).toISOString() : null,
					}
				:	null,
		};
	} catch (error: unknown) {
		const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: string }).code || '') : '';
		if (code === 'ENOENT') return null;
		throw error;
	}
}

function pushNewCrdLogLines(lines: string[], chunk: Buffer | string) {
	const entries = String(chunk || '')
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	for (const entry of entries) lines.push(entry);
	while (lines.length > newCrdsLogTailLimit) lines.shift();
}

async function startNewCrdBackgroundScan(reason: 'scheduled' | 'manual' = 'scheduled') {
	if (newCrdScanProcess) return false;
	if (!canSpawnBackgroundScan()) {
		// Vercel/serverless: still return Redis high-water list; crawls run from a host/cron with disk.
		const savedSummary = await collectSavedCrdGroups();
		const state = await loadNewCrdsState(savedSummary, { preserveRunning: true });
		const now = new Date().toISOString();
		state.lastRun = {
			status: 'idle',
			startedAt: state.lastRun.startedAt,
			completedAt: state.lastRun.completedAt || now,
			exitCode: null,
			message: 'Background high-water scan is disabled on serverless. Showing highest CRDs currently saved in Redis.',
			logTail: state.lastRun.logTail || [],
		};
		if (reason === 'manual') {
			state.manualCooldownUntil = new Date(Date.now() + newCrdsManualCooldownMs).toISOString();
		}
		await writeNewCrdsState(state);
		return false;
	}
	const savedSummary = await collectSavedCrdGroups();
	const state = await loadNewCrdsState(savedSummary, { preserveRunning: true });
	const startedAt = new Date().toISOString();
	state.lastRun = {
		status: 'running',
		startedAt,
		completedAt: null,
		exitCode: null,
		message: reason === 'manual' ? 'Manual high-water CRD check started.' : 'Daily high-water CRD check started.',
		logTail: [],
	};
	if (reason === 'manual') {
		state.manualCooldownUntil = new Date(Date.now() + newCrdsManualCooldownMs).toISOString();
	}
	await writeNewCrdsState(state);

	const tsxBinary = path.resolve(process.cwd(), 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
	const child = spawn(tsxBinary, ['scripts/query-high-water-crds.ts'], {
		cwd: process.cwd(),
		env: process.env,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	newCrdScanProcess = child;
	const logTail: string[] = [];
	let finalized = false;

	const finalize = async (status: NewCrdsState['lastRun']['status'], exitCode: number | null, messageOverride = '') => {
		if (finalized) return;
		finalized = true;
		const finishedAt = new Date().toISOString();
		const finalSummary = await collectSavedCrdGroups();
		let nextState = await loadNewCrdsState(finalSummary, { preserveRunning: true });
		nextState = await reconcileAndSaveNewCrdsState(nextState, finalSummary);
		nextState.lastCheckedAt = finishedAt;
		nextState.nextCheckAt = new Date(Date.now() + newCrdsCheckIntervalMs).toISOString();
		nextState.lastRun = {
			status,
			startedAt: nextState.lastRun?.startedAt || startedAt,
			completedAt: finishedAt,
			exitCode,
			message: messageOverride || (status === 'complete' ? 'High-water CRD check complete.' : 'High-water CRD check failed.'),
			logTail: logTail.slice(-newCrdsLogTailLimit),
		};
		await writeNewCrdsState(nextState);
		newCrdScanProcess = null;
	};

	child.stdout.on('data', (chunk) => pushNewCrdLogLines(logTail, chunk));
	child.stderr.on('data', (chunk) => pushNewCrdLogLines(logTail, chunk));
	child.on('error', async (error) => {
		await finalize('error', null, formatErrorMessage(error) || 'Failed to start the high-water CRD check.');
	});
	child.on('close', async (code) => {
		await finalize(code === 0 ? 'complete' : 'error', typeof code === 'number' ? code : null, code === 0 ? '' : `High-water CRD check exited with code ${code}.`);
	});
	return true;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
	try {
		if (req.method !== 'GET') {
			return res.status(405).json({ error: 'Method not allowed' });
		}

		// Phase 1: scan Redis for the current high-water CRDs (fast, always fresh).
		const redisHighWater = await collectRedisHighWaterSummary();

		const force = req.query.force === 'true';
		let savedSummary = await collectSavedCrdGroups();
		let state = await loadNewCrdsState(savedSummary);

		const cooldownActive = Boolean(state.manualCooldownUntil && parseIsoTime(state.manualCooldownUntil) > Date.now());
		const alreadyRunning = Boolean(newCrdScanProcess) || state.lastRun.status === 'running';
		const lastFinishedAt = parseIsoTime(state.lastRun.completedAt) || parseIsoTime(state.lastCheckedAt);
		const intervalElapsed = !lastFinishedAt || Date.now() - lastFinishedAt >= newCrdsAutoScanIntervalMs;
		const due = !alreadyRunning && !(force && cooldownActive) && (force || intervalElapsed);

		// Phase 2: kick off (or reuse) an external-API frontier scan so newly published CRDs
		// beyond what's already in Redis get discovered. This is intentionally slow/intermittent
		// (throttled to once per newCrdsAutoScanIntervalMs) and runs in the background
		// (fire-and-forget) so the response above isn't blocked on upstream API latency.
		let triggered = false;
		if (due) {
			triggered = await startNewCrdBackgroundScan(force ? 'manual' : 'scheduled');
			if (triggered) {
				savedSummary = await collectSavedCrdGroups();
				state = await loadNewCrdsState(savedSummary, { preserveRunning: true });
			}
		}

		const frontiers = await loadHighWaterFrontierSummary();
		const lastReport = await loadHighWaterReportSummary();
		const scanInProgress = Boolean(newCrdScanProcess) || state.lastRun.status === 'running';

		return res.status(200).json({
			...state,
			redisHighWater,
			frontiers,
			lastReport,
			scanInProgress,
			triggered,
			due,
			cooldownActive,
			cooldownUntil: state.manualCooldownUntil,
		});
	} catch (error) {
		return res.status(500).json({ error: formatErrorMessage(error) });
	}
}
