import { promises as fs } from 'fs';
import path from 'path';
import { buildEndpoint, fetchWithCache, formatErrorMessage, listSavedKeys, syncSavedPayload } from '../pages/api/_lib';

type Source = 'finra' | 'sec';
type Mode = 'individual' | 'firm';

interface MissingItem {
	source: Source;
	type: Mode;
	crd: string;
}

interface BackfillStats {
	totalGroups: number;
	totalMissing: number;
	attempted: number;
	saved: number;
	updated: number;
	repaired: number;
	unchanged: number;
	notFound: number;
	empty: number;
	failed: number;
	startedAt: string;
	completedAt?: string;
}

function parseLimitArg(): number {
	const index = process.argv.findIndex((arg) => arg === '--limit');
	if (index < 0) return 0;
	const value = Number(process.argv[index + 1]);
	if (!Number.isFinite(value) || value <= 0) return 0;
	return Math.floor(value);
}

function parseSinceArg(): number {
	const index = process.argv.findIndex((arg) => arg === '--since');
	if (index < 0) return 0;
	const value = Number(process.argv[index + 1]);
	if (!Number.isFinite(value) || value <= 0) return 0;
	return Math.floor(value);
}

function extractMissingPairs(keys: string[]) {
	const groups = new Map<string, { type: Mode; crd: string; hasFinra: boolean; hasSec: boolean }>();
	for (const key of keys) {
		const match = String(key || '').match(/^(finra|sec):(individual|firm):(\d+)$/i);
		if (!match) continue;
		const source = match[1].toLowerCase() as Source;
		const type = match[2].toLowerCase() as Mode;
		const crd = match[3];
		const groupKey = `${type}:${crd}`;
		if (!groups.has(groupKey)) {
			groups.set(groupKey, { type, crd, hasFinra: false, hasSec: false });
		}
		const group = groups.get(groupKey)!;
		if (source === 'finra') group.hasFinra = true;
		if (source === 'sec') group.hasSec = true;
	}

	const missing: MissingItem[] = [];
	for (const group of groups.values()) {
		if (!group.hasFinra) missing.push({ source: 'finra', type: group.type, crd: group.crd });
		if (!group.hasSec) missing.push({ source: 'sec', type: group.type, crd: group.crd });
	}

	missing.sort((a, b) => Number(a.crd) - Number(b.crd) || a.type.localeCompare(b.type) || a.source.localeCompare(b.source));
	return { groups, missing };
}

function isNotFoundPayload(payload: any) {
	if (!payload || typeof payload !== 'object') return false;
	const total = payload?.hits?.total;
	const hits = payload?.hits?.hits;
	if (typeof total === 'number' && total === 0) return true;
	if (total && typeof total === 'object' && Number(total.value) === 0) return true;
	if (Array.isArray(hits) && hits.length === 0) return true;
	return false;
}

async function run() {
	const startedAt = new Date().toISOString();
	const limit = parseLimitArg();
	const since = parseSinceArg();
	const reportDir = path.resolve(process.cwd(), 'data', 'derived');
	await fs.mkdir(reportDir, { recursive: true });

	const keys = await listSavedKeys();
	const { groups, missing } = extractMissingPairs(keys);

	const worklist = missing.filter((item) => Number(item.crd) >= since);
	const target = limit > 0 ? worklist.slice(0, limit) : worklist;

	const stats: BackfillStats = {
		totalGroups: groups.size,
		totalMissing: missing.length,
		attempted: 0,
		saved: 0,
		updated: 0,
		repaired: 0,
		unchanged: 0,
		notFound: 0,
		empty: 0,
		failed: 0,
		startedAt,
	};

	const failures: Array<{ key: string; url: string; error: string }> = [];
	const skippedNotFound: Array<{ key: string; url: string }> = [];

	console.log(`Missing pairs found: ${missing.length} across ${groups.size} CRD groups`);
	console.log(`Backfill target size: ${target.length}${limit > 0 ? ` (limit=${limit})` : ''}${since > 0 ? ` (since=${since})` : ''}`);

	for (const [idx, item] of target.entries()) {
		const key = `${item.source}:${item.type}:${item.crd}`;
		const url = buildEndpoint({ source: item.source, type: item.type, crd: item.crd });
		if (!url) {
			stats.failed += 1;
			failures.push({ key, url: '', error: 'No endpoint template for source/type' });
			continue;
		}

		stats.attempted += 1;
		try {
			// forceRefresh=true guarantees direct request to external API URL per CRD
			const payload = await fetchWithCache(url, { forceRefresh: true });
			if (isNotFoundPayload(payload)) {
				stats.notFound += 1;
				skippedNotFound.push({ key, url });
				if ((idx + 1) % 50 === 0) {
					console.log(`[${idx + 1}/${target.length}] ${key} -> not found upstream`);
				}
				continue;
			}

			const sync = await syncSavedPayload(key, payload);
			if (sync.status === 'downloaded') stats.saved += 1;
			else if (sync.status === 'updated') stats.updated += 1;
			else if (sync.status === 'repaired') stats.repaired += 1;
			else if (sync.status === 'unchanged') stats.unchanged += 1;
			else stats.empty += 1;

			if ((idx + 1) % 50 === 0) {
				console.log(
					`[${idx + 1}/${target.length}] saved=${stats.saved} updated=${stats.updated} repaired=${stats.repaired} unchanged=${stats.unchanged} notFound=${stats.notFound} failed=${stats.failed}`,
				);
			}
		} catch (error) {
			stats.failed += 1;
			failures.push({ key, url, error: formatErrorMessage(error) });
			if ((idx + 1) % 25 === 0) {
				console.log(`[${idx + 1}/${target.length}] ${key} failed: ${formatErrorMessage(error)}`);
			}
		}
	}

	stats.completedAt = new Date().toISOString();

	const report = {
		stats,
		reportGeneratedAt: new Date().toISOString(),
		failures,
		skippedNotFound,
	};

	const outFile = path.join(reportDir, 'redis-missing-crd-backfill-report.json');
	await fs.writeFile(outFile, JSON.stringify(report, null, 2), 'utf-8');

	console.log('--- Backfill complete ---');
	console.log(JSON.stringify(stats, null, 2));
	console.log(`Report written: ${outFile}`);
}

run().catch((error) => {
	console.error('Backfill failed:', formatErrorMessage(error));
	process.exit(1);
});
