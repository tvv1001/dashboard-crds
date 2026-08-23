require('dotenv').config();
const { createClient } = require('redis');
const client = createClient({ url: process.env.REDIS_URL || 'redis://127.0.0.1:6379' });
client.connect().then(async () => {
    let keys = await client.keys('finra:individual:*');
    console.log('finra:individual:*', keys.length);
    keys = await client.keys('finra:firm:*');
    console.log('finra:firm:*', keys.length);
    process.exit(0);
});
