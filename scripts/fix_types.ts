import fs from 'fs';
let content = fs.readFileSync('src/types/index.ts', 'utf8');
content = content.replace("currentAddress?: string;", "currentAddress?: string;\n\tcurrentFirm?: string;\n\tcurrentFirmCrd?: string;");
fs.writeFileSync('src/types/index.ts', content);
