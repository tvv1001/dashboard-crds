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
try {
	// Try to use __dirname if available (CommonJS-like)
	moduleDir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
} catch {
	moduleDir = process.cwd();
}

function addRootAndParents(roots: Set<string>, startPath?: string | null) {
	if (!startPath) return;

	let currentPath = path.resolve(startPath);
	for (let depth = 0; depth < 8; depth += 1) {
		roots.add(currentPath);
		const parentPath = path.dirname(currentPath);
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
		// Then try process.cwd()
		addRootAndParents(roots, process.cwd());
		// Include launcher directory
		addRootAndParents(roots, process.argv?.[1] ? path.dirname(process.argv[1]) : null);
		// Check public/search-indexes (files copied there during build, preserved on Vercel)
		addRootAndParents(roots, path.join(process.cwd(), 'public', 'search-indexes'));
	}
	return Array.from(roots);
}

function collectSearchIndexFiles(dir: string, fileNamePrefix: string) {
	try {
		return readdirSync(dir)
			.filter((name) => name === `${fileNamePrefix}.json` || (name.startsWith(`${fileNamePrefix}.part`) && name.endsWith('.json')))
			.sort()
			.map((name) => path.resolve(dir, name));
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

	for (const root of candidates) {
		const gzCandidatePath = path.resolve(root, SEARCH_INDEX_GZ_RELATIVE_FILES[bucket]);
		attemptedPaths.push(gzCandidatePath);
		if (existsSync(gzCandidatePath)) {
			return [gzCandidatePath];
		}

		// Try standard relative path first (data/national/...)
		const candidatePath = path.resolve(root, relativeFilePath);
		attemptedPaths.push(candidatePath);
		if (existsSync(candidatePath)) {
			return [candidatePath];
		}

		// If root is public/search-indexes or ends with search-indexes, look for chunked files too
		if (root.endsWith('search-indexes') || root.includes('public/search-indexes')) {
			const compressedPath = path.resolve(root, `${fileName}.gz`);
			attemptedPaths.push(compressedPath);
			if (existsSync(compressedPath)) {
				return [compressedPath];
			}

			const directPath = path.resolve(root, fileName);
			attemptedPaths.push(directPath);
			if (existsSync(directPath)) {
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
		path.resolve('/var/task', SEARCH_INDEX_GZ_RELATIVE_FILES[bucket]),
		path.resolve('/var/lang/lib', SEARCH_INDEX_GZ_RELATIVE_FILES[bucket]),
		path.resolve('/function', SEARCH_INDEX_GZ_RELATIVE_FILES[bucket]),
		path.resolve('/var/task', relativeFilePath),
		path.resolve('/var/lang/lib', relativeFilePath),
		path.resolve('/function', relativeFilePath),
	];

	for (const vercelPath of vercelPaths) {
		attemptedPaths.push(vercelPath);
		if (existsSync(vercelPath)) {
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
	return path.resolve(process.cwd(), relativeFilePath);
}
