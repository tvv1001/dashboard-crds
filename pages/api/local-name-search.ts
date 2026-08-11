import type { NextApiRequest, NextApiResponse } from 'next';
import { formatErrorMessage, getRedisConnectionMode, isSecIndividualBrokerOnlyStub, listSavedKeysWithStats, loadSavedPayload, normalizeRawPayload } from './_lib';

type EntityType = 'firm' | 'individual';

type LocalSearchEntry = {
	type: EntityType;
	crd: string;
	name: string;
	aliases: string[];
	finra: boolean;
	sec: boolean;
	secNumber: string;
	currentAddress: string;
	searchableNames: string[];
	searchableValues: string[];
	searchableNameTokens: string[];
	searchText: string;
	currentFirm: string;
	currentCity: string;
	currentState: string;
};

type LocalSearchGroup = {
	type: EntityType;
	crd: string;
	files: string[];
	finra: boolean;
	sec: boolean;
};

const defaultLimit = 250;
const maxLimit = 1000;

let cachedSignature = '';
let cachedIndex: LocalSearchEntry[] | null = null;
let cachedIndexPromise: Promise<LocalSearchEntry[]> | null = null;

function getSearchSourceMode() {
	const mode = getRedisConnectionMode();
	return mode === 'upstash-rest' || mode === 'redis-url' ? 'redis' : 'local';
}

function normalizeWhitespace(value: string) {
	return String(value || '')
		.replace(/\s+/g, ' ')
		.trim();
}

