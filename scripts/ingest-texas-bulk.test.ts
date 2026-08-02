import test from 'node:test';
import assert from 'node:assert/strict';
import { TEXAS_COUNTIES } from './ingest-texas-bulk';

test('Texas county manifest covers all 254 counties', () => {
	assert.equal(TEXAS_COUNTIES.length, 254);
	assert.ok(TEXAS_COUNTIES.includes('Bell'));
	assert.ok(TEXAS_COUNTIES.includes('Fort Bend'));
	assert.ok(TEXAS_COUNTIES.includes('Travis'));
	assert.ok(TEXAS_COUNTIES.includes('Zavala'));
});
