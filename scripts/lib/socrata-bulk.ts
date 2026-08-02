/**
 * Generic, resumable paginated downloader for Socrata (SODA API) datasets,
 * such as those published by Texas cities/counties on data.texas.gov,
 * data.austintexas.gov, etc. Paginates with $limit/$offset and writes
 * newline-delimited JSON (JSONL), with a checkpoint file for resuming
 * interrupted runs.
 */
import { promises as fs } from 'fs';
import path from 'path';
import fetch from 'node-fetch';

export interface SocrataSourceConfig {
  /** Human-readable id, used for filenames and logging, e.g. "travis-austin-land-db". */
  id: string;
  /** Socrata domain, e.g. "data.austintexas.gov". */
  domain: string;
  /** Dataset resource id, e.g. "kk8y-6cmt". */
  resourceId: string;
  /** Optional $select clause to limit/rename columns (omit geometry for speed). */
  select?: string;
  /** Optional $where clause. */
  where?: string;
  pageSize?: number;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function countExistingLines(file: string): Promise<number> {
  try {
    const content = await fs.readFile(file, 'utf-8');
    return content.split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

export async function downloadSocrataDataset(config: SocrataSourceConfig, outDir: string, delayMs = 300) {
  await fs.mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, `${config.id}.jsonl`);
  const checkpointFile = path.join(outDir, `${config.id}.checkpoint.json`);
  const pageSize = config.pageSize || 5000;

  let offset = 0;
  let fileHandle: fs.FileHandle;
  try {
    const checkpoint = JSON.parse(await fs.readFile(checkpointFile, 'utf-8'));
    offset = checkpoint.offset || 0;
    fileHandle = await fs.open(outFile, 'a');
    console.log(`[${config.id}] Resuming from offset ${offset}`);
  } catch {
    fileHandle = await fs.open(outFile, 'w');
  }

  let totalWritten = offset > 0 ? await countExistingLines(outFile) : 0;
  let page = 0;
  while (true) {
    const params = new URLSearchParams({
      $limit: String(pageSize),
      $offset: String(offset),
      $order: ':id',
    });
    if (config.select) params.set('$select', config.select);
    if (config.where) params.set('$where', config.where);

    const url = `https://${config.domain}/resource/${config.resourceId}.json?${params.toString()}`;
    let data: any;
    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        console.error(`[${config.id}] HTTP ${resp.status} at offset ${offset}`);
        break;
      }
      data = await resp.json();
    } catch (err) {
      console.error(`[${config.id}] fetch error at offset ${offset}:`, (err as Error).message);
      await sleep(2000);
      continue;
    }

    if (!Array.isArray(data) || data.length === 0) break;

    const lines = data.map((row: any) => JSON.stringify(row)).join('\n') + '\n';
    await fileHandle.appendFile(lines);
    totalWritten += data.length;
    offset += data.length;
    page += 1;

    await fs.writeFile(checkpointFile, JSON.stringify({ offset, totalWritten, updatedAt: new Date().toISOString() }, null, 2));

    if (page % 5 === 0) console.log(`[${config.id}] ${totalWritten} rows written (offset ${offset})...`);

    if (data.length < pageSize) break; // last page
    await sleep(delayMs);
  }

  await fileHandle.close();
  await fs.rm(checkpointFile, { force: true }); // mark as fully complete
  console.log(`[${config.id}] Done. Total rows: ${totalWritten}. Output: ${outFile}`);
  return totalWritten;
}
