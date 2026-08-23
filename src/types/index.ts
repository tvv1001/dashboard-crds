export interface SavedPayload {
	key: string;
	mtime?: number;
	industryDate?: string;
	isActive?: boolean;
}

export interface ParsedKey {
	source: 'finra' | 'sec';
	type: 'individual' | 'firm';
	crd: string;
}

export interface GroupEntry {
	groupKey: string;
	type: string;
	crd: string;
	keys: string[];
	displayType: string;
	latest: number;
	industryDate: string | null;
	finraActive: boolean;
	secActive: boolean;
	hasFinra: boolean;
	hasSec: boolean;
	hasWarning: boolean;
	warningText: string;
	sortLabel: string;
}

export interface QueueItem {
	term: string;
	status: 'pending' | 'running' | 'complete' | 'no-content' | 'error';
	detail: string;
}

export interface StatusConsoleState {
	phase: string;
	mode: string;
	term: string;
	queue: string;
	currentCrd: string;
	finraMatches: number;
	secMatches: number;
	seeds: number;
	savedFiles: number;
	downloaded: number;
	updated: number;
	repaired: number;
	unchanged: number;
	errors: number;
	rateLimited: boolean;
	lastEvent: string;
	lastError: string;
	startedAt: number;
	updatedAt: number;
}

export interface SyncBannerState {
	downloaded: number;
	updated: number;
	repaired: number;
	unchanged: number;
}

export interface NewCrdItem {
	id: string;
	crd: string;
	type: 'individual' | 'firm';
	name?: string;
	foundAt: string;
	sources: string[];
	sourceDates?: Record<string, string>;
	savedFiles?: string[];
}

export interface RedisHighWaterSummary {
	configured: boolean;
	mode: 'upstash-rest' | 'redis-url' | 'none';
	checkedAt: string;
	totalSavedCrds: number;
	sections: {
		individual: NewCrdItem[];
		firm: NewCrdItem[];
	};
	message: string;
}

export interface NewCrdsState {
	items: NewCrdItem[];
	loading?: boolean;
	error?: string;
	visible?: boolean;
	scanInProgress?: boolean;
	cooldownActive?: boolean;
	cooldownUntil?: string;
	lastCheckedAt?: string;
	nextCheckAt?: string;
	lastRun?: { message?: string; completedAt?: string; processedCrds?: number; lastProcessed?: { crd?: string; outcome?: string } };
	frontiers?: Record<string, unknown>;
	lastReport?: { processedCrds?: number; lastProcessed?: { crd?: string; outcome?: string } };
	redisHighWater?: RedisHighWaterSummary;
}

export interface LocalNameSearchResult {
	name: string;
	type: string;
	crd: string;
	source?: string;
	key?: string;
	secNumber?: string;
	currentAddress?: string;
	currentFirm?: string;
	currentFirmCrd?: string;
	matchedValues?: string[];
	matchedTerms?: string[];
	aliases?: string[];
}

export interface LocalNameSearchPayload {
	matches: LocalNameSearchResult[];
	totalMatches: number;
	terms: string[];
	truncated?: boolean;
}

export interface RequestedSelection {
	crd: string;
	type: string;
	preferredSources: string[];
}

export type SortOrder = 'date-desc' | 'crd-asc' | 'crd-desc';
