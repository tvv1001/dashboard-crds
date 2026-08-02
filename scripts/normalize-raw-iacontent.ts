#!/usr/bin/env node
import { promises as fs } from 'fs';
import path from 'path';
import { formatRawPayloadForStorage, formatErrorMessage, rawKeyToFilename } from '../pages/api/_lib';

const rawDir = path.resolve(process.cwd(), 'data', 'raw');

async function main() {
	const entries = (await fs.readdir(rawDir)).filter((entry) => entry.endsWith('.json'));
	let rewritten = 0;
	let unchanged = 0;
	let failed = 0;
	const bySource = {
		sec: { rewritten: 0, unchanged: 0, failed: 0 },
		finra: { rewritten: 0, unchanged: 0, failed: 0 },
		other: { rewritten: 0, unchanged: 0, failed: 0 },
	};

	for (const entry of entries) {
		const source = entry.startsWith('sec:') ? 'sec' : entry.startsWith('finra:') ? 'finra' : 'other';
		try {
			const filePath = path.join(rawDir, entry);
			const raw = await fs.readFile(filePath, 'utf-8');
			const parsed = JSON.parse(raw);
			const formatted = formatRawPayloadForStorage(rawKeyToFilename(entry), parsed);
			const serialized = JSON.stringify(formatted, null, 2);
			if (serialized === raw) {
				unchanged += 1;
				bySource[source].unchanged += 1;
				continue;
			}
			await fs.writeFile(filePath, serialized, 'utf-8');
			rewritten += 1;
			bySource[source].rewritten += 1;
		} catch (error) {
			failed += 1;
			bySource[source].failed += 1;
			console.error(`Failed ${entry}: ${formatErrorMessage(error)}`);
		}
	}

	console.log(JSON.stringify({
		totalFiles: entries.length,
		rewritten,
		unchanged,
		failed,
		bySource,
	}, null, 2));
}

main().catch((error) => {
	console.error(formatErrorMessage(error));
	process.exit(1);
});
