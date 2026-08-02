/**
 * Live crawler for okcountyrecords.com's real-time instrument feed.
 *
 * Polls the same AJAX endpoint the site's own ticker widget uses
 * (`GET /real-time?limit=&ids=&hash=`, reverse-engineered from
 * /javascripts/build/ticker.jquery.min.js) to detect newly recorded
 * instruments as they're emitted, then visits each instrument's free
 * `/detail/<county>/<instrument>` page to extract metadata (book/pages,
 * fees & dates, parties, legal description, image count).
 *
 * IMPORTANT: Document images (even "watermarked" previews) require an
 * active paid monthly subscription on okcountyrecords.com - there is no
 * free image tier. Per explicit user instruction, this crawler captures
 * METADATA ONLY and never attempts to download document images or PDFs.
 *
 * The site is behind Cloudflare bot-detection that blocks plain HTTP
 * clients (curl/fetch) but allows a real headless Chrome browser, so this
 * script drives system Chrome via puppeteer-core with `headless: 'new'`
 * (no visible window is ever opened - verified by monitoring X11 clients
 * during a run).
 *
 * Usage:
 *   pnpm okcountyrecords-crawler                # run continuously
 *   pnpm okcountyrecords-crawler -- --once       # single poll cycle then exit
 *   pnpm okcountyrecords-crawler -- --poll-ms=3000
 */
import puppeteer, { Browser, Page } from 'puppeteer-core';
import * as cheerio from 'cheerio';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';

const OUTPUT_ROOT = path.join(process.cwd(), 'data', 'states', 'oklahoma', 'okcountyrecords');
const STATE_FILE = path.join(OUTPUT_ROOT, '_state.json');
const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const QUEUE_SIZE = 15; // matches site's own ticker.jquery.min.js default
const DEFAULT_POLL_MS = 3000; // site itself polls every 2000ms; we're slightly more conservative
const DETAIL_FETCH_DELAY_MS = 600; // politeness delay between detail-page visits

interface CliArgs {
	once: boolean;
	pollMs: number;
}

function parseArgs(): CliArgs {
	const args = process.argv.slice(2);
	const once = args.includes('--once');
	const pollArg = args.find((a) => a.startsWith('--poll-ms='));
	const pollMs = pollArg ? parseInt(pollArg.split('=')[1], 10) : DEFAULT_POLL_MS;
	return { once, pollMs: Number.isFinite(pollMs) && pollMs > 0 ? pollMs : DEFAULT_POLL_MS };
}

interface TickerItem {
	id: string | number;
	hash: string;
	site: { name: string };
	instrument_type: { formatted: string };
	series: string;
	number: string;
	record_type: string;
	image_count: number;
}

interface TickerResponse {
	hash: string;
	imageCount: number;
	instrumentCount: number;
	itemsInfo: TickerItem[];
}

interface CrawlerState {
	hash: string | null;
	seenIds: string[];
	lastPolledAt: string | null;
	totalCaptured: number;
}

function loadState(): CrawlerState {
	if (existsSync(STATE_FILE)) {
		try {
			return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
		} catch {
			// fall through to fresh state
		}
	}
	return { hash: null, seenIds: [], lastPolledAt: null, totalCaptured: 0 };
}

