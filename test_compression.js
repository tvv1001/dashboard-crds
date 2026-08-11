const zlib = require('zlib');
const str = JSON.stringify({ hello: "world".repeat(100) });
const compressed = zlib.brotliCompressSync(Buffer.from(str)).toString('base64');
console.log(str.length, compressed.length);
