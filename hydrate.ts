import dotenv from 'dotenv';
dotenv.config();

process.env.ALLOW_REDIS_WRITES = '1';

import { saveRawFile } from './pages/api/_lib';

async function main() {
  const finraUrl = 'https://api.brokercheck.finra.org/search/individual/4349172?includePrevious=true';
  const secUrl = 'https://api.adviserinfo.sec.gov/search/individual/4349172?includePrevious=true';
  
  const finraRes = await fetch(finraUrl);
  const finraData = await finraRes.json();
  await saveRawFile('finra:individual:4349172', { finraBrokerCheck: finraData });
  console.log('Saved finra');

  const secRes = await fetch(secUrl);
  const secData = await secRes.json();
  await saveRawFile('sec:individual:4349172', { secInvestmentAdvisor: secData });
  console.log('Saved sec');
}

main().catch(console.error);
