import dotenv from 'dotenv';
dotenv.config();

import { getCacheValue } from './pages/api/_lib';

async function main() {
  const finra = await getCacheValue('finra:individual:4349172');
  console.log('finra exists:', !!finra);
  const sec = await getCacheValue('sec:individual:4349172');
  console.log('sec exists:', !!sec);
}

main().catch(console.error);
