import { listSavedKeysWithStats } from './pages/api/_lib.ts';

async function test() {
  const result = await listSavedKeysWithStats({ limit: 0, includeCrds: ['343460'] });
  console.log(result.keys.map(k => k.crd));
}
test().catch(console.error);
