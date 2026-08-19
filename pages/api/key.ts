import type { NextApiRequest, NextApiResponse } from 'next';
import { formatErrorMessage, loadCombinedSavedPayloadBundle, removeSavedPayload, discoverFirmIdsFromPayload, trackFirmConnections } from './_lib';
import { findOwnerReference, findEmploymentReference, type OwnerReference, type EmploymentReference } from './_graphIndex';

function parseSavedKey(key: string) {
	const raw = String(key || '')
		.trim()
		.replace(/^\/+|\/+$/g, '');
	const matchWithSource = raw.match(/^(finra|sec)[:\/](individual|firm)[:\/](\d+)(?:\.json)?$/i);
	if (matchWithSource) {
		return {
			source: matchWithSource[1].toLowerCase() as 'finra' | 'sec',
			type: matchWithSource[2].toLowerCase() as 'individual' | 'firm',
			crd: matchWithSource[3],
		};
	}
	const matchTypeOnly = raw.match(/^(individual|firm)[:\/](\d+)(?:\.json)?$/i);
	if (matchTypeOnly) {
		return {
			source: 'finra' as const,
			type: matchTypeOnly[1].toLowerCase() as 'individual' | 'firm',
			crd: matchTypeOnly[2],
		};
	}
	const matchCrdOnly = raw.match(/^(\d+)$/);
	if (matchCrdOnly) {
		return {
			source: 'finra' as const,
			type: 'individual' as const,
			crd: matchCrdOnly[1],
		};
	}
	return null;
}

function isMissingSavedPayloadError(error: unknown) {
	const message = formatErrorMessage(error).toLowerCase();
	return message.includes('saved payload not found in redis') || message.includes('raw json not found');
}

type SavedKeySource = 'finra' | 'sec';
type SavedKeyType = 'individual' | 'firm';

