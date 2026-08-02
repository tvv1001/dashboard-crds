export interface DiscussionNote {
	entityKey: string;
	entityLabel: string;
	text: string;
	updatedAt: string;
}

export type DiscussionStorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const STORAGE_KEY = 'finra-sec-discussion-notes';

export function buildDiscussionNoteSignature(type: string, crd: string): string {
	return `${String(type || 'entity').toLowerCase()}:${String(crd || '').trim()}`;
}

export function readDiscussionNotes(storage: DiscussionStorageLike): Record<string, DiscussionNote> {
	try {
		const raw = storage.getItem(STORAGE_KEY);
		if (!raw) return {};
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, DiscussionNote>) : {};
	} catch {
		return {};
	}
}

export function writeDiscussionNotes(storage: DiscussionStorageLike, notes: Record<string, DiscussionNote>) {
	storage.setItem(STORAGE_KEY, JSON.stringify(notes));
}

export function saveDiscussionNote(storage: DiscussionStorageLike, note: DiscussionNote) {
	const notes = readDiscussionNotes(storage);
	notes[note.entityKey] = note;
	writeDiscussionNotes(storage, notes);
}

export function readDiscussionNoteForEntity(storage: DiscussionStorageLike, type: string, crd: string) {
	const entityKey = buildDiscussionNoteSignature(type, crd);
	const notes = readDiscussionNotes(storage);
	return notes[entityKey] ?? null;
}

export function clearDiscussionNote(storage: DiscussionStorageLike, type: string, crd: string) {
	const entityKey = buildDiscussionNoteSignature(type, crd);
	const notes = readDiscussionNotes(storage);
	if (notes[entityKey]) {
		delete notes[entityKey];
		writeDiscussionNotes(storage, notes);
	}
}

export function getDiscussionStorage(): DiscussionStorageLike | null {
	if (typeof window === 'undefined' || !window.localStorage) return null;
	return window.localStorage;
}
