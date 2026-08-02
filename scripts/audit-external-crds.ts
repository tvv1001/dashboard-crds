#!/usr/bin/env node
import { promises as fs } from 'fs';
import path from 'path';
import {
	buildEndpoint,
	detailFilenameForSource,
	formatErrorMessage,
	hasBlockingIndicators,
	inspectSavedPayload,
	isEmptyPayload,
	isNonActionableSavedDetail,
	listSavedKeys,
	removeSavedPayload,
	syncSavedPayload,
} from '../pages/api/_lib';

type Source = 'finra' | 'sec';
type EntityType = 'firm' | 'individual';
type AuditStatus =
	| 'downloaded'
	| 'updated'
	| 'repaired'
	| 'unchanged'
	| 'removed'
	| 'empty'
	| 'blocked'
	| 'skipped-missing-local'
	| 'error';

type AuditTarget = {
	key: string;
	source: Source;
	type: EntityType;
	crd: string;
};

type SourceCadenceState = {
	baseDelayMinMs: number;
	baseDelayMaxMs: number;
	recommendedDelayMs: number;
	currentDelayMinMs: number;
	currentDelayMaxMs: number;
	consecutive429s: number;
	successesSince429: number;
	last429At: string | null;
	last429DelayMs: number | null;
};

type TargetsSnapshot = {
	generatedAt: string;
	sources: Source[];
	types: EntityType[];
	targetCount: number;
	targets: AuditTarget[];
};

type AuditReport = {
	generatedAt: string;
	startedAt: string;
	completedAt: string | null;
	sources: Source[];
	types: EntityType[];
	targetCount: number;
	cursor: number;
	limit: number | null;
	flushEvery: number;
	requestDelayMinMs: number;
	requestDelayMaxMs: number;
	decayAfterSuccesses: number;
	targetsPath: string;
	statusCounts: Record<AuditStatus, number>;
	rateLimitCounts: Partial<Record<Source, number>>;
	sourceCadence: Record<Source, SourceCadenceState>;
	lastProcessed: null | {
		key: string;
		status: AuditStatus;
		at: string;
	};
	lastRateLimit: null | {
		key: string;
		source: Source;
		attempt: number;
		waitMs: number;
		at: string;
	};
	errors: Array<{ key: string; message: string; at: string }>;
};

type AuditConfig = {
	sources: Source[];
	types: EntityType[];
	limit: number;
	restart: boolean;
	refreshTargets: boolean;
	flushEvery: number;
	requestDelayMinMs: number;
	requestDelayMaxMs: number;
	decayAfterSuccesses: number;
};

type LiveFetchResult =
	| { kind: 'json'; payload: any }
	| { kind: 'blocked'; raw: string }
	| { kind: 'empty' };

const outDir = path.resolve(process.cwd(), 'data', 'derived');
const targetsPath = path.join(outDir, 'audit-external-crds-targets.json');
const reportPath = path.join(outDir, 'audit-external-crds-report.json');

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

function sourceTypeKey(source: Source, type: EntityType) {
	return `${source}:${type}`;
}

