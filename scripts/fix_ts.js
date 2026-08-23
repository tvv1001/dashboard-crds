const fs = require('fs');

// Fix _lib.ts
let code = fs.readFileSync('pages/api/_lib.ts', 'utf8');
code = code.replace(/if \(writableUpstashClient2\) \{\n\t\t\ttry \{\n\t\t\t\tif \(ttlSeconds\) \{\n\t\t\t\t\tawait writableUpstashClient2\.set\(key, finalValue, \{ ex: Math\.floor\(ttlSeconds\) \}\);\n\t\t\t\t\} else \{\n\t\t\t\t\tawait writableUpstashClient2\.set\(key, finalValue\);\n\t\t\t\t\}\n\t\t\t\} catch \(e\) \{\n\t\t\t\}\n\t\t\}/g, '');
code = code.replace(/for \(const client of \[writableUpstashClient, writableUpstashClient2\]\) \{/g, 'for (const client of [writableUpstashClient]) {');
code = code.replace(/if \(writableUpstashClient2\) \{\n\t\t\ttry \{\n\t\t\t\tawait writableUpstashClient2\.sadd\(key, \.\.\.\(firmIds as \[string, \.\.\.string\[\]\]\)\);\n\t\t\t\} catch \(e\) \{\n\t\t\t\}\n\t\t\}/g, '');
code = code.replace(/if \(\!\(writableUpstashClient \|\| writableUpstashClient2 \|\| redisClient\)\) return;/g, 'if (!(writableUpstashClient || redisClient)) return;');

code = code.replace(/const res = await client\.scan\(cursor, \{ MATCH: pattern, COUNT: 1000 \}\);/g, 'const res = await client.scan(String(cursor), { MATCH: pattern, COUNT: 1000 });');
code = code.replace(/cursor = res\.cursor;/g, 'cursor = Number(res.cursor || 0);');

fs.writeFileSync('pages/api/_lib.ts', code);

// Fix localSearch.ts
let code2 = fs.readFileSync('src/lib/localSearch.ts', 'utf8');
code2 = code2.replace(/generatedAt: generatedAt \?\? null,/g, 'generatedAt: generatedAt ?? undefined,');
code2 = code2.replace(/generatedAt: parsed\.generatedAt \?\? null,/g, 'generatedAt: parsed.generatedAt ?? undefined,');
fs.writeFileSync('src/lib/localSearch.ts', code2);
