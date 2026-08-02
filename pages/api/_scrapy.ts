/**
 * Node wrapper around scripts/scrapy_crawler.py — the pure HTTP+HTML
 * (no-browser) crawler used for visiting/scraping target pages discovered
 * from a Google SRP. Per explicit product decision, only the Google SRP
 * itself is rendered in a real browser (for the screenshot); every target
 * page reached "by clicking into" a search result is fetched via this
 * Scrapy-based Python script instead of a second browser instance.
 */
import { spawn } from 'child_process';
import path from 'path';

const PYTHON_BIN = process.env.PYTHON3_PATH || 'python3';
const SCRAPY_SCRIPT = path.join(/*turbopackIgnore: true*/ process.cwd(), 'scripts', 'scrapy_crawler.py');

export interface ScrapyPage {
	url: string;
	title: string;
	description: string;
	text: string;
	links: string[];
	status: number;
}

export interface ScrapyCrawlResult {
	ok: boolean;
	startUrl: string;
	pageCount: number;
	pages: ScrapyPage[];
	stats: Record<string, unknown>;
	error?: string;
}

export interface ScrapyCrawlOptions {
	maxPages?: number;
	maxDepth?: number;
	allowOffsite?: boolean;
	timeoutMs?: number;
}

/** Runs scripts/scrapy_crawler.py <url> and parses its JSON stdout. */
export async function runScrapyCrawler(url: string, opts: ScrapyCrawlOptions = {}): Promise<ScrapyCrawlResult> {
	const { maxPages = 1, maxDepth = 1, allowOffsite = false, timeoutMs = 30000 } = opts;
	const args = [SCRAPY_SCRIPT, url, `--max-pages=${maxPages}`, `--max-depth=${maxDepth}`];
	if (allowOffsite) args.push('--allow-offsite');

	return new Promise((resolve) => {
		const proc = spawn(/*turbopackIgnore: true*/ PYTHON_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		const timer = setTimeout(() => {
			proc.kill('SIGKILL');
		}, timeoutMs);

		proc.stdout.on('data', (d) => (stdout += d.toString()));
		proc.stderr.on('data', (d) => (stderr += d.toString()));
		proc.on('close', () => {
			clearTimeout(timer);
			if (!stdout.trim()) {
				resolve({ ok: false, startUrl: url, pageCount: 0, pages: [], stats: {}, error: stderr.trim() || 'No output from scrapy_crawler.py' });
				return;
			}
			try {
				resolve(JSON.parse(stdout));
			} catch (e: any) {
				resolve({ ok: false, startUrl: url, pageCount: 0, pages: [], stats: {}, error: `Failed to parse scrapy_crawler.py output: ${e?.message || e}` });
			}
		});
		proc.on('error', (e) => {
			clearTimeout(timer);
			resolve({ ok: false, startUrl: url, pageCount: 0, pages: [], stats: {}, error: e?.message || String(e) });
		});
	});
}
