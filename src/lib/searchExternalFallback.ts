function getNumericId(item: any, isIndividual: boolean): string {
	const keys =
		isIndividual ?
			['individualId', 'individual_id', 'crd', 'ind_crd', 'ind_source_id', 'sourceId', 'id']
		:	['firmId', 'firm_id', 'crd', 'firm_crd', 'firm_source_id', 'bdSecNumber', 'iaSecNumber', 'sourceId', 'id'];
	for (const key of keys) {
		const raw = item?.[key];
		if (raw == null) continue;
		const value = String(raw).trim();
		if (/^\d{1,10}$/.test(value)) return value;
	}
	return '';
}

export async function searchExternalFallback(source: 'finra' | 'sec', entity: 'individual' | 'firm', query: string, baseUrl: string): Promise<any | null> {
	const encoded = encodeURIComponent(query);
	const queryParams = entity === 'individual' ? 'hl=true&includePrevious=true&nrows=50&start=0&wt=json' : 'hl=true&nrows=50&start=0&wt=json';
	const url =
		source === 'finra' ?
			`https://api.brokercheck.finra.org/search/${entity}?query=${encoded}&${queryParams}`
		:	`https://api.adviserinfo.sec.gov/search/${entity}?query=${encoded}&${queryParams}`;

	const fetchOptions = {
		headers: {
			'Accept': 'application/json',
			'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
			'Referer': source === 'finra' ? 'https://brokercheck.finra.org/' : 'https://adviserinfo.sec.gov/',
		}
	};

	try {
		const res = await fetch(url, fetchOptions);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const externalData = await res.json();
		const hits = externalData?.hits?.hits || [];
		if (!hits.length) return null;

		const results = hits.map((hit: any) => hit?._source || hit);

		// Perform background caching loop (non-blocking)
		(async () => {
			for (const item of results) {
				const id = getNumericId(item, entity === 'individual');
				if (!id) continue;
				try {
					const detailUrl = `${baseUrl}/api/key?name=${source}:${entity}:${encodeURIComponent(id)}`;
					// Fetch the local API endpoint to trigger cachedFetch loading details into Redis
					await fetch(detailUrl).catch(() => {});
					// Delay between requests to respect paced sequence crawling conventions
					await new Promise((resolve) => setTimeout(resolve, 300));
				} catch (err: any) {}
			}
		})().catch((err) => {});

		return {
			total: externalData?.hits?.total || hits.length,
			docs: results.map((r: any) => ({ ...r, type: entity, source }))
		};
	} catch (err: any) {
		return null;
	}
}
