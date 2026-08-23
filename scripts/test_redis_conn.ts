import Redis from 'ioredis';
const redis = new Redis('redis://127.0.0.1:6379', {
    connectTimeout: 500,
    maxRetriesPerRequest: 0
});
redis.ping().then(console.log).catch(console.error).finally(() => redis.disconnect());
