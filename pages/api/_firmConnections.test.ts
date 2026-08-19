import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFirmConnectionsPayload } from './_firmConnections';

test('parses graph:firm-connections v9 payload shape', () => {
	const parsed = parseFirmConnectionsPayload({
		currentConnections: [{ individualId: '254563', name: 'HOWARD JOHN IBERGER', relationship: 'Current registration', isCurrent: true }],
		previousConnections: [
			{ individualId: '1404694', name: 'DENNIS HAHN', relationship: 'Previous registration', startDate: '11/14/2024', endDate: '5/5/2026', isCurrent: false },
		],
	});

	assert.ok(parsed);
	assert.equal(parsed.currentConnections.length, 1);
	assert.equal(parsed.currentConnections[0].individualId, '254563');
	assert.equal(parsed.currentConnections[0].isCurrent, true);
	assert.equal(parsed.previousConnections.length, 1);
	assert.equal(parsed.previousConnections[0].individualId, '1404694');
	assert.equal(parsed.previousConnections[0].endDate, '5/5/2026');
});

test('parses graph:firm-emp-adj current/previous aliases', () => {
	const parsed = parseFirmConnectionsPayload({
		current: [{ personCrd: '10111', personName: 'Jane Doe' }],
		previous: [{ crd: '20222', name: 'John Smith', isCurrent: false }],
	});

	assert.ok(parsed);
	assert.equal(parsed.currentConnections[0].individualId, '10111');
	assert.equal(parsed.currentConnections[0].isCurrent, true);
	assert.equal(parsed.previousConnections[0].individualId, '20222');
	assert.equal(parsed.previousConnections[0].isCurrent, false);
});

test('returns null for unrelated payloads', () => {
	assert.equal(parseFirmConnectionsPayload({ basicInformation: { firmId: '8733' } }), null);
});