function parseArgs(argv: string[]): AuditConfig {
	const config: AuditConfig = {
		sources: ['finra', 'sec'],
		types: ['firm', 'individual'],
		limit: Number.POSITIVE_INFINITY,
		restart: false,
		refreshTargets: false,
		flushEvery: parsePositiveInteger(process.env.AUDIT_EXTERNAL_CRDS_FLUSH_EVERY || '') ?? 10,
		requestDelayMinMs: parsePositiveInteger(process.env.AUDIT_EXTERNAL_CRDS_DELAY_MS_MIN || '') ?? 15000,
		requestDelayMaxMs:
			parsePositiveInteger(process.env.AUDIT_EXTERNAL_CRDS_DELAY_MS_MAX || '')
			?? parsePositiveInteger(process.env.AUDIT_EXTERNAL_CRDS_DELAY_MS_MIN || '')
			?? 30000,
		decayAfterSuccesses: parsePositiveInteger(process.env.AUDIT_EXTERNAL_CRDS_DECAY_AFTER_SUCCESSES || '') ?? 25,
	};

	for (const arg of argv) {
		if (arg === '--restart') {
			config.restart = true;
			continue;
		}
		if (arg === '--refresh-targets') {
			config.refreshTargets = true;
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
		if (arg.startsWith('--types=')) {
			const parsed = arg
				.slice('--types='.length)
				.split(',')
				.map((value) => value.trim().toLowerCase())
				.filter((value): value is EntityType => value === 'firm' || value === 'individual');
			if (parsed.length) config.types = Array.from(new Set(parsed));
			continue;
		}
		if (arg.startsWith('--limit=')) {
			const parsed = parsePositiveInteger(arg.slice('--limit='.length));
			if (parsed) config.limit = parsed;
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
			continue;
		}
		if (arg.startsWith('--decay-after-successes=')) {
			const parsed = parsePositiveInteger(arg.slice('--decay-after-successes='.length));
			if (parsed) config.decayAfterSuccesses = parsed;
		}
	}

	if (config.requestDelayMaxMs < config.requestDelayMinMs) {
		config.requestDelayMaxMs = config.requestDelayMinMs;
	}

	return config;
}

function buildInitialCadenceState(config: AuditConfig): Record<Source, SourceCadenceState> {
	const midpoint = Math.round((config.requestDelayMinMs + config.requestDelayMaxMs) / 2);
	return {
		finra: {
			baseDelayMinMs: config.requestDelayMinMs,
			baseDelayMaxMs: config.requestDelayMaxMs,
			recommendedDelayMs: midpoint,
			currentDelayMinMs: config.requestDelayMinMs,
			currentDelayMaxMs: config.requestDelayMaxMs,
			consecutive429s: 0,
			successesSince429: 0,
			last429At: null,
			last429DelayMs: null,
		},
		sec: {
			baseDelayMinMs: config.requestDelayMinMs,
			baseDelayMaxMs: config.requestDelayMaxMs,
			recommendedDelayMs: midpoint,
			currentDelayMinMs: config.requestDelayMinMs,
			currentDelayMaxMs: config.requestDelayMaxMs,
			consecutive429s: 0,
			successesSince429: 0,
			last429At: null,
			last429DelayMs: null,
		},
	};
}

function recomputeCadenceWindow(state: SourceCadenceState) {
	const baseMin = Math.max(1, state.baseDelayMinMs);
	const baseMax = Math.max(baseMin, state.baseDelayMaxMs);
	const recommended = Math.max(baseMin, Math.round(state.recommendedDelayMs));
	state.recommendedDelayMs = recommended;
	state.currentDelayMinMs = Math.max(baseMin, Math.round(recommended * 0.85));
	state.currentDelayMaxMs = Math.max(state.currentDelayMinMs, Math.round(recommended * 1.15));
	if (recommended <= baseMax) {
		state.currentDelayMinMs = baseMin;
		state.currentDelayMaxMs = baseMax;
	}
}

function record429Cadence(state: SourceCadenceState, waitMs: number, at: string) {
	state.consecutive429s += 1;
	state.successesSince429 = 0;
	state.last429At = at;
	state.last429DelayMs = waitMs;
	state.recommendedDelayMs = Math.max(state.recommendedDelayMs, waitMs);
	recomputeCadenceWindow(state);
}

function recordSuccessfulCadence(state: SourceCadenceState, decayAfterSuccesses: number) {
	if (state.consecutive429s > 0) {
		state.consecutive429s = 0;
	}
	if (state.recommendedDelayMs <= state.baseDelayMaxMs) {
		state.successesSince429 = 0;
		state.recommendedDelayMs = Math.max(state.baseDelayMinMs, Math.round((state.baseDelayMinMs + state.baseDelayMaxMs) / 2));
		recomputeCadenceWindow(state);
		return;
	}
	state.successesSince429 += 1;
	if (state.successesSince429 < decayAfterSuccesses) {
		recomputeCadenceWindow(state);
		return;
	}
	state.successesSince429 = 0;
	const nextRecommended = Math.max(
		state.baseDelayMaxMs,
		Math.round(state.baseDelayMaxMs + (state.recommendedDelayMs - state.baseDelayMaxMs) * 0.85),
	);
	state.recommendedDelayMs = nextRecommended;
	recomputeCadenceWindow(state);
}

function parseRetryAfterMs(value: string | null) {
	if (!value) return null;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1000);
	const dateMs = Date.parse(value);
	if (Number.isFinite(dateMs)) {
		const delta = dateMs - Date.now();
		if (delta > 0) return Math.round(delta);
	}
	return null;
}

