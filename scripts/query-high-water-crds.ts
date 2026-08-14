#!/usr/bin/env node
import { promises as fs } from 'fs';
import path from 'path';
import {
	buildEndpoint,
	detailFilenameForSource,
	fetchWithCache,
	formatErrorMessage,
	hasBlockingIndicators,
	inspectSavedPayload,
	isEmptyPayload,
	listSavedKeysWithStats,
	syncSavedPayload,
} from '../pages/api/_lib';

type Source = 'finra' | 'sec';
type EntityType = 'firm' | 'individual';
type SourceAttemptStatus =
	| 'skipped-existing'
	| 'downloaded'
	| 'updated'
	| 'repaired'
	| 'unchanged'
	| 'empty'
	| 'blocked'
	| 'error';

type SourceAttemptResult = {
	status: Exclude<SourceAttemptStatus, 'error'>;
	filename: string;
};

type FrontierMissEntry = {
	attempts: number;
	lastAttemptedAt: string;
	sourceStatuses: Partial<Record<Source, 'empty' | 'blocked'>>;
};

type FrontierTypeState = {
	baselineMaxCrd: number;
	nextCrd: number;
	misses: Record<string, FrontierMissEntry>;
};

type FrontierSnapshot = {
	generatedAt: string;
	frontiers: Partial<Record<EntityType, FrontierTypeState>>;
};

type TypePlan = {
	type: EntityType;
	sources: Source[];
	sourceMaxes: Partial<Record<Source, number>>;
	currentMaxCrd: number;
	nextCrd: number;
	recordedMissCount: number;
};

const rawDir = path.resolve(process.cwd(), 'data', 'raw');
const outDir = path.resolve(process.cwd(), 'data', 'derived');
const reportPath = path.join(outDir, 'query-high-water-crds-report.json');
const frontierPath = path.join(outDir, 'query-high-water-crds-frontier.json');

function parsePositiveInteger(value: string) {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
	return parsed;
}

function parseArgs(argv: string[]) {
	const config = {
		types: ['firm', 'individual'] as EntityType[],
		sources: ['finra', 'sec'] as Source[],
		maxCrdsPerType: 20,
		stopAfterEmptyMisses: 10,
		refreshFrontier: false,
	};

	for (const arg of argv) {
		if (arg === '--refresh-frontier') {
			config.refreshFrontier = true;
			continue;
		}
		if (arg.startsWith('--types=')) {
			const parsed = arg
				.slice('--types='.length)
				.split(',')
				.map((value) => value.trim().toLowerCase())
				.filter((value): value is EntityType => value === 'firm' || value === 'individual');
			if (parsed.length) config.types = Array.from(new Set(parsed));
			continue;
		}
		if (arg.startsWith('--sources=')) {
			const parsed = arg
				.slice('--sources='.length)
				.split(',')
				.map((value) => value.trim().toLowerCase())
				.filter((value): value is Source => value === 'finra' || value === 'sec');
			if (parsed.length) config.sources = Array.from(new Set(parsed));
			continue;
		}
		if (arg.startsWith('--max-crds-per-type=')) {
			const parsed = parsePositiveInteger(arg.slice('--max-crds-per-type='.length));
			if (parsed) config.maxCrdsPerType = parsed;
			continue;
		}
		if (arg.startsWith('--stop-after-empty-misses=')) {
			const parsed = parsePositiveInteger(arg.slice('--stop-after-empty-misses='.length));
			if (parsed) config.stopAfterEmptyMisses = parsed;
		}
	}

	return config;
}

import { listRawKeysFromRedis, parseSavedRawKey } from '../pages/api/_lib';
async function collectSavedMaxes() {
	const maxes: Partial<Record<`${Source}:${EntityType}`, number>> = {};
	
	try {
		const rawKeys = await listRawKeysFromRedis();
		for (const rawKey of rawKeys) {
			const parsed = parseSavedRawKey(rawKey);
			if (!parsed) continue;
			const source = parsed.source as Source;
			const type = parsed.type as EntityType;
			const crd = Number(parsed.crd);
			if (!Number.isSafeInteger(crd) || crd <= 0) continue;
			
			const key = `${source}:${type}` as const;
			if (!maxes[key] || crd > (maxes[key] || 0)) {
				maxes[key] = crd;
			}
		}
		if (Object.keys(maxes).length > 0) return maxes;
	} catch (e) {
		// Fallback
	}

	const stats = await listSavedKeysWithStats({ limit: 0 });
	for (const entry of stats.keys) {
		const source = entry.source as Source;
		const type = entry.type as EntityType;
		const crd = Number(entry.crd);
		if (!Number.isSafeInteger(crd) || crd <= 0) continue;
		const key = `${source}:${type}` as const;
		if (!maxes[key] || crd > (maxes[key] || 0)) {
			maxes[key] = crd;
		}
	}

	return maxes;
}

