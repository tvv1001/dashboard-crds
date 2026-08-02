import assert from 'node:assert/strict';
import test from 'node:test';

import { querySerperGoogle } from '../pages/api/_google-srp';

test('querySerperGoogle returns Serper organic results when API key is set', async () => {
	process.env.SERPER_API_KEY = 'test-key';
	const originalFetch = global.fetch;

	global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		assert.equal(String(input), 'https://google.serper.dev/search');
		assert.equal((init?.headers as Record<string, string>)?.['X-API-KEY'], 'test-key');

		return new Response(
			JSON.stringify({
				organic: [{ title: 'Example result', link: 'https://example.com', snippet: 'Example snippet' }],
			}),
			{
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			},
		);
	}) as typeof fetch;

	try {
		const results = await querySerperGoogle('test query', 5);
		assert.deepEqual(results, [
			{
				position: 1,
				title: 'Example result',
				snippet: 'Example snippet',
				url: 'https://example.com',
				engine: 'google',
			},
		]);
	} finally {
		global.fetch = originalFetch;
		delete process.env.SERPER_API_KEY;
	}
});
