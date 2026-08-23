require('dotenv').config();
const { refreshSavedKeyIndexFromRedis } = require('./.next/server/pages/api/_lib.js');
refreshSavedKeyIndexFromRedis().then(res => {
    console.log('Rebuilt', res.length, 'keys');
    process.exit(0);
}).catch(console.error);
