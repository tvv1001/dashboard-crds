import * as cheerio from 'cheerio';
import { listSavedKeysWithStats, loadSavedPayload, normalizeRawPayload } from './_lib';
import { querySerperGoogle } from './_google-srp';

/**
 * Perform a raw Google search and extract organic URLs via Serper.
 */
export async function googleSearch(query: string, limit = 10) {
	const serperResults = await querySerperGoogle(query, limit);
	if (serperResults.length === 0) {
		throw new Error('Serper returned no results');
	}
	return serperResults.map((result) => result.url);
}

export interface AliasInfo {
	crd: string;
	type: 'individual' | 'firm';
	names: string[];
}

/**
 * Compile a dictionary of names/aliases from local CRD data.
 * Since we have 100k+ files, we limit this to a recent subset or specific targets.
 */
export async function getAliasDictionary(targetCrds?: string[]): Promise<AliasInfo[]> {
	const { keys } = await listSavedKeysWithStats({
		limit: targetCrds ? 5000 : 1000, // Reasonable limit for memory
		includeCrds: targetCrds,
	});

	const results: AliasInfo[] = [];

	for (const entry of keys) {
		try {
			const payload = await loadSavedPayload(entry.key);
			const normalized = normalizeRawPayload(payload);
			const names = new Set<string>();

			// Extract names from Individual
			if (entry.type === 'individual') {
				if (normalized.basicInformation) {
					const bi = normalized.basicInformation;
					if (bi.firstName && bi.lastName) names.add(`${bi.firstName} ${bi.lastName}`);
					if (bi.firstName && bi.middleName && bi.lastName) names.add(`${bi.firstName} ${bi.middleName} ${bi.lastName}`);
				}
				if (Array.isArray(normalized.otherNames)) {
					normalized.otherNames.forEach((n: any) => {
						if (n.firstName && n.lastName) names.add(`${n.firstName} ${n.lastName}`);
					});
				}
			}
			// Extract names from Firm
			else if (entry.type === 'firm') {
				if (normalized.basicInformation && normalized.basicInformation.orgName) {
					names.add(normalized.basicInformation.orgName);
				}
				if (Array.isArray(normalized.otherNames)) {
					normalized.otherNames.forEach((n: any) => {
						if (n.orgName) names.add(n.orgName);
					});
				}
			}

			if (names.size > 0) {
				results.push({
					crd: entry.crd,
					type: entry.type,
					names: Array.from(names).filter((n) => n.length > 3),
				});
			}
		} catch (e) {
			// skip errors for individual files
		}
	}

	return results;
}

export function extractDataLayer(html: string): any[] {
	const dataLayers: any[] = [];
	const $ = cheerio.load(html);

	$('script').each((_, el) => {
		const content = $(el).html() || '';

		// 1. JSON-LD
		if ($(el).attr('type') === 'application/ld+json') {
			try {
				dataLayers.push(JSON.parse(content));
			} catch (e) {}
		}

		// 2. dataLayer pushes or window.dataLayer definitions
		if (content.includes('dataLayer') && content.includes('[')) {
			// Rough extraction of array-like structures
			const match = content.match(/dataLayer\s*=\s*(\[[\s\S]*?\])/);
			if (match) {
				try {
					// Extremely loose parsing - might need a better approach for complex JS
					// but for simple object literals it might work.
					// In a real app, we'd use a JS sandbox or a better regex.
					const cleaned = match[1].replace(/(\w+):/g, '"$1":').replace(/'/g, '"');
					dataLayers.push(JSON.parse(cleaned));
				} catch (e) {}
			}
		}
	});

	return dataLayers;
}

export function extractArticleText(html: string): string {
	const $ = cheerio.load(html);

	// Remove noise
	$('script, style, nav, footer, header, noscript').remove();

	const content: string[] = [];
	$('h1, h2, h3, p').each((_, el) => {
		content.push($(el).text().trim());
	});

	return content.join('\n\n');
}
