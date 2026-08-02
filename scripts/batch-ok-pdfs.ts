import { spawn } from 'child_process';

const urls = [
    "https://oklahoma.gov/content/dam/ok/en/treasurer/documents/unclaimed-property/ad/2023%20DECEMBER%20Unclaimed%20Propery.pdf",
    "https://oklahoma.gov/content/dam/ok/en/treasurer/documents/unclaimed-property/ad/2023%20JUNE%20Unclaimed%20Propery.pdf",
    "https://oklahoma.gov/content/dam/ok/en/treasurer/documents/unclaimed-property/ad/2023%20MARCH%20Unclaimed%20Property.pdf",
    "https://oklahoma.gov/content/dam/ok/en/treasurer/documents/unclaimed-property/ad/2023%20SEPTEMBER%20Unclaimed%20Propery.pdf",
    "https://oklahoma.gov/content/dam/ok/en/treasurer/documents/unclaimed-property/ad/2024%20JUNE%20Unclaimed%20Propery.pdf",
    "https://oklahoma.gov/content/dam/ok/en/treasurer/documents/unclaimed-property/ad/2024%20MARCH%20Unclaimed%20Propery.pdf",
    "https://oklahoma.gov/content/dam/ok/en/treasurer/documents/unclaimed-property/ad/Dec%202024%20Unclaimed%20Property-all%20counties.pdf",
    "https://oklahoma.gov/content/dam/ok/en/treasurer/documents/unclaimed-property/ad/DECEMBER%202025%20-%20UNCLAIMED%20PROPERTY.pdf",
    "https://oklahoma.gov/content/dam/ok/en/treasurer/documents/unclaimed-property/ad/JUNE%202025%20Unclaimed%20Property.pdf",
    "https://oklahoma.gov/content/dam/ok/en/treasurer/documents/unclaimed-property/ad/March%202025%20Unclaimed%20Property.pdf",
    "https://oklahoma.gov/content/dam/ok/en/treasurer/documents/unclaimed-property/ad/safety%20deposit%20box%20ads-dec%202024.pdf"
];

async function runBatch() {
    for (const url of urls) {
        const filename = decodeURIComponent(url.split('/').pop() || 'file.pdf').replace(/\s+/g, '_');
        console.log(`--- Processing ${filename} ---`);
        
        await new Promise((resolve) => {
            const child = spawn('pnpm', ['tsx', 'scripts/process-state-pdf.ts', 'oklahoma', url, filename], {
                stdio: 'inherit'
            });
            child.on('close', resolve);
        });
    }
    console.log('Batch processing complete.');
}

runBatch();
