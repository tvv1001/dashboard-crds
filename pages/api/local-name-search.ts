import type { NextApiRequest, NextApiResponse } from 'next';
import { formatErrorMessage, getRedisConnectionMode } from './_lib';

function getSearchSourceMode() {
    const mode = getRedisConnectionMode();
    return mode === 'upstash-rest' || mode === 'redis-url' ? 'redis' : 'local';
}
import { searchLocalIndexMany, extractSearchQueries, hasMinimumSearchQuery } from '../../src/lib/localSearch';

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
		const total = indData.total + firmData.total;
		
		// Map back to the legacy dashboard-crds interface expected by KeyList.tsx
		const matches = allDocs.slice(0, limit).map(doc => {
		    const hit = doc.hit || {};
		    const isFirm = doc.type === 'firm';
		    const crd = isFirm ? hit.firm_id : hit.ind_crd;
		    const name = isFirm ? hit.firm_name : `${hit.ind_firstname || ''} ${hit.ind_lastname || ''}`.trim();
		    
		    // Build the expected LocalSearchEntry format
		    return {
		        type: doc.type,
		        crd: String(crd),
		        name: name,
		        aliases: (hit.otherNames || []).map((n: any) => String(n)),
		        finra: true,
		        sec: false,
		        searchableNames: [name, ...(hit.otherNames || [])],
		        searchableValues: [], // No longer needed with the sidecar pre-computed search
		        currentFirm: '',
		        secNumber: hit.bdSecNumber || '',
		        currentAddress: '',
		        currentCity: '',
		        currentState: '',
		        matchedTerms: terms,
		        matchedNames: [name],
		        matchedValues: [name],
		        matchScore: 10
		    };
		});

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
