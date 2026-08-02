import { promises as fs } from 'fs';
import path from 'path';
import fetch from 'node-fetch';

const OK_RURAL_COUNTIES = [
  { name: 'Cimarron', url: 'https://batch.openaddresses.io/data/us/ok/cimarron.csv' },
  { name: 'Texas', url: 'https://batch.openaddresses.io/data/us/ok/texas.csv' }, // Texas County, OK
  { name: 'Beaver', url: 'https://batch.openaddresses.io/data/us/ok/beaver.csv' },
  { name: 'Harper', url: 'https://batch.openaddresses.io/data/us/ok/harper.csv' }
];

interface PropertyRecord {
  owner: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  source: string;
  county: string;
}

async function fetchOklahomaRuralData() {
  const allRecords: PropertyRecord[] = [];
  
  for (const county of OK_RURAL_COUNTIES) {
    console.log(`Fetching rural data for ${county.name} County, OK...`);
    try {
      const response = await fetch(county.url);
      if (!response.ok) {
        console.warn(`Could not fetch data for ${county.name}: ${response.statusText}`);
        continue;
      }
      
      const text = await response.text();
      const lines = text.split('\n');
      const headers = lines[0].split(',');
      
      // Basic CSV parsing for OpenAddresses format
      // Headers usually: LON, LAT, NUMBER, STREET, UNIT, CITY, DISTRICT, REGION, POSTCODE, ID, HASH
      const numIdx = headers.indexOf('NUMBER');
      const streetIdx = headers.indexOf('STREET');
      const cityIdx = headers.indexOf('CITY');
      const zipIdx = headers.indexOf('POSTCODE');
      
      for (let i = 1; i < Math.min(lines.length, 100); i++) { // Sample 100 per county for now
        const cells = lines[i].split(',');
        if (cells.length < headers.length) continue;
        
        allRecords.push({
          owner: 'Unknown (OpenAddresses)', // OpenAddresses usually doesn't have owner names in CSV
          address: `${cells[numIdx]} ${cells[streetIdx]}`.trim(),
          city: cells[cityIdx] || '',
          state: 'OK',
          zip: cells[zipIdx] || '',
          source: 'OpenAddresses',
          county: county.name
        });
      }
    } catch (error) {
      console.error(`Error processing ${county.name}:`, error);
    }
  }
  
  const indexPath = path.resolve(process.cwd(), 'data', 'derived', 'property-index.json');
  let existing: any[] = [];
  try {
    const content = await fs.readFile(indexPath, 'utf-8');
    existing = JSON.parse(content);
  } catch (e) {
    console.log('Creating new property index.');
  }
  
  const updated = [...existing, ...allRecords];
  await fs.writeFile(indexPath, JSON.stringify(updated, null, 2));
  console.log(`Added ${allRecords.length} rural Oklahoma records to the index.`);
}

fetchOklahomaRuralData().catch(console.error);
