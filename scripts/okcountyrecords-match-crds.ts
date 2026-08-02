/**
 * Cross-references every CRD *individual* saved in Redis against
 * okcountyrecords.com's site-wide (all-Oklahoma-counties) name search to
 * find Oklahoma property/land records with a matching first + last name.
 *
 * Uses the same free, all-county "omni" search the site's own homepage
 * search box submits to (`POST /` -> `GET /results/omni=<Last, First>/page-N`),
 * discovered by inspecting the search form action. This endpoint requires no
 * login and returns full historical results (observed back to the 1980s),
 * unlike the per-county advanced search which requires being logged in for
 * some views.
 *
 * IMPORTANT CAVEATS (surfaced in every output file):
 *   - This is a NAME-ONLY match. okcountyrecords.com has no CRD/SSN/DOB
 *     linkage, so a hit only means some Oklahoma instrument lists a grantor
 *     or grantee with the same first+last name as the CRD individual - it is
 *     NOT a verified identity match and must be manually confirmed.
 *   - Common names (e.g. "Smith, John") can return tens of thousands of
 *     results. To keep this crawl tractable and avoid saving purely-noise
 *     data, results per name are capped at MAX_PAGES_PER_NAME pages
 *     (MAX_PAGES_PER_NAME * PAGE_SIZE rows); the true total is always
 *     recorded so truncation is visible.
 *   - Per user's explicit prior instruction, this script (like the real-time
 *     crawler) captures METADATA ONLY - it never attempts to view or
 *     download document images/PDFs (which require a paid subscription).
 *
 * Usage:
 *   pnpm okcountyrecords-match-crds [--limit=N] [--crds=CRD1,CRD2,...] [--force] [--delay-ms=N]
 */
import puppeteer, { Browser, Page } from 'puppeteer-core';
import * as cheerio from 'cheerio';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { listSavedKeysWithStats, loadSavedPayload, type SavedKeyStat } from '../pages/api/_lib';

const OUTPUT_DIR = path.join(process.cwd(), 'data', 'states', 'oklahoma', 'okcountyrecords', 'crd-name-matches');
const STATE_FILE = path.join(OUTPUT_DIR, '_progress.json');
const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_SIZE = 15; // observed rows-per-page on /results
const MAX_PAGES_PER_NAME = 5; // cap = 75 rows/name to avoid runaway crawls on common names
const REQUEST_DELAY_MS = 900; // politeness delay between requests

interface CliArgs {
	limit: number | null;
	crds: Set<string> | null;
	force: boolean;
	delayMs: number;
}

