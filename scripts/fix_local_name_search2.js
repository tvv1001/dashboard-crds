const fs = require('fs');

let content = fs.readFileSync('pages/api/local-name-search.ts', 'utf8');

if (!content.includes('searchExternalFallback')) {
    content = content.replace(
        "import { searchLocalIndexMany, extractSearchQueries, hasMinimumSearchQuery } from '../../src/lib/localSearch';",
        "import { searchLocalIndexMany, extractSearchQueries, hasMinimumSearchQuery } from '../../src/lib/localSearch';\nimport { searchExternalFallback } from '../../src/lib/searchExternalFallback';"
    );
}

if (!content.includes('if (allDocs.length < limit)')) {
    const target = `
		const allDocs = [...indData.response.docs, ...firmData.response.docs];
		const total = indData.total + firmData.total;`;

    const replacement = `
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
								id: \`\${source}:\${type}:\${c}\`,
								type,
								source,
								hit: {
									id: \`\${source}:\${type}:\${c}\`,
									crd: c,
									type,
									source,
									label: type === 'firm' ? doc.firm_name : [doc.ind_firstname, doc.ind_middlename, doc.ind_lastname].filter(Boolean).join(' '),
									ind_firstname: doc.ind_firstname,
									ind_lastname: doc.ind_lastname,
									firm_name: doc.firm_name
								},
								primaryNameCandidates: [type === 'firm' ? doc.firm_name : [doc.ind_firstname, doc.ind_middlename, doc.ind_lastname].filter(Boolean).join(' ')]
							});
						}
					}
					total += ext.total || 0;
				}
			}
			allDocs.push(...newDocs);
		}`;

    content = content.replace(target, replacement);
    fs.writeFileSync('pages/api/local-name-search.ts', content);
    console.log('Added external fallback.');
} else {
    console.log('Already added.');
}
