require('dotenv').config({ path: '.env.local' });
require('dotenv').config();
import { getTopCrdsFromZset } from './pages/api/_lib.ts';

async function test() {
  const topFirmCrds = await getTopCrdsFromZset('firm', 20);
  console.log("topFirmCrds from zset:", topFirmCrds);
  const topIndCrds = await getTopCrdsFromZset('individual', 20);
  console.log("topIndCrds from zset:", topIndCrds);
}
test().catch(console.error);
