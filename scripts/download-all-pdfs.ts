/**
 * Downloads the official report/brochure PDFs for every CRD saved in Redis.
 *
 * Endpoints below were verified live (2026-07-29) and were also confirmed by
 * inspecting the client bundles served by brokercheck.finra.org and
 * adviserinfo.sec.gov (the `buildPdfLink` / `buildCrsLink` / `getBrochureLink`
 * helpers in their Angular `main.*.js`), so these match exactly what the
 * "View report" / "View latest Form ADV" / "Part 2 Brochures" / relationship
 * summary links on each site actually point to:
 *
 *   - FINRA individual report:  https://files.brokercheck.finra.org/individual/individual_<CRD>.pdf
 *   - FINRA firm report:        https://files.brokercheck.finra.org/firm/firm_<CRD>.pdf
 *   - SEC firm Form ADV report: https://reports.adviserinfo.sec.gov/reports/ADV/<CRD>/PDF/<CRD>.pdf
 *   - SEC firm Form CRS:        https://reports.adviserinfo.sec.gov/crs/crs_<CRD>.pdf
 *   - SEC firm Part 2 Brochure: https://files.adviserinfo.sec.gov/IAPD/Content/Common/crd_iapd_Brochure.aspx?BRCHR_VRSN_ID=<brochureVersionID>
 *     (one PDF per entry in the firm's cached `brochures.brochuredetails[]`,
 *     which is exactly the list the "Part 2 Brochures" page on
 *     adviserinfo.sec.gov renders links from - so every brochure a firm has
 *     on file gets downloaded, not just the combined ADV report.)
 *
 * FINRA firm Form CRS was tested at the equivalent files.brokercheck.finra.org
 * path and consistently 403s, so it is not requested for FINRA entries.
 * SEC does not publish a per-CRD PDF report for individuals (Form ADV/CRS are
 * firm-only filings).
 *
 * As a defense-in-depth "crawl" step (both sites are Angular SPAs, so the
 * static HTML itself carries no links), this script also regex-scans the
 * raw detail-page HTML for any other *.pdf links so nothing new added to
 * those pages in the future is missed.
 *
 * Usage:
 *   pnpm download-pdfs [--limit=N] [--concurrency=N] [--delay-ms=N] [--force] [--crds=CRD1,CRD2,...]
 */
import { promises as fs } from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import { listSavedKeysWithStats, loadSavedPayload, type SavedKeyStat } from '../pages/api/_lib';

const outRoot = path.resolve(process.cwd(), 'data', 'pdfs');
const logPath = path.join(outRoot, '_download-log.json');
const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function parseArgs() {
	const args = process.argv.slice(2);
	const get = (name: string, fallback: number) => {
		const hit = args.find((a) => a.startsWith(`--${name}=`));
		if (!hit) return fallback;
		const v = Number(hit.split('=')[1]);
		return Number.isFinite(v) && v > 0 ? v : fallback;
	};
	const crdsArg = args.find((a) => a.startsWith('--crds='));
	const crds =
		crdsArg ?
			crdsArg
				.split('=')[1]
				.split(',')
				.map((v) => v.trim())
				.filter(Boolean)
		:	null;
	return {
		limit: get('limit', Number.POSITIVE_INFINITY),
		concurrency: get('concurrency', 4),
		delayMs: get('delay-ms', 400),
		force: args.includes('--force'),
		crds,
	};
}

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeName(name: string | null | undefined) {
	const cleaned = String(name || '')
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return cleaned.slice(0, 60) || 'unknown';
}

interface DownloadTarget {
	url: string;
	destDir: string;
	fileName: string;
	label: string;
}

// Best-effort extraction of the normalized content block from any of the
// shapes saved payloads can take (already-normalized wrapper, or the raw
// upstream search-hit envelope with a stringified iacontent/content field).
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

