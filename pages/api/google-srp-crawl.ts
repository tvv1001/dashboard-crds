import type { NextApiRequest, NextApiResponse } from 'next';
import { promises as fs } from 'fs';
import path from 'path';
import { captureGoogleSrp, captureBingSrp, crawlSrpResult, type CrawledResult, type SrpCapture, type SrpResult } from './_google-srp';

/**
 * POST /api/google-srp-crawl
 * body: { query: string, limit?: number }
 *
 * Pipeline (see pages/api/_google-srp.ts for full rationale) — queries
 * BOTH Google and Bing for every request:
 *   1. Fetch the SRP from each engine, recording the exact final URL landed
 *      on (for validity/correlation) and saving the raw HTML bytes as
 *      text-only evidence of what was actually returned by each engine.
 *      Google is IP-blocked in some environments (CAPTCHA/JS-wall) — when
 *      that happens its capture is simply marked `valid: false` and
 *      contributes no results, while Bing (usually unaffected) still does.
 *   2. Extract each organic result's title + snippet + URL from that HTML,
 *      tagged with which engine it came from, deduped by URL.
 *   3. For each result, crawl the target page via scripts/scrapy_crawler.py
 *      (plain HTTP/HTML) and score how much the real page content diverges
 *      from what the SRP promised.
 *   4. When divergence is significant, save that page's raw HTML too, so
 *      the mismatch itself is documented.
 *   5. Persist everything to data/web-search/<query-slug>/<run-timestamp>/.
 */

function slugify(input: string): string {
	return (
		input
			.toLowerCase()
			.trim()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 80) || 'query'
	);
}

const OUTPUT_ROOT = path.join(process.cwd(), 'data', 'web-search');

function srpSummary(srp: SrpCapture, htmlFile: string) {
	return {
		engine: srp.engine,
		searchUrl: srp.searchUrl,
		finalUrl: srp.finalUrl,
		valid: srp.valid,
		statusCode: srp.statusCode,
		usedFallback: srp.usedFallback,
		htmlFile,
		resultCount: srp.results.length,
	};
}

async function saveRun(query: string, timestamp: string, googleSrp: SrpCapture, bingSrp: SrpCapture, results: CrawledResult[]) {
	const runDir = path.join(OUTPUT_ROOT, slugify(query), timestamp.replace(/[:.]/g, '-'));
	await fs.mkdir(runDir, { recursive: true });

	await fs.writeFile(path.join(runDir, 'google-srp.html'), googleSrp.html || '');
	await fs.writeFile(path.join(runDir, 'bing-srp.html'), bingSrp.html || '');

	const resultsOut: any[] = [];
	for (const [i, r] of results.entries()) {
		let divergentHtmlFile: string | null = null;
		if (r.divergentHtml != null) {
			divergentHtmlFile = `result-${i + 1}-divergent.html`;
			await fs.writeFile(path.join(runDir, divergentHtmlFile), r.divergentHtml);
		}
		resultsOut.push({
			engine: r.engine,
			position: r.position,
			srpTitle: r.title,
			srpSnippet: r.snippet,
			url: r.url,
			page: r.page,
			similarity: r.similarity,
			divergent: r.divergent,
			divergentHtmlFile,
		});
	}

	const summary = {
		query,
		timestamp,
		engines: {
			google: srpSummary(googleSrp, 'google-srp.html'),
			bing: srpSummary(bingSrp, 'bing-srp.html'),
		},
		resultCount: resultsOut.length,
		divergentCount: resultsOut.filter((r) => r.divergent).length,
		results: resultsOut,
	};
	await fs.writeFile(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));
	return { runDir, summary };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
	if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
	const body = req.body || {};
	const query = String(body.query || '').trim();
	const limit = Math.max(1, Math.min(Number(body.limit) || 10, 20));
	if (!query) return res.status(400).json({ error: 'Provide a query' });

	try {
		const timestamp = new Date().toISOString();
		const [googleSrp, bingSrp] = await Promise.all([captureGoogleSrp(query, limit), captureBingSrp(query, limit)]);

		if (!googleSrp.valid && !bingSrp.valid) {
			const { runDir, summary } = await saveRun(query, timestamp, googleSrp, bingSrp, []);
			return res.status(502).json({ error: 'Neither Google nor Bing SRP looked valid (blocked/CAPTCHA on both)', runDir, summary });
		}

		// Merge results from both engines, deduped by URL (first-seen wins,
		// Google first since it's the primary engine when it works).
		const seenUrls = new Set<string>();
		const merged: SrpResult[] = [];
		for (const r of [...googleSrp.results, ...bingSrp.results]) {
			if (seenUrls.has(r.url)) continue;
			seenUrls.add(r.url);
			merged.push(r);
			if (merged.length >= limit) break;
		}

		const results: CrawledResult[] = [];
		for (const srpResult of merged) {
			try {
				const crawled = await crawlSrpResult(srpResult);
				results.push(crawled);
			} catch (e: any) {
				results.push({
					...srpResult,
					page: { finalUrl: srpResult.url, ok: false, statusCode: null, title: '', description: '', textExcerpt: '', error: e?.message || String(e) },
					similarity: { titleScore: 0, snippetScore: 0, overall: 0 },
					divergent: true,
					divergentHtml: null,
				});
			}
		}

		const { runDir, summary } = await saveRun(query, timestamp, googleSrp, bingSrp, results);
		return res.json({ runDir, summary });
	} catch (e: any) {
		return res.status(500).json({ error: e?.message || String(e) });
	}
}