function parseArgs(): CliArgs {
	const args = process.argv.slice(2);
	const limitArg = args.find((a) => a.startsWith('--limit='));
	const crdsArg = args.find((a) => a.startsWith('--crds='));
	const delayArg = args.find((a) => a.startsWith('--delay-ms='));
	return {
		limit: limitArg ? parseInt(limitArg.split('=')[1], 10) : null,
		crds:
			crdsArg ?
				new Set(
					crdsArg
						.split('=')[1]
						.split(',')
						.map((s) => s.trim()),
				)
			:	null,
		force: args.includes('--force'),
		delayMs: delayArg ? parseInt(delayArg.split('=')[1], 10) : REQUEST_DELAY_MS,
	};
}

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function slugify(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

// Same defensive payload-shape handling used by scripts/download-all-pdfs.ts.
function getContentBlock(payload: any): any {
	try {
		if (payload?.finraBrokerCheck) return payload.finraBrokerCheck;
		if (payload?.secInvestmentAdvisor) return payload.secInvestmentAdvisor;
		const hit = payload?.hits?.hits?.[0]?._source;
		if (hit) {
			if (typeof hit.iacontent === 'string') return JSON.parse(hit.iacontent);
			if (typeof hit.content === 'string') return JSON.parse(hit.content);
			if (hit.content) return hit.content;
		}
		return payload;
	} catch {
		return null;
	}
}

interface NameGroup {
	firstName: string;
	lastName: string;
	searchQuery: string; // "Last, First"
	crds: string[];
}

async function buildNameGroups(filterCrds: Set<string> | null): Promise<NameGroup[]> {
	const { keys } = await listSavedKeysWithStats({ type: 'individual', limit: 0 });
	const groups = new Map<string, NameGroup>();

	for (const entry of keys as SavedKeyStat[]) {
		if (filterCrds && !filterCrds.has(entry.crd)) continue;
		let firstName = '';
		let lastName = '';
		try {
			const payload = await loadSavedPayload(entry.key);
			const content = getContentBlock(payload);
			const bi = content?.basicInformation || {};
			firstName = String(bi.firstName || content?.firstName || '').trim();
			lastName = String(bi.lastName || content?.lastName || '').trim();
		} catch {
			// fall through to displayName-based fallback below
		}
		if (!firstName || !lastName) {
			// Fallback: displayName is "First [Middle] Last [Suffix]" - take first
			// and last tokens as a best-effort approximation.
			const parts = (entry.displayName || '').trim().split(/\s+/).filter(Boolean);
			if (parts.length >= 2) {
				firstName = firstName || parts[0];
				lastName = lastName || parts[parts.length - 1];
			}
		}
		if (!firstName || !lastName) continue; // can't build a usable search query

		const key = `${lastName.toLowerCase()}|${firstName.toLowerCase()}`;
		const searchQuery = `${lastName}, ${firstName}`;
		if (!groups.has(key)) {
			groups.set(key, { firstName, lastName, searchQuery, crds: [] });
		}
		groups.get(key)!.crds.push(entry.crd);
	}

	return Array.from(groups.values());
}

interface MatchRow {
	county: string;
	recordedDate: string;
	instrumentNumber: string;
	detailUrl: string;
	instrumentType: string;
	book: string;
	pages: string;
	grantors: string[];
	grantees: string[];
	legalDescriptionSnippet: string;
	imageCount: number | null;
}

function parseResultsPage(html: string): { totalResultsText: string; rows: MatchRow[] } {
	const $ = cheerio.load(html);
	const totalResultsText =
		$('body')
			.text()
			.match(/[\d,]+\s+results?/i)?.[0]
			.trim() || '';

	const rows: MatchRow[] = [];
	$('#results-table tbody tr').each((_, tr) => {
		const tds = $(tr).find('td');
		const get = (i: number) => $(tds.get(i)).text().replace(/\s+/g, ' ').trim();
		const splitNames = (i: number) =>
			$(tds.get(i))
				.html()
				?.split(/<br\s*\/?>/i)
				.map((s) => cheerio.load(s).text().replace(/\s+/g, ' ').trim())
				.filter(Boolean) || [];

		const instrumentLink = $(tds.get(3)).find('a').first();
		const detailHref = instrumentLink.attr('href') || '';
		const imageCountMatch = get(10).match(/^(\d+)/);

		rows.push({
			county: get(1),
			recordedDate: get(2),
			instrumentNumber: instrumentLink.text().trim(),
			detailUrl: detailHref ? `https://okcountyrecords.com${detailHref}` : '',
			instrumentType: get(4),
			book: get(5),
			pages: get(6),
			grantors: splitNames(7),
			grantees: splitNames(8),
			legalDescriptionSnippet: get(9),
			imageCount: imageCountMatch ? parseInt(imageCountMatch[1], 10) : null,
		});
	});

	return { totalResultsText, rows };
}

interface ProgressState {
	processedNameKeys: string[];
	totalCrdsProcessed: number;
	lastRunAt: string | null;
}

function loadProgress(): ProgressState {
	if (existsSync(STATE_FILE)) {
		try {
			return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
		} catch {
			// fall through
		}
	}
	return { processedNameKeys: [], totalCrdsProcessed: 0, lastRunAt: null };
}

function saveProgress(state: ProgressState) {
	mkdirSync(OUTPUT_DIR, { recursive: true });
	writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function launchBrowser(): Promise<Browser> {
	return puppeteer.launch({
		executablePath: CHROME_PATH,
		headless: 'new' as any,
		args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
	});
}

async function fetchResultsPage(page: Page, query: string, pageNum: number): Promise<string> {
	const url = `https://okcountyrecords.com/results/omni=${encodeURIComponent(query)}/page-${pageNum}`;
	await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
	return page.content();
}

async function main() {
	const { limit, crds, force, delayMs } = parseArgs();
	mkdirSync(OUTPUT_DIR, { recursive: true });

	console.log('Loading CRD individuals from Redis and grouping by first+last name...');
	const nameGroups = await buildNameGroups(crds);
	console.log(`Found ${nameGroups.length} unique first+last name combinations to search.`);

	const progress = loadProgress();
	const processedSet = new Set(progress.processedNameKeys);

	const browser = await launchBrowser();
	const page = await browser.newPage();
	await page.setUserAgent(USER_AGENT);

	let processedThisRun = 0;
	for (const group of nameGroups) {
		const nameKey = `${group.lastName.toLowerCase()}|${group.firstName.toLowerCase()}`;
		if (!force && processedSet.has(nameKey)) continue;
		if (limit !== null && processedThisRun >= limit) break;

		const outFile = path.join(OUTPUT_DIR, `${slugify(nameKey)}.json`);
		try {
			const allRows: MatchRow[] = [];
			let totalResultsText = '';
			for (let p = 1; p <= MAX_PAGES_PER_NAME; p++) {
				const html = await fetchResultsPage(page, group.searchQuery, p);
				const parsed = parseResultsPage(html);
				if (p === 1) totalResultsText = parsed.totalResultsText;
				if (parsed.rows.length === 0) break;
				allRows.push(...parsed.rows);
				if (parsed.rows.length < PAGE_SIZE) break; // last page reached
				await sleep(delayMs);
			}

			if (allRows.length > 0) {
				writeFileSync(
					outFile,
					JSON.stringify(
						{
							searchName: group.searchQuery,
							firstName: group.firstName,
							lastName: group.lastName,
							matchedCrds: group.crds,
							totalResultsText,
							capturedRowCount: allRows.length,
							truncated: allRows.length >= MAX_PAGES_PER_NAME * PAGE_SIZE,
							capturedAt: new Date().toISOString(),
							matches: allRows,
							disclaimer:
								'NAME-ONLY match against okcountyrecords.com (Oklahoma county land records). This is NOT a verified identity match - okcountyrecords.com has no CRD/SSN/DOB linkage, so a same-name hit may belong to a completely different person. Manual verification required. Metadata only; document images/PDFs require a paid subscription and were not downloaded.',
						},
						null,
						2,
					),
				);
				console.log(`[match] ${group.searchQuery} -> ${allRows.length} rows captured (${totalResultsText}) for CRDs ${group.crds.join(',')}`);
			} else {
				console.log(`[no-match] ${group.searchQuery} (CRDs ${group.crds.join(',')})`);
			}
		} catch (err) {
			console.error(`[error] ${group.searchQuery}:`, (err as Error).message);
		}

		processedSet.add(nameKey);
		processedThisRun += 1;
		progress.totalCrdsProcessed += group.crds.length;
		progress.lastRunAt = new Date().toISOString();
		progress.processedNameKeys = Array.from(processedSet);
		saveProgress(progress);

		await sleep(delayMs);
	}

	await browser.close();
	console.log(`Done. Processed ${processedThisRun} name(s) this run. Total unique names processed overall: ${processedSet.size}.`);
}

main().catch((err) => {
	console.error('Fatal error:', err);
	process.exit(1);
});