async function buildDirectTargets(entry: SavedKeyStat): Promise<DownloadTarget[]> {
	const targets: DownloadTarget[] = [];
	const nameSlug = sanitizeName(entry.displayName);
	if (entry.source === 'finra') {
		const destDir = path.join(outRoot, 'finra', entry.type);
		targets.push({
			url: `https://files.brokercheck.finra.org/${entry.type}/${entry.type}_${entry.crd}.pdf`,
			destDir,
			fileName: `${entry.crd}_${nameSlug}.pdf`,
			label: `finra:${entry.type}:${entry.crd}:report`,
		});
	} else if (entry.source === 'sec' && entry.type === 'firm') {
		// SEC does not publish per-CRD PDF reports for individuals (Form ADV and
		// Form CRS are firm-only filings), so only firm targets are built here.
		const destDir = path.join(outRoot, 'sec', 'firm');
		targets.push({
			url: `https://reports.adviserinfo.sec.gov/reports/ADV/${entry.crd}/PDF/${entry.crd}.pdf`,
			destDir,
			fileName: `${entry.crd}_${nameSlug}_adv.pdf`,
			label: `sec:firm:${entry.crd}:adv`,
		});
		targets.push({
			url: `https://reports.adviserinfo.sec.gov/crs/crs_${entry.crd}.pdf`,
			destDir,
			fileName: `${entry.crd}_${nameSlug}_crs.pdf`,
			label: `sec:firm:${entry.crd}:crs`,
		});

		try {
			const payload = await loadSavedPayload(entry.key);
			const content = getContentBlock(payload);
			const brochures = content?.brochures?.brochuredetails;
			if (Array.isArray(brochures)) {
				for (const b of brochures) {
					const versionId = b?.brochureVersionID;
					if (!versionId) continue;
					const brochureSlug = sanitizeName(b?.brochureName) || String(versionId);
					targets.push({
						url: `https://files.adviserinfo.sec.gov/IAPD/Content/Common/crd_iapd_Brochure.aspx?BRCHR_VRSN_ID=${versionId}`,
						destDir: path.join(destDir, 'brochures'),
						fileName: `${entry.crd}_${versionId}_${brochureSlug}.pdf`,
						label: `sec:firm:${entry.crd}:brochure:${versionId}`,
					});
				}
			}
		} catch {
			// Payload missing/unreadable - the ADV/CRS targets above still apply.
		}
	}
	return targets;
}

function detailPageUrl(entry: SavedKeyStat): string | null {
	if (entry.source === 'finra') {
		return `https://brokercheck.finra.org/${entry.type}/summary/${entry.crd}`;
	}
	if (entry.source === 'sec') {
		return `https://adviserinfo.sec.gov/${entry.type}/summary/${entry.crd}`;
	}
	return null;
}

async function fetchWithRetry(url: string, attempts = 4): Promise<Response> {
	let lastErr: unknown = null;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			const resp = await fetch(url, { headers: { 'User-Agent': userAgent, 'Accept': 'application/pdf,text/html,*/*' } });
			if (resp.status === 429 || (resp.status >= 500 && resp.status < 600)) {
				lastErr = new Error(`HTTP ${resp.status}`);
				await sleep(1000 * attempt * attempt);
				continue;
			}
			return resp;
		} catch (err) {
			lastErr = err;
			await sleep(1000 * attempt);
		}
	}
	throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function isPdfFile(filePath: string) {
	try {
		const handle = await fs.open(filePath, 'r');
		const buf = Buffer.alloc(5);
		await handle.read(buf, 0, 5, 0);
		await handle.close();
		return buf.toString('ascii') === '%PDF-';
	} catch {
		return false;
	}
}

type Outcome = 'downloaded' | 'skipped-exists' | 'not-found' | 'failed';

async function downloadOne(target: DownloadTarget, force: boolean): Promise<{ outcome: Outcome; detail?: string }> {
	await fs.mkdir(target.destDir, { recursive: true });
	const destPath = path.join(target.destDir, target.fileName);
	if (!force) {
		try {
			await fs.access(destPath);
			return { outcome: 'skipped-exists' };
		} catch {
			// fall through to download
		}
	}
	try {
		const resp = await fetchWithRetry(target.url);
		if (!resp.ok) {
			return { outcome: 'not-found', detail: `HTTP ${resp.status}` };
		}
		const contentType = resp.headers.get('content-type') || '';
		const buf = Buffer.from(await resp.arrayBuffer());
		if (buf.length < 100 || (!contentType.includes('pdf') && buf.subarray(0, 5).toString('ascii') !== '%PDF-')) {
			return { outcome: 'not-found', detail: `unexpected content-type: ${contentType}` };
		}
		await fs.writeFile(destPath, buf);
		if (!(await isPdfFile(destPath))) {
			await fs.unlink(destPath).catch(() => {});
			return { outcome: 'failed', detail: 'downloaded file was not a valid PDF' };
		}
		return { outcome: 'downloaded' };
	} catch (err) {
		return { outcome: 'failed', detail: err instanceof Error ? err.message : String(err) };
	}
}

