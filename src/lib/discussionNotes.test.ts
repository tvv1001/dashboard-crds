import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDiscussionNoteSignature, clearDiscussionNote, readDiscussionNoteForEntity, saveDiscussionNote } from './discussionNotes';

function createMemoryStorage(initial: Record<string, string> = {}) {
	const store = new Map(Object.entries(initial));
	return {
		getItem(key: string) {
			return store.has(key) ? store.get(key)! : null;
		},
		setItem(key: string, value: string) {
			store.set(key, value);
		},
		removeItem(key: string) {
			store.delete(key);
		},
		clear() {
			store.clear();
		},
	};
}

test('builds a stable note signature from entity type and CRD', () => {
	assert.equal(buildDiscussionNoteSignature('individual', '12345'), 'individual:12345');
	assert.equal(buildDiscussionNoteSignature('firm', '999'), 'firm:999');
});

test('saves and reloads a discussion note for the current entity', () => {
	const storage = createMemoryStorage();
	const note = {
		entityKey: 'individual:12345',
		entityLabel: 'Jane Doe',
		text: 'AI discussion text',
		updatedAt: '2026-07-31T00:00:00.000Z',
	};

	saveDiscussionNote(storage, note);
	assert.deepEqual(readDiscussionNoteForEntity(storage, 'individual', '12345'), note);

	clearDiscussionNote(storage, 'individual', '12345');
	assert.equal(readDiscussionNoteForEntity(storage, 'individual', '12345'), null);
});
