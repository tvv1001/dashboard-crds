import { getTopCrdsFromZset, getCacheValue } from './pages/api/_lib.ts';
async function test() {
  const crds = await getTopCrdsFromZset('firm', 1);
  console.log(crds);
}
test().catch(console.error);