async function loadFrontierSnapshot(): Promise<FrontierSnapshot> {
	try {
		const parsed = JSON.parse(await fs.readFile(frontierPath, 'utf-8')) as Partial<FrontierSnapshot>;
		const snapshot: FrontierSnapshot = {
			generatedAt: typeof parsed.generatedAt === 'string' && parsed.generatedAt ? parsed.generatedAt : new Date().toISOString(),
			frontiers: {},
		};

		for (const type of ['firm', 'individual'] as const) {
			const value = parsed.frontiers?.[type];
			if (!value || typeof value !== 'object') continue;
			const baselineMaxCrd = Number(value.baselineMaxCrd);
			const nextCrd = Number(value.nextCrd);
			if (!Number.isSafeInteger(baselineMaxCrd) || baselineMaxCrd <= 0) continue;
			if (!Number.isSafeInteger(nextCrd) || nextCrd <= baselineMaxCrd) continue;

			const misses: Record<string, FrontierMissEntry> = {};
			for (const [crd, miss] of Object.entries(value.misses || {})) {
				if (!/^\d+$/.test(crd) || !miss || typeof miss !== 'object') continue;
				const sourceStatuses: FrontierMissEntry['sourceStatuses'] = {};
				for (const source of ['finra', 'sec'] as const) {
					if (miss.sourceStatuses?.[source] === 'empty' || miss.sourceStatuses?.[source] === 'blocked') {
						sourceStatuses[source] = miss.sourceStatuses[source];
					}
				}
				misses[crd] = {
					attempts: Number.isSafeInteger(miss.attempts) && miss.attempts > 0 ? miss.attempts : 1,
					lastAttemptedAt: typeof miss.lastAttemptedAt === 'string' && miss.lastAttemptedAt ? miss.lastAttemptedAt : snapshot.generatedAt,
					sourceStatuses,
				};
			}

			snapshot.frontiers[type] = { baselineMaxCrd, nextCrd, misses };
		}

		return snapshot;
	} catch (error: any) {
		if (error?.code === 'ENOENT') {
			return { generatedAt: new Date().toISOString(), frontiers: {} };
		}
		throw error;
	}
}

function buildPlans(
	args: ReturnType<typeof parseArgs>,
	savedMaxes: Partial<Record<`${Source}:${EntityType}`, number>>,
	frontierSnapshot: FrontierSnapshot,
) {
	const plans: TypePlan[] = [];

	for (const type of args.types) {
		const sourceMaxes: TypePlan['sourceMaxes'] = {};
		for (const source of args.sources) {
			const max = savedMaxes[`${source}:${type}`];
			if (max) sourceMaxes[source] = max;
		}

		const maxValues = Object.values(sourceMaxes).filter((value): value is number => Number.isSafeInteger(value) && value > 0);
		if (!maxValues.length) continue;

		const currentMaxCrd = Math.max(...maxValues);
		const existing = frontierSnapshot.frontiers[type];
		if (
			args.refreshFrontier
			|| !existing
			|| existing.baselineMaxCrd !== currentMaxCrd
			|| existing.nextCrd <= currentMaxCrd
		) {
			frontierSnapshot.frontiers[type] = {
				baselineMaxCrd: currentMaxCrd,
				nextCrd: currentMaxCrd + 1,
				misses: {},
			};
		}

		const frontier = frontierSnapshot.frontiers[type]!;
		plans.push({
			type,
			sources: args.sources,
			sourceMaxes,
			currentMaxCrd,
			nextCrd: frontier.nextCrd,
			recordedMissCount: Object.keys(frontier.misses).length,
		});
	}

	return plans;
}

async function saveState(report: unknown, frontierSnapshot: FrontierSnapshot) {
	const timestamp = new Date().toISOString();
	frontierSnapshot.generatedAt = timestamp;
	await fs.mkdir(outDir, { recursive: true });
	await Promise.all([
		fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf-8'),
		fs.writeFile(frontierPath, JSON.stringify(frontierSnapshot, null, 2), 'utf-8'),
	]);
}

