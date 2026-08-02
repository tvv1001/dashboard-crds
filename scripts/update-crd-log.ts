import fs from 'fs/promises';
import path from 'path';

const rawDir = path.resolve(process.cwd(), 'data', 'raw');
const logPath = path.resolve(process.cwd(), 'data/crd-discovery-log.csv');

async function updateDiscoveryLog() {
	// 1. Load existing log to find already tracked CRDs
	const tracked = new Set<string>();
	try {
		const existing = await fs.readFile(logPath, 'utf-8');
		const lines = existing.split('\n');
		for (const line of lines) {
			const [crd, type, source] = line.split(',');
			if (crd && type && source) {
				tracked.add(`${source}:${type}:${crd}`);
			}
		}
	} catch (e) {
		// Log doesn't exist yet, start fresh
		await fs.writeFile(logPath, 'CRD,TYPE,SOURCE,FIRST_DETECTED\n', 'utf-8');
	}

	// 2. Scan disk for all records
	const files = (await fs.readdir(rawDir)).filter(f => f.endsWith('.json'));
	const now = new Date().toISOString();
	
	let newDiscoveries = 0;
	const appendLines: string[] = [];

	for (const file of files) {
		const match = file.match(/^(finra|sec):(individual|firm):(\d+)\.json$/i);
		if (!match) continue;
		const [,, type, crd] = match;
		const source = match[1].toLowerCase();
		const key = `${source}:${type}:${crd}`;

		if (!tracked.has(key)) {
			// Get actual file timestamp for accuracy if possible
			let timestamp = now;
			try {
				const stat = await fs.stat(path.join(rawDir, file));
				timestamp = stat.birthtime.toISOString();
			} catch {}
			
			appendLines.push(`${crd},${type},${source},${timestamp}`);
			tracked.add(key);
			newDiscoveries++;
		}
	}

	// 3. Append new findings
	if (appendLines.length > 0) {
		await fs.appendFile(logPath, appendLines.join('\n') + '\n', 'utf-8');
	}

	console.log(`Log update complete.`);
	console.log(`- New discoveries logged: ${newDiscoveries}`);
	console.log(`- Total tracked records: ${tracked.size}`);
}

updateDiscoveryLog().catch(console.error);
