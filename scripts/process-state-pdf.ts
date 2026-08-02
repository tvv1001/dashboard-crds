import axios from 'axios';
import { promises as fs } from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pdf = require('pdf-parse');

async function processStatePdf(state: string, url: string, filename: string) {
    const stateDir = path.resolve(process.cwd(), 'data', 'states', state.toLowerCase());
    const rawDir = path.join(stateDir, 'raw');
    const processedDir = path.join(stateDir, 'processed');

    try {
        await fs.mkdir(rawDir, { recursive: true });
        await fs.mkdir(processedDir, { recursive: true });

        const rawPath = path.join(rawDir, filename);
        const processedPath = path.join(processedDir, `${path.parse(filename).name}.json`);

        console.log(`Downloading PDF from ${url}...`);
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        await fs.writeFile(rawPath, response.data);
        console.log(`Saved raw PDF to ${rawPath}`);

        console.log(`Extracting text from PDF...`);
        const data = await pdf(response.data);
        
        const result = {
            state,
            sourceUrl: url,
            processedAt: new Date().toISOString(),
            metadata: data.metadata,
            info: data.info,
            text: data.text,
            // In the future, we can add more specific parsing logic here
            // to extract CRDs, Names, etc.
        };

        await fs.writeFile(processedPath, JSON.stringify(result, null, 2));
        console.log(`Saved processed data to ${processedPath}`);
        
        return result;
    } catch (error) {
        console.error(`Error processing PDF:`, error);
        throw error;
    }
}

const args = process.argv.slice(2);
const [state, url, filename] = args;

if (!state || !url || !filename) {
    console.log('Usage: tsx scripts/process-state-pdf.ts <state> <url> <filename>');
    console.log('Example: tsx scripts/process-state-pdf.ts oklahoma https://example.com/list.pdf ok-list.pdf');
    process.exit(1);
}

processStatePdf(state, url, filename);