function compute429WaitMs(state: SourceCadenceState, retryAfterMs: number | null) {
	const progressiveMinutes = 2 + (state.consecutive429s + 1);
	const progressiveMs = progressiveMinutes * 60 * 1000;
	return Math.max(progressiveMs, retryAfterMs ?? 0);
}

function isBlockingText(text: string, contentType: string | null) {
	const normalized = String(text || '').trim().toLowerCase();
	const type = String(contentType || '').toLowerCase();
	if (!normalized) return false;
	return (
		type.includes('text/html')
		|| normalized.startsWith('<!doctype html')
		|| normalized.startsWith('<html')
		|| normalized.includes('too many requests')
		|| normalized.includes('rate limit')
		|| normalized.includes('access denied')
		|| normalized.includes('captcha')
		|| normalized.includes('blocked')
	);
}

function interleaveTargets(targets: AuditTarget[], sources: Source[], types: EntityType[]) {
	const orderedKeys = sources.flatMap((source) => types.map((type) => sourceTypeKey(source, type)));
	const buckets = new Map<string, AuditTarget[]>();

	for (const target of targets) {
		const key = sourceTypeKey(target.source, target.type);
		buckets.set(key, [...(buckets.get(key) || []), target]);
	}

	for (const bucket of buckets.values()) {
		bucket.sort((left, right) => Number(left.crd) - Number(right.crd));
	}

	const result: AuditTarget[] = [];
	while (true) {
		let pushed = false;
		for (const key of orderedKeys) {
			const bucket = buckets.get(key);
			if (!bucket?.length) continue;
			const next = bucket.shift();
			if (!next) continue;
			result.push(next);
			pushed = true;
		}
		if (!pushed) break;
	}
	return result;
}

async function buildTargetsSnapshot(config: AuditConfig): Promise<TargetsSnapshot> {
	const keys = await listSavedKeys();
	const targets: AuditTarget[] = [];

	for (const key of keys) {
		const match = key.match(/^(finra|sec):(individual|firm):(\d+)$/i);
		if (!match) continue;
		const source = match[1].toLowerCase() as Source;
		const type = match[2].toLowerCase() as EntityType;
		const crd = String(Number(match[3]));
		if (!config.sources.includes(source) || !config.types.includes(type)) continue;
		targets.push({
			key: detailFilenameForSource(source, type, crd),
			source,
			type,
			crd,
		});
	}

	return {
		generatedAt: new Date().toISOString(),
		sources: config.sources,
		types: config.types,
		targetCount: targets.length,
		targets: interleaveTargets(targets, config.sources, config.types),
	};
}

async function loadTargetsSnapshot(config: AuditConfig): Promise<TargetsSnapshot> {
	if (!config.refreshTargets && !config.restart) {
		try {
			const parsed = JSON.parse(await fs.readFile(targetsPath, 'utf-8')) as Partial<TargetsSnapshot>;
			const sameSources =
				Array.isArray(parsed.sources)
				&& parsed.sources.join(',') === config.sources.join(',');
			const sameTypes =
				Array.isArray(parsed.types)
				&& parsed.types.join(',') === config.types.join(',');
			if (sameSources && sameTypes && Array.isArray(parsed.targets)) {
				return {
					generatedAt: typeof parsed.generatedAt === 'string' ? parsed.generatedAt : new Date().toISOString(),
					sources: config.sources,
					types: config.types,
					targetCount: parsed.targets.length,
					targets: parsed.targets.filter(
						(target): target is AuditTarget => Boolean(
							target
							&& (target.source === 'finra' || target.source === 'sec')
							&& (target.type === 'firm' || target.type === 'individual')
							&& typeof target.crd === 'string'
							&& typeof target.key === 'string',
						),
					),
				};
			}
		} catch (error: any) {
			if (error?.code !== 'ENOENT') throw error;
		}
	}

	const snapshot = await buildTargetsSnapshot(config);
	await fs.mkdir(outDir, { recursive: true });
	await fs.writeFile(targetsPath, JSON.stringify(snapshot, null, 2), 'utf-8');
	return snapshot;
}

