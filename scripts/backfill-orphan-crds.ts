// One-off: persist the synthetic "orphan" bundle (owner-reference-only CRDs
// with no live FINRA/SEC record) into Redis so lookups no longer depend on
// on-the-fly detection in pages/api/key.ts. Usage: tsx scripts/backfill-orphan-crds.ts <crd> [<crd> ...]
import { findOwnerReference } from '../pages/api/_graphIndex';
import { saveRawFile } from '../pages/api/_lib';

async function run() {
	const crds = process.argv
		.slice(2)
		.map((v) => v.trim())
		.filter(Boolean);
	if (!crds.length) {
		console.error('Usage: tsx scripts/backfill-orphan-crds.ts <crd> [<crd> ...]');
		process.exit(1);
	}

	for (const crd of crds) {
		const owner = await findOwnerReference(crd);
		if (!owner) {
			console.log(`${crd}: not an orphan (no owner reference found) — skipped`);
			continue;
		}

		const bundle = {
			requestedKey: `finra:individual:${crd}`,
			resolvedKey: `finra:individual:${crd}`,
			crd,
			type: 'individual',
			orphan: owner,
			sources: {
				finra: {
					key: `finra:individual:${crd}`,
					found: false,
					rawPayload: null,
					payload: null,
					error: 'no live CRD — scraped reference only',
					origin: null,
				},
				sec: {
					key: `sec:individual:${crd}`,
					found: false,
					rawPayload: null,
					payload: null,
					error: 'no live CRD — scraped reference only',
					origin: null,
				},
			},
		};

		await saveRawFile(`finra:individual:${crd}`, bundle);
		console.log(`${crd}: saved orphan bundle (parent firm CRD ${owner.parentCrd})`);
	}
}

run().catch((err) => {
	console.error(err);
	process.exit(1);
});
