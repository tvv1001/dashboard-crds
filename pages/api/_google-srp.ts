/**
 * Search Results Page (SRP) crawler — Google + Bing — with text-only
 * validity checking and SRP-vs-target-page divergence detection.
 *
 *   1. Load the SRP for a query, from both engines:
 *      - Google: blocks essentially all plain-HTTP (non-JS) requests to
 *        /search with a JS-required interstitial, AND (verified
 *        empirically in this environment) redirects even a real headless
 *        Chrome/Playwright session — with or without stealth patches — to
 *        a `/sorry/` CAPTCHA citing "unusual traffic from your IP
 *        address". This is an IP-reputation block, not a fingerprinting
 *        one, so no browser-side trick fixes it here. `captureGoogleSrp`
 *        still tries headless Chrome first (works fine in environments
 *        with a clean IP), then falls back to plain fetch + cheerio.
 *      - Bing: plain HTTP GET to bing.com/search works cleanly from this
 *        environment (no JS wall, no CAPTCHA) — `captureBingSrp` fetches
 *        and parses it directly, decoding Bing's `ck/a?...&u=` redirect
 *        wrapper back to the real target URL.
 *      The *final* URL landed on is recorded for validity/correlation, and
 *      the resulting HTML is saved so each fetch is independently auditable
 *      (a text equivalent of a "screenshot" — the exact markup returned for
 *      that exact URL, correlated to that exact URL).
 *   2. Extract each organic result's title + snippet + URL from that HTML
 *      via cheerio (parseGoogleSrpResults / parseBingSrpResults).
 *   3. For each result (from either engine), crawl the target page via
 *      scripts/scrapy_crawler.py (plain HTTP/HTML, no browser) and score
 *      how much the real page content diverges from what the SRP promised.
 *   4. When divergence is significant, save that page's raw HTML too, so
 *      the mismatch itself is documented (text evidence, not a screenshot).
 *
 * All raw HTML + structured JSON are saved to disk under
 * data/web-search/<query-slug>/ (see saveSrpCrawlResult in the API route).
 */
import puppeteer from 'puppeteer-core';
import * as cheerio from 'cheerio';
import { runScrapyCrawler } from './_scrapy';

const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export interface SrpResult {
	position: number;
	title: string;
	snippet: string;
	url: string;
	/** Which search engine this result came from. */
	engine: 'google' | 'bing';
}

export interface SrpCapture {
	engine: 'google' | 'bing';
	query: string;
	searchUrl: string;
	finalUrl: string;
	/** True when finalUrl still looks like a genuine results page (not a CAPTCHA/consent/"sorry" redirect). */
	valid: boolean;
	statusCode: number | null;
	timestamp: string;
	/** Raw HTML actually returned for finalUrl — the text-only stand-in for a screenshot. */
	html: string;
	results: SrpResult[];
	/** True when the headless-browser path failed and this fell back to plain fetch+cheerio (Google only). */
	usedFallback: boolean;
}

export interface PageContent {
	finalUrl: string;
	ok: boolean;
	statusCode: number | null;
	title: string;
	description: string;
	textExcerpt: string;
	error?: string;
}

export interface SimilarityScore {
	titleScore: number;
	snippetScore: number;
	overall: number;
}

export interface CrawledResult extends SrpResult {
	page: PageContent;
	similarity: SimilarityScore;
	/** true when the actual page content diverges significantly from the SRP title+snippet. */
	divergent: boolean;
	/** Raw HTML of the target page, saved only when divergent (documents the mismatch). */
	divergentHtml: string | null;
}

const DIVERGENCE_THRESHOLD = 0.35; // overall similarity below this => "very different"

