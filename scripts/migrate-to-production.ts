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

	console.log("Fetching keys from local Redis...");
	const keys = await localRedis.keys('*');
	console.log(`Found ${keys.length} keys to migrate.`);

	let migratedCount = 0;
	let errorCount = 0;
	
	for (let i = 0; i < keys.length; i++) {
		const key = keys[i];
		try {
			// Handle different types of keys if necessary, but standard payload is string
			const type = await localRedis.type(key);
			
			if (type === 'string') {
				const val = await localRedis.get(key);
				if (val) {
					// Use REST API to set the raw string (Upstash parses json automatically if it can, but set raw works)
					// We'll use set with the raw string
					await upstashRedis.set(key, val);
					migratedCount++;
				}
			} else if (type === 'hash') {
				const val = await localRedis.hGetAll(key);
				if (val && Object.keys(val).length > 0) {
					await upstashRedis.hset(key, val);
					migratedCount++;
				}
			} else {
				console.log(`Skipping key ${key} of unsupported type ${type}`);
			}
			
			if (migratedCount % 500 === 0) {
				console.log(`Progress: Migrated ${migratedCount} keys...`);
			}
			
			// Small sleep to avoid Upstash rate limits (1000 requests per second is typical, but let's be safe)
			if (i % 50 === 0) {
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			
		} catch (err: any) {
			console.error(`Failed to migrate key ${key}: ${err.message}`);
			errorCount++;
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
