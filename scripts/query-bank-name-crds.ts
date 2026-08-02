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
type DiscoveryKey = 'firmId' | 'crdNumber';
type RequestResultStatus = 'skipped-existing' | 'downloaded' | 'updated' | 'repaired' | 'unchanged' | 'empty' | 'blocked' | 'error';

type Target = {
	type: EntityType;
	crd: string;
	discoveredFrom: Set<string>;
	files: Set<string>;
};

const rawDir = path.resolve(process.cwd(), 'data', 'raw');
const outDir = path.resolve(process.cwd(), 'data', 'derived');
const reportPath = path.join(outDir, 'query-bank-name-crds-report.json');
const targetsPath = path.join(outDir, 'query-bank-name-crds-targets.json');

const defaultBankTerms = [
	'bank of america',
	'wells fargo',
	'jpmorgan',
	'chase',
	'citibank',
	'pnc bank',
	'capital one',
	'u.s. bank',
	'td bank',
	'truist',
	'citizens bank',
	'regions bank',
	'keybank',
	'fifth third',
	'goldman sachs',
	'morgan stanley',
	'barclays',
	'hsbc',
	'bmo',
	'bank',
];

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function randBetween(min: number, max: number) {
	const lo = Number(min) || 0;
	const hi = Number(max) || 0;
	if (hi <= lo) return lo;
	return Math.round(lo + Math.random() * (hi - lo));
}