// Builds a synthetic "no live CRD" bundle for individuals that only exist as
// a directOwners/indirectOwners reference scraped from a firm's own detail
// payload (see findOwnerReference in _graphIndex.ts). The `orphan` field is
// what src/components/panel/StatusBox.tsx checks to render a generic
// name/position card with FINRA/SEC links pointing at the parent firm
// instead of a dead-end record-not-found error.
function buildOrphanBundle(type: SavedKeyType, crd: string, requestedKey: string, reference: OwnerReference | EmploymentReference) {
	const emptySource = (source: SavedKeySource) => ({
		key: `${source}:${type}:${crd}`,
		found: false,
		rawPayload: null,
		payload: null,
		error: 'no live CRD — scraped reference only',
		origin: null,
	});
	return {
		requestedKey,
		resolvedKey: requestedKey,
		crd,
		type,
		orphan: reference,
		sources: {
			finra: emptySource('finra'),
			sec: emptySource('sec'),
		},
	};
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
	const key = String(req.query.name || '').trim();
	if (!key) return res.status(400).json({ error: 'Missing key name' });
	const parsed = parseSavedKey(key);
	// Always try FINRA first for combined loads when the caller only guessed a source
	// (path deep-links prefer sec historically). Redis primary for people is usually FINRA.
	const preferredLoadKey =
		parsed ?
			parsed.source === 'sec' ?
				`finra:${parsed.type}:${parsed.crd}`
			:	`${parsed.source}:${parsed.type}:${parsed.crd}`
		:	key;
	const canonicalKey = parsed ? `${parsed.source}:${parsed.type}:${parsed.crd}` : key;
	const alternateType = parsed && parsed.type === 'individual' ? 'firm' : 'individual';
	const loadKeysToTry =
		parsed ?
			Array.from(
				new Set([
					preferredLoadKey,
					canonicalKey,
					`finra:${parsed.type}:${parsed.crd}`,
					`sec:${parsed.type}:${parsed.crd}`,
					`finra:${alternateType}:${parsed.crd}`,
					`sec:${alternateType}:${parsed.crd}`,
				]),
			)
		:	[key];

	async function loadFirstAvailableBundle() {
		let lastError: unknown = null;
		for (const candidate of loadKeysToTry) {
			try {
				return await loadCombinedSavedPayloadBundle(candidate);
			} catch (error) {
				lastError = error;
				if (!isMissingSavedPayloadError(error)) throw error;
			}
		}
		throw lastError || new Error(`Saved payload not found in Redis for key: ${canonicalKey}`);
	}

	try {
		const bundle = await loadFirstAvailableBundle();
		
		// In the background, extract firm connections to reference later
		if (bundle) {
			const firmIds = discoverFirmIdsFromPayload(bundle);
			if (firmIds.length > 0) {
				trackFirmConnections(firmIds).catch(() => {});
			}
		}

		// Never surface an orphan card when Redis already has a live individual record,
		// even if this CRD also appears as a firm owner reference.
		return res.json({
			rawPayload: JSON.stringify(bundle, null, 2),
			requestedKey: key,
			resolvedKey: bundle.resolvedKey,
			fallbackUsed: bundle.resolvedKey !== key,
			bundle,
		});
	} catch (e) {
		if (parsed && isMissingSavedPayloadError(e)) {
			const alternateSource = parsed.source === 'finra' ? 'sec' : 'finra';
			const swappedType = parsed.type === 'individual' ? 'firm' : 'individual';
			const candidateKeys = [
				`${alternateSource}:${parsed.type}:${parsed.crd}`,
				`${parsed.source}:${swappedType}:${parsed.crd}`,
				`${alternateSource}:${swappedType}:${parsed.crd}`,
			];

			for (const candidateKey of candidateKeys) {
				try {
					const bundle = await loadCombinedSavedPayloadBundle(candidateKey);
					return res.json({
						rawPayload: JSON.stringify(bundle, null, 2),
						requestedKey: key,
						resolvedKey: candidateKey,
						fallbackUsed: true,
						bundle,
					});
				} catch {
					// Redis-only: keep trying the other source/type keys
				}
			}

			// Orphan only as last resort: no Redis/live/national payload at all,
			// and the CRD only exists as a scraped owner reference on a firm.
			if (parsed.type === 'individual') {
				const ownerReference = await findOwnerReference(parsed.crd).catch(() => null);
				if (ownerReference) {
					const orphanBundle = buildOrphanBundle(parsed.type, parsed.crd, key, ownerReference);
					return res.json({
						rawPayload: JSON.stringify(orphanBundle, null, 2),
						requestedKey: key,
						resolvedKey: key,
						fallbackUsed: true,
						bundle: orphanBundle,
					});
				}
				const employmentReference = await findEmploymentReference(parsed.crd).catch(() => null);
				if (employmentReference) {
					const orphanBundle = buildOrphanBundle(parsed.type, parsed.crd, key, employmentReference);
					return res.json({
						rawPayload: JSON.stringify(orphanBundle, null, 2),
						requestedKey: key,
						resolvedKey: key,
						fallbackUsed: true,
						bundle: orphanBundle,
					});
				}
			} else if (parsed.type === 'firm') {
				const employmentReference = await findEmploymentReference(parsed.crd).catch(() => null);
				if (employmentReference) {
					const orphanBundle = buildOrphanBundle(parsed.type, parsed.crd, key, employmentReference);
					return res.json({
						rawPayload: JSON.stringify(orphanBundle, null, 2),
						requestedKey: key,
						resolvedKey: key,
						fallbackUsed: true,
						bundle: orphanBundle,
					});
				}
			}

			await removeSavedPayload(key).catch(() => {});
		}
		const error = e as NodeJS.ErrnoException;
		if ((error && error.code === 'ENOENT') || isMissingSavedPayloadError(e)) {
			return res.status(404).json({ error: `Raw JSON not found for ${key}` });
		}
		return res.status(500).json({ error: formatErrorMessage(e) });
	}
}