function saveState(state: CrawlerState) {
	mkdirSync(OUTPUT_ROOT, { recursive: true });
	writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function slugifyCounty(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function detailUrlFor(item: TickerItem): { county: string; instrument: string; url: string } {
	const county = item.site.name.toLowerCase();
	const instrument = `${item.series}-${item.number}`;
	return { county, instrument, url: `https://okcountyrecords.com/detail/${county}/${instrument}` };
}

/** Parses the free /detail/<county>/<instrument> page HTML into structured metadata. */
function parseDetailHtml(html: string, sourceUrl: string) {
	const $ = cheerio.load(html);

	const instrumentType = $('#primary-details h2').first().clone().children().remove().end().text().trim();
	const book = $('#primary-details table th:contains("Book")').next('td').text().trim();
	const pages = $('#primary-details table th:contains("Pages")').next('td').text().trim();

	const countyName = $('#secondary-details h3').first().clone().children().remove().end().text().trim();
	const instrumentNumber = $('#secondary-details table th:contains("Instrument")').next('td').text().trim();
	const recorded = $('#secondary-details table th:contains("Recorded")').next('td').text().replace(/\s+/g, ' ').trim();

	const fees: Record<string, string> = {};
	$('#detail-fees table tr').each((_, el) => {
		const label = $(el).find('th').text().trim();
		const value = $(el).find('td').text().trim();
		if (label) fees[label] = value;
	});

	const parties: { type: string; names: string[] }[] = [];
	$('#detail-people ul > li').each((_, li) => {
		const type = $(li).find('> span.label').text().trim();
		const names: string[] = [];
		$(li)
			.find('.people-type-list > li')
			.each((_, nameLi) => {
				const name = $(nameLi).clone().children().remove().end().text().replace(/\s+/g, ' ').trim();
				if (name) names.push(name);
			});
		if (type) parties.push({ type, names });
	});

	const legalDescriptions: string[] = [];
	$('#detail-legals ul > li').each((_, li) => {
		const text = $(li).clone().children().remove().end().text().replace(/\s+/g, ' ').trim();
		if (text) legalDescriptions.push(text);
	});

	const imageCountText = $('#detail-images h4').text().replace(/\s+/g, ' ').trim();
	const images: { page: string }[] = [];
	$('#image-list .thumbnail-description').each((_, el) => {
		const text = $(el).text().replace(/\s+/g, ' ').trim();
		if (text) images.push({ page: text.replace(/^Pg:\s*/, '') });
	});

	return {
		sourceUrl,
		capturedAt: new Date().toISOString(),
		instrumentType,
		book,
		pages,
		countyName,
		instrumentNumber,
		recorded,
		feesAndDates: fees,
		parties,
		legalDescriptions,
		imageCountText,
		images,
		note: 'Metadata only. Document images/PDFs require a paid okcountyrecords.com subscription and were intentionally NOT downloaded.',
	};
}

async function launchBrowser(): Promise<Browser> {
	return puppeteer.launch({
		executablePath: CHROME_PATH,
		headless: 'new' as any,
		args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
	});
}

async function getCurrentFeed(page: Page): Promise<{ ids: string[]; hash: string }> {
	await page.goto('https://okcountyrecords.com/real-time', { waitUntil: 'networkidle2', timeout: 30000 });
	return page.evaluate(() => {
		const feed = document.getElementById('instrument-feed');
		const ids = Array.from(feed ? feed.querySelectorAll('li') : []).map((li) => li.id);
		const hash = feed ? feed.getAttribute('data-hash') || '' : '';
		return { ids, hash };
	});
}

async function pollTicker(page: Page, ids: string[], hash: string): Promise<TickerResponse> {
	return page.evaluate(
		async (idsJson: string, hashVal: string, limit: number) => {
			const url = `/real-time?limit=${limit}&ids=${encodeURIComponent(idsJson)}&hash=${encodeURIComponent(hashVal)}`;
			const resp = await fetch(url, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
			return resp.json();
		},
		JSON.stringify(ids),
		hash,
		QUEUE_SIZE,
	);
}

function saveRecord(county: string, instrument: string, record: unknown) {
	const dir = path.join(OUTPUT_ROOT, slugifyCounty(county));
	mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${instrument}.json`);
	writeFileSync(file, JSON.stringify(record, null, 2));
}

async function captureDetail(page: Page, item: TickerItem, state: CrawlerState) {
	const { county, instrument, url } = detailUrlFor(item);
	try {
		await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
		const html = await page.content();
		const record = parseDetailHtml(html, url);
		saveRecord(county, instrument, {
			...record,
			tickerId: item.id,
			tickerHash: item.hash,
			recordTypePrefix: item.record_type,
			imageCount: item.image_count,
		});
		state.totalCaptured += 1;
		console.log(`[captured] ${county}/${instrument} (${item.image_count} images) -> ${record.instrumentType}`);
	} catch (err) {
		console.error(`[error] failed to capture ${county}/${instrument}:`, (err as Error).message);
	}
}

async function main() {
	const { once, pollMs } = parseArgs();
	mkdirSync(OUTPUT_ROOT, { recursive: true });

	const state = loadState();
	const seen = new Set(state.seenIds);

	console.log(`Starting okcountyrecords.com real-time crawler (metadata-only). Poll interval: ${pollMs}ms`);
	console.log(`Output directory: ${OUTPUT_ROOT}`);
	console.log(`Previously seen instruments: ${seen.size}`);

	const browser = await launchBrowser();
	const feedPage = await browser.newPage();
	await feedPage.setUserAgent(USER_AGENT);
	const detailPage = await browser.newPage();
	await detailPage.setUserAgent(USER_AGENT);

	let running = true;
	const shutdown = async () => {
		if (!running) return;
		running = false;
		console.log('\nShutting down gracefully...');
		saveState({ ...state, seenIds: Array.from(seen) });
		await browser.close();
		process.exit(0);
	};
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);

	// Establish baseline ids/hash from the live page on startup.
	let { ids, hash } = await getCurrentFeed(feedPage);
	if (state.hash) hash = state.hash; // resume from last known cursor if we have one

	// On first run (no prior state), capture the ~20 items currently visible
	// so we don't start completely empty-handed.
	if (seen.size === 0) {
		const initialItems = await feedPage.evaluate(() => {
			const feed = document.getElementById('instrument-feed');
			return Array.from(feed ? feed.querySelectorAll('li') : []).map((li) => {
				const link = li.querySelector('.instrument-detail-link a') as HTMLAnchorElement | null;
				const typeEl = li.querySelector('.instrument-type');
				const siteEl = li.querySelector('.site-name');
				const imagesEl = li.querySelector('.instrument-images');
				const href = link ? link.getAttribute('href') || '' : '';
				const match = href.match(/\/detail\/([^/]+)\/(.+)$/);
				return {
					id: li.id,
					county: match ? match[1] : siteEl?.textContent?.trim().toLowerCase() || '',
					instrument: match ? match[2] : '',
					instrumentType: typeEl?.textContent?.trim() || '',
					imagesText: imagesEl?.textContent?.trim() || '',
				};
			});
		});
		console.log(`Backfilling ${initialItems.length} currently-visible instruments...`);
		for (const initItem of initialItems) {
			if (!initItem.county || !initItem.instrument) continue;
			const url = `https://okcountyrecords.com/detail/${initItem.county}/${initItem.instrument}`;
			try {
				await detailPage.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
				const html = await detailPage.content();
				const record = parseDetailHtml(html, url);
				saveRecord(initItem.county, initItem.instrument, {
					...record,
					tickerId: initItem.id,
					note2: 'Captured during initial backfill of currently-visible real-time feed items.',
				});
				seen.add(initItem.id);
				state.totalCaptured += 1;
				console.log(`[backfill] ${initItem.county}/${initItem.instrument}`);
			} catch (err) {
				console.error(`[backfill-error] ${initItem.county}/${initItem.instrument}:`, (err as Error).message);
			}
			await sleep(DETAIL_FETCH_DELAY_MS);
		}
		state.hash = hash;
		saveState({ ...state, hash, seenIds: Array.from(seen) });
	}

	do {
		try {
			const result = await pollTicker(feedPage, ids, hash);
			if (Array.isArray(result.itemsInfo) && result.itemsInfo.length > 0) {
				for (const item of result.itemsInfo) {
					const idStr = String(item.id);
					ids = [idStr, ...ids].slice(0, QUEUE_SIZE);
					if (seen.has(idStr)) continue;
					seen.add(idStr);
					await captureDetail(detailPage, item, state);
					await sleep(DETAIL_FETCH_DELAY_MS);
				}
			}
			hash = result.hash || hash;
			state.hash = hash;
			state.lastPolledAt = new Date().toISOString();
			saveState({ ...state, seenIds: Array.from(seen) });
		} catch (err) {
			console.error('[poll-error]', (err as Error).message);
		}

		if (once) break;
		await sleep(pollMs);
	} while (running);

	if (!once) return; // shutdown() handles exit via signal
	saveState({ ...state, seenIds: Array.from(seen) });
	await browser.close();
	console.log(`Done. Total captured this run reflected in state: ${state.totalCaptured}`);
}

main().catch((err) => {
	console.error('Fatal error:', err);
	process.exit(1);
});
