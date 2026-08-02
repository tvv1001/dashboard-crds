import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { classifyLink, createLocalSecResourceBundle, extractDownloadLinks } from '../scripts/analyze-sec-resources';

test('classifies SEC bulk data downloads as useful non-duplicate sources', () => {
	const result = classifyLink('https://www.sec.gov/foia/docs/invafoia.htm');
	assert.equal(result.category, 'sec-bulk-data');
	assert.equal(result.useful, true);
	assert.equal(result.duplicateReason, null);
});

test('treats adviserinfo and BrokerCheck links as already-covered duplicates', () => {
	const adviserInfo = classifyLink('https://adviserinfo.sec.gov/');
	const brokerCheck = classifyLink('https://brokercheck.finra.org/');

	assert.equal(adviserInfo.category, 'covered-by-existing-ingestion');
	assert.equal(adviserInfo.useful, false);
	assert.match(adviserInfo.duplicateReason ?? '', /Redis|existing/i);

	assert.equal(brokerCheck.category, 'covered-by-existing-ingestion');
	assert.equal(brokerCheck.useful, false);
});

test('extracts monthly registered and exempt adviser download links from SEC HTML', () => {
	const html = `
    <html>
      <body>
        <a href="https://www.sec.gov/files/registered-july-2026.zip">Registered Investment Advisers, July 2026</a>
        <a href="https://www.sec.gov/files/exempt-july-2026.zip">Exempt Investment Advisers, July 2026</a>
      </body>
    </html>
  `;

	const downloads = extractDownloadLinks(html);
	assert.equal(downloads.length, 2);
	assert.ok(downloads.some((item) => item.kind === 'registered' && item.label.includes('July 2026')));
	assert.ok(downloads.some((item) => item.kind === 'exempt' && item.label.includes('July 2026')));
});

test('writes a local manifest without touching Redis', async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sec-resources-'));
	const html = `
    <html>
      <body>
        <a href="https://adviserinfo.sec.gov/resources">Resources</a>
        <a href="https://www.sec.gov/foia/docs/invafoia.htm">SEC FOIA bulk data</a>
        <a href="https://www.sec.gov/files/registered-july-2026.zip">Registered Investment Advisers, July 2026</a>
      </body>
    </html>
  `;

	const result = await createLocalSecResourceBundle({ outputDir: tempDir, sourceUrl: 'https://adviserinfo.sec.gov/resources', html, label: 'resources-page' });
	assert.equal(result.wroteToRedis, false);
	const manifest = JSON.parse(await fs.readFile(path.join(tempDir, 'manifest.json'), 'utf8'));
	assert.equal(manifest.sourceUrl, 'https://adviserinfo.sec.gov/resources');
	assert.ok(manifest.classified.some((item: { category: string }) => item.category === 'sec-bulk-data'));
	assert.ok(
		await fs
			.stat(path.join(tempDir, 'source.html'))
			.then(() => true)
			.catch(() => false),
	);
});
