const fs = require('fs');
let code = fs.readFileSync('pages/api/local-name-search.ts', 'utf8');

code = code.replace(/import \{ formatErrorMessage, getSearchSourceMode \} from '\.\/_lib';/, "import { formatErrorMessage, getRedisConnectionMode } from './_lib';\n\nfunction getSearchSourceMode() {\n    const mode = getRedisConnectionMode();\n    return mode === 'upstash-rest' || mode === 'redis-url' ? 'redis' : 'local';\n}");

fs.writeFileSync('pages/api/local-name-search.ts', code);
