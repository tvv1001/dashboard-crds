import type { NextApiRequest, NextApiResponse } from 'next';
import { formatErrorMessage, getRedisConnectionMode, loadSavedPayload, getContentBlock } from './_lib';

function getSearchSourceMode(): 'redis' | 'local' {
    const mode = getRedisConnectionMode();
    return mode === 'upstash-rest' || mode === 'redis-url' || mode === 'local-redis' ? 'redis' : 'local';
}
import { searchLocalIndexMany, extractSearchQueries, hasMinimumSearchQuery } from '../../src/lib/localSearch';
import { searchExternalFallback } from '../../src/lib/searchExternalFallback';
function toTitleCase(str: string) { return str.toLowerCase().replace(/\b\w/g, c => c.toUpperCase()); }

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
	const query = req.method === 'POST' ? req.body?.q : req.query.q;
	const rawQuery = typeof query === 'string' ? query : '';
	const searchQueries = extractSearchQueries(rawQuery);
	const terms = searchQueries.length > 0 ? searchQueries : [rawQuery.trim()].filter(Boolean);
	
	const parsedLimit = Number(req.method === 'POST' ? req.body?.limit : req.query.limit);
	const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(Math.round(parsedLimit), 200) : 12;

	if (!terms.length || !terms.some(t => hasMinimumSearchQuery(t))) {
		return res.status(200).json({
			query: rawQuery,
			terms: [],
			totalIndexed: 0,
			totalMatches: 0,
			truncated: false,
			sourceMode: getSearchSourceMode(),
			matches: [],
		});
	}

	try {
		const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';
		const [indData, firmData] = await Promise.all([
		    searchLocalIndexMany('finra', 'individual', rawQuery, { limit, offset: 0, baseUrl }),
		    searchLocalIndexMany('finra', 'firm', rawQuery, { limit, offset: 0, baseUrl })
		]);
		
		const allDocs = [...indData.response.docs, ...firmData.response.docs];
		let total = indData.total + firmData.total;

		// External API fallback if local flatfile doesn't have enough results
		if (allDocs.length < limit && rawQuery.trim().length >= 3) {
			const [extInd, extFirm] = await Promise.all([
				searchExternalFallback('finra', 'individual', rawQuery, baseUrl),
				searchExternalFallback('finra', 'firm', rawQuery, baseUrl)
			]);
			
			const newDocs = [];
			const seenCrds = new Set(allDocs.map(d => String(d.hit?.crd || d.hit?.ind_crd || d.hit?.firm_id || d.crd || d.id?.split(':').pop() || '')));
			
			for (const ext of [extInd, extFirm]) {
				if (ext && ext.docs) {
					for (const doc of ext.docs) {
						const c = doc.ind_source_id || doc.firm_source_id || doc.crd;
						if (c && !seenCrds.has(String(c))) {
							seenCrds.add(String(c));
							
							// Map FINRA format to expected hit format
							const type = doc.type || 'individual';
							const source = doc.source || 'finra';
							
							newDocs.push({
								id: `${source}:${type}:${c}`,
								type,
								source,
								hit: {
									id: `${source}:${type}:${c}`,
									crd: c,
									type,
									source,
									label: type === 'firm' ? doc.firm_name : [doc.ind_firstname, doc.ind_middlename, doc.ind_lastname].filter(Boolean).join(' '),
									ind_firstname: doc.ind_firstname,
									ind_lastname: doc.ind_lastname,
									firm_name: doc.firm_name,
									otherNames: type === 'firm' ? doc.firm_other_names : doc.ind_other_names,
									ind_current_employments: doc.ind_current_employments,
									firm_city: doc.firm_city,
									firm_state: doc.firm_state,
									firm_zip: doc.firm_zip
								},
								primaryNameCandidates: [type === 'firm' ? doc.firm_name : [doc.ind_firstname, doc.ind_middlename, doc.ind_lastname].filter(Boolean).join(' ')],
								nameCandidates: type === 'firm' ? doc.firm_other_names : doc.ind_other_names
							});
						}
					}
					total += ext.total || 0;
				}
			}
			allDocs.push(...newDocs);
		}
		
		// Map back to the legacy dashboard-crds interface expected by KeyList.tsx
		const matches = allDocs.slice(0, limit).map(doc => {
		    const hit = doc.hit || doc || {};
		    const isFirm = doc.type === 'firm' || hit.type === 'firm';
		    const crd = hit.crd || hit.ind_crd || hit.firm_id || hit.firmId || doc.crd || doc.id?.split(':').pop() || '';
		    const rawName = doc.primaryNameCandidates?.[0] || hit.label || doc.label || hit.name || hit.firm_name || hit.firmName || `${hit.ind_firstname || ''} ${hit.ind_lastname || ''}`.trim() || crd;
		    const name = toTitleCase(rawName);
		    
		    const rawAliases = Array.isArray(doc.nameCandidates) ? doc.nameCandidates : (hit.otherNames || []);
		    const aliases = rawAliases.map((n: any) => toTitleCase(String(n))).filter((n: string) => n.toLowerCase() !== name.toLowerCase());

			const employments = doc.ind_current_employments || hit.ind_current_employments || [];
			const primaryEmp = employments[0];
			const currentFirm = primaryEmp ? toTitleCase(primaryEmp.firm_name || '') : isFirm ? name : '';
			const currentFirmCrd = primaryEmp ? primaryEmp.firm_id : '';
			
			const empCity = isFirm ? (doc.firm_city || hit.firm_city || hit.city || '') : (primaryEmp ? primaryEmp.branch_city : '');
			const empState = isFirm ? (doc.firm_state || hit.firm_state || hit.state || '') : (primaryEmp ? primaryEmp.branch_state : '');
			const empZip = isFirm ? (doc.firm_zip || hit.firm_zip || hit.zip || '') : (primaryEmp ? primaryEmp.branch_zip : '');
			const currentAddress = [toTitleCase(empCity), empState, empZip].filter(Boolean).join(', ').replace(/, \d+$/, (m) => m.replace(', ', ' '));

		    // Build the expected LocalSearchEntry format
		    return {
		        type: doc.type || hit.type || (isFirm ? 'firm' : 'individual'),
		        source: doc.source || hit.source || 'finra',
		        key: doc.id || hit.id || `${doc.source || hit.source || 'finra'}:${doc.type || hit.type || (isFirm ? 'firm' : 'individual')}:${crd}`,
		        crd: String(crd),
		        name: name,
		        aliases: Array.from(new Set(aliases)),
		        finra: true,
		        sec: false,
		        searchableNames: [name, ...aliases],
		        searchableValues: [],
		        currentFirm: currentFirm,
				currentFirmCrd: currentFirmCrd,
		        secNumber: hit.bdSecNumber || '',
		        currentAddress: currentAddress,
		        currentCity: empCity,
		        currentState: empState,
		        matchedTerms: terms,
		        matchedNames: [name],
		        matchedValues: [name, ...aliases],
		        matchScore: 10
		    };
		});

		// Augment with Redis if available
		if (getSearchSourceMode() === 'redis') {
			await Promise.all(matches.map(async (m: any) => {
				try {
					const payload = await loadSavedPayload(m.key);
					if (payload) {
						const content = getContentBlock(m.key, payload);
						if (m.type === 'individual') {
							const emps = [
								...(Array.isArray(content?.currentEmployments) ? content.currentEmployments : []),
								...(Array.isArray(content?.currentIAEmployments) ? content.currentIAEmployments : [])
							];
							for (const emp of emps) {
								if (emp.firmName) {
									m.currentFirm = emp.firmName;
									const locs = Array.isArray(emp.branchOfficeLocations) ? emp.branchOfficeLocations : [];
									const loc = locs.find((l: any) => l.locatedAtFlag === 'Y') || locs[0];
									if (loc) {
										m.currentCity = loc.city || '';
										m.currentState = loc.state || '';
										m.currentAddress = [loc.street1, loc.street2, loc.city, loc.state, loc.zipCode].filter(Boolean).join(', ');
									} else {
										m.currentCity = emp.city || '';
										m.currentState = emp.state || '';
										m.currentAddress = [emp.city, emp.state].filter(Boolean).join(', ');
									}
									break;
								}
							}
						} else {
							const addr = (content as any)?.mainOfficeAddress || (content as any)?.mainAddress;
							if (addr) {
								m.currentCity = addr.city || '';
								m.currentState = addr.state || '';
								m.currentAddress = [addr.street1, addr.street2, addr.city, addr.state, addr.zipCode].filter(Boolean).join(', ');
							}
						}
						
						const otherNames = Array.isArray((content as any)?.basicInformation?.otherNames) ? (content as any).basicInformation.otherNames : [];
						if (otherNames.length) {
							m.aliases = Array.from(new Set([...m.aliases, ...otherNames]));
							m.matchedValues = Array.from(new Set([...m.matchedValues, ...otherNames]));
						}
					}
				} catch (e) {}
			}));
		}

		return res.status(200).json({
			query: rawQuery,
			terms,
			totalIndexed: total, // we don't have exact indexed count from sidecars efficiently, just return total matches
			totalMatches: total,
			truncated: total > limit,
			sourceMode: getSearchSourceMode(),
			matches: matches,
		});
	} catch (error) {
		return res.status(500).json({ error: formatErrorMessage(error) });
	}
}
