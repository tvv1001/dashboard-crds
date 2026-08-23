import type { Redis } from '@upstash/redis';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { getRedisClientInstance } from './redisClient';
import { getSearchIndexFilePaths, SEARCH_INDEX_RELATIVE_FILES } from './searchDataPaths';
import * as path from 'node:path';
import * as fsSync from 'node:fs';
import * as zlib from 'node:zlib';

let cachedRedisClient: Redis | null = null;
function getUpstashClient() {
	if (cachedRedisClient) return cachedRedisClient;
	const url = process.env.UPSTASH_REDIS_REST_URL_MIRROR || process.env.UPSTASH_REDIS_REST_URL_2 || process.env.UPSTASH_REDIS_REST_URL;
	const token = process.env.UPSTASH_REDIS_REST_TOKEN_2 || process.env.UPSTASH_REDIS_REST_TOKEN;
	if (!url || !token) return null;
	cachedRedisClient = getRedisClientInstance({ url, token });
	return cachedRedisClient;
}

async function fetchFromRedis(bucket: string): Promise<any | null> {
	const redis = getUpstashClient();
	if (!redis) {
		return null;
	}

	function parseStoredIndexPayload(value: unknown) {
		if (typeof value !== 'string' || !value.trim()) return null;
		const trimmed = value.trim();
		try {
			if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
				return JSON.parse(trimmed);
			}
			if (trimmed.startsWith('br:')) {
				const decoded = zlib.brotliDecompressSync(Buffer.from(trimmed.slice(3), 'base64')).toString('utf-8');
				return JSON.parse(decoded);
			}
			const decoded = zlib.gunzipSync(Buffer.from(trimmed, 'base64')).toString('utf-8');
			return JSON.parse(decoded);
		} catch {
			return null;
		}
	}

	try {
		const key = `search:indexes:${bucket}`;
		const parsedValue = await parseStoredIndexPayload(await redis.get(key));
		if (parsedValue) return parsedValue;

		const metaPayload = await redis.get(`${key}:meta`);

		const meta = await parseStoredIndexPayload(metaPayload) ?? (typeof metaPayload === 'string' ? JSON.parse(metaPayload) : metaPayload);
		const chunkCount = Number(meta?.chunks ?? meta?.parts ?? 0);
		if (!chunkCount || chunkCount < 1) return null;

		const partPromises: Promise<string | null>[] = [];
		for (let index = 0; index < chunkCount; index += 1) {
			partPromises.push(redis.get<string>(`${key}:part:${index}`));
		}
		const chunks = await Promise.all(partPromises);
		if (chunks.some((chunk) => typeof chunk !== 'string' || !chunk)) return null;

		return await parseStoredIndexPayload(chunks.filter((c): c is string => c !== null).join(''));
	} catch (err) {
		console.error(`[localSearch] Failed to fetch index from Redis for ${bucket}:`, err instanceof Error ? err.message : String(err));
		return null;
	}
}

export type LocalSearchSource = 'finra' | 'sec';
export type LocalSearchEntity = 'individual' | 'firm';
type LocalSearchBucket = `${LocalSearchSource}:${LocalSearchEntity}`;

export type LocalSearchHit = Record<string, any>;
export type LocalSearchDoc = {
	id: string;
	type: LocalSearchEntity;
	source: LocalSearchSource;
	nameSearchText: string;
	addressSearchText?: string;
	strictSearchText: string;
	searchText: string;
	hit: LocalSearchHit;
};

type PreparedLocalSearchDoc = LocalSearchDoc & {
	primaryNameSearchText: string;
	normalizedNameSearchText: string;
	normalizedStrictSearchText: string;
	addressSearchText: string;
	primaryNameCandidates: string[];
	primaryNameTokens: string[];
	nameCandidates: string[];
	nameTokens: string[];
	surnameCandidates: string[];
	surnameCompactCandidates: string[];
};

export type LocalSearchIndex = {
	generatedAt?: string;
	bucket: string;
	docs: PreparedLocalSearchDoc[];
};

export type LocalSearchOptions = {
	limit?: number;
	offset?: number;
	baseUrl?: string;
	seedRoots?: Array<string | null | undefined>;
};

export type LocalSearchResponse = {
	bucket: LocalSearchBucket;
	generatedAt: string | null;
	total: number;
	hits: {
		total: number;
		start: number;
		hits: { _id: string; _source: LocalSearchHit }[];
	};
	response: {
		numFound: number;
		start: number;
		docs: LocalSearchHit[];
	};
	results: LocalSearchHit[];
	currentPage: LocalSearchHit[];
	pageNumber: number;
	pageSize: number;
};

const indexPromiseCache = new Map<string, Promise<LocalSearchIndex | null>>();
const STRICT_MATCH_QUERY_ALLOWLIST = new Set(['mason', 'bryan']);

function simplifyName(name: string): string {
	if (!name) return '';
	const punctuation = ['.', ',', '(', ')', '|', '[', ']', '{', '}'];
	const substitutions: Record<string, string> = { '-': ' ', 'ł': 'l', 'ø': 'o', 'æ': 'ae' };
	const suffixes = ['Esq', 'JD', 'MBA', 'PA', 'PhD', 'Jr', 'Sr', 'II', 'III', 'IV', 'V'].map((s) => ` ${s.toLowerCase()}`);

	// Lowercase and remove diacritics
	let simple = name
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '');

	// Remove punctuation
	for (const p of punctuation) {
		if (simple.includes(p)) {
			simple = simple.split(p).join('');
		}
	}

	// Substitutions
	for (const [k, v] of Object.entries(substitutions)) {
		if (simple.includes(k)) {
			simple = simple.split(k).join(v);
		}
	}

	// Remove suffixes
	for (const s of suffixes) {
		if (simple.endsWith(s)) {
			simple = simple.slice(0, -s.length);
		}
	}

	return simple.replace(/\s+/g, ' ').trim();
}

const NICKNAMES_RAW: Record<string, string[]> = {
	william: ['bill', 'billy', 'will', 'willy'],
	robert: ['bob', 'bobby', 'rob', 'bert'],
	richard: ['dick', 'rick', 'rich'],
	theodore: ['theo', 'ted', 'teddy'],
	samantha: ['sam', 'sammy'],
	kathryn: ['katie', 'katy', 'kate', 'kathleen', 'katherine', 'catherine', 'cathy'],
	matthew: ['matt'],
	nicholas: ['nick'],
	alexander: ['alex', 'sasha', 'al'],
	alexandra: ['alex', 'lexi', 'ali'],
	elizabeth: ['beth', 'liz', 'lizzie', 'eliza'],
	james: ['jim', 'jimmy', 'jamie'],
	john: ['jack', 'johnny'],
	joseph: ['joe', 'joey'],
	charles: ['charlie', 'chuck'],
	christopher: ['chris'],
	david: ['dave'],
	thomas: ['tom', 'tommy'],
	steven: ['steve'],
	patrick: ['pat'],
	gerald: ['jerry'],
	lawrence: ['larry'],
	ronald: ['ron', 'ronny'],
	anthony: ['tony'],
	timothy: ['tim', 'timmy'],
	michael: ['mike', 'micky'],
};

