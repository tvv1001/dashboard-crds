#!/usr/bin/env node
import { readdir } from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { formatErrorMessage } from '../pages/api/_lib';

type Strategy = {
	name: string;
	npmArgs: string[];
};

const rawDir = path.resolve(process.cwd(), 'data', 'raw');

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function randBetween(min: number, max: number) {
	const lo = Number(min) || 0;
	const hi = Number(max) || 0;
	if (hi <= lo) return lo;
	return Math.round(lo + Math.random() * (hi - lo));
}

function parseArgs(argv: string[]) {
	const config = {
		targetUniqueCrds: 50_000,
		sleepMinMs: 20 * 60_000,
		sleepMaxMs: 45 * 60_000,
		maxCycles: Number.POSITIVE_INFINITY,
	};

	for (const arg of argv) {
		if (arg.startsWith('--target-unique-crds=')) {
			const parsed = Number(arg.slice('--target-unique-crds='.length));
			if (Number.isFinite(parsed) && parsed > 0) config.targetUniqueCrds = parsed;
			continue;
		}
		if (arg.startsWith('--sleep-min-ms=')) {
			const parsed = Number(arg.slice('--sleep-min-ms='.length));
			if (Number.isFinite(parsed) && parsed >= 0) config.sleepMinMs = parsed;
			continue;
		}
		if (arg.startsWith('--sleep-max-ms=')) {
			const parsed = Number(arg.slice('--sleep-max-ms='.length));
			if (Number.isFinite(parsed) && parsed >= 0) config.sleepMaxMs = parsed;
			continue;
		}
		if (arg.startsWith('--max-cycles=')) {
			const parsed = Number(arg.slice('--max-cycles='.length));
			if (Number.isFinite(parsed) && parsed > 0) config.maxCycles = parsed;
		}
	}

	return config;
}

async function countUniqueCrds() {
	const files = (await readdir(rawDir)).filter((entry) => entry.endsWith('.json'));
	const unique = new Set<string>();
	for (const entry of files) {
		const match = entry.match(/^(?:finra|sec):(?:individual|firm):(\d+)\.json$/i);
		if (match) unique.add(match[1]);
	}
	return { files: files.length, uniqueCrds: unique.size };
}

async function runStrategy(strategy: Strategy) {
	console.log(`[target-supervisor] Starting ${strategy.name}: npm ${strategy.npmArgs.join(' ')}`);
	await new Promise<void>((resolve, reject) => {
		const child = spawn('npm', strategy.npmArgs, { stdio: 'inherit' });
		child.on('error', reject);
		child.on('exit', (code) => {
			if (code === 0) resolve();
			else reject(new Error(`${strategy.name} exited with code ${String(code)}`));
		});
	});
}

function buildStrategies(): Strategy[] {
	return [
		{
			name: 'derived-crd-crawl',
			npmArgs: ['run', 'query-derived-crds'],
		},
		{
			name: 'common-name-crawl',
			npmArgs: ['run', 'query-common-name-crds', '--', '--limit-terms=25'],
		},
		{
			name: 'alphanumeric-crawl',
			npmArgs: ['run', 'query-alnum-crds'],
		},
		{
			name: 'bank-name-crawl',
			npmArgs: ['run', 'query-bank-name-crds'],
		},
	];
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const strategies = buildStrategies();
	let cycle = 0;

	while (cycle < args.maxCycles) {
		const before = await countUniqueCrds();
		console.log(`[target-supervisor] Current unique CRDs: ${before.uniqueCrds.toLocaleString()} / ${args.targetUniqueCrds.toLocaleString()} (${before.files.toLocaleString()} files).`);
		if (before.uniqueCrds >= args.targetUniqueCrds) {
			console.log('[target-supervisor] Target reached. Stopping supervisor.');
			return;
		}

		cycle += 1;
		console.log(`[target-supervisor] Cycle ${cycle} starting.`);
		for (const strategy of strategies) {
			try {
				await runStrategy(strategy);
			} catch (error) {
				console.error(`[target-supervisor] ${strategy.name} failed: ${formatErrorMessage(error)}`);
			}
			const progress = await countUniqueCrds();
			console.log(`[target-supervisor] After ${strategy.name}: ${progress.uniqueCrds.toLocaleString()} unique CRDs.`);
			if (progress.uniqueCrds >= args.targetUniqueCrds) {
				console.log('[target-supervisor] Target reached. Stopping supervisor.');
				return;
			}
		}

		if (cycle >= args.maxCycles) break;
		const sleepMs = randBetween(
			Math.min(args.sleepMinMs, args.sleepMaxMs),
			Math.max(args.sleepMinMs, args.sleepMaxMs),
		);
		console.log(`[target-supervisor] Sleeping ${(sleepMs / 60_000).toFixed(1)} minutes before the next expansion cycle.`);
		await sleep(sleepMs);
	}
}

main().catch((error) => {
	console.error(formatErrorMessage(error));
	process.exit(1);
});