async function loadOrCreateReport(config: AuditConfig, targets: TargetsSnapshot): Promise<AuditReport> {
	if (!config.restart) {
		try {
			const parsed = JSON.parse(await fs.readFile(reportPath, 'utf-8')) as Partial<AuditReport>;
			const sameSources = Array.isArray(parsed.sources) && parsed.sources.join(',') === config.sources.join(',');
			const sameTypes = Array.isArray(parsed.types) && parsed.types.join(',') === config.types.join(',');
			const stillRunning = !parsed.completedAt;
			const sameTargetCount = Number(parsed.targetCount) === targets.targetCount;
			if (sameSources && sameTypes && stillRunning && sameTargetCount) {
				const report: AuditReport = {
					generatedAt: typeof parsed.generatedAt === 'string' ? parsed.generatedAt : new Date().toISOString(),
					startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : new Date().toISOString(),
					completedAt: null,
					sources: config.sources,
					types: config.types,
					targetCount: targets.targetCount,
					cursor: Number.isSafeInteger(parsed.cursor) && parsed.cursor! >= 0 ? Math.min(parsed.cursor!, targets.targetCount) : 0,
					limit: Number.isFinite(parsed.limit) ? Number(parsed.limit) : null,
					flushEvery: parsePositiveInteger(String(parsed.flushEvery || '')) ?? config.flushEvery,
					requestDelayMinMs: parsePositiveInteger(String(parsed.requestDelayMinMs || '')) ?? config.requestDelayMinMs,
					requestDelayMaxMs: parsePositiveInteger(String(parsed.requestDelayMaxMs || '')) ?? config.requestDelayMaxMs,
					decayAfterSuccesses: parsePositiveInteger(String(parsed.decayAfterSuccesses || '')) ?? config.decayAfterSuccesses,
					targetsPath,
					statusCounts: (parsed.statusCounts || {}) as Record<AuditStatus, number>,
					rateLimitCounts: (parsed.rateLimitCounts || {}) as Partial<Record<Source, number>>,
					sourceCadence: buildInitialCadenceState(config),
					lastProcessed: parsed.lastProcessed ?? null,
					lastRateLimit: parsed.lastRateLimit ?? null,
					errors: Array.isArray(parsed.errors) ? parsed.errors.slice(-200) : [],
				};
				for (const source of ['finra', 'sec'] as const) {
					const candidate = parsed.sourceCadence?.[source];
					if (!candidate || typeof candidate !== 'object') continue;
					report.sourceCadence[source] = {
						baseDelayMinMs: parsePositiveInteger(String(candidate.baseDelayMinMs || '')) ?? config.requestDelayMinMs,
						baseDelayMaxMs: parsePositiveInteger(String(candidate.baseDelayMaxMs || '')) ?? config.requestDelayMaxMs,
						recommendedDelayMs: parsePositiveInteger(String(candidate.recommendedDelayMs || ''))
							?? Math.round((config.requestDelayMinMs + config.requestDelayMaxMs) / 2),
						currentDelayMinMs: parsePositiveInteger(String(candidate.currentDelayMinMs || '')) ?? config.requestDelayMinMs,
						currentDelayMaxMs: parsePositiveInteger(String(candidate.currentDelayMaxMs || '')) ?? config.requestDelayMaxMs,
						consecutive429s: parsePositiveInteger(String(candidate.consecutive429s || '')) ?? 0,
						successesSince429: parsePositiveInteger(String(candidate.successesSince429 || '')) ?? 0,
						last429At: typeof candidate.last429At === 'string' ? candidate.last429At : null,
						last429DelayMs: parsePositiveInteger(String(candidate.last429DelayMs || '')),
					};
					recomputeCadenceWindow(report.sourceCadence[source]);
				}
				return report;
			}
		} catch (error: any) {
			if (error?.code !== 'ENOENT') throw error;
		}
	}

	return {
		generatedAt: new Date().toISOString(),
		startedAt: new Date().toISOString(),
		completedAt: null,
		sources: config.sources,
		types: config.types,
		targetCount: targets.targetCount,
		cursor: 0,
		limit: Number.isFinite(config.limit) ? config.limit : null,
		flushEvery: config.flushEvery,
		requestDelayMinMs: config.requestDelayMinMs,
		requestDelayMaxMs: config.requestDelayMaxMs,
		decayAfterSuccesses: config.decayAfterSuccesses,
		targetsPath,
		statusCounts: {} as Record<AuditStatus, number>,
		rateLimitCounts: {},
		sourceCadence: buildInitialCadenceState(config),
		lastProcessed: null,
		lastRateLimit: null,
		errors: [],
	};
}

