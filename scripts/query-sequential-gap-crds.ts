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
	syncSavedPayload,
} from '../pages/api/_lib';

type Source = 'finra' | 'sec';
type EntityType = 'firm' | 'individual';
type RequestResultStatus =
	| 'skipped-existing'
	| 'downloaded'
	| 'updated'
	| 'repaired'
	| 'unchanged'
	| 'empty'
	| 'blocked'
	| 'error';

type RequestResult = {
	status: Exclude<RequestResultStatus, 'error'>;
	filename: string;
};

type MissStatus = Extract<RequestResultStatus, 'empty' | 'blocked'>;

type MissEntry = {
	status: MissStatus;
	attempts: number;
	lastAttemptedAt: string;
};

type MissesSnapshot = {
	generatedAt: string;
	misses: Record<string, Record<string, MissEntry>>;
};

type PlanSummary = {
	source: Source;
	type: EntityType;
	minObservedCrd: number;
	maxObservedCrd: number;
	startCrd: number;
	endCrd: number;
	spanSize: number;
	savedCountInRange: number;
	attemptedMissCountInRange: number;
	gapCount: number;
};

const rawDir = path.resolve(process.cwd(), 'data', 'raw');
const outDir = path.resolve(process.cwd(), 'data', 'derived');
const targetsPath = path.join(outDir, 'query-sequential-gap-crds-targets.json');
const reportPath = path.join(outDir, 'query-sequential-gap-crds-report.json');
const missesPath = path.join(outDir, 'query-sequential-gap-crds-misses.json');

function parsePositiveInteger(value: string) {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
	return parsed;
}

function randBetween(min: number, max: number) {
	const lo = Number(min) || 0;
	const hi = Number(max) || 0;
	if (hi <= lo) return lo;
	return Math.round(lo + Math.random() * (hi - lo));
}

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function countValuesInRange(values: Iterable<number>, start: number, end: number) {
	let count = 0;
	for (const value of values) {
		if (value >= start && value <= end) count += 1;
	}
	return count;
}

function pairKey(source: Source, type: EntityType) {
	return `${source}:${type}`;
}

