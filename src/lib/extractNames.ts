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
		// Orphan-only bundles have empty sources but still carry a scraped name on `orphan`.
		if (body.orphan && typeof body.orphan === 'object') return body;
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

function isGenericEntityLabel(name: string, type?: 'individual' | 'firm', crd?: string): boolean {
	const trimmed = String(name || '')
		.replace(/\s+/g, ' ')
		.trim();
	if (!trimmed) return true;
	const lower = trimmed.toLowerCase();
	if (/^(individual|firm|person|entity|record|unknown|n\/a|na|none)(\s+#?\d+)?$/i.test(trimmed)) return true;
	if (/^crd\s*#?\s*\d+$/i.test(trimmed)) return true;
	if (crd && new RegExp(`^(individual|firm|person|crd)\\s*#?\\s*${crd}$`, 'i').test(trimmed)) return true;
	if (type && crd && lower === `${type} ${crd}`.toLowerCase()) return true;
	return false;
}

/** Pull a display name from an /api/key orphan card when present. */
export function extractOrphanName(payload: any): string {
	if (!payload || typeof payload !== 'object') return '';
	const orphan = (payload as any).orphan;
	if (!orphan || typeof orphan !== 'object') return '';
	const name = typeof orphan.name === 'string' ? orphan.name.replace(/\s+/g, ' ').trim() : '';
	return name.length >= 2 ? name : '';
}

/**
 * Resolve a human display name from a content block, full /api/key bundle,
 * or orphan card. Never invents "Individual/Firm &lt;crd&gt;" placeholders —
 * returns '' when no real name is available (callers may show CRD separately).
 */
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
		if (isGenericEntityLabel(trimmed, type)) return;
		seen.add(trimmed.toLowerCase());
		names.push(trimmed);
	};

	// Orphan-only bundles (no FINRA/SEC payload) — scraped owner/employee name.
	add(extractOrphanName(payload));

	if (type === 'individual') {
		// Try to build name from parts
		const parts = [basicInformation.firstName, basicInformation.middleName, basicInformation.lastName, basicInformation.suffix].filter(
			(p) => typeof p === 'string' && p.trim().length > 0,
		);

		if (parts.length > 0) add(parts.join(' '));

		add(basicInformation.individualName);
		add(basicInformation.fullName);
		add(basicInformation.displayName);
		add(payload.individualName);
		add(payload.fullName);
		add(payload.name);
		add(payload.ownerName);
		add(payload.legalName);
		add(payload.personName);
	} else {
		add(basicInformation.iaFirmName);
		add(basicInformation.firmName);
		add(basicInformation.organizationName);
		add(basicInformation.orgName);
		add(payload.primaryBusinessName);
		add(payload.firmName);
		add(payload.orgName);
		add(payload.organizationName);
		add(payload.legalName);
		add(payload.name);
	}

	// Other names
	const otherNames = Array.isArray(basicInformation.otherNames) ? basicInformation.otherNames : [];
	for (const other of otherNames) {
		if (typeof other === 'string') {
			add(other);
		} else if (other && typeof other === 'object') {
			// Some schemas use objects for other names
			if (type === 'individual') {
				const p = [other.firstName, other.middleName, other.lastName, other.suffix].filter((x) => typeof x === 'string' && x.trim().length > 0);
				if (p.length > 0) add(p.join(' '));
			} else {
				add(other.orgName);
				add(other.firmName);
			}
		}
	}

	return {
		primary: names[0] || '',
		aliases: names.slice(1),
	};
}

/**
 * Best-effort display name for UI surfaces (panel, graphs, history).
 * Prefers real names; falls back to bare CRD digits only (never "Individual 123").
 */
export function resolveEntityDisplayName(options: {
	payload?: any;
	type: 'individual' | 'firm';
	crd?: string;
	source?: string;
	candidates?: Array<string | null | undefined>;
}): string {
	const { payload, type, crd, source = 'finra', candidates = [] } = options;
	const tryName = (value: unknown): string => {
		if (typeof value !== 'string') return '';
		const trimmed = value.replace(/\s+/g, ' ').trim();
		if (!trimmed || isGenericEntityLabel(trimmed, type, crd)) return '';
		return trimmed;
	};

	for (const c of candidates) {
		const hit = tryName(c);
		if (hit) return hit;
	}

	if (payload && typeof payload === 'object') {
		const orphan = tryName(extractOrphanName(payload));
		if (orphan) return orphan;
		const content = getContentBlock(payload, source, type);
		const fromContent = tryName(extractNamesFromPayload(content ?? payload, type).primary);
		if (fromContent) return fromContent;
		const fromPayload = tryName(extractNamesFromPayload(payload, type).primary);
		if (fromPayload) return fromPayload;
	}

	return crd ? String(crd) : '';
}
