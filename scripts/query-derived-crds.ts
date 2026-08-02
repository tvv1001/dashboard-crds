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
	loadSavedPayload,
	syncSavedPayload,
} from '../pages/api/_lib';

type Source = 'finra' | 'sec';
type EntityType = 'firm' | 'individual';
type DiscoveryKey = 'firmId' | 'crdNumber';

type Target = {
	type: EntityType;
	crd: string;
	discoveredFrom: Set<DiscoveryKey>;
	files: Set<string>;
};

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

const rawDir = path.resolve(process.cwd(), 'data', 'raw');
const outDir = path.resolve(process.cwd(), 'data', 'derived');
const targetsPath = path.join(outDir, 'query-derived-crds-targets.json');
const reportPath = path.join(outDir, 'query-derived-crds-report.json');

function parseArgs(argv: string[]) {
	const config = {
		refreshExisting: false,
		limit: Number.POSITIVE_INFINITY,
		sources: ['finra', 'sec'] as Source[],
		types: ['firm', 'individual'] as EntityType[],
	};

	for (const arg of argv) {
		if (arg === '--refresh-existing') {
			config.refreshExisting = true;
			continue;
		}
		if (arg.startsWith('--limit=')) {
			const parsed = Number(arg.slice('--limit='.length));
			if (Number.isFinite(parsed) && parsed > 0) config.limit = parsed;
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
		}
	}

	return config;
}

function normalizeNumericId(value: unknown) {
	if (typeof value !== 'number' && typeof value !== 'string') return null;
	const text = String(value).trim();
	if (!/^\d+$/.test(text)) return null;
	const normalized = text.replace(/^0+/, '') || '0';
	if (normalized === '0') return null;
	return normalized;
}

function walk(node: unknown, visit: (key: string, value: unknown) => void, seen = new Set<unknown>()) {
	if (!node || typeof node !== 'object') return;
	if (seen.has(node)) return;
	seen.add(node);

	if (Array.isArray(node)) {
		for (const item of node) walk(item, visit, seen);
		return;
	}

	for (const [key, value] of Object.entries(node)) {
		visit(key, value);
		walk(value, visit, seen);
	}
}

function mergeTarget(targets: Map<string, Target>, file: string, type: EntityType, crd: string, discoveredFrom: DiscoveryKey) {
	const key = `${type}:${crd}`;
	const current = targets.get(key) || {
		type,
		crd,
		discoveredFrom: new Set<DiscoveryKey>(),
		files: new Set<string>(),
	};
	current.discoveredFrom.add(discoveredFrom);
	current.files.add(file);
	targets.set(key, current);
}

function extractTargetsFromPayload(file: string, payload: unknown, targets: Map<string, Target>) {
	walk(payload, (key, value) => {
		const normalizedKey = key.toLowerCase();
		const crd = normalizeNumericId(value);
		if (!crd) return;
		if (normalizedKey === 'firmid' || normalizedKey === 'firm_id') {
			mergeTarget(targets, file, 'firm', crd, 'firmId');
			return;
		}
		if (normalizedKey === 'crdnumber' || normalizedKey === 'crd_number') {
			mergeTarget(targets, file, 'individual', crd, 'crdNumber');
		}
	});
}

async function collectTargets() {
	const stats = await listSavedKeysWithStats({ limit: 0 });
	const targets = new Map<string, Target>();
	let parseFailures = 0;

	for (const keyStat of stats.keys) {
		try {
			const payload = await loadSavedPayload(keyStat.key);
			extractTargetsFromPayload(keyStat.key, payload, targets);
		} catch {
			parseFailures += 1;
		}
	}

	return { fileCount: stats.keys.length, parseFailures, targets };
}

function summarizeTargetCounts(targets: Target[]) {
	return targets.reduce(
		(summary, target) => {
			summary[target.type] += 1;
			return summary;
		},
		{ firm: 0, individual: 0 },
	);
}