function parseArgs(argv: string[]) {
	const config = {
		types: ['firm', 'individual'] as EntityType[],
		sources: ['finra', 'sec'] as Source[],
		startCrd: null as number | null,
		endCrd: null as number | null,
		limitGaps: Number.POSITIVE_INFINITY,
		refreshAttempted: false,
		flushEvery: 25,
		requestDelayMinMs: parsePositiveInteger(process.env.SEQUENTIAL_GAP_DELAY_MS_MIN || '') ?? 0,
		requestDelayMaxMs:
			parsePositiveInteger(process.env.SEQUENTIAL_GAP_DELAY_MS_MAX || '')
			?? parsePositiveInteger(process.env.SEQUENTIAL_GAP_DELAY_MS_MIN || '')
			?? 0,
	};

	for (const arg of argv) {
		if (arg === '--refresh-attempted') {
			config.refreshAttempted = true;
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
		if (arg.startsWith('--start-crd=')) {
			config.startCrd = parsePositiveInteger(arg.slice('--start-crd='.length));
			continue;
		}
		if (arg.startsWith('--end-crd=')) {
			config.endCrd = parsePositiveInteger(arg.slice('--end-crd='.length));
			continue;
		}
		if (arg.startsWith('--limit-gaps=')) {
			const parsed = parsePositiveInteger(arg.slice('--limit-gaps='.length));
			if (parsed) config.limitGaps = parsed;
			continue;
		}
		if (arg.startsWith('--flush-every=')) {
			const parsed = parsePositiveInteger(arg.slice('--flush-every='.length));
			if (parsed) config.flushEvery = parsed;
			continue;
		}
		if (arg.startsWith('--request-delay-ms=')) {
			const parsed = parsePositiveInteger(arg.slice('--request-delay-ms='.length));
			if (parsed) {
				config.requestDelayMinMs = parsed;
				config.requestDelayMaxMs = parsed;
			}
			continue;
		}
		if (arg.startsWith('--request-delay-ms-min=')) {
			const parsed = parsePositiveInteger(arg.slice('--request-delay-ms-min='.length));
			if (parsed) config.requestDelayMinMs = parsed;
			continue;
		}
		if (arg.startsWith('--request-delay-ms-max=')) {
			const parsed = parsePositiveInteger(arg.slice('--request-delay-ms-max='.length));
			if (parsed) config.requestDelayMaxMs = parsed;
		}
	}

	if (config.startCrd != null && config.endCrd != null && config.startCrd > config.endCrd) {
		throw new Error('--start-crd must be less than or equal to --end-crd');
	}
	if (config.requestDelayMaxMs > 0 && config.requestDelayMaxMs < config.requestDelayMinMs) {
		config.requestDelayMaxMs = config.requestDelayMinMs;
	}

	return config;
}

async function collectSavedCrds() {
	const saved = new Map<string, Set<number>>();
	const entries = await fs.readdir(rawDir);

	for (const entry of entries) {
		const match = entry.match(/^(finra|sec):(individual|firm):(\d+)\.json$/i);
		if (!match) continue;
		const source = match[1].toLowerCase() as Source;
		const type = match[2].toLowerCase() as EntityType;
		const crd = Number(match[3]);
		if (!Number.isSafeInteger(crd) || crd <= 0) continue;
		const key = pairKey(source, type);
		if (!saved.has(key)) saved.set(key, new Set<number>());
		saved.get(key)?.add(crd);
	}

	return saved;
}

async function loadMissesSnapshot(): Promise<MissesSnapshot> {
	try {
		const parsed = JSON.parse(await fs.readFile(missesPath, 'utf-8')) as Partial<MissesSnapshot>;
		if (!parsed || typeof parsed !== 'object' || !parsed.misses || typeof parsed.misses !== 'object') {
			return { generatedAt: new Date().toISOString(), misses: {} };
		}
		const misses: MissesSnapshot['misses'] = {};
		for (const [scanKey, values] of Object.entries(parsed.misses)) {
			if (!values || typeof values !== 'object') continue;
			for (const [crd, entry] of Object.entries(values)) {
				if (!/^\d+$/.test(crd)) continue;
				if (!entry || typeof entry !== 'object') continue;
				const status = entry.status === 'blocked' ? 'blocked' : entry.status === 'empty' ? 'empty' : null;
				if (!status) continue;
				const attempts = Number.isSafeInteger(entry.attempts) && entry.attempts > 0 ? entry.attempts : 1;
				const lastAttemptedAt = typeof entry.lastAttemptedAt === 'string' && entry.lastAttemptedAt ? entry.lastAttemptedAt : parsed.generatedAt || new Date().toISOString();
				misses[scanKey] ??= {};
				misses[scanKey][crd] = { status, attempts, lastAttemptedAt };
			}
		}
		return {
			generatedAt: typeof parsed.generatedAt === 'string' && parsed.generatedAt ? parsed.generatedAt : new Date().toISOString(),
			misses,
		};
	} catch (error: any) {
		if (error?.code === 'ENOENT') {
			return { generatedAt: new Date().toISOString(), misses: {} };
		}
		throw error;
	}
}

function pruneMissesForSaved(snapshot: MissesSnapshot, savedCrds: Map<string, Set<number>>) {
	for (const [scanKey, entries] of Object.entries(snapshot.misses)) {
		const saved = savedCrds.get(scanKey);
		if (!saved) continue;
		for (const crd of Object.keys(entries)) {
			if (saved.has(Number(crd))) delete entries[crd];
		}
		if (!Object.keys(entries).length) delete snapshot.misses[scanKey];
	}
}

function buildPlans(
	args: ReturnType<typeof parseArgs>,
	savedCrds: Map<string, Set<number>>,
	missesSnapshot: MissesSnapshot,
) {
	const plans: PlanSummary[] = [];

	for (const type of args.types) {
		for (const source of args.sources) {
			const scanKey = pairKey(source, type);
			const saved = savedCrds.get(scanKey) ?? new Set<number>();
			const observed = Array.from(saved).sort((left, right) => left - right);
			if (!observed.length) continue;

			const minObservedCrd = observed[0];
			const maxObservedCrd = observed[observed.length - 1];
			const startCrd = Math.max(args.startCrd ?? minObservedCrd, minObservedCrd);
			const endCrd = Math.min(args.endCrd ?? maxObservedCrd, maxObservedCrd);
			if (startCrd > endCrd) continue;

			const attemptedMissValues = Object.keys(missesSnapshot.misses[scanKey] ?? {}).map(Number);
			const savedCountInRange = countValuesInRange(saved, startCrd, endCrd);
			const attemptedMissCountInRange = args.refreshAttempted ? 0 : countValuesInRange(attemptedMissValues, startCrd, endCrd);
			const spanSize = endCrd - startCrd + 1;
			const gapCount = Math.max(0, spanSize - savedCountInRange - attemptedMissCountInRange);

			plans.push({
				source,
				type,
				minObservedCrd,
				maxObservedCrd,
				startCrd,
				endCrd,
				spanSize,
				savedCountInRange,
				attemptedMissCountInRange,
				gapCount,
			});
		}
	}

	return plans;
}

async function saveTargetsSnapshot(
	args: ReturnType<typeof parseArgs>,
	plans: PlanSummary[],
	missesSnapshot: MissesSnapshot,
) {
	await fs.mkdir(outDir, { recursive: true });
	await fs.writeFile(
		targetsPath,
		JSON.stringify(
			{
				generatedAt: new Date().toISOString(),
				sources: args.sources,
				types: args.types,
				startCrd: args.startCrd,
				endCrd: args.endCrd,
				limitGapsPerSourceType: Number.isFinite(args.limitGaps) ? args.limitGaps : null,
				refreshAttempted: args.refreshAttempted,
				plans,
				attemptedMissCounts: Object.fromEntries(
					Object.entries(missesSnapshot.misses).map(([scanKey, entries]) => [scanKey, Object.keys(entries).length]),
				),
			},
			null,
			2,
		),
		'utf-8',
	);
}

async function fetchGap(source: Source, type: EntityType, crd: string, forceRefresh: boolean): Promise<RequestResult> {
	const filename = detailFilenameForSource(source, type, crd);
	const existing = await inspectSavedPayload(filename);
	if (existing.exists && !existing.invalid && !forceRefresh) {
		return { status: 'skipped-existing', filename };
	}

	const url = buildEndpoint({ source, type, crd });
	if (!url) throw new Error(`No detail endpoint configured for ${source} ${type} ${crd}`);

	const payload = await fetchWithCache(url, {
		forceRefresh: forceRefresh || existing.invalid,
		onRateLimit: async ({ attempt, waitMs }) => {
			console.log(`[rate-limit] ${source} ${type} ${crd} attempt ${attempt}; upstream requested a pause (~${Math.round(waitMs / 1000)}s)`);
		},
	});

	if (isEmptyPayload(payload)) {
		return { status: 'empty', filename };
	}
	if (hasBlockingIndicators(payload)) {
		return { status: 'blocked', filename };
	}

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
	const savedCrds = await collectSavedCrds();
	const missesSnapshot = await loadMissesSnapshot();
	pruneMissesForSaved(missesSnapshot, savedCrds);

	const plans = buildPlans(args, savedCrds, missesSnapshot);
	await saveTargetsSnapshot(args, plans, missesSnapshot);

	const report = {
		generatedAt: new Date().toISOString(),
		startedAt: new Date().toISOString(),
		completedAt: null as string | null,
		sources: args.sources,
		types: args.types,
		startCrd: args.startCrd,
		endCrd: args.endCrd,
		limitGapsPerSourceType: Number.isFinite(args.limitGaps) ? args.limitGaps : null,
		refreshAttempted: args.refreshAttempted,
		targetsPath,
		missesPath,
		planCount: plans.length,
		plans,
		processedGapCount: 0,
		statusCounts: {} as Record<RequestResultStatus, number>,
		lastProcessed: null as null | { source: Source; type: EntityType; crd: string; status: RequestResultStatus; at: string },
		errors: [] as Array<{ source: Source; type: EntityType; crd: string; message: string }>,
	};

	const flushState = async () => {
		report.generatedAt = new Date().toISOString();
		missesSnapshot.generatedAt = report.generatedAt;
		await fs.mkdir(outDir, { recursive: true });
		await Promise.all([
			fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf-8'),
			fs.writeFile(missesPath, JSON.stringify(missesSnapshot, null, 2), 'utf-8'),
		]);
	};

	const incrementStatus = (status: RequestResultStatus) => {
		report.statusCounts[status] = (report.statusCounts[status] || 0) + 1;
	};

	if (!plans.length) {
		await flushState();
		console.log('No sequential gap ranges matched the selected filters.');
		return;
	}

	const totalCandidateGaps = plans.reduce((sum, plan) => sum + plan.gapCount, 0);
	console.log(`Loaded ${plans.length} sequential gap range(s) with ${totalCandidateGaps.toLocaleString()} candidate gaps.`);
	console.log(`Target snapshot: ${targetsPath}`);
	console.log(`Report path: ${reportPath}`);
	console.log(`Misses path: ${missesPath}`);
	if (args.requestDelayMinMs > 0 || args.requestDelayMaxMs > 0) {
		console.log(
			`Per-request pacing enabled: ${args.requestDelayMinMs.toLocaleString()}-${Math.max(args.requestDelayMinMs, args.requestDelayMaxMs).toLocaleString()}ms between probes.`,
		);
	}

	let processedSinceFlush = 0;

	for (const plan of plans) {
		const scanKey = pairKey(plan.source, plan.type);
		const saved = savedCrds.get(scanKey) ?? new Set<number>();
		missesSnapshot.misses[scanKey] ??= {};
		const misses = missesSnapshot.misses[scanKey];
		let processedForPlan = 0;

		console.log(
			`Scanning ${plan.source.toUpperCase()} ${plan.type} gaps from ${plan.startCrd.toLocaleString()} to ${plan.endCrd.toLocaleString()}`
				+ ` (${plan.gapCount.toLocaleString()} pending gaps${Number.isFinite(args.limitGaps) ? `, limit ${args.limitGaps.toLocaleString()}` : ''}).`,
		);

		for (let crd = plan.startCrd; crd <= plan.endCrd; crd += 1) {
			if (saved.has(crd)) continue;
			if (!args.refreshAttempted && misses[String(crd)]) continue;
			if (processedForPlan >= args.limitGaps) break;

			const crdText = String(crd);
			const retryingMiss = Boolean(misses[crdText]);
			process.stdout.write(`[${plan.source.toUpperCase()} ${plan.type} ${crdText}] ... `);

			try {
				const result = await fetchGap(plan.source, plan.type, crdText, retryingMiss);
				incrementStatus(result.status);
				report.processedGapCount += 1;
				report.lastProcessed = {
					source: plan.source,
					type: plan.type,
					crd: crdText,
					status: result.status,
					at: new Date().toISOString(),
				};

				if (result.status === 'empty' || result.status === 'blocked') {
					const previousAttempts = misses[crdText]?.attempts || 0;
					misses[crdText] = {
						status: result.status,
						attempts: previousAttempts + 1,
						lastAttemptedAt: report.lastProcessed.at,
					};
				} else {
					delete misses[crdText];
					saved.add(crd);
				}

				console.log(result.status);
			} catch (error) {
				const message = formatErrorMessage(error);
				incrementStatus('error');
				report.processedGapCount += 1;
				report.lastProcessed = {
					source: plan.source,
					type: plan.type,
					crd: crdText,
					status: 'error',
					at: new Date().toISOString(),
				};
				report.errors.push({ source: plan.source, type: plan.type, crd: crdText, message });
				console.log(`error (${message})`);
			}

			processedForPlan += 1;
			processedSinceFlush += 1;

			if (processedSinceFlush >= args.flushEvery) {
				await flushState();
				processedSinceFlush = 0;
			}

			if (args.requestDelayMinMs > 0 || args.requestDelayMaxMs > 0) {
				const waitMs = randBetween(args.requestDelayMinMs, Math.max(args.requestDelayMinMs, args.requestDelayMaxMs));
				if (waitMs > 0) await sleep(waitMs);
			}
		}
	}

	report.completedAt = new Date().toISOString();
	await flushState();
	console.log(`Done. Wrote ${reportPath}`);
}

main().catch((error) => {
	console.error(formatErrorMessage(error));
	process.exit(1);
});
