import { Redis as UpstashRedis } from '@upstash/redis';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });
dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: true });

async function run() {
	const upstashUrl = process.env.UPSTASH_REDIS_REST_URL;
	const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;
	const upstashRedis = new UpstashRedis({ url: upstashUrl, token: upstashToken });
    const keys = await upstashRedis.keys('*3013195*');
    console.log(keys);
}
run();
