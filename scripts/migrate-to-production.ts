import zlib from "zlib";
import { createClient } from 'redis';
import { Redis as UpstashRedis } from '@upstash/redis';
import dotenv from 'dotenv';
import path from 'path';

// Load both .env and .env.local
dotenv.config({ path: path.resolve(process.cwd(), '.env') });
dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: true });

async function migrate() {
	const localUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
	const upstashUrl = process.env.UPSTASH_REDIS_REST_URL;
	const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;

	if (!upstashUrl || !upstashToken) {
		console.error("Missing Upstash REST URL or Token in environment variables.");
		process.exit(1);
	}

	console.log(`Connecting to local Redis at ${localUrl}...`);
	const localRedis = createClient({ url: localUrl });
	await localRedis.connect();

	console.log(`Connecting to production Upstash Redis at ${upstashUrl}...`);
	const upstashRedis = new UpstashRedis({
		url: upstashUrl,
		token: upstashToken,
	});

	const targetKeys = process.argv.slice(2);
	let keys: string[] = [];

	if (targetKeys.length > 0) {
		console.log(`Targeting specific keys provided via arguments: ${targetKeys.join(', ')}`);
		// Check if they exist locally
		for (const key of targetKeys) {
			const exists = await localRedis.exists(key);
			if (exists) {
				keys.push(key);
			} else {
				console.warn(`Warning: Target key ${key} not found in local Redis.`);
			}
		}
	} else {
		console.log("Fetching all keys from local Redis...");
		keys = await localRedis.keys('*');
	}
	
	console.log(`Found ${keys.length} keys to migrate.`);

	let migratedCount = 0;
	let errorCount = 0;
	
	// Process in chunks of 100 to stay under 1MB payload limits and use very few requests
	const CHUNK_SIZE = 100;
	
	for (let i = 0; i < keys.length; i += CHUNK_SIZE) {
		const chunk = keys.slice(i, i + CHUNK_SIZE);
		const msetPayload: Record<string, string> = {};
		let hasKeys = false;
		
		for (const key of chunk) {
			try {
				const type = await localRedis.type(key);
				if (type === 'string') {
					const val = await localRedis.get(key);
					if (val) {
						// Compress using Brotli and encode to base64
						const compressed = zlib.brotliCompressSync(Buffer.from(val, 'utf-8')).toString('base64');
						msetPayload[key] = compressed;
						hasKeys = true;
					}
				}
			} catch (err) {
				console.error(`Failed to read key ${key} from local:`, err);
				errorCount++;
			}
		}
		
		if (hasKeys) {
			try {
				// MSET uses exactly 1 request for the entire chunk!
				await upstashRedis.mset(msetPayload);
				migratedCount += Object.keys(msetPayload).length;
				
				console.log(`Progress: Migrated ${migratedCount} / ${keys.length} keys...`);
				
				// Sleep to respect the REST API (just in case)
				await new Promise(resolve => setTimeout(resolve, 200));
			} catch (err: any) {
				console.error(`Failed to MSET chunk starting at ${chunk[0]}: ${err.message}`);
				errorCount += chunk.length;
			}
		}
	}
	
	console.log('\nMigration complete!');
	console.log(`Successfully migrated: ${migratedCount}`);
	console.log(`Errors: ${errorCount}`);
	
	await localRedis.disconnect();
}

migrate().catch((err) => {
	console.error('Fatal error during migration:', err);
	process.exit(1);
});