function normalizeForSearch(value: string) {
	return normalizeWhitespace(String(value || ''))
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

function tokenizeSearchValue(value: string) {
	return normalizeForSearch(value)
		.split(' ')
		.map((token) => token.trim())
		.filter((token) => token.length >= 2);
}

function addCandidate(target: string[], seen: Set<string>, value: unknown) {
	if (typeof value !== 'string') return;
	const normalized = normalizeWhitespace(value);
	if (normalized.length < 2) return;
	if (seen.has(normalized)) return;
	seen.add(normalized);
	target.push(normalized);
}

function getObject(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function buildIndividualName(basicInformation: Record<string, unknown> | null) {
	if (!basicInformation) return '';
	const parts = [basicInformation.firstName, basicInformation.middleName, basicInformation.lastName, basicInformation.suffix]
		.filter((part): part is string => typeof part === 'string' && normalizeWhitespace(part).length > 0)
		.map((part) => normalizeWhitespace(part));
	return parts.join(' ');
}

function getString(value: unknown) {
	return typeof value === 'string' ? normalizeWhitespace(value) : '';
}

function getAddressString(value: Record<string, unknown> | null) {
	if (!value) return '';
	const street1 = getString(value.street1);
	const street2 = getString(value.street2);
	const city = getString(value.city);
	const state = getString(value.state);
	const zipCode = getString(value.zipCode || value.zip);
	const country = getString(value.country);
	const segments = [[street1, street2].filter(Boolean).join(', '), [city, state, zipCode].filter(Boolean).join(' '), country].filter(Boolean);
	if (segments.length < 2 && !street1) return '';
	return segments.join(', ');
}

function collectAddressStrings(node: unknown, results: string[], seen = new Set<unknown>()) {
	if (!node || typeof node !== 'object' || seen.has(node)) return;
	seen.add(node);

	if (Array.isArray(node)) {
		for (const item of node) collectAddressStrings(item, results, seen);
		return;
	}

	const objectNode = node as Record<string, unknown>;
	const address = getAddressString(objectNode);
	if (address) results.push(address);

	for (const value of Object.values(objectNode)) collectAddressStrings(value, results, seen);
}

function collectSecNumbers(payload: Record<string, unknown> | null) {
	const basicInformation = getObject(payload?.basicInformation);
	const candidates = [basicInformation?.bdSECNumber, basicInformation?.iaSECNumber];
	for (const employmentKey of ['currentEmployments', 'currentIAEmployments', 'previousEmployments', 'previousIAEmployments'] as const) {
		const employments = Array.isArray(payload?.[employmentKey]) ? (payload?.[employmentKey] as unknown[]) : [];
		for (const employment of employments) {
			const entry = getObject(employment);
			candidates.push(entry?.bdSECNumber, entry?.iaSECNumber, entry?.secNumber);
		}
	}
	return Array.from(new Set(candidates.map((value) => getString(value)).filter(Boolean)));
}

function extractNamesFromPayload(payload: unknown, type: EntityType) {
	const normalizedPayload = normalizeRawPayload(payload);
	const root = getObject(normalizedPayload);
	const basicInformation = getObject(root?.basicInformation);
	const orderedNames: string[] = [];
	const seenNames = new Set<string>();

	if (type === 'individual') {
		addCandidate(orderedNames, seenNames, buildIndividualName(basicInformation));
		addCandidate(orderedNames, seenNames, basicInformation?.individualName);
		addCandidate(orderedNames, seenNames, basicInformation?.fullName);
		addCandidate(orderedNames, seenNames, basicInformation?.displayName);
		addCandidate(orderedNames, seenNames, root?.individualName);
		addCandidate(orderedNames, seenNames, root?.fullName);
		// Orphan bundles (see buildOrphanBundle in key.ts) have no basicInformation —
		// their only name is the scraped owner reference at orphan.name.
		addCandidate(orderedNames, seenNames, getObject(root?.orphan)?.name);
	} else {
		addCandidate(orderedNames, seenNames, basicInformation?.iaFirmName);
		addCandidate(orderedNames, seenNames, basicInformation?.firmName);
		addCandidate(orderedNames, seenNames, basicInformation?.organizationName);
		addCandidate(orderedNames, seenNames, basicInformation?.orgName);
		addCandidate(orderedNames, seenNames, root?.primaryBusinessName);
		addCandidate(orderedNames, seenNames, root?.firmName);
	}

	const otherNames = Array.isArray(basicInformation?.otherNames) ? basicInformation.otherNames : [];
	for (const otherName of otherNames) addCandidate(orderedNames, seenNames, otherName);

	return orderedNames;
}

function collectSearchableValues(node: unknown, target: string[], seenValues: Set<string>, seenNodes = new Set<unknown>()) {
	if (node == null) return;
	if (typeof node === 'string') {
		addCandidate(target, seenValues, node);
		return;
	}
	if (typeof node === 'number') {
		addCandidate(target, seenValues, String(node));
		return;
	}
	if (typeof node !== 'object' || seenNodes.has(node)) return;
	seenNodes.add(node);

	if (Array.isArray(node)) {
		for (const item of node) collectSearchableValues(item, target, seenValues, seenNodes);
		return;
	}

	for (const value of Object.values(node as Record<string, unknown>)) {
		collectSearchableValues(value, target, seenValues, seenNodes);
	}
}

function getMaxFuzzyDistance(term: string) {
	if (term.length <= 5) return 1;
	if (term.length <= 9) return 2;
	return 3;
}

function levenshteinWithinLimit(left: string, right: string, limit: number) {
	if (left === right) return true;
	if (!left || !right) return false;
	if (Math.abs(left.length - right.length) > limit) return false;

	const previous = new Array(right.length + 1);
	const current = new Array(right.length + 1);

	for (let j = 0; j <= right.length; j += 1) previous[j] = j;

	for (let i = 1; i <= left.length; i += 1) {
		current[0] = i;
		let rowMin = current[0];

		for (let j = 1; j <= right.length; j += 1) {
			const cost = left[i - 1] === right[j - 1] ? 0 : 1;
			current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
			rowMin = Math.min(rowMin, current[j]);
		}

		if (rowMin > limit) return false;
		for (let j = 0; j <= right.length; j += 1) previous[j] = current[j];
	}

	return previous[right.length] <= limit;
}

function isFuzzyTokenCandidate(term: string, token: string) {
	const normalizedTerm = normalizeForSearch(term);
	if (!normalizedTerm || !token) return false;
	if (normalizedTerm.length < 4 || token.length < 4) return false;
	if (Math.abs(normalizedTerm.length - token.length) > getMaxFuzzyDistance(normalizedTerm)) return false;
	if (normalizedTerm[0] !== token[0]) return false;
	const prefixLength = normalizedTerm.length >= 6 ? 2 : 1;
	if (normalizedTerm.slice(0, prefixLength) !== token.slice(0, prefixLength)) return false;
	return levenshteinWithinLimit(normalizedTerm, token, getMaxFuzzyDistance(normalizedTerm));
}

function findMatchedValues(term: string, entry: LocalSearchEntry) {
	const normalizedTerm = normalizeForSearch(term);
	if (!normalizedTerm) return null;

	// Prefer matches against the entity's own name(s) over an incidental hit
	// somewhere else in its record (e.g. an individual's employment history
	// containing a firm name like "LPL Financial LLC"), so searching for a
	// firm's name surfaces that firm itself instead of burying it under every
	// person who has ever worked there.
	const nameMatches = entry.searchableNames.filter((value) => normalizeForSearch(value).includes(normalizedTerm));
	if (nameMatches.length) {
		return {
			term,
			exact: true,
			nameMatch: true,
			matchedValues: nameMatches.slice(0, 6),
		};
	}

	const exactMatches = entry.searchableValues.filter((value) => normalizeForSearch(value).includes(normalizedTerm));
	if (exactMatches.length) {
		return {
			term,
			exact: true,
			nameMatch: false,
			matchedValues: exactMatches.slice(0, 6),
		};
	}

	const fuzzyNameMatches = entry.searchableNames.filter((value) => tokenizeSearchValue(value).some((token) => isFuzzyTokenCandidate(normalizedTerm, token)));
	if (fuzzyNameMatches.length) {
		return {
			term,
			exact: false,
			nameMatch: true,
			matchedValues: fuzzyNameMatches.slice(0, 6),
		};
	}

	// Broad fuzzy fallback: allow a typo-tolerant match against any value in
	// the entity's full record (addresses, employer names, etc.), not just
	// its own name fields.
	const fuzzyValueMatches = entry.searchableValues.filter((value) => tokenizeSearchValue(value).some((token) => isFuzzyTokenCandidate(normalizedTerm, token)));
	if (!fuzzyValueMatches.length) return null;

	return {
		term,
		exact: false,
		nameMatch: false,
		matchedValues: fuzzyValueMatches.slice(0, 6),
	};
}

async function getSavedSignature() {
	const stats = await listSavedKeysWithStats({ limit: 0, sort: 'date-desc', type: 'all' });
	const keys = stats.keys.map((entry) => String(entry.key || '')).filter(Boolean);
	const newest = stats.keys[0];
	const oldest = stats.keys[stats.keys.length - 1];
	const signature = `${stats.totalCount}:${newest?.key || ''}:${Math.round(Number(newest?.mtime || 0))}:${oldest?.key || ''}:${Math.round(Number(oldest?.mtime || 0))}`;
	return { keys, signature, totalCount: stats.totalCount };
}

async function buildLocalSearchIndex(keys: string[]) {
	const groups = new Map<string, LocalSearchGroup>();

	for (const savedKey of keys) {
		const match = savedKey.match(/^(finra|sec):(firm|individual):(\d+)(?:\.json)?$/i);
		if (!match) continue;
		const [, source, type, crd] = match;
		const groupKey = `${type}:${crd}`;
		const current: LocalSearchGroup = groups.get(groupKey) || {
			type: type as EntityType,
			crd,
			files: [],
			finra: false,
			sec: false,
		};
		current.files.push(savedKey);
		if (source.toLowerCase() === 'finra') current.finra = true;
		if (source.toLowerCase() === 'sec') current.sec = true;
		groups.set(groupKey, current);
	}

	const rows = (
		await Promise.all(
			Array.from(groups.values()).map(async (group) => {
				const orderedNames: string[] = [];
				const seenNames = new Set<string>();
				const addresses: string[] = [];
				const seenAddresses = new Set<string>();
				const secNumbers: string[] = [];
				const seenSecNumbers = new Set<string>();
				const searchableValues: string[] = [];
				const seenSearchableValues = new Set<string>();
				let hasFinra = false;
				let hasSec = false;
				const prioritizedFiles = group.files.slice().sort((left, right) => left.localeCompare(right));

				for (const file of prioritizedFiles) {
					try {
						const payload = await loadSavedPayload(file);
						const sourceMatch = file.match(/^(finra|sec):(individual|firm):/i);
						const source = sourceMatch?.[1]?.toLowerCase();
						const fileType = sourceMatch?.[2]?.toLowerCase();
						if (source === 'sec' && fileType === 'individual' && isSecIndividualBrokerOnlyStub(payload)) continue;
						const normalizedPayload = normalizeRawPayload(payload);
						if (source === 'finra') hasFinra = true;
						if (source === 'sec') hasSec = true;
						const names = extractNamesFromPayload(normalizedPayload, group.type);
						for (const name of names) addCandidate(orderedNames, seenNames, name);
						for (const secNumber of collectSecNumbers(getObject(normalizedPayload))) addCandidate(secNumbers, seenSecNumbers, secNumber);
						const nextAddresses: string[] = [];
						collectAddressStrings(normalizedPayload, nextAddresses);
						for (const address of nextAddresses) addCandidate(addresses, seenAddresses, address);
						collectSearchableValues(normalizedPayload, searchableValues, seenSearchableValues);
					} catch {
						continue;
					}
				}

				if (!hasFinra && !hasSec) return null;

				let currentFirm = '';
				let currentCity = '';
				let currentState = '';
				if (group.type === 'individual') {
					for (const file of prioritizedFiles) {
						try {
							const payload = await loadSavedPayload(file);
							const normalizedPayload = normalizeRawPayload(payload);
							const emps = [
								...(Array.isArray(normalizedPayload?.currentEmployments) ? normalizedPayload.currentEmployments : []),
								...(Array.isArray(normalizedPayload?.currentIAEmployments) ? normalizedPayload.currentIAEmployments : []),
							];
							for (const emp of emps) {
								const empObj = getObject(emp);
								if (empObj && typeof empObj.firmName === 'string') {
									currentFirm = normalizeWhitespace(empObj.firmName);
									const locations = Array.isArray(empObj.branchOfficeLocations) ? (empObj.branchOfficeLocations as Record<string, unknown>[]) : [];
									const primaryLoc = locations.find((loc) => loc?.locatedAtFlag === 'Y') || locations[0];
									if (primaryLoc) {
										currentCity = getString(primaryLoc.city);
										currentState = getString(primaryLoc.state);
									} else {
										currentCity = getString(empObj.city);
										currentState = getString(empObj.state);
									}
									break;
								}
							}
							if (currentFirm) break;

							// Fallback to previous employments if no current employment
							if (!currentFirm) {
								const prevEmps = [
									...(Array.isArray(normalizedPayload?.previousEmployments) ? normalizedPayload.previousEmployments : []),
									...(Array.isArray(normalizedPayload?.previousIAEmployments) ? normalizedPayload.previousIAEmployments : []),
								];
								for (const emp of prevEmps) {
									const empObj = getObject(emp);
									if (empObj && typeof empObj.firmName === 'string') {
										currentFirm = normalizeWhitespace(empObj.firmName);
										const locations = Array.isArray(empObj.branchOfficeLocations) ? (empObj.branchOfficeLocations as Record<string, unknown>[]) : [];
										const primaryLoc = locations.find((loc) => loc?.locatedAtFlag === 'Y') || locations[0];
										if (primaryLoc) {
											currentCity = getString(primaryLoc.city);
											currentState = getString(primaryLoc.state);
										} else {
											currentCity = getString(empObj.city);
											currentState = getString(empObj.state);
										}
										break;
									}
								}
							}
							if (currentFirm) break;
						} catch {}
					}
				}

				const primaryName = orderedNames[0] || `${group.type === 'individual' ? 'Individual' : 'Firm'} ${group.crd}`;
				const aliases = orderedNames.slice(1);
				const searchableNames = [primaryName, ...aliases];
				const searchableNameTokens = Array.from(new Set(searchableNames.flatMap((value) => tokenizeSearchValue(value))));

				return {
					type: group.type,
					crd: group.crd,
					name: primaryName,
					aliases,
					finra: hasFinra,
					sec: hasSec,
					secNumber: secNumbers[0] || '',
					currentAddress: addresses[0] || '',
					searchableNames,
					searchableValues,
					searchableNameTokens,
					searchText: searchableValues.map((value) => normalizeForSearch(value)).join('\n'),
					currentFirm,
					currentCity,
					currentState,
				} satisfies LocalSearchEntry;
			}),
		)
	).filter((row): row is LocalSearchEntry => Boolean(row));

	rows.sort(
		(left, right) =>
			left.name.localeCompare(right.name, undefined, { sensitivity: 'base', numeric: true }) || Number(left.crd) - Number(right.crd) || left.type.localeCompare(right.type),
	);

	return rows;
}

async function getLocalSearchIndex() {
	const { keys, signature } = await getSavedSignature();
	if (cachedIndex && cachedSignature === signature) return cachedIndex;
	if (cachedIndexPromise && cachedSignature === signature) return cachedIndexPromise;

	cachedSignature = signature;
	cachedIndexPromise = buildLocalSearchIndex(keys)
		.then((index) => {
			cachedIndex = index;
			return index;
		})
		.finally(() => {
			cachedIndexPromise = null;
		});

	return cachedIndexPromise;
}

// Each comma/newline-separated line is its own OR'd query (so pasting a list
// of several different names/CRDs searches for any of them). Within a line,
// each word is OR'd + fuzzy-matched independently (so "timothy d bryan"
// surfaces any record matching "timothy" OR "d" OR "bryan", ranked by how
// many/how well the words match), rather than requiring an exact verbatim
// phrase or requiring every word to match.
function parseTermGroups(value: string): string[][] {
	const groups = String(value || '')
		.split(/[\n,]+/)
		.map((line) => normalizeWhitespace(line).toLowerCase())
		.filter(Boolean)
		.map((line) => Array.from(new Set(line.split(/\s+/).filter(Boolean))))
		.filter((group) => group.length > 0);
	return groups;
}

function matchTermGroup(tokens: string[], entry: LocalSearchEntry) {
	// Broad OR + fuzzy matching: a record matches a query group if it matches
	// ANY of the group's words (anywhere in its record, name or otherwise),
	// exactly or fuzzily. Results are ranked afterward by matchScore so
	// records matching more/exact/own-name terms surface above partial or
	// incidental matches.
	const matches: NonNullable<ReturnType<typeof findMatchedValues>>[] = [];
	for (const token of tokens) {
		// A single-character token (e.g. a middle initial like "d") is too
		// short to safely OR-match against the entire record — almost every
		// entry contains that letter somewhere as a substring. Instead of
		// dropping it (or requiring it), only credit it as a match when it
		// appears as a standalone word/initial in the entity's own name, so
		// it can still contribute to ranking without flooding results.
		if (token.length < 2) {
			const initialMatches = entry.searchableNames.filter((value) => normalizeForSearch(value).split(' ').includes(token));
			if (initialMatches.length) {
				matches.push({ term: token, exact: true, nameMatch: true, matchedValues: initialMatches.slice(0, 6) });
			}
			continue;
		}
		const match = findMatchedValues(token, entry);
		if (match) matches.push(match);
	}
	if (!matches.length) return null;
	return matches;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
	const query = req.method === 'POST' ? req.body?.q : req.query.q;
	const rawQuery = typeof query === 'string' ? query : '';
	const termGroups = parseTermGroups(rawQuery);
	const terms = termGroups.map((group) => group.join(' '));
	const parsedLimit = Number(req.method === 'POST' ? req.body?.limit : req.query.limit);
	const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(Math.round(parsedLimit), maxLimit) : defaultLimit;

	if (!termGroups.length) {
		return res.status(200).json({
			query: rawQuery,
			terms: [],
			totalIndexed: 0,
			totalMatches: 0,
			truncated: false,
			sourceMode: getSearchSourceMode(),
			matches: [],
		});
	}

	try {
		const index = await getLocalSearchIndex();
		const matches = index
			.map((entry) => {
				const matchedGroups = termGroups.map((group) => matchTermGroup(group, entry)).filter((group): group is NonNullable<typeof group> => Boolean(group));
				if (!matchedGroups.length) return null;
				const termMatches = matchedGroups.flat();
				const matchedTerms = termMatches.map((match) => match.term);
				const matchedValues = Array.from(new Set(termMatches.flatMap((match) => match.matchedValues))).slice(0, 8);
				const matchedNames = entry.searchableNames.filter((name) =>
					termMatches.some((match) => match.matchedValues.some((value) => value === name || normalizeForSearch(value).includes(normalizeForSearch(name)))),
				);
				return {
					...entry,
					matchedTerms,
					matchedValues,
					matchScore: termMatches.reduce(
						(score, match) =>
							score +
							(match.nameMatch ?
								match.exact ?
									5
								:	2
							: match.exact ? 3
							: 1),
						0,
					),
					matchedNames: matchedNames.length ? matchedNames : [entry.name],
				};
			})
			.filter((entry): entry is LocalSearchEntry & { matchedTerms: string[]; matchedNames: string[]; matchedValues: string[]; matchScore: number } => Boolean(entry))
			.sort(
				(left, right) =>
					right.matchScore - left.matchScore ||
					(left.type === 'individual' ? 0 : 1) - (right.type === 'individual' ? 0 : 1) ||
					right.matchedTerms.length - left.matchedTerms.length ||
					left.name.localeCompare(right.name, undefined, { sensitivity: 'base', numeric: true }),
			);

		return res.status(200).json({
			query: rawQuery,
			terms,
			totalIndexed: index.length,
			totalMatches: matches.length,
			truncated: matches.length > limit,
			sourceMode: getSearchSourceMode(),
			matches: matches.slice(0, limit),
		});
	} catch (error) {
		return res.status(500).json({ error: formatErrorMessage(error) });
	}
}
