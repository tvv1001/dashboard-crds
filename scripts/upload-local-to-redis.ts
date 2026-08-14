import fs from 'fs/promises';
import path from 'path';
import { saveRawFile } from '../pages/api/_lib';

const rawDir = path.resolve(process.cwd(), 'data', 'raw');

async function uploadLocalToRedis() {
	try {
		const entries = await fs.readdir(rawDir);
		const jsonFiles = entries.filter(f => f.endsWith('.json'));
		
		console.log(`Found ${jsonFiles.length} JSON files in ${rawDir}`);
		console.log('Uploading to Redis...');
		
		let uploaded = 0;
		let errors = 0;

		for (const file of jsonFiles) {
			const filePath = path.join(rawDir, file);
			try {
				const content = await fs.readFile(filePath, 'utf-8');
				const payload = JSON.parse(content);
				
				// Extract cache key from filename (e.g., finra:individual:123.json -> finra:individual:123)
				let key = file.replace('.json', '');
				
				// Handle legacy naming if present
				if (key.includes('api.brokercheck.finra.org_search_individual_')) {
					key = key.replace('api.brokercheck.finra.org_search_individual_', 'finra:individual:');
				} else if (key.includes('api.adviserinfo.sec.gov_search_individual_')) {
					key = key.replace('api.adviserinfo.sec.gov_search_individual_', 'sec:individual:');
				} else if (key.includes('api.brokercheck.finra.org_search_firm_')) {
					key = key.replace('api.brokercheck.finra.org_search_firm_', 'finra:firm:');
				} else if (key.includes('api.adviserinfo.sec.gov_search_firm_')) {
					key = key.replace('api.adviserinfo.sec.gov_search_firm_', 'sec:firm:');
				}
				
				await saveRawFile(key, payload);
				uploaded++;
				
				if (uploaded % 1000 === 0) {
					console.log(`Progress: ${uploaded} files uploaded to Redis...`);
				}
			} catch (e: any) {
				console.error(`Error uploading ${file}: ${e.message}`);
				errors++;
			}
		}

		console.log('\nUpload complete!');
		console.log(`- Successfully uploaded: ${uploaded}`);
		console.log(`- Errors: ${errors}`);
	} catch (err: any) {
		console.error(`Failed to read directory ${rawDir}: ${err.message}`);
		console.log('Ensure that your local files are placed in data/raw/ before running this script.');
	}
}

uploadLocalToRedis().catch(console.error);