const NICKNAME_MAP = new Map<string, string[]>();
Object.entries(NICKNAMES_RAW).forEach(([formal, variants]) => {
	const all = Array.from(new Set([formal, ...variants]));
	all.forEach((name) => {
		NICKNAME_MAP.set(name, all);
	});
});

function normalizeText(value: unknown) {
	return String(value || '')
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function compactNormalizeText(value: unknown) {
	return normalizeText(value).replace(/\s+/g, '');
}

function uniqueNormalized(values: unknown[]) {
	const seen = new Set<string>();
	const normalizedValues: string[] = [];
	for (const value of values) {
		const normalized = normalizeText(value);
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		normalizedValues.push(normalized);
	}
	return normalizedValues;
}

function extractQuotedValues(raw: string) {
	const values: string[] = [];
	for (const match of raw.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
		values.push(match[1].replace(/\\"/g, '"'));
	}
	return values;
}

function arrayify(value: unknown) {
	if (Array.isArray(value)) return value;
	if (value == null || value === '') return [];
	return [value];
}

function collectNameCandidates(doc: LocalSearchDoc) {
	const hit = doc.hit || {};
	const primaryIndividualName = [hit.ind_firstname, hit.ind_middlename, hit.ind_lastname].filter(Boolean).join(' ');
	const primaryFirmName = hit.firm_name || hit.firmName || hit.organizationName || hit.organization_name || hit.companyName || hit.legalName || hit.name;

	const rawNames = [primaryIndividualName, primaryFirmName, hit.name, hit.fullName, hit.full_name, hit.displayName, hit.label, hit.personName];

	// For individuals, also include their current firm names as searchable name candidates
	if (doc.type === 'individual') {
		const emps = [...(hit.ind_current_employments || []), ...(hit.ind_ia_current_employments || [])];
		emps.forEach((e: any) => {
			if (e.firmName) rawNames.push(e.firmName);
			if (e.firm_name) rawNames.push(e.firm_name);
		});
	}

	const extraNameKeys = [
		'otherNames',
		'ind_other_names',
		'other_names',
		'previousNames',
		'previous_names',
		'priorNames',
		'prior_names',
		'formerNames',
		'former_names',
		'aliases',
		'alias',
		'aka',
		'dbaNames',
		'doingBusinessAs',
	];

	extraNameKeys.forEach((key) => {
		rawNames.push(...arrayify(hit[key]));
	});

	const candidates = new Set<string>();
	rawNames.forEach((n) => {
		const simple = simplifyName(String(n || ''));
		if (simple) {
			candidates.add(simple);
			if (simple.includes(' ')) {
				candidates.add(simple.replace(/\s+/g, ''));
			}
			const parts = simple.split(' ');
			if (parts.some((p) => p.length === 1)) {
				const noInitials = parts.filter((p) => p.length > 1).join(' ');
				if (noInitials) candidates.add(noInitials);
			}
		}
	});

	return Array.from(candidates);
}

function collectSurnameCandidates(doc: LocalSearchDoc) {
	const hit = doc.hit || {};
	const rawSurnames = [hit.ind_lastname, hit.lastName, hit.lastname, hit.surname, hit.familyName];
	const candidates = new Set<string>();
	rawSurnames.forEach((s) => {
		const simple = simplifyName(String(s || ''));
		if (simple) candidates.add(simple);
	});
	return Array.from(candidates);
}

function prepareDoc(doc: LocalSearchDoc): PreparedLocalSearchDoc {
	const hit = doc.hit || {};
	const primaryIndividualName = [hit.ind_firstname, hit.ind_middlename, hit.ind_lastname].filter(Boolean).join(' ');
	const primaryFirmName = hit.firm_name || hit.firmName || hit.organizationName || hit.organization_name || hit.companyName || hit.legalName || hit.name;
	const primaryNameCandidates = uniqueNormalized([primaryIndividualName, primaryFirmName, hit.name, hit.fullName, hit.full_name, hit.displayName, hit.label, hit.personName]);
	const nameCandidates = collectNameCandidates(doc);
	const surnameCandidates = collectSurnameCandidates(doc);
	const normalizedNameSearchText = simplifyName(doc.nameSearchText || primaryNameCandidates.join(' '));
	const normalizedStrictSearchText = simplifyName(doc.strictSearchText || doc.searchText);
	const primaryNameTokens = Array.from(new Set(primaryNameCandidates.flatMap((candidate) => tokenizeQuery(candidate))));
	const nameTokens = Array.from(new Set(nameCandidates.flatMap((candidate) => tokenizeQuery(candidate))));
	return {
		...doc,
		primaryNameSearchText: normalizedNameSearchText,
		normalizedNameSearchText,
		normalizedStrictSearchText,
		addressSearchText: normalizeText((doc as any).addressSearchText || ''),
		primaryNameCandidates,
		primaryNameTokens,
		nameCandidates,
		nameTokens,
		surnameCandidates,
		surnameCompactCandidates: Array.from(new Set(surnameCandidates.map((candidate) => compactNormalizeText(candidate)).filter(Boolean))),
	};
}

function tokenizeQuery(query: string) {
	return normalizeText(query)
		.split(' ')
		.map((token) => token.trim())
		.filter(Boolean);
}

const MIN_SEARCH_QUERY_CHARS = 3;
const SHORT_QUERY_ALLOWLIST = new Set(['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', 'a', 'b', 'c', 'd', 'e', 'f', 'g']);

export function hasMinimumSearchQuery(query: string) {
	const compactQuery = normalizeText(query).replace(/\s+/g, '');
	return SHORT_QUERY_ALLOWLIST.has(compactQuery) || compactQuery.length >= MIN_SEARCH_QUERY_CHARS;
}

async function loadIndex(bucket: LocalSearchBucket, baseUrl?: string, seedRoots: Array<string | null | undefined> = []): Promise<LocalSearchIndex | null> {
	const cacheKey = [bucket, baseUrl || '', ...seedRoots.map((root) => String(root || ''))].join('|');

	async function readIndexPayload(filePath: string) {
		const raw = await readFile(filePath);
		const util = await import('node:util');
		const jsonText = filePath.endsWith('.gz') ? (await util.promisify(require('node:zlib').gunzip)(raw)).toString('utf-8') : raw.toString('utf-8');
		return JSON.parse(jsonText) as { generatedAt?: string; bucket?: string; docs?: LocalSearchDoc[] };
	}

	async function readIndexPayloadFromUrl(url: string) {
		const response = await fetch(url);
		if (!response.ok) return null;
		const raw = Buffer.from(await response.arrayBuffer());
		const util = await import('node:util');
		const jsonText = url.endsWith('.gz') ? (await util.promisify(require('node:zlib').gunzip)(raw)).toString('utf-8') : raw.toString('utf-8');
		return JSON.parse(jsonText) as { generatedAt?: string; bucket?: string; docs?: LocalSearchDoc[] };
	}

	function getDeployedStaticIndexUrl(fileName: string, baseUrl?: string) {
		const url = baseUrl?.trim() || process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim() || process.env.VERCEL_BRANCH_URL?.trim() || process.env.VERCEL_URL?.trim();
		if (!url) return null;
		const origin = /^https?:\/\//i.test(url) ? url.replace(/\/$/, '') : `https://${url.replace(/\/$/, '')}`;
		return `${origin}/search-indexes/${fileName}`;
	}

	function getRemoteSearchIndexFileName(targetBucket: LocalSearchBucket) {
		switch (targetBucket) {
			case 'finra:individual':
				return 'search-index.finra.individual.json.gz';
			case 'finra:firm':
				return 'search-index.finra.firm.json.gz';
			case 'sec:individual':
				return 'search-index.sec.individual.json.gz';
			case 'sec:firm':
				return 'search-index.sec.firm.json.gz';
		}
	}

	if (!indexPromiseCache.has(cacheKey)) {
		indexPromiseCache.set(
			cacheKey,
			(async () => {
				const filePaths = getSearchIndexFilePaths(bucket, seedRoots);
				let index: LocalSearchIndex | null = null;
				if (filePaths.length > 0) {
					try {
						const allDocs: LocalSearchDoc[] = [];
						let generatedAt: string | undefined;
						let bucketName: string | undefined;

						const results = await Promise.all(filePaths.map((fp: string) => readIndexPayload(fp)));
						for (const parsed of results) {
							if (parsed?.generatedAt) generatedAt = generatedAt || parsed.generatedAt;
							bucketName = bucketName || parsed?.bucket;
							if (Array.isArray(parsed?.docs)) allDocs.push(...parsed.docs);
						}

						index = {
							generatedAt: generatedAt ?? undefined,
							bucket: bucketName ?? bucket,
							docs: allDocs.map(prepareDoc),
						};
					} catch (err: any) {
						console.warn(`[localSearch] Failed to load local search indexes for ${bucket}, trying Redis...`);
					}
				}

				if (!index) {
					const remoteUrl = getDeployedStaticIndexUrl(getRemoteSearchIndexFileName(bucket), baseUrl);
					if (remoteUrl) {
						try {
							const parsed = await readIndexPayloadFromUrl(remoteUrl);
							if (parsed) {
								index = {
									generatedAt: parsed.generatedAt ?? undefined,
									bucket: parsed.bucket ?? bucket,
									docs: Array.isArray(parsed.docs) ? parsed.docs.map(prepareDoc) : [],
								};
							}
						} catch (err: any) {
							console.warn(`[localSearch] Failed to fetch remote search index for ${bucket} from ${remoteUrl}, trying Redis...`);
						}
					}
				}

				if (!index) {
					// Fall back to Redis if local files are unavailable
					console.warn(`[localSearch] Local files not available for ${bucket}, trying Redis...`);
					const redisData = await fetchFromRedis(bucket);
					if (redisData) {
						index = {
							generatedAt: redisData?.generatedAt,
							bucket: redisData?.bucket,
							docs: Array.isArray(redisData?.docs) ? redisData.docs.map(prepareDoc) : [],
						};
					}
				}

				if (index) {
					// Load dynamic extensions from Redis and append them
					const extensions = await fetchExtensionsFromRedis(bucket);
					if (extensions.length > 0) {
						// Avoid duplicates: keep track of IDs in the static index
						const existingIds = new Set<string>();
						for (const doc of index.docs) {
							existingIds.add(doc.id);
						}

						for (const extDoc of extensions) {
							if (!existingIds.has(extDoc.id)) {
								index.docs.push(prepareDoc(extDoc));
								existingIds.add(extDoc.id);
							} else {
								// Upgrade/overwrite the existing doc in place with the latest dynamic data
								const pos = index.docs.findIndex((d) => d.id === extDoc.id);
								if (pos !== -1) {
									index.docs[pos] = prepareDoc(extDoc);
								}
							}
						}
					}
					return index;
				}

				console.error(`[localSearch] Failed to load index for bucket ${bucket}.`);
				return null;
			})(),
		);
	}
	return (await indexPromiseCache.get(cacheKey)) ?? null;
}

function getIdentifierText(doc: PreparedLocalSearchDoc) {
	const hit = doc.hit || {};
	return normalizeText(hit.ind_source_id || hit.ind_crd || hit.firm_id || hit.firmId || hit.firm_source_id || hit.bdSecNumber || hit.iaSecNumber || doc.id);
}

function containsWholePhrase(text: string, phrase: string) {
	if (!text || !phrase) return false;
	return ` ${text} `.includes(` ${phrase} `);
}

function isStrictMatchQuery(normalizedQuery: string) {
	return STRICT_MATCH_QUERY_ALLOWLIST.has(normalizedQuery);
}

function hasStrictTokenMatch(doc: PreparedLocalSearchDoc, tokens: string[]) {
	if (!tokens.length) return false;
	return tokens.every((token) => doc.nameTokens.some((candidateToken) => candidateToken === token));
}

function hasStrictMatch(doc: PreparedLocalSearchDoc, normalizedQuery: string, tokens: string[]) {
	const strictText = doc.primaryNameSearchText || doc.normalizedNameSearchText;
	const identifier = getIdentifierText(doc);
	if (!strictText) return false;
	if (identifier === normalizedQuery) return true;
	if (containsWholePhrase(strictText, normalizedQuery)) return true;
	return tokens.every((token) => containsWholePhrase(strictText, token));
}

function getBoundedEditDistance(left: string, right: string, maxDistance: number) {
	if (left === right) return 0;
	if (!left || !right) return maxDistance + 1;
	if (Math.abs(left.length - right.length) > maxDistance) return maxDistance + 1;

	let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let row = 1; row <= left.length; row += 1) {
		const current = [row];
		let rowMin = current[0];
		for (let col = 1; col <= right.length; col += 1) {
			const cost = left[row - 1] === right[col - 1] ? 0 : 1;
			const nextValue = Math.min(previous[col] + 1, current[col - 1] + 1, previous[col - 1] + cost);
			current[col] = nextValue;
			if (nextValue < rowMin) rowMin = nextValue;
		}
		if (rowMin > maxDistance) return maxDistance + 1;
		previous = current;
	}
	return previous[right.length];
}

function locationTokensMatch(queryToken: string, candidateToken: string) {
	if (!queryToken || !candidateToken) return false;
	if (queryToken === candidateToken) return true;
	if (queryToken.length < 5 || candidateToken.length < 5) return false;
	return getBoundedEditDistance(queryToken, candidateToken, 1) <= 1;
}

function tokensFuzzyMatch(queryToken: string, candidateToken: string) {
	if (!queryToken || !candidateToken) return false;
	if (queryToken === candidateToken) return true;

	const nicknames = NICKNAME_MAP.get(queryToken);
	if (nicknames && nicknames.includes(candidateToken)) return true;

	// Candidate token contains the query token (e.g. 'hooten' contains 'hoot')
	if (candidateToken.includes(queryToken) && queryToken.length >= 3) return true;

	const minLength = Math.min(queryToken.length, candidateToken.length);
	if (minLength < 4) return false;
	const maxDistance = Math.max(1, Math.floor(queryToken.length * 0.3));
	return getBoundedEditDistance(queryToken, candidateToken, maxDistance) <= maxDistance;
}

function tokensOrderMatch(queryTokens: string[], candidateTokens: string[]) {
	if (!queryTokens || queryTokens.length < 2) return false;
	const firstQt = queryTokens[0];
	const lastQt = queryTokens[queryTokens.length - 1];
	const firstMatches: number[] = [];
	const lastMatches: number[] = [];
	for (let i = 0; i < candidateTokens.length; i++) {
		const ct = candidateTokens[i];
		if (tokensFuzzyMatch(firstQt, ct)) firstMatches.push(i);
		if (tokensFuzzyMatch(lastQt, ct)) lastMatches.push(i);
	}
	for (const i of firstMatches) {
		for (const j of lastMatches) {
			if (i < j && j - i <= 4) return true;
			if (j < i && i - j <= 2) return true;
		}
	}
	return false;
}

function isStrictSurnameQuery(rawQuery: string, normalizedQuery: string) {
	const compactQuery = compactNormalizeText(normalizedQuery);
	const raw = String(rawQuery || '')
		.trim()
		.toLowerCase();
	if (compactQuery.length < 4 || /\s/.test(compactQuery)) return false;
	return compactQuery.startsWith('mc') || raw.startsWith("o'");
}

function getSurnameMatchScore(doc: PreparedLocalSearchDoc, rawQuery: string, normalizedQuery: string) {
	if (doc.type !== 'individual') return 0;
	const compactQuery = compactNormalizeText(normalizedQuery);
	if (!compactQuery) return 0;
	const strictSurnameQuery = isStrictSurnameQuery(rawQuery, normalizedQuery);
	const strictQuery = isStrictMatchQuery(normalizedQuery);
	let bestScore = 0;
	for (const candidate of doc.surnameCompactCandidates) {
		if (candidate === compactQuery) {
			bestScore = Math.max(
				bestScore,
				strictSurnameQuery ? 420
				: strictQuery ? 320
				: 240,
			);
			continue;
		}
		if (strictQuery) continue;
		if (compactQuery.length >= 3 && candidate.startsWith(compactQuery)) bestScore = Math.max(bestScore, strictSurnameQuery ? 320 : 170);
		else if (candidate.includes(compactQuery) && compactQuery.length >= 4) bestScore = Math.max(bestScore, strictSurnameQuery ? 200 : 140);
		else if (!strictSurnameQuery && compactQuery.length >= 4 && tokensFuzzyMatch(compactQuery, candidate)) bestScore = Math.max(bestScore, 120);
	}
	return bestScore;
}

function isStrictMcOrOQuery(rawQuery: string, normalizedQuery: string) {
	const raw = String(rawQuery || '')
		.trim()
		.toLowerCase();
	if (!normalizedQuery) return false;
	return normalizedQuery.startsWith('mc') || raw.startsWith("o'") || raw.startsWith('o’');
}

function getStrictNamePatternScore(candidate: string, normalizedQuery: string) {
	const compactCandidate = compactNormalizeText(candidate);
	const compactQuery = compactNormalizeText(normalizedQuery);
	if (!compactCandidate || !compactQuery) return 0;

	const candidateTrimmedS = compactCandidate.endsWith('s') ? compactCandidate.slice(0, -1) : compactCandidate;
	const queryTrimmedS = compactQuery.endsWith('s') ? compactQuery.slice(0, -1) : compactQuery;

	if (compactCandidate === compactQuery) return 260;
	if (candidateTrimmedS === compactQuery || compactCandidate === queryTrimmedS) return 245;
	if (compactCandidate.startsWith(compactQuery) || compactQuery.startsWith(compactCandidate)) return 220;
	if (candidateTrimmedS.startsWith(queryTrimmedS) || queryTrimmedS.startsWith(candidateTrimmedS)) return 210;
	if (compactCandidate.includes(compactQuery) || compactQuery.includes(compactCandidate)) return 180;
	return 0;
}

function getNameMatchScore(doc: PreparedLocalSearchDoc, rawQuery: string, normalizedQuery: string, tokens: string[]) {
	if (isStrictMcOrOQuery(rawQuery, normalizedQuery)) {
		let bestScore = 0;
		for (const candidate of doc.nameCandidates) {
			const score = getStrictNamePatternScore(candidate, normalizedQuery);
			if (score > bestScore) bestScore = score;
		}
		return Math.max(bestScore, getSurnameMatchScore(doc, rawQuery, normalizedQuery));
	}
	if (isStrictSurnameQuery(rawQuery, normalizedQuery)) {
		return getSurnameMatchScore(doc, rawQuery, normalizedQuery);
	}
	const strictQuery = isStrictMatchQuery(normalizedQuery);
	if (strictQuery) {
		let bestScore = 0;
		for (const candidate of doc.nameCandidates) {
			const isPrimaryCandidate = doc.primaryNameCandidates.includes(candidate);
			if (candidate === normalizedQuery) bestScore = Math.max(bestScore, isPrimaryCandidate ? 280 : 240);
			else if (containsWholePhrase(candidate, normalizedQuery)) bestScore = Math.max(bestScore, isPrimaryCandidate ? 220 : 190);
			else {
				const candidateTokens = tokenizeQuery(candidate);
				const matchedTokenCount = tokens.filter((token) => candidateTokens.some((candidateToken) => candidateToken === token)).length;
				if (matchedTokenCount === tokens.length && tokens.length > 0) {
					bestScore = Math.max(bestScore, (isPrimaryCandidate ? 200 : 170) + matchedTokenCount * 20);
				}
			}
		}
		return Math.max(bestScore, getSurnameMatchScore(doc, rawQuery, normalizedQuery));
	}
	let bestScore = 0;
	for (const candidate of doc.nameCandidates) {
		const isPrimaryCandidate = doc.primaryNameCandidates.includes(candidate);
		if (candidate === normalizedQuery) bestScore = Math.max(bestScore, isPrimaryCandidate ? 260 : 220);
		else if (containsWholePhrase(candidate, normalizedQuery)) bestScore = Math.max(bestScore, isPrimaryCandidate ? 180 : 150);
		else if (candidate.includes(normalizedQuery) && normalizedQuery.length >= 3) bestScore = Math.max(bestScore, isPrimaryCandidate ? 130 : 110);

		const candidateTokens = tokenizeQuery(candidate);
		const matchedTokenCount = tokens.filter((token) =>
			candidateTokens.some((candidateToken) => {
				if (strictQuery && token === normalizedQuery) {
					return candidateToken === token || candidateToken.includes(token) || token.includes(candidateToken);
				}
				return tokensFuzzyMatch(token, candidateToken);
			}),
		).length;
		if (matchedTokenCount === tokens.length && tokens.length > 0) {
			bestScore = Math.max(bestScore, (isPrimaryCandidate ? 150 : 130) + matchedTokenCount * 20);
		}
	}
	return Math.max(bestScore, getSurnameMatchScore(doc, rawQuery, normalizedQuery));
}

function getAddressFieldMatchScore(text: string, normalizedQuery: string, tokens: string[]) {
	if (!text) return 0;
	if (containsWholePhrase(text, normalizedQuery)) return 180;
	const fieldTokens = tokenizeQuery(text);
	if (tokens.length > 0 && tokens.every((token) => fieldTokens.some((fieldToken) => locationTokensMatch(token, fieldToken)))) {
		return 140 + tokens.length * 10;
	}
	return 0;
}

function hasEmploymentFirmIdMatch(doc: PreparedLocalSearchDoc, normalizedQuery: string): boolean {
	if (doc.type !== 'individual' || !doc.hit) return false;
	const emps = [
		...(doc.hit.ind_current_employments || []),
		...(doc.hit.ind_ia_current_employments || []),
		...(doc.hit.ind_previous_employments || []),
		...(doc.hit.ind_ia_previous_employments || []),
	];
	for (const e of emps) {
		const fid = String(e?.firmId || e?.firm_id || '').trim();
		if (fid && fid === normalizedQuery) return true;
	}
	return false;
}

function getAddressMatchScore(doc: PreparedLocalSearchDoc, normalizedQuery: string, tokens: string[]) {
	if (doc.type === 'firm') return 0;
	return getAddressFieldMatchScore(doc.addressSearchText, normalizedQuery, tokens);
}

function getStrictDocumentMatchScore(doc: PreparedLocalSearchDoc, normalizedQuery: string, tokens: string[]) {
	const strictText = doc.normalizedStrictSearchText;
	if (!strictText) return 0;

	if (containsWholePhrase(strictText, normalizedQuery)) return 220;
	if (strictText.includes(normalizedQuery)) return 180;

	if (tokens.length > 0) {
		const matchedTokenCount = tokens.filter((token) => containsWholePhrase(strictText, token) || strictText.includes(token)).length;
		if (matchedTokenCount === tokens.length) return 140 + matchedTokenCount * 10;
		if (matchedTokenCount > 0) return 60 + matchedTokenCount * 8;
	}

	return 0;
}

function getSortScore(doc: PreparedLocalSearchDoc, rawQuery: string, normalizedQuery: string, tokens: string[]) {
	const identifier = getIdentifierText(doc);
	const nameText = doc.normalizedNameSearchText;
	let score = 0;
	if (identifier === normalizedQuery) score += 300;
	if (doc.id.toLowerCase().endsWith(`:${normalizedQuery}`)) score += 250;
	if (hasEmploymentFirmIdMatch(doc, normalizedQuery)) score += 150;
	if (containsWholePhrase(nameText, normalizedQuery)) score += 100;
	if (tokens.every((token) => token === normalizedQuery || identifier.includes(token))) score += 40;
	for (const token of tokens) {
		if (identifier === token) score += 120;
	}
	score += getNameMatchScore(doc, rawQuery, normalizedQuery, tokens);
	score += getAddressMatchScore(doc, normalizedQuery, tokens);
	score += getStrictDocumentMatchScore(doc, normalizedQuery, tokens);
	return score;
}

function matchesQuery(doc: PreparedLocalSearchDoc, rawQuery: string, normalizedQuery: string, tokens: string[]) {
	if (!tokens.length) return false;
	const identifier = getIdentifierText(doc);
	if (!identifier) return false;
	if (identifier === normalizedQuery || doc.id.toLowerCase().endsWith(`:${normalizedQuery}`) || containsWholePhrase(identifier, normalizedQuery)) return true;
	if (hasEmploymentFirmIdMatch(doc, normalizedQuery)) return true;
	if (getAddressMatchScore(doc, normalizedQuery, tokens) > 0) return true;
	if (getStrictDocumentMatchScore(doc, normalizedQuery, tokens) > 0) return true;
	const strictQuery = isStrictMatchQuery(normalizedQuery);
	if (strictQuery) {
		return hasStrictMatch(doc, normalizedQuery, tokens) || hasStrictTokenMatch(doc, tokens);
	}
	if (isStrictSurnameQuery(rawQuery, normalizedQuery)) {
		return getSurnameMatchScore(doc, rawQuery, normalizedQuery) > 0;
	}
	if (getNameMatchScore(doc, rawQuery, normalizedQuery, tokens) > 0) return true;
	if (hasStrictMatch(doc, normalizedQuery, tokens)) return true;
	if (tokens.every((token) => doc.nameTokens.some((candidateToken) => tokensFuzzyMatch(token, candidateToken)))) return true;
	// Allow ordered first+last (or last+first) fuzzy match with a small gap to
	// accommodate middle names or initials (e.g., "John Doe" → "John A. Doe").
	if (tokensOrderMatch(tokens, doc.nameTokens)) return true;
	return false;
}

function buildQueryMatches(docs: PreparedLocalSearchDoc[], rawQuery: string, normalizedQuery: string, tokens: string[], limit: number) {
	if (!normalizedQuery || !tokens.length) return [];
	const matches = docs
		.filter((doc) => matchesQuery(doc, rawQuery, normalizedQuery, tokens))
		.sort((left, right) => {
			const scoreDiff = getSortScore(right, rawQuery, normalizedQuery, tokens) - getSortScore(left, rawQuery, normalizedQuery, tokens);
			if (scoreDiff !== 0) return scoreDiff;
			return left.id.localeCompare(right.id);
		});
	return limit > 0 ? matches.slice(0, limit) : matches;
}

export async function searchLocalIndex(source: LocalSearchSource, type: LocalSearchEntity, query: string, options: LocalSearchOptions = {}): Promise<LocalSearchResponse> {
	const bucket = `${source}:${type}` as LocalSearchBucket;
	const limit = Math.max(0, Math.min(options.limit ?? 12, 1000));
	const offset = Math.max(0, options.offset ?? 0);
	const normalizedQuery = simplifyName(query);
	const tokens = tokenizeQuery(query);
	const index = await loadIndex(bucket, options.baseUrl, options.seedRoots || []);

	// If index failed to load, return null result to trigger fallback search
	if (!index) {
		return {
			bucket,
			generatedAt: null,
			total: 0,
			hits: { total: 0, start: offset, hits: [] },
			response: { numFound: 0, start: offset, docs: [] },
			results: [],
			currentPage: [],
			pageNumber: Math.floor(offset / Math.max(limit, 1)) + 1,
			pageSize: limit,
		};
	}

	const docs = Array.isArray(index?.docs) ? index.docs : [];
	const hasMinimumQuery = hasMinimumSearchQuery(query);
	const matches = !normalizedQuery || !hasMinimumQuery ? [] : buildQueryMatches(docs, query, normalizedQuery, tokens, 0);
	const pageDocs = limit > 0 ? matches.slice(offset, offset + limit) : [];
	const resultDocs = pageDocs.map((doc) => doc.hit || {});
	return {
		bucket,
		generatedAt: index?.generatedAt ?? null,
		total: matches.length,
		hits: {
			total: matches.length,
			start: offset,
			hits: pageDocs.map((doc) => ({ _id: doc.id, _source: doc.hit || {} })),
		},
		response: {
			numFound: matches.length,
			start: offset,
			docs: resultDocs,
		},
		results: resultDocs,
		currentPage: resultDocs,
		pageNumber: limit > 0 ? Math.floor(offset / limit) + 1 : 1,
		pageSize: limit,
	};
}

export async function searchQueriesSequentially<T>(queries: string[], runner: (query: string) => Promise<T | null>, predicate: (value: T | null) => boolean): Promise<T[]> {
	const matches: T[] = [];
	for (const query of queries) {
		const value = await runner(query);
		if (predicate(value)) {
			matches.push(value as T);
		}
	}
	return matches;
}

export function mergeLocalSearchResponses(
	responses: LocalSearchResponse[],
	options: { bucket?: string; generatedAt?: string | null; limit?: number; offset?: number } = {},
): LocalSearchResponse {
	const bucket = options.bucket ?? responses[0]?.bucket ?? 'finra:individual';
	const limit = Math.max(0, Math.min(options.limit ?? 12, 1000));
	const offset = Math.max(0, options.offset ?? 0);
	const mergedDocs: any[] = [];
	const seenIds = new Set<string>();
	for (const response of responses) {
		for (const doc of response.results || []) {
			const docId = String(doc?.id || doc?.ind_source_id || doc?.firm_source_id || '').trim();
			if (!docId || seenIds.has(docId)) continue;
			seenIds.add(docId);
			mergedDocs.push(doc);
		}
	}
	const pageDocs = limit > 0 ? mergedDocs.slice(offset, offset + limit) : [];
	return {
		bucket: bucket as LocalSearchBucket,
		generatedAt: options.generatedAt ?? responses.find((response) => response.generatedAt)?.generatedAt ?? null,
		total: mergedDocs.length,
		hits: {
			total: mergedDocs.length,
			start: offset,
			hits: pageDocs.map((doc) => ({ _id: String(doc?.id || doc?.ind_source_id || doc?.firm_source_id || ''), _source: doc })),
		},
		response: {
			numFound: mergedDocs.length,
			start: offset,
			docs: pageDocs,
		},
		results: pageDocs,
		currentPage: pageDocs,
		pageNumber: limit > 0 ? Math.floor(offset / limit) + 1 : 1,
		pageSize: limit,
	};
}

export async function searchLocalIndexMany(source: LocalSearchSource, type: LocalSearchEntity, query: string, options: LocalSearchOptions = {}): Promise<LocalSearchResponse> {
	const bucket = `${source}:${type}` as LocalSearchBucket;
	const limit = Math.max(0, Math.min(options.limit ?? 12, 1000));
	const offset = Math.max(0, options.offset ?? 0);
	const searchQueries = extractSearchQueries(query).filter(Boolean);
	if (!searchQueries.length) {
		return searchLocalIndex(source, type, query, options);
	}

	const index = await loadIndex(bucket, options.baseUrl, options.seedRoots || []);
	if (!index) {
		return {
			bucket,
			generatedAt: null,
			total: 0,
			hits: { total: 0, start: offset, hits: [] },
			response: { numFound: 0, start: offset, docs: [] },
			results: [],
			currentPage: [],
			pageNumber: Math.floor(offset / Math.max(limit, 1)) + 1,
			pageSize: limit,
		};
	}

	const docs = Array.isArray(index?.docs) ? index.docs : [];
	const mergedDocs: any[] = [];
	const seenIds = new Set<string>();
	for (const searchQuery of searchQueries) {
		const normalizedQuery = simplifyName(searchQuery);
		const tokens = tokenizeQuery(searchQuery);
		if (!normalizedQuery || !tokens.length || !hasMinimumSearchQuery(searchQuery)) continue;
		const matches = buildQueryMatches(docs, searchQuery, normalizedQuery, tokens, limit > 0 ? limit : 0);
		if (!matches.length) continue;
		for (const match of matches) {
			const docId = String(match?.hit?.id || match?.id || match?.hit?.ind_source_id || match?.hit?.firm_source_id || '').trim();
			if (!docId || seenIds.has(docId)) continue;
			seenIds.add(docId);
			mergedDocs.push(match.hit || {});
		}
	}

	const pageDocs = limit > 0 ? mergedDocs.slice(offset, offset + limit) : [];
	return {
		bucket,
		generatedAt: index?.generatedAt ?? null,
		total: mergedDocs.length,
		hits: {
			total: mergedDocs.length,
			start: offset,
			hits: pageDocs.map((doc) => ({ _id: String(doc?.id || doc?.ind_source_id || doc?.firm_source_id || ''), _source: doc })),
		},
		response: {
			numFound: mergedDocs.length,
			start: offset,
			docs: pageDocs,
		},
		results: pageDocs,
		currentPage: pageDocs,
		pageNumber: limit > 0 ? Math.floor(offset / limit) + 1 : 1,
		pageSize: limit,
	};
}

async function fetchExtensionsFromRedis(bucket: LocalSearchBucket): Promise<LocalSearchDoc[]> {
	const redis = getUpstashClient();
	if (!redis) return [];
	try {
		const key = `search:indexes:extensions:${bucket}`;
		const docs: LocalSearchDoc[] = [];

		const keys = await redis.hkeys(key);
		if (!keys || !keys.length) return [];

		// Chunk keys to avoid Upstash 10MB response limits (hscan ignores count sometimes)
		const chunkSize = 500;
		for (let i = 0; i < keys.length; i += chunkSize) {
			const chunk = keys.slice(i, i + chunkSize);
			const vals = await redis.hmget<Record<string, unknown>>(key, ...chunk);

			if (vals && typeof vals === 'object') {
				// hmget returns an object mapping key to value
				for (const raw of Object.values(vals)) {
					if (!raw) continue;
					if (typeof raw === 'object') {
						docs.push(raw as LocalSearchDoc);
					} else if (typeof raw === 'string') {
						try {
							const doc = JSON.parse(raw);
							if (doc && typeof doc === 'object') {
								docs.push(doc);
							}
						} catch {
							// ignore
						}
					}
				}
			}
		}

		return docs;
	} catch (err) {
		console.error(`[localSearch] Failed to fetch extensions from Redis for ${bucket}:`, err);
		return [];
	}
}

export function clearSearchIndexCache() {
	indexPromiseCache.clear();
}

function toText(value: any): string {
	return String(value ?? '')
		.replace(/\s+/g, ' ')
		.trim();
}

function uniqueTexts(values: any[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const value of values) {
		const text = toText(value);
		if (!text) continue;
		const key = text.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(text);
	}
	return out;
}

function collectScalarTexts(value: any, out: any[] = [], seen = new WeakSet()): any[] {
	if (value == null) return out;
	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
		out.push(value);
		return out;
	}
	if (Array.isArray(value)) {
		for (const entry of value) collectScalarTexts(entry, out, seen);
		return out;
	}
	if (typeof value === 'object') {
		if (seen.has(value)) return out;
		seen.add(value);
		for (const entry of Object.values(value)) collectScalarTexts(entry, out, seen);
	}
	return out;
}

function normalizeBranchLocation(location: any) {
	if (!location || typeof location !== 'object') return null;
	const normalized = {
		city: toText(location.city) || null,
		state: toText(location.state) || null,
		street1: toText(location.street1) || null,
		street2: toText(location.street2) || null,
		zipCode: toText(location.zipCode) || null,
	};
	return Object.values(normalized).some(Boolean) ? normalized : null;
}

function normalizeEmployment(employment: any) {
	if (!employment || typeof employment !== 'object') return null;
	const firmId = toText(employment.firmId ?? employment.firm_id ?? employment.firmIdNumber);
	const firmName = toText(employment.firmName ?? employment.firm_name);
	const branchOfficeLocations = (Array.isArray(employment.branchOfficeLocations) ? employment.branchOfficeLocations : []).map(normalizeBranchLocation).filter(Boolean);
	const branchLocation = branchOfficeLocations[0] || null;
	return {
		firmId: firmId ? Number(firmId) || firmId : null,
		firm_id: firmId ? Number(firmId) || firmId : null,
		firmName: firmName || null,
		firm_name: firmName || null,
		iaOnly: employment.iaOnly ?? null,
		registrationBeginDate: employment.registrationBeginDate ?? null,
		registrationEndDate: employment.registrationEndDate ?? null,
		employmentStatus: employment.employmentStatus ?? null,
		firmBCScope: employment.firmBCScope ?? employment.firm_bc_scope ?? null,
		firmIAScope: employment.firmIAScope ?? employment.firm_ia_scope ?? null,
		bdSECNumber: toText(employment.bdSECNumber ?? employment.bdSecNumber ?? employment.firm_bd_sec_number) || null,
		iaSECNumber: toText(employment.iaSECNumber ?? employment.iaSecNumber ?? employment.firm_ia_sec_number) || null,
		city: toText(employment.city ?? branchLocation?.city) || null,
		state: toText(employment.state ?? branchLocation?.state) || null,
		zipCode: toText(employment.zipCode ?? branchLocation?.zipCode) || null,
		expelledDate: employment.expelledDate ?? null,
		branchOfficeLocations,
	};
}

function getRegistrationCount(detail: any) {
	const registrations = detail?.registrations && typeof detail.registrations === 'object' ? detail.registrations : {};
	return {
		approvedFinraRegistrationCount: registrations.approvedFinraRegistrationCount ?? detail.registrationCount?.approvedFinraRegistrationCount ?? 0,
		approvedSRORegistrationCount: registrations.approvedSRORegistrationCount ?? detail.registrationCount?.approvedSRORegistrationCount ?? 0,
		approvedStateRegistrationCount: registrations.approvedStateRegistrationCount ?? detail.registrationCount?.approvedStateRegistrationCount ?? 0,
		approvedIAStateRegistrationCount: registrations.approvedIAStateRegistrationCount ?? detail.registrationCount?.approvedIAStateRegistrationCount ?? 0,
	};
}

export function buildIndividualDoc(source: string, detail: any): LocalSearchDoc | null {
	const basicInformation = detail?.basicInformation && typeof detail.basicInformation === 'object' ? detail.basicInformation : {};
	const individualId = toText(basicInformation.individualId ?? detail.individualId);
	if (!individualId) return null;

	const otherNames = uniqueTexts(basicInformation.otherNames || []);
	const currentEmployments = (Array.isArray(detail.currentEmployments) ? detail.currentEmployments : []).map(normalizeEmployment).filter(Boolean);
	const currentIAEmployments = (Array.isArray(detail.currentIAEmployments) ? detail.currentIAEmployments : []).map(normalizeEmployment).filter(Boolean);
	const previousEmployments = (Array.isArray(detail.previousEmployments) ? detail.previousEmployments : []).map(normalizeEmployment).filter(Boolean);
	const previousIAEmployments = (Array.isArray(detail.previousIAEmployments) ? detail.previousIAEmployments : []).map(normalizeEmployment).filter(Boolean);
	const firmIds = uniqueTexts([
		...currentEmployments.map((e: any) => e.firmId),
		...currentIAEmployments.map((e: any) => e.firmId),
		...previousEmployments.map((e: any) => e.firmId),
		...previousIAEmployments.map((e: any) => e.firmId),
	]);
	const registrationCount = getRegistrationCount(detail);

	const currentAddressTexts = uniqueTexts([
		...currentEmployments.flatMap((e: any) => [e.city, e.state, ...e.branchOfficeLocations.flatMap((l: any) => [l.street1, l.street2, l.city, l.state])]),
		...currentIAEmployments.flatMap((e: any) => [e.city, e.state, ...e.branchOfficeLocations.flatMap((l: any) => [l.street1, l.street2, l.city, l.state])]),
	]);

	const nameTexts = uniqueTexts([basicInformation.firstName, basicInformation.middleName, basicInformation.lastName, ...otherNames]);
	const hit = {
		ind_source_id: individualId,
		ind_crd: individualId,
		ind_firstname: toText(basicInformation.firstName),
		ind_middlename: toText(basicInformation.middleName),
		ind_lastname: toText(basicInformation.lastName),
		ind_other_names: otherNames,
		otherNames,
		ind_bc_scope: toText(basicInformation.bcScope),
		ind_ia_scope: toText(basicInformation.iaScope),
		ind_approved_finra_registration_count: registrationCount.approvedFinraRegistrationCount,
		ind_approved_sro_registration_count: registrationCount.approvedSRORegistrationCount,
		ind_approved_state_registration_count: registrationCount.approvedStateRegistrationCount,
		ind_approved_ia_state_registration_count: registrationCount.approvedIAStateRegistrationCount,
		ind_current_employments: currentEmployments,
		ind_ia_current_employments: currentIAEmployments,
		ind_previous_employments: previousEmployments,
		ind_ia_previous_employments: previousIAEmployments,
		disclosureFlag: detail.bdDisclosureFlag ?? detail.disclosureFlag ?? null,
		iaDisclosureFlag: detail.iaDisclosureFlag ?? null,
	};

	return {
		id: `${source}:individual:${individualId}`,
		type: 'individual',
		source: source as LocalSearchSource,
		nameSearchText: nameTexts.join(' ').toLowerCase(),
		addressSearchText: currentAddressTexts.join(' ').toLowerCase(),
		strictSearchText: uniqueTexts(collectScalarTexts(detail)).join(' ').toLowerCase(),
		searchText: uniqueTexts([individualId, ...nameTexts, ...firmIds])
			.join(' ')
			.toLowerCase(),
		hit,
	};
}

export function buildFirmDoc(source: string, detail: any): LocalSearchDoc | null {
	const basicInformation = detail?.basicInformation && typeof detail.basicInformation === 'object' ? detail.basicInformation : {};
	const firmId = toText(basicInformation.firmId ?? detail.firmId);
	if (!firmId) return null;

	const firmName = toText(basicInformation.firmName || detail.firmName || detail.name);
	const otherNames = uniqueTexts(basicInformation.otherNames || []);

	const addressDetails = detail.firmAddressDetails || {};
	const office = addressDetails.officeAddress || {};
	const mailing = addressDetails.mailingAddress || {};
	const currentAddressTexts = uniqueTexts([office.city, office.state, office.street1, office.street2, mailing.city, mailing.state, mailing.street1, mailing.street2]);

	const nameTexts = uniqueTexts([firmName, ...otherNames]);
	const hit = {
		firm_id: firmId,
		firmId,
		firm_source_id: firmId,
		firm_name: firmName,
		firmName,
		firm_other_names: otherNames,
		otherNames,
		firm_bc_scope: toText(basicInformation.bcScope),
		bdSecNumber: toText(basicInformation.bdSECNumber || detail.bdSecNumber) || null,
		iaSecNumber: toText(basicInformation.iaSECNumber || detail.iaSecNumber) || null,
		disclosureFlag: detail.bdDisclosureFlag ?? detail.disclosureFlag ?? null,
		iaDisclosureFlag: detail.iaDisclosureFlag ?? null,
	};

	return {
		id: `${source}:firm:${firmId}`,
		type: 'firm',
		source: source as LocalSearchSource,
		nameSearchText: nameTexts.join(' ').toLowerCase(),
		addressSearchText: currentAddressTexts.join(' ').toLowerCase(),
		strictSearchText: uniqueTexts(collectScalarTexts(detail)).join(' ').toLowerCase(),
		searchText: uniqueTexts([firmId, ...nameTexts])
			.join(' ')
			.toLowerCase(),
		hit,
	};
}

export async function addRecordToSearchIndex(source: LocalSearchSource, type: LocalSearchEntity, crd: string, detail: any) {
	const bucket: LocalSearchBucket = `${source}:${type}`;
	const doc = type === 'individual' ? buildIndividualDoc(source, detail) : buildFirmDoc(source, detail);
	if (!doc) return false;

	const redis = getUpstashClient();
	if (!redis) return false;

	try {
		const key = `search:indexes:extensions:${bucket}`;
		await redis.hset(key, { [crd]: JSON.stringify(doc) });
		// Clear local memory cache so subsequent searches reload the index with the new extension
		indexPromiseCache.clear();

		// Also write to local filesystem if we are running locally and files exist
		try {
			const relativeFilePath = SEARCH_INDEX_RELATIVE_FILES[bucket];
			const getCwd = () => (typeof window === 'undefined' && typeof process !== 'undefined' ? (process.env.PWD || '') : '');
			const absolutePath = path.resolve(/*turbopackIgnore: true*/ getCwd(), relativeFilePath);
			const fsMod = typeof window === 'undefined' ? eval("require('fs')") : null;
			if (fsMod && fsMod.existsSync(absolutePath)) {
				const { readFile } = await import('node:fs/promises');
				const raw = await readFile(absolutePath, 'utf8');
				const parsed = JSON.parse(raw);
				if (parsed && Array.isArray(parsed.docs)) {
					const existingPos = parsed.docs.findIndex((d: any) => d.id === doc.id);
					if (existingPos !== -1) {
						parsed.docs[existingPos] = doc;
					} else {
						parsed.docs.push(doc);
					}
					parsed.generatedAt = new Date().toISOString();
					const { writeFile } = await import('node:fs/promises');
					await writeFile(absolutePath, JSON.stringify(parsed, null, 2), 'utf8');

					// Also update gzip sidecar if it exists
					const gzPath = `${absolutePath}.gz`;
					if (fsMod && fsMod.existsSync(gzPath)) {
						const util = await import('node:util');
						const gzBuffer = await util.promisify(zlib.gzip)(Buffer.from(JSON.stringify(parsed, null, 2), 'utf8'), { level: 9 });
						await writeFile(gzPath, gzBuffer);
					}
				}
			}
		} catch (fileErr: any) {
			console.warn(`[localSearch] Skipping filesystem update: ${fileErr?.message || fileErr}`);
		}

		return true;
	} catch (err) {
		console.error(`[localSearch] Failed to save dynamic search extension to Redis for ${bucket}:${crd}`, err);
		return false;
	}
}

function normalizeExtractedCrd(value: string): string {
	const cleaned = String(value || '').trim();
	return /^\d{1,10}$/.test(cleaned) ? cleaned : '';
}

function collectLineCandidates(line: string): string[] {
	const cleaned = line.trim();
	if (!cleaned) return [];

	const candidates: string[] = [];
	const explicitPatterns = [/\bcrd\s*#?\s*(\d{1,10})\b/gi, /::\s*(?:crd\s*#?)?\s*(\d{1,10})\b/gi];
	for (const pattern of explicitPatterns) {
		for (const match of cleaned.matchAll(pattern)) {
			const normalized = normalizeExtractedCrd(match[1] || '');
			if (normalized) candidates.push(normalized);
		}
	}

	if (candidates.length > 0) return candidates;
	if (/^\d{1,10}$/.test(cleaned)) return [cleaned];
	return [];
}

export function extractSearchQueries(query: string): string[] {
	const trimmed = query.trim();
	if (!trimmed) return [];

	// If the query is a whitespace-separated list of numeric CRDs, treat them as separate fetches
	const tokens = trimmed.split(/\s+/);
	if (tokens.length > 0 && tokens.every((t) => /^\d{1,10}$/.test(t))) {
		return tokens;
	}

	const candidates: string[] = [];
	const lines = trimmed
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);

	for (const line of lines) {
		for (const candidate of collectLineCandidates(line)) {
			if (!candidates.includes(candidate)) candidates.push(candidate);
		}
	}

	if (candidates.length > 0) return candidates;
	return trimmed.length > 0 ? [trimmed] : [];
}

export function cleanSearchQuery(query: string): string {
	const queries = extractSearchQueries(query);
	return queries[0] || query.trim();
}
