const { createClient } = require('redis');
async function run() {
    const client = createClient({ url: 'redis://127.0.0.1:6379' });
    await client.connect();
    await client.del('dashboard:cached-crd-count');
    console.log("Deleted cache key");
    process.exit(0);
}
run();