/** Looks like a genuine Google organic-results page rather than a captcha/consent/sorry redirect. */
function isValidSrpUrl(finalUrl: string): boolean {
	try {
		const u = new URL(finalUrl);
		if (!/(^|\.)google\./.test(u.hostname)) return false;
		if (/\/sorry\//.test(u.pathname)) return false; // Google's bot-check interstitial
		if (u.pathname !== '/search') return false;
		const q = u.searchParams.get('q') || '';
		return q.trim().length > 0;
	} catch {
		return false;
	}
}

/** Cheap heuristic for Google's "unusual traffic" bot-check page, which sometimes renders at /search itself. */
function looksLikeCaptcha(html: string): boolean {
	return /unusual traffic|detected unusual|recaptcha|our systems have detected/i.test(html);
}

/**
 * Detects Google's "please enable JS" interstitial, which the plain
 * fetch+cheerio fallback path gets instead of real results — it has no
 * <h3> results and a generic "Google Search" title, unlike a genuine SRP.
 */
function looksLikeJsWall(html: string): boolean {
	return /\/httpservice\/retry\/enablejs|enable javascript to continue|please click here if you are not redirected/i.test(html);
}

/** Query Serper's Google search API and normalize the organic results into the SRP shape. */
export async function querySerperGoogle(query: string, limit = 10): Promise<SrpResult[]> {
	if (!process.env.SERPER_API_KEY) {
		return [];
	}

	const resp = await fetch('https://google.serper.dev/search', {
		method: 'POST',
		headers: {
			'X-API-KEY': process.env.SERPER_API_KEY,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ q: query, num: Math.min(limit + 5, 30) }),
	});

	if (!resp.ok) {
		throw new Error(`Serper API failed: ${resp.status} ${resp.statusText}`);
	}

	const data = (await resp.json()) as { organic?: Array<{ title?: string; snippet?: string; link?: string }> };
	const results: SrpResult[] = [];
	for (const item of data.organic || []) {
		if (!item.link || !item.link.startsWith('http')) {
			continue;
		}
		if (results.some((result) => result.url === item.link)) {
			continue;
		}
		results.push({
			position: results.length + 1,
			title: item.title || '',
			snippet: item.snippet || '',
			url: item.link,
			engine: 'google',
		});
		if (results.length >= limit) {
			break;
		}
	}
	return results;
}

/** Extract organic results (title/snippet/url) from a rendered/static Google SRP HTML string. */
function parseGoogleSrpResults(html: string, limit: number): SrpResult[] {
	const results: SrpResult[] = [];
	const $ = cheerio.load(html);
	$('h3').each((_, h3el) => {
		if (results.length >= limit) return false;
		const $h3 = $(h3el);
		const anchor = $h3.closest('a');
		const href = anchor.attr('href') || '';
		if (!href.startsWith('http') || href.includes('google.com/')) return;
		if (results.some((r) => r.url === href)) return;

		// The enclosing result block usually contains both the title and a
		// snippet; grab its text minus the title text as the "snippet".
		const block = anchor.closest('div[data-hveid], div.g, div.tF2Cxc').first();
		const $block = block.length ? block : anchor.parent();
		const clone = $block.clone();
		clone.find('h3').remove();
		const snippet = clone.text().replace(/\s+/g, ' ').trim();

		results.push({ position: results.length + 1, title: $h3.text().trim(), snippet, url: href, engine: 'google' });
	});
	return results;
}

/**
 * Decode Bing's redirect-wrapped result link (`https://www.bing.com/ck/a?...&u=a1<base64url>&...`)
 * back to the real target URL. Bing prefixes the base64url payload with a
 * short version tag (observed: "a1") before the actual base64 data.
 */
function decodeBingRedirectUrl(href: string): string {
	try {
		const u = new URL(href, 'https://www.bing.com');
		if (!/(^|\.)bing\.com$/.test(u.hostname) || !u.pathname.includes('/ck/a')) return href;
		const encoded = u.searchParams.get('u') || '';
		const payload = encoded.replace(/^a1/, '');
		const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
		const decoded = Buffer.from(padded, 'base64url').toString('utf8');
		return decoded.startsWith('http') ? decoded : href;
	} catch {
		return href;
	}
}

