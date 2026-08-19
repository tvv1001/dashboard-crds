import test from 'node:test';
import assert from 'node:assert/strict';
import { bucketConnectionRows, extractConnectionRows, isOwnerLikeRelationship } from './connectionData';

test('owner rows from a firm payload are surfaced as current connections when explicit current/previous arrays are missing', () => {
	const payload = {
		directOwners: [{ legalName: 'LPL HOLDINGS, INC.', position: 'MANAGING MEMBER', crdNumber: '6413' }],
	};

	const buckets = bucketConnectionRows(extractConnectionRows(payload));

	assert.equal(buckets.current.length, 1);
	assert.equal(buckets.previous.length, 0);
	assert.equal(buckets.owner.length, 1);
	assert.equal(isOwnerLikeRelationship(buckets.current[0]), true);
});

test('search-index employment arrays (ind_current_employments) are extracted as connection rows', () => {
	const payload = {
		ind_current_employments: [{ firmId: 8733, firm_id: 8733, firmName: 'LPL ENTERPRISE, LLC' }],
		ind_previous_employments: [{ firmId: 5685, firmName: 'PRUCO SECURITIES, LLC.', registrationEndDate: '1/1/2020' }],
	};

	const rows = extractConnectionRows(payload);
	assert.equal(rows.length, 2);
	const buckets = bucketConnectionRows(rows);
	assert.equal(buckets.current.length, 1);
	assert.equal(buckets.previous.length, 1);
});