async function flushReport(report: AuditReport) {
	report.generatedAt = new Date().toISOString();
	await fs.mkdir(outDir, { recursive: true });
	await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf-8');
}

async function waitForCadence(source: Source, report: AuditReport) {
	const cadence = report.sourceCadence[source];
	const waitMs = randBetween(cadence.currentDelayMinMs, cadence.currentDelayMaxMs);
	if (waitMs > 0) {
		console.log(
			`[cadence] ${source.toUpperCase()} waiting ${Math.round(waitMs / 1000)}s `
			+ `(window ${Math.round(cadence.currentDelayMinMs / 1000)}-${Math.round(cadence.currentDelayMaxMs / 1000)}s).`,
		);
		await sleep(waitMs);
	}
}

async function fetchLivePayload(target: AuditTarget, report: AuditReport) {
	const url = buildEndpoint({ source: target.source, type: target.type, crd: target.crd });
	if (!url) throw new Error(`No detail endpoint configured for ${target.key}`);

	let attempt = 0;
	while (true) {
		attempt += 1;
		const response = await fetch(url, {
			headers: {
				accept: 'application/json,text/plain;q=0.9,*/*;q=0.8',
				'user-agent': 'Mozilla/5.0 (compatible; Data-finra-sec external audit)',
			},
		});

		if (response.status === 429) {
			const sourceCadence = report.sourceCadence[target.source];
			const waitMs = compute429WaitMs(sourceCadence, parseRetryAfterMs(response.headers.get('retry-after')));
			const at = new Date().toISOString();
			record429Cadence(sourceCadence, waitMs, at);
			report.rateLimitCounts[target.source] = (report.rateLimitCounts[target.source] || 0) + 1;
			report.lastRateLimit = {
				key: target.key,
				source: target.source,
				attempt,
				waitMs,
				at,
			};
			await flushReport(report);
			console.log(
				`[429] ${target.key} attempt ${attempt}; waiting ${Math.round(waitMs / 60000)} minute(s) before retry.`,
			);
			await sleep(waitMs);
			continue;
		}

		if (response.status >= 500 && response.status < 600) {
			const text = await response.text().catch(() => '');
			throw new Error(`Upstream error ${response.status} for ${target.key}${text ? `: ${text.slice(0, 200)}` : ''}`);
		}

		if (!response.ok) {
			const text = await response.text().catch(() => '');
			throw new Error(`HTTP ${response.status} ${response.statusText}${text ? `: ${text.slice(0, 200)}` : ''}`);
		}

		const contentType = response.headers.get('content-type');
		const text = await response.text();
		const trimmed = text.trim();
		if (!trimmed) return { kind: 'empty' } as LiveFetchResult;
		try {
			return { kind: 'json', payload: JSON.parse(trimmed) } as LiveFetchResult;
		} catch (error) {
			if (isBlockingText(trimmed, contentType)) {
				return { kind: 'blocked', raw: trimmed.slice(0, 1000) } as LiveFetchResult;
			}
			throw new Error(`Expected JSON from ${target.key} but received non-JSON content.`);
		}
	}
}