// Crawl the public detail page HTML for a CRD and return any *.pdf links found
// that are not already covered by the known direct-report/brochure patterns.
async function discoverExtraPdfLinks(entry: SavedKeyStat, knownUrls: Set<string>): Promise<string[]> {
	const pageUrl = detailPageUrl(entry);
	if (!pageUrl) return [];

	const found = new Set<string>();

	try {
		const resp = await fetchWithRetry(pageUrl, 2);
		if (resp.ok) {
			const html = await resp.text();
			const re = /https?:\/\/[^\s"'<>]+\.pdf/gi;
			let match: RegExpExecArray | null;
			while ((match = re.exec(html))) {
				if (!knownUrls.has(match[0])) found.add(match[0]);
			}
		}
	} catch {
		// fall through to browser rendering fallback
	}

	try {
		const browser = await chromium.launch({ headless: true });
		const page = await browser.newPage({ userAgent });
		await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
		await page.waitForTimeout(4000);
		const renderedLinks = await page.evaluate(() => {
			const seen = new Set<string>();
			for (const el of document.querySelectorAll('a[href], link[href], iframe[src], object[data]')) {
				const value = (el as HTMLAnchorElement | HTMLLinkElement).href || (el as HTMLIFrameElement).src || (el as HTMLObjectElement).data || '';
				if (value) seen.add(value);
			}
			return Array.from(seen);
		});
		for (const link of renderedLinks) {
			if (/\.pdf(?:$|[?#])/i.test(link) && !knownUrls.has(link)) found.add(link);
		}
		await browser.close();
	} catch {
		// Ignore browser discovery failures and rely on the raw HTML fallback.
	}

	return Array.from(found);
}

async function main() {
	const opts = parseArgs();
	await fs.mkdir(outRoot, { recursive: true });

	console.log('Loading saved CRD index from Redis...');
	const { keys, uniqueTotalCrds } = await listSavedKeysWithStats({ limit: 0 });
	console.log(`Found ${keys.length} saved keys across ${uniqueTotalCrds} unique CRDs.`);

	const crdFiltered = opts.crds ? keys.filter((k) => opts.crds!.includes(k.crd)) : keys;
	const entries = Number.isFinite(opts.limit) ? crdFiltered.slice(0, opts.limit) : crdFiltered;

	const summary = {
		startedAt: new Date().toISOString(),
		totalEntries: entries.length,
		downloaded: 0,
		skippedExisting: 0,
		notFound: 0,
		failed: 0,
		extraDiscovered: 0,
		failures: [] as { label: string; url: string; detail?: string }[],
	};

	let cursor = 0;
	async function worker() {
		while (cursor < entries.length) {
			const idx = cursor++;
			const entry = entries[idx];
			const targets = await buildDirectTargets(entry);
			const knownUrls = new Set(targets.map((t) => t.url));

			for (const target of targets) {
				const result = await downloadOne(target, opts.force);
				if (result.outcome === 'downloaded') summary.downloaded++;
				else if (result.outcome === 'skipped-exists') summary.skippedExisting++;
				else if (result.outcome === 'not-found') summary.notFound++;
				else {
					summary.failed++;
					summary.failures.push({ label: target.label, url: target.url, detail: result.detail });
				}
				await sleep(opts.delayMs);
			}

			// Crawl the detail page for any additional PDFs not already covered.
			const extras = await discoverExtraPdfLinks(entry, knownUrls);
			for (const url of extras) {
				const nameSlug = sanitizeName(entry.displayName);
				const destDir = path.join(outRoot, entry.source, entry.type, 'extra');
				const fileName = `${entry.crd}_${nameSlug}_${sanitizeName(path.basename(url))}`;
				const result = await downloadOne({ url, destDir, fileName, label: `${entry.source}:${entry.type}:${entry.crd}:extra` }, opts.force);
				if (result.outcome === 'downloaded') {
					summary.downloaded++;
					summary.extraDiscovered++;
				} else if (result.outcome === 'skipped-exists') summary.skippedExisting++;
				else if (result.outcome === 'not-found') summary.notFound++;
				else {
					summary.failed++;
					summary.failures.push({ label: `${entry.source}:${entry.type}:${entry.crd}:extra`, url, detail: result.detail });
				}
				await sleep(opts.delayMs);
			}

			if (idx > 0 && idx % 100 === 0) {
				console.log(
					`[${idx}/${entries.length}] downloaded=${summary.downloaded} skipped=${summary.skippedExisting} notFound=${summary.notFound} failed=${summary.failed} extra=${summary.extraDiscovered}`,
				);
				await fs.writeFile(logPath, JSON.stringify({ ...summary, updatedAt: new Date().toISOString(), progress: `${idx}/${entries.length}` }, null, 2));
			}
		}
	}

	await Promise.all(Array.from({ length: opts.concurrency }, () => worker()));

	const finalLog = { ...summary, finishedAt: new Date().toISOString() };
	await fs.writeFile(logPath, JSON.stringify(finalLog, null, 2));
	console.log('\n=== Download complete ===');
	console.log(JSON.stringify({ ...finalLog, failures: `${finalLog.failures.length} failures (see ${logPath})` }, null, 2));
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
