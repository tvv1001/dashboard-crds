import { createClient } from 'redis';
import { Redis as UpstashRedis } from '@upstash/redis';
import dotenv from 'dotenv';
import path from 'path';

// Load both .env and .env.local
dotenv.config({ path: path.resolve(process.cwd(), '.env') });
dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: true });

async function buildIndex() {
	const localUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
	const upstashUrl = process.env.UPSTASH_REDIS_REST_URL;
	const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;

	if (!upstashUrl || !upstashToken) {
		console.error("Missing Upstash REST URL or Token.");
		process.exit(1);
	}

	console.log(`Connecting to local Redis at ${localUrl}...`);
	const localRedis = createClient({ url: localUrl });
	await localRedis.connect();

	console.log(`Connecting to production Upstash Redis at ${upstashUrl}...`);
	const upstashRedis = new UpstashRedis({ url: upstashUrl, token: upstashToken });

	console.log("Fetching keys from local Redis...");
	const keys = await localRedis.keys('*');
	
	const crdKeys = keys.filter(k => /^(finra|sec):(individual|firm):\d+$/i.test(k));
	console.log(`Found ${crdKeys.length} CRD keys.`);

	const entries: any[] = [];
	
	for (let i = 0; i < crdKeys.length; i++) {
		const key = crdKeys[i];
		const match = key.match(/^(finra|sec):(individual|firm):(\d+)$/i);
		if (!match) continue;
		
		const source = match[1].toLowerCase();
		const type = match[2].toLowerCase();
		const crd = match[3];
		
		let displayName = '';
		try {
			const val = await localRedis.get(key);
			if (val) {
				const payload = JSON.parse(val);
				if (payload?.finraBrokerCheck?.basicInformation?.firstName) {
					displayName = `${payload.finraBrokerCheck.basicInformation.firstName} ${payload.finraBrokerCheck.basicInformation.lastName}`;
				} else if (payload?.secInvestmentAdvisor?.basicInformation?.firstName) {
					displayName = `${payload.secInvestmentAdvisor.basicInformation.firstName} ${payload.secInvestmentAdvisor.basicInformation.lastName}`;
				} else if (payload?.finraBrokerCheck?.organizationName) {
					displayName = payload.finraBrokerCheck.organizationName;
				} else if (payload?.secInvestmentAdvisor?.organizationName) {
					displayName = payload.secInvestmentAdvisor.organizationName;
				}
			}
		} catch (e) {}

		entries.push({
			key,
			mtime: Date.now(),
			source,
			type,
			crd,
			displayName: displayName.trim() || undefined,
			industryDate: null,
			isActive: true
		});
	}
	
	console.log(`Successfully built index with ${entries.length} entries.`);
	
	const payload = JSON.stringify(
		{
			generatedAt: new Date().toISOString(),
			entries: entries.sort((a, b) => b.mtime - a.mtime),
		},
		null,
		0,
	);
	
	console.log(`Saving payload to finra-sec:cache:rawKeysIndex (${Math.round(payload.length / 1024)} KB)...`);
	await upstashRedis.set('finra-sec:cache:rawKeysIndex', payload, { ex: 43200 });
	
	console.log(`Done!`);
	process.exit(0);
}
buildIndex().catch(console.error);
