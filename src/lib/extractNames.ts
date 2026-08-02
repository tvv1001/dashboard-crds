import { parseCrdKey } from './parseKey';

function maybeParseJson(value: unknown): unknown {
	if (typeof value !== 'string') return value;
	const text = value.trim();
	if (!text) return null;
	if (!(text.startsWith('{') || text.startsWith('['))) return value;
	try {
		return JSON.parse(text);
	} catch {
		return value;
	}
}

// Digs through the various saved-payload/API-response shapes (combined
// bundle, raw FINRA/SEC search responses, ES/solr-like hit wrappers) to
// find the actual record content block for the requested source/type.
export function getContentBlock(payload: any, source: string, type: string): any {
	const parsed = maybeParseJson(payload);
	if (!parsed || typeof parsed !== 'object') return null;
	if (Array.isArray(parsed)) return null;

	const body = parsed as Record<string, any>;

	// Combined saved-payload bundle shape returned by /api/key: { sources: { finra: { payload }, sec: { payload } } }
	if (body.sources && typeof body.sources === 'object') {
		const preferred = body.sources[source]?.payload;
		const other = source === 'finra' ? body.sources.sec?.payload : body.sources.finra?.payload;
		const candidate = preferred ?? other;
		if (candidate != null) return getContentBlock(candidate, source, type);
	}

	if (body.finraBrokerCheck) return getContentBlock(body.finraBrokerCheck, source, type);
	if (body.secInvestmentAdvisor) return getContentBlock(body.secInvestmentAdvisor, source, type);

	const firstHit = Array.isArray(body.hits?.hits) ? body.hits.hits[0] : null;
	if (firstHit && typeof firstHit === 'object') {
		const hitSource = firstHit._source;
		if (hitSource && typeof hitSource === 'object') {
			if (hitSource.content != null) return getContentBlock(hitSource.content, source, type);
			if (hitSource.iacontent != null) return getContentBlock(hitSource.iacontent, source, type);
			return getContentBlock(hitSource, source, type);
		}
		if (firstHit.content != null) return getContentBlock(firstHit.content, source, type);
		if (firstHit.iacontent != null) return getContentBlock(firstHit.iacontent, source, type);
	}

	if (body._source && typeof body._source === 'object') {
		if (body._source.content != null) return getContentBlock(body._source.content, source, type);
		if (body._source.iacontent != null) return getContentBlock(body._source.iacontent, source, type);
		return getContentBlock(body._source, source, type);
	}

	if (source === 'finra') {
		const candidate = body.finraBrokerCheck ?? body.bccontent ?? (type === 'firm' ? body.content : null);
		if (candidate && candidate !== body) return getContentBlock(candidate, source, type);
		return body;
	}
	if (source === 'sec') {
		const candidate = body.secInvestmentAdvisor ?? body.iacontent;
		if (candidate && candidate !== body) return getContentBlock(candidate, source, type);
		return body;
	}

	return body;
}

export function extractNamesFromPayload(payload: any, type: 'individual' | 'firm'): { primary: string; aliases: string[] } {
	if (!payload || typeof payload !== 'object') {
		return { primary: '', aliases: [] };
	}

	const basicInformation = payload.basicInformation || {};
	const names: string[] = [];
	const seen = new Set<string>();

	const add = (val: any) => {
		if (typeof val !== 'string') return;
		const trimmed = val.replace(/\s+/g, ' ').trim();
		if (trimmed.length < 2 || seen.has(trimmed.toLowerCase())) return;
		seen.add(trimmed.toLowerCase());
		names.push(trimmed);
	};

	if (type === 'individual') {
		// Try to build name from parts
		const parts = [
			basicInformation.firstName,
			basicInformation.middleName,
			basicInformation.lastName,
			basicInformation.suffix,
		].filter(p => typeof p === 'string' && p.trim().length > 0);
		
		if (parts.length > 0) add(parts.join(' '));
		
		add(basicInformation.individualName);
		add(basicInformation.fullName);
		add(basicInformation.displayName);
		add(payload.individualName);
		add(payload.fullName);
	} else {
		add(basicInformation.iaFirmName);
		add(basicInformation.firmName);
		add(basicInformation.organizationName);
		add(basicInformation.orgName);
		add(payload.primaryBusinessName);
		add(payload.firmName);
	}

	// Other names
	const otherNames = Array.isArray(basicInformation.otherNames) ? basicInformation.otherNames : [];
	for (const other of otherNames) {
		if (typeof other === 'string') {
			add(other);
		} else if (other && typeof other === 'object') {
			// Some schemas use objects for other names
			if (type === 'individual') {
				const p = [other.firstName, other.middleName, other.lastName, other.suffix].filter(x => typeof x === 'string' && x.trim().length > 0);
				if (p.length > 0) add(p.join(' '));
			} else {
				add(other.orgName);
				add(other.firmName);
			}
		}
	}

	return {
		primary: names[0] || '',
		aliases: names.slice(1)
	};
}
