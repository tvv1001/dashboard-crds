import { existsSync, readdirSync } from 'node:fs';
import * as path from 'node:path';

export const SEARCH_INDEX_RELATIVE_FILES = {
	'finra:individual': path.join('data', 'national', 'search-index.finra.individual.json'),
	'finra:firm': path.join('data', 'national', 'search-index.finra.firm.json'),
	'sec:individual': path.join('data', 'national', 'search-index.sec.individual.json'),
	'sec:firm': path.join('data', 'national', 'search-index.sec.firm.json'),
} as const;

const SEARCH_INDEX_GZ_RELATIVE_FILES = {
	'finra:individual': `${SEARCH_INDEX_RELATIVE_FILES['finra:individual']}.gz`,
	'finra:firm': `${SEARCH_INDEX_RELATIVE_FILES['finra:firm']}.gz`,
	'sec:individual': `${SEARCH_INDEX_RELATIVE_FILES['sec:individual']}.gz`,
	'sec:firm': `${SEARCH_INDEX_RELATIVE_FILES['sec:firm']}.gz`,
} as const;

type SearchIndexBucket = keyof typeof SEARCH_INDEX_RELATIVE_FILES;

// Get the directory where this module is located
// This is needed because __dirname is not reliably available in ES modules
let moduleDir: string;
const getCwd = () => (typeof window === 'undefined' && typeof process !== 'undefined' ? (process.env.PWD || '') : '');
try {
	// Try to use __dirname if available (CommonJS-like)
	moduleDir = typeof __dirname !== 'undefined' ? __dirname : getCwd();
} catch {
	moduleDir = getCwd();
}

function addRootAndParents(roots: Set<string>, startPath?: string | null) {
	if (!startPath) return;

	let currentPath = path.resolve(/*turbopackIgnore: true*/ startPath);
	for (let depth = 0; depth < 8; depth += 1) {
		roots.add(currentPath);
		const parentPath = path.dirname(/*turbopackIgnore: true*/ currentPath);
		if (parentPath === currentPath) break;
		currentPath = parentPath;
	}
}

function getCandidateRoots(seedRoots: Array<string | null | undefined> = []) {
	const roots = new Set<string>();
	for (const seedRoot of seedRoots) addRootAndParents(roots, seedRoot);
	if (!seedRoots.length) {
		// Always start from module directory first (most reliable on Vercel)
		addRootAndParents(roots, moduleDir);
		// Then try getCwd()
		addRootAndParents(roots, getCwd());
		// Include launcher directory
		addRootAndParents(roots, process.argv?.[1] ? path.dirname(/*turbopackIgnore: true*/ process.argv[1]) : null);
		// Check public/search-indexes (files copied there during build, preserved on Vercel)
		addRootAndParents(roots, path.join(/*turbopackIgnore: true*/ getCwd(), 'public', 'search-indexes'));
	}
	return Array.from(roots);
}

function collectSearchIndexFiles(dir: string, fileNamePrefix: string) {
	try {
		const fsMod = typeof window === 'undefined' ? eval("require('fs')") : null;
		if (!fsMod) return [];
		return fsMod.readdirSync(dir)
			.filter((name: string) => name === `${fileNamePrefix}.json` || (name.startsWith(`${fileNamePrefix}.part`) && name.endsWith('.json')))
			.sort()
			.map((name: string) => path.resolve(/*turbopackIgnore: true*/ dir, name));
	} catch {
		return [];
	}
}

export function getSearchIndexFilePaths(bucket: SearchIndexBucket, seedRoots: Array<string | null | undefined> = []) {
	const relativeFilePath = SEARCH_INDEX_RELATIVE_FILES[bucket];
	const fileName = path.basename(relativeFilePath);
	const fileNamePrefix = fileName.replace(/\.json$/, '');
	const candidates = getCandidateRoots(seedRoots);
	const attemptedPaths: string[] = [];

	const fsMod = typeof window === 'undefined' ? eval("require('fs')") : null;
	const checkExists = (p: string) => (fsMod ? fsMod.existsSync(p) : false);

	for (const root of candidates) {
		const gzCandidatePath = path.resolve(/*turbopackIgnore: true*/ root, SEARCH_INDEX_GZ_RELATIVE_FILES[bucket]);
		attemptedPaths.push(gzCandidatePath);
		if (checkExists(gzCandidatePath)) {
			return [gzCandidatePath];
		}

		// Try standard relative path first (data/national/...)
		const candidatePath = path.resolve(/*turbopackIgnore: true*/ root, relativeFilePath);
		attemptedPaths.push(candidatePath);
		if (checkExists(candidatePath)) {
			return [candidatePath];
		}

		// If root is public/search-indexes or ends with search-indexes, look for chunked files too
		if (root.endsWith('search-indexes') || root.includes('public/search-indexes')) {
			const compressedPath = path.resolve(/*turbopackIgnore: true*/ root, `${fileName}.gz`);
			attemptedPaths.push(compressedPath);
			if (checkExists(compressedPath)) {
				return [compressedPath];
			}

			const directPath = path.resolve(/*turbopackIgnore: true*/ root, fileName);
			attemptedPaths.push(directPath);
			if (checkExists(directPath)) {
				return [directPath];
			}

			const chunkFiles = collectSearchIndexFiles(root, fileNamePrefix);
			if (chunkFiles.length > 0) {
				return chunkFiles;
			}
		}
	}

	// Try common Vercel paths
	const vercelPaths = [
		path.resolve(/*turbopackIgnore: true*/ '/var/task', SEARCH_INDEX_GZ_RELATIVE_FILES[bucket]),
		path.resolve(/*turbopackIgnore: true*/ '/var/lang/lib', SEARCH_INDEX_GZ_RELATIVE_FILES[bucket]),
		path.resolve(/*turbopackIgnore: true*/ '/function', SEARCH_INDEX_GZ_RELATIVE_FILES[bucket]),
		path.resolve(/*turbopackIgnore: true*/ '/var/task', relativeFilePath),
		path.resolve(/*turbopackIgnore: true*/ '/var/lang/lib', relativeFilePath),
		path.resolve(/*turbopackIgnore: true*/ '/function', relativeFilePath),
	];

	for (const vercelPath of vercelPaths) {
		attemptedPaths.push(vercelPath);
		if (checkExists(vercelPath)) {
			return [vercelPath];
		}
	}

	console.warn(`[searchDataPaths] No files found for ${bucket}. Checked ${attemptedPaths.length} paths. First 3: ${attemptedPaths.slice(0, 3).join(', ')}`);
	return [];
}

export function getSearchIndexFilePath(bucket: SearchIndexBucket, seedRoots: Array<string | null | undefined> = []) {
	const filePaths = getSearchIndexFilePaths(bucket, seedRoots);
	if (filePaths.length > 0) return filePaths[0];

	const relativeFilePath = SEARCH_INDEX_RELATIVE_FILES[bucket];
	return path.resolve(/*turbopackIgnore: true*/ getCwd(), relativeFilePath);
}
