#!/usr/bin/env node
import { promises as fs } from 'fs';
import path from 'path';
import {
	buildEndpoint,
	detailFilenameForSource,
	discoverCrdsFromPayload,
	fetchWithCache,
	formatErrorMessage,
	hasBlockingIndicators,
	inspectSavedPayload,
	isEmptyPayload,
	isIaOnlyFromPayload,
	syncSavedPayload,
} from '../pages/api/_lib';

type Source = 'finra' | 'sec';
type SyncStatus = 'downloaded' | 'updated' | 'repaired' | 'unchanged';

const rawDir = path.resolve(process.cwd(), 'data', 'raw');
const outDir = path.resolve(process.cwd(), 'data', 'derived');
const reportPath = path.join(outDir, 'query-common-name-crds-report.json');

const corporateStopWords = new Set([
	'inc',
	'llc',
	'ltd',
	'corp',
	'corporation',
	'company',
	'co',
	'group',
	'partners',
	'capital',
	'management',
	'financial',
	'advisors',
	'adviser',
	'advisor',
	'investments',
	'investment',
	'securities',
	'services',
	'service',
	'holdings',
	'associates',
	'asset',
	'fund',
	'funds',
	'bank',
	'trust',
	'wealth',
	'institutional',
	'national',
	'american',
	'international',
	'markets',
	'market',
	'insurance',
	'equity',
	'global',
	'private',
	'the',
	'and',
	'of',
	'sr',
	'jr',
	'iii',
	'ii',
	'iv',
	'pc',
	'pllc',
	'lp',
	'llp',
	'holdco',
	'enterprises',
	'enterprise',
	'distribution',
	'distributors',
	'brokerage',
	'advisory',
	'consulting',
	'consultants',
	'usa',
	'professional',
	'operations',
]);

