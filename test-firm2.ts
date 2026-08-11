import { loadCombinedSavedPayloadBundle } from './pages/api/_lib.js';
async function run() {
  const bundle = await loadCombinedSavedPayloadBundle('finra:firm:30016');
  console.log(JSON.stringify(Object.keys(bundle.sources.finra?.payload || {}), null, 2));
}
run();
