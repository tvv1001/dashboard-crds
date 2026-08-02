#!/usr/bin/env node
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { formatErrorMessage } from '../pages/api/_lib';

const execFileAsync = promisify(execFile);
const crawlPatterns = [
	'query-bank-name-crds.ts',
	'query-alnum-crds.ts',
	'query-common-name-crds.ts',
	'query-derived-crds.ts',
];

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
		waitPollMs: 60_000,
		sleepMinMs: 20 * 60_000,
		sleepMaxMs: 45 * 60_000,
		maxCycles: Number.POSITIVE_INFINITY,
		bankArgs: [] as string[],
	};

	for (const arg of argv) {
		if (arg.startsWith('--wait-poll-ms=')) {
			const parsed = Number(arg.slice('--wait-poll-ms='.length));
			if (Number.isFinite(parsed) && parsed > 0) config.waitPollMs = parsed;
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
			continue;
		}
		config.bankArgs.push(arg);
	}

	return config;
}

async function listActiveCrawls(selfPid: number) {
	const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,args=']);
	return stdout
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const match = line.match(/^(\d+)\s+(.*)$/);
			return match ? { pid: Number(match[1]), cmd: match[2] } : null;
		})
		.filter((entry): entry is { pid: number; cmd: string } => Boolean(entry))
		.filter((entry) => entry.pid !== selfPid)
		.filter((entry) => crawlPatterns.some((pattern) => entry.cmd.includes(pattern)));
}

async function waitForOtherCrawlsToFinish(selfPid: number, waitPollMs: number) {
	while (true) {
		const active = await listActiveCrawls(selfPid);
		if (active.length === 0) return;
		console.log(`[supervisor] Waiting on ${active.length} active crawl process(es): ${active.map((entry) => `${entry.pid}:${entry.cmd}`).join(' | ')}`);
		await sleep(waitPollMs);
	}
}

async function runBankCrawl(bankArgs: string[]) {
	const args = ['run', 'query-bank-name-crds'];
	if (bankArgs.length) args.push('--', ...bankArgs);
	console.log(`[supervisor] Starting bank crawl: npm ${args.join(' ')}`);
	await new Promise<void>((resolve, reject) => {
		const child = spawn('npm', args, { stdio: 'inherit' });
		child.on('error', reject);
		child.on('exit', (code) => {
			if (code === 0) resolve();
			else reject(new Error(`Bank crawl exited with code ${String(code)}`));
		});
	});
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	let cycle = 0;

	while (cycle < args.maxCycles) {
		await waitForOtherCrawlsToFinish(process.pid, args.waitPollMs);
		cycle += 1;
		console.log(`[supervisor] Cycle ${cycle} starting.`);
		try {
			await runBankCrawl(args.bankArgs);
			console.log(`[supervisor] Cycle ${cycle} finished.`);
		} catch (error) {
			console.error(`[supervisor] Cycle ${cycle} failed: ${formatErrorMessage(error)}`);
		}
		if (cycle >= args.maxCycles) break;
		const sleepMs = randBetween(
			Math.min(args.sleepMinMs, args.sleepMaxMs),
			Math.max(args.sleepMinMs, args.sleepMaxMs),
		);
		console.log(`[supervisor] Sleeping ${(sleepMs / 60_000).toFixed(1)} minutes before the next cycle.`);
		await sleep(sleepMs);
	}
}

main().catch((error) => {
	console.error(formatErrorMessage(error));
	process.exit(1);
});
