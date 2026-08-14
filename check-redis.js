const { Redis } = require('@upstash/redis');
require('dotenv').config({ path: '.env.local' });
require('dotenv').config({ path: '.env' });
const redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
redis.dbsize().then(size => console.log('DB SIZE:', size)).catch(console.error);