function parseArgs(argv: string[]) {
	const config = {
		limitTerms: 10,
		limitCrds: Number.POSITIVE_INFINITY,
		refreshExisting: false,
	};

	for (const arg of argv) {
		if (arg === '--refresh-existing') {
			config.refreshExisting = true;
			continue;
		}
		if (arg.startsWith('--limit-terms=')) {
			const parsed = Number(arg.slice('--limit-terms='.length));
			if (Number.isFinite(parsed) && parsed > 0) config.limitTerms = parsed;
			continue;
		}
		if (arg.startsWith('--limit-crds=')) {
			const parsed = Number(arg.slice('--limit-crds='.length));
			if (Number.isFinite(parsed) && parsed > 0) config.limitCrds = parsed;
		}
	}

	return config;
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

function normalizeNameTokens(value: string) {
	const normalized = value
		.toLowerCase()
		.replace(/[^a-z]+/g, ' ')
		.trim();
	if (!normalized) return [];
	return normalized
		.split(/\s+/)
		.filter(Boolean)
		.filter((token) => token.length >= 3 && !corporateStopWords.has(token));
}

async function collectTopNameTrigrams(limitTerms: number) {
	const entries = (await fs.readdir(rawDir)).filter((entry) => entry.endsWith('.json'));
	const trigramCounts = new Map<string, number>();
	const examplesByTrigram = new Map<string, Set<string>>();
	let parseFailures = 0;

	for (const entry of entries) {
		try {
			const payload = JSON.parse(await fs.readFile(path.join(rawDir, entry), 'utf-8'));
			walk(payload, (key, value) => {
				if (typeof value !== 'string') return;
				const normalizedKey = key.toLowerCase();
				if (!normalizedKey.includes('name') || normalizedKey.includes('district') || normalizedKey.includes('firm')) return;
				const raw = value.trim();
				if (!raw.includes(',') || raw.length > 60 || /[()]/.test(raw)) return;
				const tokens = normalizeNameTokens(raw);
				if (tokens.length < 2 || tokens.length > 4) return;
				const perNameTrigrams = new Set<string>();
				for (const token of tokens) {
					for (let i = 0; i <= token.length - 3; i += 1) {
						perNameTrigrams.add(token.slice(i, i + 3));
					}
				}
				for (const trigram of perNameTrigrams) {
					trigramCounts.set(trigram, (trigramCounts.get(trigram) || 0) + 1);
					const examples = examplesByTrigram.get(trigram) || new Set<string>();
					if (examples.size < 5) examples.add(raw);
					examplesByTrigram.set(trigram, examples);
				}
			});
		} catch {
			parseFailures += 1;
		}
	}

	const topTerms = Array.from(trigramCounts.entries())
		.sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
		.slice(0, limitTerms)
		.map(([term, count]) => ({
			term,
			count,
			examples: Array.from(examplesByTrigram.get(term) || []).sort(),
		}));

	return { fileCount: entries.length, parseFailures, topTerms };
}

function searchUrlFor(source: Source, term: string) {
	if (source === 'finra') {
		return `https://api.brokercheck.finra.org/search/individual?query=${encodeURIComponent(term)}&hl=true&includePrevious=true&nrows=50&wt=json`;
	}
	return `https://api.adviserinfo.sec.gov/search/individual?query=${encodeURIComponent(term)}&hl=true&includePrevious=true&nrows=50&wt=json`;
}

async function searchTerm(source: Source, term: string) {
	const url = searchUrlFor(source, term);
	const payload = await fetchWithCache(url);
	if (isEmptyPayload(payload) || hasBlockingIndicators(payload)) {
		return { crds: [] as string[], empty: true };
	}
	return { crds: discoverCrdsFromPayload(payload), empty: false };
}

async function fetchAndSyncProfile(source: Source, crd: string, refreshExisting: boolean) {
	const url = buildEndpoint({ source, type: 'individual', crd });
	if (!url) throw new Error(`Unsupported detail URL for ${source} ${crd}`);

	const filename = detailFilenameForSource(source, 'individual', crd);
	const existing = await inspectSavedPayload(filename);
	const payload = await fetchWithCache(url, { forceRefresh: refreshExisting || existing.exists });
	if (isEmptyPayload(payload)) return { status: 'empty' as const, filename };
	if (hasBlockingIndicators(payload)) return { status: 'blocked' as const, filename };
	const sync = await syncSavedPayload(filename, payload);
	return { status: sync.status as SyncStatus, filename };
}

async function syncKnownProfile(source: Source, crd: string, payload: unknown) {
	const filename = detailFilenameForSource(source, 'individual', crd);
	if (isEmptyPayload(payload)) return { status: 'empty' as const, filename };
	if (hasBlockingIndicators(payload)) return { status: 'blocked' as const, filename };
	const sync = await syncSavedPayload(filename, payload);
	return { status: sync.status as SyncStatus, filename };
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	await fs.mkdir(outDir, { recursive: true });

	const { fileCount, parseFailures, topTerms } = await collectTopNameTrigrams(args.limitTerms);
	const termMatches: Record<string, Record<Source, string[]>> = {};
	const discoveredCrds = new Set<string>();
	const searchErrors: Array<{ source: Source; term: string; message: string }> = [];

	console.log(`Selected ${topTerms.length} common three-letter name terms: ${topTerms.map((entry) => entry.term).join(', ')}`);

	for (const { term } of topTerms) {
		termMatches[term] = { finra: [], sec: [] };
		for (const source of ['finra', 'sec'] as Source[]) {
			process.stdout.write(`Searching ${source.toUpperCase()} for "${term}" ... `);
			try {
				const result = await searchTerm(source, term);
				const crds = Array.from(new Set(result.crds)).sort((left, right) => Number(left) - Number(right));
				termMatches[term][source] = crds;
				for (const crd of crds) discoveredCrds.add(crd);
				console.log(result.empty ? 'empty' : `${crds.length} CRDs`);
			} catch (error) {
				const message = formatErrorMessage(error);
				searchErrors.push({ source, term, message });
				console.log(`error (${message})`);
			}
		}
	}

	const selectedCrds = Array.from(discoveredCrds)
		.sort((left, right) => Number(left) - Number(right))
		.slice(0, args.limitCrds);

	const syncSummary: Record<SyncStatus, string[]> = {
		downloaded: [],
		updated: [],
		repaired: [],
		unchanged: [],
	};
	const statusCounts: Record<string, number> = {
		searchErrors: searchErrors.length,
	};
	const detailErrors: Array<{ source: Source; crd: string; message: string }> = [];

	console.log(`Discovered ${selectedCrds.length} unique CRDs from the selected name terms.`);

	for (let index = 0; index < selectedCrds.length; index += 1) {
		const crd = selectedCrds[index];
		process.stdout.write(`[${index + 1}/${selectedCrds.length}] Hydrating CRD ${crd} ... `);
		try {
			const finraProbeUrl = buildEndpoint({ source: 'finra', type: 'individual', crd });
			if (!finraProbeUrl) throw new Error(`Missing FINRA probe URL for ${crd}`);
			const finraProbeFilename = detailFilenameForSource('finra', 'individual', crd);
			const finraExisting = await inspectSavedPayload(finraProbeFilename);
			const finraProbe = await fetchWithCache(finraProbeUrl, { forceRefresh: args.refreshExisting || finraExisting.exists });
			const iaOnly = isIaOnlyFromPayload(finraProbe || {});

			const finraTargets = iaOnly ? [] : [await syncKnownProfile('finra', crd, finraProbe)];
			const otherTargets = iaOnly ? (['sec'] as Source[]) : (['sec'] as Source[]);
			for (const sync of finraTargets) {
				statusCounts[sync.status] = (statusCounts[sync.status] || 0) + 1;
				if (sync.status === 'downloaded' || sync.status === 'updated' || sync.status === 'repaired' || sync.status === 'unchanged') {
					syncSummary[sync.status].push(sync.filename);
				}
			}
			for (const source of otherTargets) {
				const sync = await fetchAndSyncProfile(source, crd, args.refreshExisting);
				statusCounts[sync.status] = (statusCounts[sync.status] || 0) + 1;
				if (sync.status === 'downloaded' || sync.status === 'updated' || sync.status === 'repaired' || sync.status === 'unchanged') {
					syncSummary[sync.status].push(sync.filename);
				}
			}
			console.log(iaOnly ? 'sec-only' : 'finra+sec');
		} catch (error) {
			const message = formatErrorMessage(error);
			detailErrors.push({ source: 'finra', crd, message });
			statusCounts.error = (statusCounts.error || 0) + 1;
			console.log(`error (${message})`);
		}
	}

	const report = {
		generatedAt: new Date().toISOString(),
		refreshExisting: args.refreshExisting,
		fileCount,
		parseFailures,
		topTerms,
		discoveredCrdCount: selectedCrds.length,
		discoveredCrds: selectedCrds,
		termMatches,
		syncSummary,
		statusCounts,
		searchErrors,
		detailErrors,
	};

	await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf-8');
	console.log(`Done. Wrote ${reportPath}`);
}

main().catch((error) => {
	console.error(formatErrorMessage(error));
	process.exit(1);
});
