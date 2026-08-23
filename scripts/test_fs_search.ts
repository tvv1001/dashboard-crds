import fs from 'fs';
const data = JSON.parse(fs.readFileSync('data/search-index.json', 'utf8'));
console.log(`Loaded ${data.length} entries.`);
const albany = data.filter((e: any) => e.name.toLowerCase().includes('albany') || e.aliases.some((a: any) => a.toLowerCase().includes('albany')));
console.log(`Found ${albany.length} albany matches.`);
