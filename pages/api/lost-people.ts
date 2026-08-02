import type { NextApiRequest, NextApiResponse } from 'next';
import { promises as fs } from 'fs';
import path from 'path';
import { formatErrorMessage } from './_lib';

type LostPeopleState = 'texas' | 'oklahoma' | 'all';
type LostPeopleSourceType = 'obituary' | 'crime-news' | 'police-report';

export interface LostPersonRecord {
	id: string;
	state: Exclude<LostPeopleState, 'all'>;
	sourceType: LostPeopleSourceType;
	title: string;
	summary: string;
	personName?: string;
	location?: string;
	agency?: string;
	publishedAt?: string;
	url?: string;
	identifiers?: Array<{ type: string; value: string; available: boolean }>;
	tags?: string[];
}

interface LostPeopleResponse {
	state: LostPeopleState;
	query: string;
	limit: number;
	total: number;
	results: LostPersonRecord[];
	sourceTypes: LostPeopleSourceType[];
}

const DATA_PATH = path.resolve(process.cwd(), 'data', 'lost-people.json');
const DEFAULT_LIMIT = 20;
const SUPPORTED_SOURCE_TYPES: LostPeopleSourceType[] = ['obituary', 'crime-news', 'police-report'];

function normalizeState(raw: string | undefined): LostPeopleState {
	const value = String(raw || '')
		.trim()
		.toLowerCase();
	if (value === 'tx' || value === 'texas') return 'texas';
	if (value === 'ok' || value === 'oklahoma') return 'oklahoma';
	return 'all';
}

function normalizeQuery(raw: string | undefined): string {
	return String(raw || '').trim();
}

function normalizeSourceTypes(raw: string | undefined): LostPeopleSourceType[] {
	if (!raw) return SUPPORTED_SOURCE_TYPES;
	const values = raw
		.split(',')
		.map((value) => value.trim().toLowerCase())
		.filter(Boolean);
	if (!values.length) return SUPPORTED_SOURCE_TYPES;
	return values.filter((value): value is LostPeopleSourceType => SUPPORTED_SOURCE_TYPES.includes(value as LostPeopleSourceType));
}

function normalizeLimit(raw: string | string[] | undefined): number {
	const numeric = Number(Array.isArray(raw) ? raw[0] : raw);
	if (!Number.isFinite(numeric) || numeric <= 0) return DEFAULT_LIMIT;
	return Math.min(100, Math.max(1, Math.floor(numeric)));
}

function matchesQuery(record: LostPersonRecord, query: string): boolean {
	if (!query) return true;
	const haystack = [record.title, record.summary, record.personName, record.location, record.agency, ...(record.tags || [])].filter(Boolean).join(' ').toLowerCase();
	const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
	return terms.every((term) => haystack.includes(term));
}

async function readCatalog(): Promise<LostPersonRecord[]> {
	try {
		const raw = await fs.readFile(DATA_PATH, 'utf8');
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		await fs.mkdir(path.dirname(DATA_PATH), { recursive: true });
		await fs.writeFile(DATA_PATH, '[]', 'utf8');
		return [];
	}
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<LostPeopleResponse | { error: string }>) {
	try {
		const state = normalizeState(String(req.query.state || 'all'));
		const query = normalizeQuery(String(req.query.q || req.query.query || ''));
		const limit = normalizeLimit(req.query.limit);
		const sourceTypes = normalizeSourceTypes(String(req.query.source || ''));
		const records = await readCatalog();

		const filtered = records.filter((record) => {
			if (!sourceTypes.includes(record.sourceType)) return false;
			if (state !== 'all' && record.state !== state) return false;
			return matchesQuery(record, query);
		});

		const paged = filtered.slice(0, limit);
		const payload: LostPeopleResponse = {
			state,
			query,
			limit,
			total: filtered.length,
			results: paged,
			sourceTypes: SUPPORTED_SOURCE_TYPES,
		};
		return res.status(200).json(payload);
	} catch (error) {
		return res.status(500).json({ error: formatErrorMessage(error) });
	}
}