function parseArgs(argv: string[]) {
	const config = {
		refreshExisting: false,
		limitTargets: Number.POSITIVE_INFINITY,
		terms: defaultBankTerms,
		searchDelayMinMs: 5000,
		searchDelayMaxMs: 12000,
		detailDelayMinMs: 2000,
		detailDelayMaxMs: 6000,
	};

	for (const arg of argv) {
		if (arg === '--refresh-existing') {
			config.refreshExisting = true;
			continue;
		}
		if (arg.startsWith('--limit-targets=')) {
			const parsed = Number(arg.slice('--limit-targets='.length));
			if (Number.isFinite(parsed) && parsed > 0) config.limitTargets = parsed;
			continue;
		}
		if (arg.startsWith('--terms=')) {
			const parsed = Array.from(
				new Set(
					arg
						.slice('--terms='.length)
						.split(',')
						.map((value) => value.trim())
						.filter(Boolean),
				),
			);
			if (parsed.length) config.terms = parsed;
			continue;
		}
		if (arg.startsWith('--search-delay-min-ms=')) {
			const parsed = Number(arg.slice('--search-delay-min-ms='.length));
			if (Number.isFinite(parsed) && parsed >= 0) config.searchDelayMinMs = parsed;
			continue;
		}
		if (arg.startsWith('--search-delay-max-ms=')) {
			const parsed = Number(arg.slice('--search-delay-max-ms='.length));
			if (Number.isFinite(parsed) && parsed >= 0) config.searchDelayMaxMs = parsed;
			continue;
		}
		if (arg.startsWith('--detail-delay-min-ms=')) {
			const parsed = Number(arg.slice('--detail-delay-min-ms='.length));
			if (Number.isFinite(parsed) && parsed >= 0) config.detailDelayMinMs = parsed;
			continue;
		}
		if (arg.startsWith('--detail-delay-max-ms=')) {
			const parsed = Number(arg.slice('--detail-delay-max-ms='.length));
			if (Number.isFinite(parsed) && parsed >= 0) config.detailDelayMaxMs = parsed;
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

function mergeTarget(targets: Map<string, Target>, file: string, type: EntityType, crd: string, discoveredFrom: string) {
	const key = `${type}:${crd}`;
	const current = targets.get(key) || {
		type,
		crd,
		discoveredFrom: new Set<string>(),
		files: new Set<string>(),
	};
	current.discoveredFrom.add(discoveredFrom);
	current.files.add(file);
	targets.set(key, current);
}

function extractTargetsFromPayload(file: string, payload: unknown, targets: Map<string, Target>, discoveredFrom: string) {
	walk(payload, (key, value) => {
		const normalizedKey = key.toLowerCase();
		const crd = normalizeNumericId(value);
		if (!crd) return;
		if (normalizedKey === 'firmid' || normalizedKey === 'firm_id') {
			mergeTarget(targets, file, 'firm', crd, discoveredFrom);
			return;
		}
		if (normalizedKey === 'crdnumber' || normalizedKey === 'crd_number') {
			mergeTarget(targets, file, 'individual', crd, discoveredFrom);
		}
	});
}

async function collectTargetsFromExistingDownloads() {
	const entries = (await fs.readdir(rawDir)).filter((entry) => entry.endsWith('.json'));
	const targets = new Map<string, Target>();
	let parseFailures = 0;

	for (const entry of entries) {
		try {
			const payload = JSON.parse(await fs.readFile(path.join(rawDir, entry), 'utf-8'));
			extractTargetsFromPayload(entry, payload, targets, 'existing-download');
		} catch {
			parseFailures += 1;
		}
	}

	return { fileCount: entries.length, parseFailures, targets };
}

function searchUrlFor(source: Source, type: EntityType, term: string) {
	return `https://${source === 'finra' ? 'api.brokercheck.finra.org' : 'api.adviserinfo.sec.gov'}/search/${type}?query=${encodeURIComponent(term)}&hl=true&includePrevious=true&nrows=50&wt=json`;
}

async function searchBankTerm(source: Source, type: EntityType, term: string) {
	const url = searchUrlFor(source, type, term);
	const payload = await fetchWithCache(url);
	if (isEmptyPayload(payload) || hasBlockingIndicators(payload)) {
		return { payload, count: 0, empty: true };
	}
	return { payload, count: 1, empty: false };
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

async function fetchTarget(source: Source, target: Target, refreshExisting: boolean) {
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
			console.log(`[rate-limit] ${source} ${target.type} ${target.crd} attempt ${attempt}; waiting ~${Math.round(waitMs / 1000)}s`);
		},
	});

	if (isEmptyPayload(payload)) return { status: 'empty' as const, filename };
	if (hasBlockingIndicators(payload)) return { status: 'blocked' as const, filename };

	const sync = await syncSavedPayload(filename, payload);
	if (sync.status === 'downloaded' || sync.status === 'updated' || sync.status === 'repaired' || sync.status === 'unchanged') {
		return { status: sync.status as Exclude<RequestResultStatus, 'error'>, filename };
	}
	throw new Error(`Unexpected sync status "${String(sync.status)}" for ${filename}`);
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const { fileCount, parseFailures, targets: existingTargets } = await collectTargetsFromExistingDownloads();
	const combinedTargets = new Map<string, Target>(existingTargets);
	const existingTargetCount = combinedTargets.size;
	const searchSummary: Record<string, Record<string, number>> = {};
	const searchErrors: Array<{ source: Source; type: EntityType; term: string; message: string }> = [];

	await fs.mkdir(outDir, { recursive: true });

	console.log(`Searching ${args.terms.length} bank terms slowly: ${args.terms.join(' | ')}`);
	console.log(`Pacing: search ${args.searchDelayMinMs}-${args.searchDelayMaxMs}ms, detail ${args.detailDelayMinMs}-${args.detailDelayMaxMs}ms`);

	for (const term of args.terms) {
		searchSummary[term] = {};
		for (const type of ['firm', 'individual'] as EntityType[]) {
			for (const source of ['finra', 'sec'] as Source[]) {
				process.stdout.write(`Searching ${source.toUpperCase()} ${type} for "${term}" ... `);
				try {
					const { payload, empty } = await searchBankTerm(source, type, term);
					const beforeCount = combinedTargets.size;
					extractTargetsFromPayload(`search:${source}:${type}:${term}`, payload, combinedTargets, `bank-term:${term}`);
					const discoveredNow = combinedTargets.size - beforeCount;
					searchSummary[term][`${source}:${type}`] = discoveredNow;
					console.log(empty ? 'empty' : `${discoveredNow} new typed CRDs`);
				} catch (error) {
					const message = formatErrorMessage(error);
					searchErrors.push({ source, type, term, message });
					searchSummary[term][`${source}:${type}`] = -1;
					console.log(`error (${message})`);
				}
				await sleep(randBetween(args.searchDelayMinMs, args.searchDelayMaxMs));
			}
		}
	}

	const filteredTargets = Array.from(combinedTargets.values())
		.sort((left, right) => Number(left.crd) - Number(right.crd) || left.type.localeCompare(right.type))
		.slice(0, args.limitTargets);

	await saveTargetsSnapshot(fileCount, parseFailures, filteredTargets);

	const report = {
		generatedAt: new Date().toISOString(),
		refreshExisting: args.refreshExisting,
		fileCount,
		parseFailures,
		bankTerms: args.terms,
		existingTargetCount,
		delays: {
			searchMinMs: args.searchDelayMinMs,
			searchMaxMs: args.searchDelayMaxMs,
			detailMinMs: args.detailDelayMinMs,
			detailMaxMs: args.detailDelayMaxMs,
		},
		targetCount: filteredTargets.length,
		targetsPath,
		statusCounts: {} as Record<RequestResultStatus, number>,
		searchSummary,
		searchErrors,
		errors: [] as Array<{ source: Source; type: EntityType; crd: string; message: string }>,
	};

	const incrementStatus = (status: RequestResultStatus) => {
		report.statusCounts[status] = (report.statusCounts[status] || 0) + 1;
	};

	const flushReport = async () => {
		report.generatedAt = new Date().toISOString();
		await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf-8');
	};

	console.log(`Combined target set: ${filteredTargets.length} typed CRDs (${existingTargetCount} from existing downloads before bank-name expansion).`);
	console.log(`Target snapshot: ${targetsPath}`);
	console.log(`Report path: ${reportPath}`);

	let requestIndex = 0;
	const totalRequests = filteredTargets.length * 2;
	for (const target of filteredTargets) {
		for (const source of ['finra', 'sec'] as Source[]) {
			requestIndex += 1;
			process.stdout.write(`[${requestIndex}/${totalRequests}] ${source.toUpperCase()} ${target.type} ${target.crd} ... `);
			try {
				const result = await fetchTarget(source, target, args.refreshExisting);
				incrementStatus(result.status);
				console.log(result.status);
				if (result.status !== 'skipped-existing') {
					await sleep(randBetween(args.detailDelayMinMs, args.detailDelayMaxMs));
				}
			} catch (error) {
				incrementStatus('error');
				const message = formatErrorMessage(error);
				report.errors.push({ source, type: target.type, crd: target.crd, message });
				console.log(`error (${message})`);
				await sleep(randBetween(args.detailDelayMinMs, args.detailDelayMaxMs));
			}

			if (requestIndex % 10 === 0) await flushReport();
		}
	}

	await flushReport();
	console.log(`Done. Wrote ${reportPath}`);
}

main().catch((error) => {
	console.error(formatErrorMessage(error));
	process.exit(1);
});