async function saveTargetsSnapshot(fileCount: number, parseFailures: number, targets: Target[]) {
	await fs.mkdir(outDir, { recursive: true });
	await fs.writeFile(
		targetsPath,
		JSON.stringify(
			{
				generatedAt: new Date().toISOString(),
				fileCount,
				parseFailures,
				targetCount: targets.length,
				targets: targets.map((target) => ({
					type: target.type,
					crd: target.crd,
					discoveredFrom: Array.from(target.discoveredFrom).sort(),
					files: Array.from(target.files).sort(),
				})),
			},
			null,
			2,
		),
		'utf-8',
	);
}

async function fetchTarget(source: Source, target: Target, refreshExisting: boolean): Promise<RequestResult> {
	const filename = detailFilenameForSource(source, target.type, target.crd);
	const existing = await inspectSavedPayload(filename);
	if (existing.exists && !existing.invalid && !refreshExisting) {
		return { status: 'skipped-existing' as const, filename };
	}

	const url = buildEndpoint({ source, type: target.type, crd: target.crd });
	if (!url) throw new Error(`No detail endpoint configured for ${source} ${target.type} ${target.crd}`);

	const payload = await fetchWithCache(url, {
		forceRefresh: refreshExisting || existing.invalid,
		onRateLimit: async ({ attempt, waitMs }) => {
			console.log(`[rate-limit] ${source} ${target.type} ${target.crd} attempt ${attempt}; upstream requested a pause (~${Math.round(waitMs / 1000)}s)`);
		},
	});

	if (isEmptyPayload(payload)) {
		return { status: 'empty' as const, filename };
	}
	if (hasBlockingIndicators(payload)) {
		return { status: 'blocked' as const, filename };
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
	const { fileCount, parseFailures, targets } = await collectTargets();

	const filteredTargets = Array.from(targets.values())
		.filter((target) => args.types.includes(target.type))
		.sort((left, right) => Number(left.crd) - Number(right.crd) || left.type.localeCompare(right.type))
		.slice(0, args.limit);

	await saveTargetsSnapshot(fileCount, parseFailures, filteredTargets);

	const counts = summarizeTargetCounts(filteredTargets);
	const report = {
		generatedAt: new Date().toISOString(),
		refreshExisting: args.refreshExisting,
		sources: args.sources,
		types: args.types,
		fileCount,
		parseFailures,
		targetCount: filteredTargets.length,
		targetsPath,
		counts,
		statusCounts: {} as Record<RequestResultStatus, number>,
		errors: [] as Array<{ source: Source; type: EntityType; crd: string; message: string }>,
	};

	const incrementStatus = (status: RequestResultStatus) => {
		report.statusCounts[status] = (report.statusCounts[status] || 0) + 1;
	};

	const flushReport = async () => {
		await fs.mkdir(outDir, { recursive: true });
		await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf-8');
	};

	console.log(`Scanned ${fileCount} raw files and found ${filteredTargets.length} query targets (${counts.firm} firms, ${counts.individual} individuals).`);
	console.log(`Target snapshot: ${targetsPath}`);
	console.log(`Report path: ${reportPath}`);

	const totalRequests = filteredTargets.length * args.sources.length;
	let requestIndex = 0;

	for (const target of filteredTargets) {
		for (const source of args.sources) {
			requestIndex += 1;
			process.stdout.write(`[${requestIndex}/${totalRequests}] ${source.toUpperCase()} ${target.type} ${target.crd} ... `);
			try {
				const result = await fetchTarget(source, target, args.refreshExisting);
				incrementStatus(result.status);
				console.log(result.status);
			} catch (error) {
				incrementStatus('error');
				const message = formatErrorMessage(error);
				report.errors.push({ source, type: target.type, crd: target.crd, message });
				console.log(`error (${message})`);
			}

			if (requestIndex % 25 === 0) {
				report.generatedAt = new Date().toISOString();
				await flushReport();
			}
		}
	}

	report.generatedAt = new Date().toISOString();
	await flushReport();
	console.log(`Done. Wrote ${reportPath}`);
}

main().catch((error) => {
	console.error(formatErrorMessage(error));
	process.exit(1);
});
