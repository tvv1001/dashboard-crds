import fs from 'fs/promises';
import path from 'path';
import { isNonActionableSavedDetail } from '../pages/api/_lib';

const rawDir = path.resolve(process.cwd(), 'data', 'raw');

async function migrate() {
	const entries = await fs.readdir(rawDir);
	const jsonFiles = entries.filter(f => f.endsWith('.json'));
	
	console.log(`Starting migration of ${jsonFiles.length} files...`);
	
	let migrated = 0;
	let alreadyCorrect = 0;
	let deletedStubs = 0;
	let errors = 0;

	for (const file of jsonFiles) {
		const filePath = path.join(rawDir, file);
		try {
			const content = await fs.readFile(filePath, 'utf-8');
			const payload = JSON.parse(content);

			// NEW: Stub detection and removal
			if (isNonActionableSavedDetail(file, payload)) {
				await fs.unlink(filePath);
				deletedStubs++;
				continue;
			}
			
			const isFinra = file.startsWith('finra:');
			const isSec = file.startsWith('sec:');
			
			if (!isFinra && !isSec) continue;

			// Check if already migrated
			if (isFinra && payload.finraBrokerCheck && Object.keys(payload).length === 1) {
				alreadyCorrect++;
				continue;
			}
			if (isSec && payload.secInvestmentAdvisor && Object.keys(payload).length === 1) {
				alreadyCorrect++;
				continue;
			}

			// Extract inner payload
			let inner = payload;
			if (payload.finraBrokerCheck) inner = payload.finraBrokerCheck;
			else if (payload.secInvestmentAdvisor) inner = payload.secInvestmentAdvisor;
			else if (payload.bccontent) inner = payload.bccontent;
			else if (payload.iacontent) inner = payload.iacontent;
			else if (payload.content && Object.keys(payload).length === 1) inner = payload.content;

			// Re-wrap
			const nextPayload = isFinra ? { finraBrokerCheck: inner } : { secInvestmentAdvisor: inner };
			
			await fs.writeFile(filePath, JSON.stringify(nextPayload, null, 2), 'utf-8');
			migrated++;
			
			if (migrated % 1000 === 0) {
				console.log(`Progress: ${migrated} migrated, ${alreadyCorrect} skipped, ${deletedStubs} deleted...`);
			}
		} catch (e: any) {
			console.error(`Error migrating ${file}: ${e.message}`);
			errors++;
		}
	}

	console.log('\nMigration complete!');
	console.log(`- Migrated: ${migrated}`);
	console.log(`- Already correct: ${alreadyCorrect}`);
	console.log(`- Deleted Stubs: ${deletedStubs}`);
	console.log(`- Errors: ${errors}`);
}

migrate().catch(console.error);