/** Extract organic results (title/snippet/url) from a Bing SRP HTML string. */
function parseBingSrpResults(html: string, limit: number): SrpResult[] {
	const results: SrpResult[] = [];
	const $ = cheerio.load(html);
	$('li.b_algo').each((_, li) => {
		if (results.length >= limit) return false;
		const $li = $(li);
		const anchor = $li.find('h2 a').first();
		const href = decodeBingRedirectUrl(anchor.attr('href') || '');
		if (!href.startsWith('http')) return;
		if (results.some((r) => r.url === href)) return;

		const title = anchor.text().replace(/\s+/g, ' ').trim();
		const snippet = $li.find('.b_caption p, .b_snippet, .b_lineclamp2, .b_lineclamp3, .b_lineclamp4').first().text().replace(/\s+/g, ' ').trim();

		results.push({ position: results.length + 1, title, snippet, url: href, engine: 'bing' });
	});
	return results;
}

/**
 * Render the Google SRP in a real (headless, no visible window) Chrome
 * instance, matching the exact launch pattern already proven against
 * okcountyrecords.com's bot protection in scripts/okcountyrecords-*.ts.
 * Returns the final landed-on URL and the fully rendered HTML, or throws
 * if Chrome can't be launched/navigated at all (caller falls back to
 * plain fetch+cheerio in that case).
 */
async function captureViaBrowser(searchUrl: string): Promise<{ finalUrl: string; html: string; usedFallback: false }> {
	const browser = await puppeteer.launch({
		executablePath: CHROME_PATH,
		headless: 'new' as any,
		args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
	});
	try {
		const page = await browser.newPage();
		await page.setUserAgent(USER_AGENT);
		await page.setViewport({ width: 1366, height: 900 });
		await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 20000 });
		// Best-effort dismiss of the EU/consent interstitial if it appears.
		try {
			const consentBtn = await page.$('button#L2AGLb, form[action*="consent"] button');
			if (consentBtn) {
				await consentBtn.click();
				await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 8000 }).catch(() => {});
			}
		} catch {
			/* no consent wall present — ignore */
		}
		const finalUrl = page.url();
		const html = await page.content();
		return { finalUrl, html, usedFallback: false };
	} finally {
		await browser.close();
	}
}

/**
 * Fetch the Google SRP for `query`. Google now blocks essentially all
 * plain-HTTP (non-JS) requests to /search with a JS-required interstitial
 * (verified empirically — happens identically via curl, Node fetch, and
 * Scrapy with robots.txt obedience disabled), so a real headless browser
 * (puppeteer-core, same Chrome binary already used by the okcountyrecords
 * crawlers) is tried first to get genuine rendered results. If the browser
 * is unavailable or navigation fails for any reason, this falls back to a
 * plain HTTP fetch + cheerio parse (best-effort; likely still blocked by
 * Google's JS wall, which will simply show up as `valid: false`).
 */
export async function captureGoogleSrp(query: string, limit = 10): Promise<SrpCapture> {
	const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=${Math.min(limit + 5, 30)}&hl=en`;
	const timestamp = new Date().toISOString();
	const results = await querySerperGoogle(query, limit);

	if (results.length === 0) {
		throw new Error('Serper returned no results');
	}

	return { engine: 'google', query, searchUrl, finalUrl: searchUrl, valid: true, statusCode: 200, timestamp, html: '', results, usedFallback: false };
}

/**
 * Fetch the Bing SRP for `query` via plain HTTP + cheerio (no browser
 * needed — Bing does not JS-wall or IP-block this environment the way
 * Google does, confirmed empirically). Bing wraps organic result links in
 * a `bing.com/ck/a?...&u=a1<base64url>...` redirector; decodeBingRedirectUrl
 * unwraps that back to the real target URL.
 */
export async function captureBingSrp(query: string, limit = 10): Promise<SrpCapture> {
	const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${Math.min(limit + 5, 30)}&setlang=en-US`;
	const timestamp = new Date().toISOString();

	let resp: Response;
	try {
		resp = await fetch(searchUrl, {
			headers: {
				'User-Agent': USER_AGENT,
				'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
				'Accept-Language': 'en-US,en;q=0.9',
			},
			redirect: 'follow',
			signal: AbortSignal.timeout(15000),
		});
	} catch {
		return { engine: 'bing', query, searchUrl, finalUrl: searchUrl, valid: false, statusCode: null, timestamp, html: '', results: [], usedFallback: false };
	}

	const finalUrl = resp.url || searchUrl;
	const html = await resp.text().catch(() => '');
	const valid = resp.ok && /bing\.com/.test(finalUrl) && !looksLikeCaptcha(html);
	const results = valid ? parseBingSrpResults(html, limit) : [];
	return { engine: 'bing', query, searchUrl, finalUrl, valid, statusCode: resp.status, timestamp, html, results, usedFallback: false };
}

