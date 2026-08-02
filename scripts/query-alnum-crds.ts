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

const outDir = path.resolve(process.cwd(), 'data', 'derived');
const reportPath = path.join(outDir, 'query-alnum-crds-report.json');
const defaultSeeds = 'abcdefghijklmnopqrstuvwxyz0123456789'.split('');

function parseArgs(argv: string[]) {
	const config = {
		refreshExisting: false,
		limitCrds: Number.POSITIVE_INFINITY,
		seeds: defaultSeeds,
	};

	for (const arg of argv) {
		if (arg === '--refresh-existing') {
			config.refreshExisting = true;
			continue;
		}
		if (arg.startsWith('--limit-crds=')) {
			const parsed = Number(arg.slice('--limit-crds='.length));
			if (Number.isFinite(parsed) && parsed > 0) config.limitCrds = parsed;
			continue;
		}
		if (arg.startsWith('--seeds=')) {
			const parsed = Array.from(
				new Set(
					arg
						.slice('--seeds='.length)
						.split(',')
						.map((value) => value.trim().toLowerCase())
						.filter((value) => /^[a-z0-9]$/.test(value)),
				),
			);
			if (parsed.length) config.seeds = parsed;
		}
	}

	return config;
}

function searchUrlFor(source: Source, term: string) {
	if (source === 'finra') {
		return `https://api.brokercheck.finra.org/search/individual?query=${encodeURIComponent(term)}&hl=true&includePrevious=true&nrows=50&wt=json`;
	}
	return `https://api.adviserinfo.sec.gov/search/individual?query=${encodeURIComponent(term)}&hl=true&includePrevious=true&nrows=50&wt=json`;
}

async function searchSeed(source: Source, seed: string) {
	const url = searchUrlFor(source, seed);
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

	const seedMatches: Record<string, Record<Source, string[]>> = {};
	const discoveredCrds = new Set<string>();
	const searchErrors: Array<{ source: Source; seed: string; message: string }> = [];

	console.log(`Searching ${args.seeds.length} seeds: ${args.seeds.join(', ')}`);

	for (const seed of args.seeds) {
		seedMatches[seed] = { finra: [], sec: [] };
		for (const source of ['finra', 'sec'] as Source[]) {
			process.stdout.write(`Searching ${source.toUpperCase()} for "${seed}" ... `);
			try {
				const result = await searchSeed(source, seed);
				const crds = Array.from(new Set(result.crds)).sort((left, right) => Number(left) - Number(right));
				seedMatches[seed][source] = crds;
				for (const crd of crds) discoveredCrds.add(crd);
				console.log(result.empty ? 'empty' : `${crds.length} CRDs`);
			} catch (error) {
				const message = formatErrorMessage(error);
				searchErrors.push({ source, seed, message });
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
	const detailErrors: Array<{ crd: string; message: string }> = [];

	console.log(`Discovered ${selectedCrds.length} unique CRDs from the alphanumeric seeds.`);

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
			for (const sync of finraTargets) {
				statusCounts[sync.status] = (statusCounts[sync.status] || 0) + 1;
				if (sync.status === 'downloaded' || sync.status === 'updated' || sync.status === 'repaired' || sync.status === 'unchanged') {
					syncSummary[sync.status].push(sync.filename);
				}
			}

			const secSync = await fetchAndSyncProfile('sec', crd, args.refreshExisting);
			statusCounts[secSync.status] = (statusCounts[secSync.status] || 0) + 1;
			if (secSync.status === 'downloaded' || secSync.status === 'updated' || secSync.status === 'repaired' || secSync.status === 'unchanged') {
				syncSummary[secSync.status].push(secSync.filename);
			}

			console.log(iaOnly ? 'sec-only' : 'finra+sec');
		} catch (error) {
			const message = formatErrorMessage(error);
			detailErrors.push({ crd, message });
			statusCounts.error = (statusCounts.error || 0) + 1;
			console.log(`error (${message})`);
		}
	}

	const report = {
		generatedAt: new Date().toISOString(),
		refreshExisting: args.refreshExisting,
		seeds: args.seeds,
		discoveredCrdCount: selectedCrds.length,
		discoveredCrds: selectedCrds,
		seedMatches,
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
