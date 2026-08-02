/**
 * Full county-by-county, year-by-year historical crawler for
 * okcountyrecords.com, using the site's free "Advanced Search" per-county
 * filter (`/search/<county>`) restricted to a single `instrument-series`
 * (recording year) and NO name - this returns every instrument recorded in
 * that county/year, paginated 15/page, with no login required:
 *
 *   GET /results/instrument-series=<YEAR>:site=<county>/page-<N>
 *
 * Unlike the live real-time crawler or the CRD-name-match crawler, this is
 * a full historical sweep: a single mid-size county can have 10,000+
 * instruments in one year alone (e.g. Bryan County 2024 = 10,202 results /
 * 681 pages), so visiting each record's full `/detail/...` page as well
 * would multiply requests ~1x-per-record and make a full crawl impractical.
 *
 * Fortunately the results-table rows themselves already carry rich data -
 * recorded date, instrument number, type, book/page range, full grantor and
 * grantee name lists, legal description(s), and image count - so this
 * script parses that list page directly and does NOT visit detail pages.
 * (Document images/PDFs still require a paid subscription regardless, per
 * earlier findings, so there is nothing lost by skipping detail pages here.)
 *
 * Output: one JSONL file per county/year, mirroring the county-partitioned
 * convention used elsewhere:
 *   data/states/oklahoma/okcountyrecords/<county>/history/<year>.jsonl
 * Resumable via a `_checkpoint.json` per county tracking the last
 * completed (year, page).
 *
 * Usage:
 *   pnpm okcountyrecords-county-crawl -- --counties=bryan,marshall,johnston,atoka,choctaw,love
 *   pnpm okcountyrecords-county-crawl -- --all-counties
 *   pnpm okcountyrecords-county-crawl -- --counties=bryan --force
 */