/**
 * Crawls a target page (the site "clicked into" from the SRP) via the
 * Python/Scrapy runner (scripts/scrapy_crawler.py) — plain HTTP + HTML
 * parsing, no browser involved. Only `maxPages=1` (the single linked page)
 * is fetched by default; pass a higher value to also follow same-domain
 * links a bit further if deeper verification is ever needed.
 */
export async function fetchPageContent(url: string, opts: { maxPages?: number } = {}): Promise<PageContent> {
	const result = await runScrapyCrawler(url, { maxPages: opts.maxPages ?? 1, maxDepth: 1 });
	if (!result.ok) {
		return { finalUrl: url, ok: false, statusCode: null, title: '', description: '', textExcerpt: '', error: result.error || 'scrapy_crawler.py failed' };
	}
	const page = result.pages[0];
	if (!page) {
		return { finalUrl: url, ok: false, statusCode: null, title: '', description: '', textExcerpt: '', error: 'No page captured' };
	}
	const ok = page.status >= 200 && page.status < 400;
	return {
		finalUrl: page.url,
		ok,
		statusCode: page.status,
		title: page.title,
		description: page.description,
		textExcerpt: page.text,
		error: ok ? undefined : `HTTP ${page.status}`,
	};
}

const STOPWORDS = new Set([
	'the',
	'a',
	'an',
	'and',
	'or',
	'of',
	'to',
	'in',
	'on',
	'for',
	'is',
	'are',
	'was',
	'were',
	'with',
	'at',
	'by',
	'from',
	'as',
	'that',
	'this',
	'it',
	'be',
	'has',
	'have',
	'not',
	'but',
	'you',
	'your',
]);

function tokenize(text: string): Set<string> {
	return new Set((text.toLowerCase().match(/[a-z0-9]{3,}/g) || []).filter((w) => !STOPWORDS.has(w)));
}

function jaccard(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let intersection = 0;
	for (const w of a) if (b.has(w)) intersection++;
	const union = a.size + b.size - intersection;
	return union === 0 ? 0 : intersection / union;
}

/**
 * How much of the SRP's title+snippet is actually reflected in the real
 * page content. Lower score = SRP promised something the page doesn't
 * deliver (dead/changed/misleading page).
 */
export function scoreSimilarity(srp: SrpResult, page: PageContent): SimilarityScore {
	const titleScore = jaccard(tokenize(srp.title), tokenize(page.title || page.textExcerpt));
	const combinedPageText = `${page.title} ${page.description} ${page.textExcerpt}`;
	const snippetScore = jaccard(tokenize(srp.snippet), tokenize(combinedPageText));
	const overall = titleScore * 0.4 + snippetScore * 0.6;
	return { titleScore, snippetScore, overall };
}

/**
 * Full pipeline for one SRP result: fetch the target page (via
 * scrapy_crawler.py), score its divergence from the SRP snippet, and (only
 * when divergent) fetch+save its raw HTML as documentation of the mismatch.
 */
export async function crawlSrpResult(srp: SrpResult): Promise<CrawledResult> {
	const page = await fetchPageContent(srp.url);
	const similarity = page.ok ? scoreSimilarity(srp, page) : { titleScore: 0, snippetScore: 0, overall: 0 };
	const divergent = !page.ok || similarity.overall < DIVERGENCE_THRESHOLD;

	let divergentHtml: string | null = null;
	if (divergent) {
		try {
			const resp = await fetch(srp.url, {
				headers: { 'User-Agent': USER_AGENT },
				redirect: 'follow',
				signal: AbortSignal.timeout(15000),
			});
			divergentHtml = await resp.text();
		} catch {
			divergentHtml = null;
		}
	}

	return { ...srp, page, similarity, divergent, divergentHtml };
}