async function auditOneTarget(target: AuditTarget, report: AuditReport): Promise<AuditStatus> {
	const existing = await inspectSavedPayload(target.key);
	if (!existing.exists && !existing.invalid) {
		return 'skipped-missing-local';
	}

	const result = await fetchLivePayload(target, report);
	if (result.kind === 'blocked') {
		return 'blocked';
	}
	if (result.kind === 'empty') return 'empty';
	const payload = result.payload;
	if (isEmptyPayload(payload)) {
		return 'empty';
	}
	if (hasBlockingIndicators(payload)) {
		return 'blocked';
	}
	if (isNonActionableSavedDetail(target.key, payload)) {
		await removeSavedPayload(target.key);
		return 'removed';
	}
	const syncResult = await syncSavedPayload(target.key, payload);
	if (
		syncResult.status === 'downloaded'
		|| syncResult.status === 'updated'
		|| syncResult.status === 'repaired'
		|| syncResult.status === 'unchanged'
	) {
		return syncResult.status;
	}
	throw new Error(`Unexpected sync status "${String(syncResult.status)}" for ${target.key}`);
}

function incrementStatus(report: AuditReport, status: AuditStatus) {
	report.statusCounts[status] = (report.statusCounts[status] || 0) + 1;
}

async function main() {
	const config = parseArgs(process.argv.slice(2));
	const targets = await loadTargetsSnapshot(config);
	const report = await loadOrCreateReport(config, targets);

	await flushReport(report);

	if (!targets.targetCount) {
		report.completedAt = new Date().toISOString();
		await flushReport(report);
		console.log('No saved CRD detail files matched the selected filters.');
		return;
	}

	console.log(`Loaded ${targets.targetCount.toLocaleString()} saved CRD target(s).`);
	console.log(`Target snapshot: ${targetsPath}`);
	console.log(`Report path: ${reportPath}`);
	console.log(
		`Randomized cadence starts at ${config.requestDelayMinMs.toLocaleString()}-${config.requestDelayMaxMs.toLocaleString()}ms `
		+ 'and escalates to 3, 4, 5... minute pauses per source after repeated 429s.',
	);

	let processedThisRun = 0;

	while (report.cursor < targets.targets.length && processedThisRun < config.limit) {
		const target = targets.targets[report.cursor];
		await waitForCadence(target.source, report);
		const startedAt = new Date().toISOString();
		process.stdout.write(`[${report.cursor + 1}/${targets.targets.length}] ${target.key} ... `);

		try {
			const status = await auditOneTarget(target, report);
			recordSuccessfulCadence(report.sourceCadence[target.source], report.decayAfterSuccesses);
			incrementStatus(report, status);
			report.lastProcessed = {
				key: target.key,
				status,
				at: startedAt,
			};
			report.cursor += 1;
			processedThisRun += 1;
			console.log(status);
		} catch (error) {
			const message = formatErrorMessage(error);
			incrementStatus(report, 'error');
			report.lastProcessed = {
				key: target.key,
				status: 'error',
				at: startedAt,
			};
			report.errors.push({ key: target.key, message, at: startedAt });
			report.errors = report.errors.slice(-200);
			report.cursor += 1;
			processedThisRun += 1;
			console.log(`error (${message})`);
		}

		if (processedThisRun % report.flushEvery === 0) {
			await flushReport(report);
		}
	}

	if (report.cursor >= targets.targets.length) {
		report.completedAt = new Date().toISOString();
	}

	await flushReport(report);

	if (report.completedAt) {
		console.log('External CRD audit complete.');
	} else {
		console.log(`Paused after ${processedThisRun.toLocaleString()} item(s); resume with the same command.`);
	}
}

main().catch((error) => {
	console.error(formatErrorMessage(error));
	process.exit(1);
});