import puppeteer, { Browser, Page } from 'puppeteer-core';
import * as cheerio from 'cheerio';
import { mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import path from 'path';

const OUTPUT_ROOT = path.join(process.cwd(), 'data', 'states', 'oklahoma', 'okcountyrecords');
const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_DELAY_MS = 500; // politeness delay between page loads

// Bryan County, OK and its immediately-surrounding counties (per user request).
const DEFAULT_COUNTIES = ['bryan', 'marshall', 'johnston', 'atoka', 'choctaw', 'love'];

// Full list of counties covered by okcountyrecords.com (discovered from the
// site's own county-jump navigation menu; NOT all 77 OK counties are on
// this site - larger/urban counties like Oklahoma, Tulsa, Cleveland,
// Canadian, Creek, Garfield, Payne, Rogers, Wagoner, and Woods use separate
// recorder systems and are out of scope here).
const ALL_COUNTIES = [
	'adair',
	'alfalfa',
	'atoka',
	'beaver',
	'beckham',
	'blaine',
	'bryan',
	'carter',
	'cherokee',
	'choctaw',
	'cimarron',
	'coal',
	'comanche',
	'cotton',
	'craig',
	'custer',
	'delaware',
	'dewey',
	'ellis',
	'garvin',
	'grady',
	'grant',
	'greer',
	'harmon',
	'harper',
	'haskell',
	'hughes',
	'jackson',
	'jefferson',
	'johnston',
	'kay',
	'kingfisher',
	'kiowa',
	'latimer',
	'leflore',
	'lincoln',
	'logan',
	'love',
	'mcclain',
	'mccurtain',
	'mcintosh',
	'major',
	'marshall',
	'mayes',
	'murray',
	'muskogee',
	'noble',
	'nowata',
	'okfuskee',
	'okmulgee',
	'osage',
	'ottawa',
	'pawnee',
	'pittsburg',
	'pontotoc',
	'pottawatomie',
	'pushmataha',
	'roger+mills',
	'seminole',
	'sequoyah',
	'stephens',
	'texas',
	'tillman',
	'washington',
	'washita',
	'woodward',
];

interface CliArgs {
	counties: string[];
	force: boolean;
}

function parseArgs(): CliArgs {
	const args = process.argv.slice(2);
	const force = args.includes('--force');
	if (args.includes('--all-counties')) return { counties: ALL_COUNTIES, force };
	const countiesArg = args.find((a) => a.startsWith('--counties='));
	const counties =
		countiesArg ?
			countiesArg
				.split('=')[1]
				.split(',')
				.map((c) => c.trim())
		:	DEFAULT_COUNTIES;
	return { counties, force };
}

interface Checkpoint {
	// Years fully completed for this county.
	completedYears: string[];
	// In-progress year and next page to fetch (1-based), if interrupted mid-year.
	inProgress: { year: string; nextPage: number } | null;
}

function checkpointFile(county: string): string {
	return path.join(OUTPUT_ROOT, county, 'history', '_checkpoint.json');
}

function loadCheckpoint(county: string): Checkpoint {
	const file = checkpointFile(county);
	if (existsSync(file)) {
		try {
			return JSON.parse(readFileSync(file, 'utf-8'));
		} catch {
			// fall through
		}
	}
	return { completedYears: [], inProgress: null };
}

function saveCheckpoint(county: string, cp: Checkpoint) {
	const dir = path.join(OUTPUT_ROOT, county, 'history');
	mkdirSync(dir, { recursive: true });
	writeFileSync(checkpointFile(county), JSON.stringify(cp, null, 2));
}

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function launchBrowser(): Promise<Browser> {
	return puppeteer.launch({
		executablePath: CHROME_PATH,
		headless: 'new' as any,
		args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
	});
}

/** Discovers the available recording-year ("series") options for a county. */
async function discoverYears(page: Page, county: string): Promise<string[]> {
	await page.goto(`https://okcountyrecords.com/search/${county}`, { waitUntil: 'networkidle2', timeout: 30000 });
	return page.evaluate(() => {
		const sel = document.querySelector('#search-instrument-series') as HTMLSelectElement | null;
		if (!sel) return [];
		return Array.from(sel.options)
			.map((o) => o.value)
			.filter(Boolean);
	});
}

interface RecordRow {
	county: string;
	recordedDate: string;
	instrumentNumber: string;
	instrumentUrl: string | null;
	type: string;
	book: string;
	pageRange: string;
	grantors: string[];
	grantees: string[];
	legalDescriptions: string[];
	imageCount: number | null;
}

function parseResultsHtml(html: string, county: string): { rows: RecordRow[]; totalResults: number | null; totalPages: number | null } {
	const $ = cheerio.load(html);
	const totalText = $('body')
		.text()
		.match(/([\d,]+)\s+results?/i)?.[1];
	const totalResults = totalText ? parseInt(totalText.replace(/,/g, ''), 10) : null;

	const pageLinks = $('nav.pagination a')
		.map((_, a) => $(a).text().trim())
		.get()
		.filter((t) => /^\d+$/.test(t))
		.map(Number);
	const totalPages = pageLinks.length ? Math.max(...pageLinks) : null;

	const rows: RecordRow[] = [];
	$('#results-table tbody tr').each((_, tr) => {
		const tds = $(tr).find('td');
		const countyCell = $(tds[0]).text().trim();
		const recordedDate = $(tds[1]).text().replace(/\s+/g, ' ').trim();
		const instrumentLink = $(tds[2]).find('a').first();
		const instrumentNumber = instrumentLink.text().trim();
		const instrumentHref = instrumentLink.attr('href') || null;
		const type = $(tds[3]).text().replace(/\s+/g, ' ').trim();
		const book = $(tds[4]).text().trim();
		const pageRange = $(tds[5]).text().trim();
		const grantors = ($(tds[6]).html() || '')
			.split(/<br\s*\/?>/i)
			.map((s) => s.replace(/<[^>]+>/g, '').trim())
			.filter(Boolean);
		const grantees = ($(tds[7]).html() || '')
			.split(/<br\s*\/?>/i)
			.map((s) => s.replace(/<[^>]+>/g, '').trim())
			.filter(Boolean);
		const legalDescriptions = ($(tds[8]).html() || '')
			.split(/<br\s*\/?>/i)
			.map((s) => s.replace(/<[^>]+>/g, '').trim())
			.filter(Boolean);
		const imagesText = $(tds[9]).text().replace(/\s+/g, ' ').trim();
		const imageCount = imagesText ? parseInt(imagesText, 10) : null;

		rows.push({
			county: countyCell || county,
			recordedDate,
			instrumentNumber,
			instrumentUrl: instrumentHref ? `https://okcountyrecords.com${instrumentHref}` : null,
			type,
			book,
			pageRange,
			grantors,
			grantees,
			legalDescriptions,
			imageCount: Number.isFinite(imageCount) ? imageCount : null,
		});
	});

	return { rows, totalResults, totalPages };
}

async function crawlCounty(browser: Browser, county: string, force: boolean) {
	const page = await browser.newPage();
	await page.setUserAgent(USER_AGENT);

	console.log(`\n=== ${county} ===`);
	const years = await discoverYears(page, county);
	if (years.length === 0) {
		console.error(`[${county}] Could not discover any years - skipping.`);
		await page.close();
		return;
	}
	console.log(`[${county}] Years available: ${years.join(', ')}`);

	let cp = force ? { completedYears: [], inProgress: null } : loadCheckpoint(county);

	for (const year of years) {
		if (cp.completedYears.includes(year)) {
			console.log(`[${county}/${year}] Already complete, skipping.`);
			continue;
		}

		const outFile = path.join(OUTPUT_ROOT, county, 'history', `${year}.jsonl`);
		mkdirSync(path.dirname(outFile), { recursive: true });
		let startPage = 1;
		if (cp.inProgress && cp.inProgress.year === year) {
			startPage = cp.inProgress.nextPage;
			console.log(`[${county}/${year}] Resuming from page ${startPage}.`);
		} else if (!existsSync(outFile) || force) {
			writeFileSync(outFile, ''); // fresh start for this year
		}

		let totalPages: number | null = null;
		let pageNum = startPage;
		// Safety cap in case pagination detection ever fails - avoids infinite loops.
		const HARD_PAGE_CAP = 20000;

		while (pageNum <= HARD_PAGE_CAP) {
			const url = `https://okcountyrecords.com/results/instrument-series=${year}:site=${county}/page-${pageNum}`;
			try {
				await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
				const html = await page.content();
				const { rows, totalResults, totalPages: pagesFound } = parseResultsHtml(html, county);
				if (pagesFound) totalPages = pagesFound;

				if (rows.length === 0) {
					console.log(`[${county}/${year}] No rows on page ${pageNum} - treating as end of results.`);
					break;
				}

				const lines = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
				appendFileSync(outFile, lines);

				if (pageNum === startPage) {
					console.log(`[${county}/${year}] ${totalResults ?? '?'} total results, ${totalPages ?? '?'} pages.`);
				}
				if (pageNum % 20 === 0 || pageNum === totalPages) {
					console.log(`[${county}/${year}] page ${pageNum}${totalPages ? `/${totalPages}` : ''} done.`);
				}

				cp = { ...cp, inProgress: { year, nextPage: pageNum + 1 } };
				saveCheckpoint(county, cp);

				if (totalPages && pageNum >= totalPages) break;
				pageNum += 1;
				await sleep(PAGE_DELAY_MS);
			} catch (err) {
				console.error(`[${county}/${year}] Error on page ${pageNum}:`, (err as Error).message, '- retrying once after 5s.');
				await sleep(5000);
				try {
					await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
				} catch (err2) {
					console.error(`[${county}/${year}] Retry failed too, aborting this year:`, (err2 as Error).message);
					break;
				}
			}
		}

		cp = { completedYears: [...cp.completedYears, year], inProgress: null };
		saveCheckpoint(county, cp);
		console.log(`[${county}/${year}] Complete.`);
	}

	await page.close();
	console.log(`[${county}] All years processed.`);
}

async function main() {
	const { counties, force } = parseArgs();
	console.log(`Crawling okcountyrecords.com full history for counties: ${counties.join(', ')}`);
	console.log(`Output directory: ${OUTPUT_ROOT}/<county>/history/<year>.jsonl`);

	const browser = await launchBrowser();

	let shuttingDown = false;
	const shutdown = async () => {
		if (shuttingDown) return;
		shuttingDown = true;
		console.log('\nShutting down gracefully (checkpoints already saved per-page)...');
		await browser.close();
		process.exit(0);
	};
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);

	for (const county of counties) {
		if (shuttingDown) break;
		try {
			await crawlCounty(browser, county, force);
		} catch (err) {
			console.error(`[${county}] Fatal error, moving to next county:`, (err as Error).message);
		}
	}

	await browser.close();
	console.log('\nAll requested counties processed.');
}

main().catch((err) => {
	console.error('Fatal error:', err);
	process.exit(1);
});
