import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

export interface LocalSecResourceBundle {
	sourceUrl: string;
	label: string;
	generatedAt: string;
	classified: ClassifiedLink[];
	downloadLinks: DownloadLink[];
	wroteToRedis: false;
	outputDir: string;
}

export type ResourceCategory = 'sec-bulk-data' | 'state-regulator-directory' | 'adviser-reporting-info' | 'covered-by-existing-ingestion' | 'general-resource' | 'unknown';

export interface ClassifiedLink {
	url: string;
	category: ResourceCategory;
	useful: boolean;
	duplicateReason: string | null;
}

export interface DownloadLink {
	url: string;
	label: string;
	kind: 'registered' | 'exempt' | 'unknown';
}

export function classifyLink(url: string): ClassifiedLink {
	const normalized = (url || '').trim().toLowerCase();
	if (normalized.includes('adviserinfo.sec.gov') || normalized.includes('brokercheck.finra.org') || normalized.includes('finra.org/brokercheck')) {
		return {
			url,
			category: 'covered-by-existing-ingestion',
			useful: false,
			duplicateReason: 'This is already covered by the existing Redis-backed FINRA/SEC detail ingestion.',
		};
	}
	if (normalized.includes('sec.gov/foia/docs/invafoia.htm') || normalized.includes('sec.gov/foia/docs/form-adv-archive-data.htm')) {
		return {
			url,
			category: 'sec-bulk-data',
			useful: true,
			duplicateReason: null,
		};
	}
	if (normalized.includes('nasaa.org/contact-your-regulator') || normalized.includes('nasaa.org/about-us/contact-us/contact-your-regulator')) {
		return {
			url,
			category: 'state-regulator-directory',
			useful: true,
			duplicateReason: null,
		};
	}
	if (
		normalized.includes('adviserinfo.sec.gov/resources') ||
		normalized.includes('sec.gov/iard') ||
		normalized.includes('sec.gov/about/divisions-offices/division-investment-management/electronic-filing-investment-advisers-iard')
	) {
		return {
			url,
			category: 'adviser-reporting-info',
			useful: true,
			duplicateReason: null,
		};
	}
	if (normalized.includes('sec.gov') || normalized.includes('investor.gov') || normalized.includes('nasaa.org')) {
		return {
			url,
			category: 'general-resource',
			useful: false,
			duplicateReason: 'General informational link; not a direct data source for enrichment.',
		};
	}
	return {
		url,
		category: 'unknown',
		useful: false,
		duplicateReason: null,
	};
}

export function extractDownloadLinks(html: string): DownloadLink[] {
	const links = Array.from(html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([^<]+)</gi));
	const results: DownloadLink[] = [];
	for (const [, href, label] of links) {
		const cleanedHref = href.trim();
		const cleanedLabel = label.replace(/\s+/g, ' ').trim();
		if (!cleanedHref) continue;
		const lower = cleanedHref.toLowerCase();
		if (!lower.includes('.zip') && !lower.includes('.xlsx') && !lower.includes('.csv')) continue;
		const kind =
			/exempt/i.test(cleanedLabel) ? 'exempt'
			: /registered/i.test(cleanedLabel) ? 'registered'
			: 'unknown';
		results.push({ url: cleanedHref, label: cleanedLabel, kind });
	}
	return results;
}

export async function analyzeSecResourcesPage(htmlPath: string) {
	const html = await fs.readFile(htmlPath, 'utf8');
	return analyzeSecResourcesHtml(html);
}

export async function fetchSecResourceHtml(url: string) {
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage();
		await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
		await page.waitForTimeout(4000);
		return await page.content();
	} finally {
		await browser.close();
	}
}

export async function analyzeSecResourcesUrl(url: string) {
	const html = await fetchSecResourceHtml(url);
	return analyzeSecResourcesHtml(html);
}

export function analyzeSecResourcesHtml(html: string) {
	const links = Array.from(html.matchAll(/https?:\/\/[^"'\s>]+/gi)).map((m) => m[0]);
	const classified = links.map((url) => classifyLink(url));
	const downloadLinks = extractDownloadLinks(html);
	return {
		totalLinks: links.length,
		classified,
		downloadLinks,
	};
}

export async function createLocalSecResourceBundle(options: { outputDir: string; sourceUrl: string; html: string; label: string }): Promise<LocalSecResourceBundle> {
	const outputDir = path.resolve(options.outputDir);
	await fs.mkdir(outputDir, { recursive: true });
	const analysis = analyzeSecResourcesHtml(options.html);
	const manifest: LocalSecResourceBundle = {
		sourceUrl: options.sourceUrl,
		label: options.label,
		generatedAt: new Date().toISOString(),
		classified: analysis.classified,
		downloadLinks: analysis.downloadLinks,
		wroteToRedis: false,
		outputDir,
	};
	await fs.writeFile(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
	await fs.writeFile(path.join(outputDir, 'source.html'), options.html);
	return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const input = process.argv[2];
	const outputDir = process.argv[3] ? path.resolve(process.cwd(), process.argv[3]) : undefined;
	if (!input) {
		console.error('Usage: tsx scripts/analyze-sec-resources.ts <html-file-or-url> [output-dir]');
		process.exit(1);
	}
	const isUrl = /^https?:\/\//i.test(input);
	const html = isUrl ? await fetchSecResourceHtml(input) : await fs.readFile(path.resolve(process.cwd(), input), 'utf8');
	const result = analyzeSecResourcesHtml(html);
	if (outputDir) {
		const written = await createLocalSecResourceBundle({ outputDir, sourceUrl: input, html, label: path.basename(outputDir) });
		console.log(JSON.stringify(written, null, 2));
	} else {
		console.log(JSON.stringify(result, null, 2));
	}
}
