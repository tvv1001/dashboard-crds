import { saveRawFile } from '../pages/api/_lib';

async function run() {
  const crd = '2614915';
  const bundle = {
    requestedKey: `owner-ref:individual:${crd}`,
    resolvedKey: `owner-ref:individual:${crd}`,
    crd,
    type: 'individual',
    orphan: {
      parentType: 'firm',
      parentCrd: '3487',
      name: 'UNKNOWN', // Or can we get the name?
    },
    sources: {
      finra: {
        key: `owner-ref:individual:${crd}`,
        found: false,
        rawPayload: null,
        payload: null,
        error: 'no live CRD — scraped reference only',
        origin: null,
      },
      sec: {
        key: `owner-ref:individual:${crd}`,
        found: false,
        rawPayload: null,
        payload: null,
        error: 'no live CRD — scraped reference only',
        origin: null,
      },
    },
  };

  await saveRawFile(`owner-ref:individual:${crd}`, bundle);
  console.log(`Saved owner-ref:individual:${crd}`);
}

run().catch(console.error);