async function fetchOneSource(source: Source, type: EntityType, crd: string): Promise<SourceAttemptResult> {
	const filename = detailFilenameForSource(source, type, crd);
	const existing = await inspectSavedPayload(filename);
	if (existing.exists && !existing.invalid) {
		return { status: 'skipped-existing', filename };
	}

	const url = buildEndpoint({ source, type, crd });
	if (!url) throw new Error(`No detail endpoint configured for ${source} ${type} ${crd}`);

	const payload = await fetchWithCache(url, {
		forceRefresh: existing.invalid,
		onRateLimit: async ({ attempt, waitMs }) => {
			console.log(`[rate-limit] ${source} ${type} ${crd} attempt ${attempt}; upstream requested a pause (~${Math.round(waitMs / 1000)}s)`);
		},
	});

	if (isEmptyPayload(payload)) return { status: 'empty', filename };
	if (hasBlockingIndicators(payload)) return { status: 'blocked', filename };

	const syncResult = await syncSavedPayload(filename, payload);
	if (
		syncResult.status === 'downloaded'
		|| syncResult.status === 'updated'
		|| syncResult.status === 'repaired'
		|| syncResult.status === 'unchanged'
	) {
		return { status: syncResult.status, filename };
	}

	throw new Error(`Unexpected sync status "${String(syncResult.status)}" for ${filename}`);
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const savedMaxes = await collectSavedMaxes();
	const frontierSnapshot = await loadFrontierSnapshot();
	const plans = buildPlans(args, savedMaxes, frontierSnapshot);

	const report = {
		generatedAt: new Date().toISOString(),
		startedAt: new Date().toISOString(),
		completedAt: null as string | null,
		sources: args.sources,
		types: args.types,
		maxCrdsPerType: args.maxCrdsPerType,
		stopAfterEmptyMisses: args.stopAfterEmptyMisses,
		refreshFrontier: args.refreshFrontier,
		plans,
		processedCrds: 0,
		statusCounts: {} as Record<string, number>,
		lastProcessed: null as null | {
			type: EntityType;
			crd: string;
			outcome: 'found' | 'empty' | 'blocked' | 'error';
			at: string;
		},
		errors: [] as Array<{ type: EntityType; source?: Source; crd: string; message: string }>,
	};

	const incrementStatus = (status: string) => {
		report.statusCounts[status] = (report.statusCounts[status] || 0) + 1;
	};

	await saveState(report, frontierSnapshot);

	for (const plan of plans) {
		const frontier = frontierSnapshot.frontiers[plan.type]!;
		let candidate = frontier.nextCrd;
		let checkedForType = 0;
		let consecutiveEmptyMisses = 0;

		console.log(
			`Scanning ${plan.type} above ${plan.currentMaxCrd.toLocaleString()} starting at ${candidate.toLocaleString()}`
				+ ` (sources: ${plan.sources.join(',')}; max ${args.maxCrdsPerType} CRDs; stop after ${args.stopAfterEmptyMisses} empty misses).`,
		);

		while (checkedForType < args.maxCrdsPerType && consecutiveEmptyMisses < args.stopAfterEmptyMisses) {
			const crd = String(candidate);
			const attemptTime = new Date().toISOString();
			const missEntry = frontier.misses[crd];
			process.stdout.write(`[${plan.type} ${crd}] ... `);

			let foundAny = false;
			let blockedAny = false;
			let errorAny = false;
			const sourceStatuses: FrontierMissEntry['sourceStatuses'] = {};

			for (const source of plan.sources) {
				try {
					const result = await fetchOneSource(source, plan.type, crd);
					incrementStatus(`${source}:${result.status}`);

					if (
						result.status === 'downloaded'
						|| result.status === 'updated'
						|| result.status === 'repaired'
						|| result.status === 'unchanged'
						|| result.status === 'skipped-existing'
					) {
						foundAny = true;
					} else if (result.status === 'blocked') {
						blockedAny = true;
						sourceStatuses[source] = 'blocked';
					} else if (result.status === 'empty') {
						sourceStatuses[source] = 'empty';
					}
				} catch (error) {
					errorAny = true;
					const message = formatErrorMessage(error);
					incrementStatus(`${source}:error`);
					report.errors.push({ type: plan.type, source, crd, message });
				}
			}

			report.processedCrds += 1;

			if (foundAny) {
				const newMax = candidate;
				frontier.baselineMaxCrd = newMax;
				frontier.nextCrd = newMax + 1;
				frontier.misses = {};
				candidate = frontier.nextCrd;
				consecutiveEmptyMisses = 0;
				report.lastProcessed = { type: plan.type, crd, outcome: 'found', at: attemptTime };
				console.log('found');
			} else if (errorAny) {
				report.lastProcessed = { type: plan.type, crd, outcome: 'error', at: attemptTime };
				incrementStatus('stopped-on-error');
				console.log('error');
				await saveState(report, frontierSnapshot);
				break;
			} else if (blockedAny) {
				frontier.misses[crd] = {
					attempts: (missEntry?.attempts || 0) + 1,
					lastAttemptedAt: attemptTime,
					sourceStatuses,
				};
				report.lastProcessed = { type: plan.type, crd, outcome: 'blocked', at: attemptTime };
				incrementStatus('stopped-on-blocked');
				console.log('blocked');
				await saveState(report, frontierSnapshot);
				break;
			} else {
				frontier.misses[crd] = {
					attempts: (missEntry?.attempts || 0) + 1,
					lastAttemptedAt: attemptTime,
					sourceStatuses,
				};
				frontier.nextCrd = candidate + 1;
				candidate = frontier.nextCrd;
				consecutiveEmptyMisses += 1;
				report.lastProcessed = { type: plan.type, crd, outcome: 'empty', at: attemptTime };
				console.log('empty');
			}

			await saveState(report, frontierSnapshot);
			checkedForType += 1;
		}
	}

	report.completedAt = new Date().toISOString();
	await saveState(report, frontierSnapshot);
	console.log(`Done. Wrote ${reportPath}`);
}

main().catch((error) => {
	console.error(formatErrorMessage(error));
	process.exit(1);
});
