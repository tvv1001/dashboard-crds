import re

with open('pages/api/_lib.ts', 'r') as f:
    content = f.read()

old_size = """		let total = 0;
		for (const client of [upstashRedisClient, upstashRedisClient2]) {
			if (!client) continue;
			try {
				total += await client.dbsize();
			} catch (e) {}
		}
		
		// Only write back to cache if we have both configured, ensuring environments with only one connection don't overwrite with a partial count
		if (upstashRedisClient && upstashRedisClient2) {"""

new_size = """		let total = 0;
		let usingUpstash = false;
		for (const client of [upstashRedisClient, upstashRedisClient2]) {
			if (!client) continue;
			usingUpstash = true;
			try {
				total += await client.dbsize();
			} catch (e) {}
		}
		
		if (!usingUpstash) {
			try {
				const client = await getRedisClient();
				if (client) total = await client.dbSize();
			} catch (e) {}
		}
		
		// Only write back to cache if we have both configured, ensuring environments with only one connection don't overwrite with a partial count
		if (upstashRedisClient && upstashRedisClient2) {"""

content = content.replace(old_size, new_size)

with open('pages/api/_lib.ts', 'w') as f:
    f.write(content)
