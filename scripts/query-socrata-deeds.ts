import { promises as fs } from 'fs';
import path from 'path';
import fetch from 'node-fetch';

const SOCRATA_CATALOG_API = 'https://api.us.socrata.com/api/catalog/v1';

interface SocrataResult {
  resource: {
    name: string;
    description: string;
    id: string;
    domain: string;
    type: string;
    updatedAt: string;
    permalink: string;
  };
  classification: {
    categories: string[];
    tags: string[];
  };
}

interface SocrataResponse {
  results: SocrataResult[];
  count: number;
}

async function querySocrata(query: string, state: string): Promise<SocrataResult[]> {
  const url = `${SOCRATA_CATALOG_API}?q=${encodeURIComponent(query + ' ' + state)}&limit=100`;
  console.log(`Querying Socrata for: "${query}" in ${state}...`);
  
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Socrata API error: ${response.statusText}`);
    }
    const data = (await response.json()) as SocrataResponse;
    return data.results;
  } catch (error) {
    console.error(`Error querying Socrata for "${query}" ${state}:`, error);
    return [];
  }
}

async function main() {
  const states = ['Oklahoma', 'Texas'];
  const keywords = ['land deed', 'quitclaim', 'property records', 'unclaimed property'];

  for (const state of states) {
    const stateDir = path.resolve(process.cwd(), 'data', 'states', state.toLowerCase(), 'raw');
    await fs.mkdir(stateDir, { recursive: true });

    let allResults: SocrataResult[] = [];
    const seenIds = new Set<string>();

    for (const keyword of keywords) {
      const results = await querySocrata(keyword, state);
      for (const result of results) {
        if (!seenIds.has(result.resource.id)) {
          seenIds.add(result.resource.id);
          allResults.push(result);
        }
      }
    }

    const outputPath = path.join(stateDir, 'socrata-datasets.json');
    await fs.writeFile(outputPath, JSON.stringify(allResults, null, 2));
    console.log(`Saved ${allResults.length} unique datasets for ${state} to ${outputPath}`);
  }
}

main().catch(console.error);
