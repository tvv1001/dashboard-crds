const fs = require('fs');
let code = fs.readFileSync('pages/api/_lib.ts', 'utf8');

// Find all occurrences of writableUpstashClient2 and replace the block
// Since there are only a few, let's just use string replacement or regex carefully
code = code.replace(/if\s*\(writableUpstashClient2\)\s*\{[\s\S]*?\n\t\t\}/g, '');

fs.writeFileSync('pages/api/_lib.ts', code);
