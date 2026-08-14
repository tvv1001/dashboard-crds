import { promises as fs } from 'fs';
import path from 'path';
import { brotliCompressSync } from 'zlib';
import { config as loadEnv } from 'dotenv';
import { Redis } from '@upstash/redis';

loadEnv({ path: path.resolve(process.cwd(), '.env.local') });
loadEnv({ path: path.resolve(process.cwd(), '.env') });

const redis = new Redis({
	url: process.env.UPSTASH_REDIS_REST_URL || '',
	token: process.env.UPSTASH_REDIS_REST_TOKEN || ''
});

// We can just use the app's _lib to build the index locally
async function main() {
	console.log('Starting index build...');
	// We will write a custom builder here since we are in a node script
    // Wait, it's easier to just call a local script to read keys and build.
}
main().catch(console.error);
