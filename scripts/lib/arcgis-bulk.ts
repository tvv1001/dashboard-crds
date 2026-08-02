/**
 * Generic, resumable paginated downloader for ArcGIS Server "FeatureServer"
 * / "MapServer" layers exposing the standard REST `query` operation.
 *
 * Many Texas county/city GIS departments and Central Appraisal Districts
 * publish free, public, no-auth parcel layers this way (e.g. the City of
 * Dallas's DallasTaxParcels layer). This helper paginates through the whole
 * layer using `resultOffset` + `resultRecordCount` (capped at the service's
 * own `maxRecordCount`), and writes each page as newline-delimited JSON
 * (JSONL) so arbitrarily large layers (hundreds of thousands to millions of
 * rows) never need to be held in memory at once.
 *
 * A small `.checkpoint.json` file next to the output is updated after every
 * page so an interrupted run can resume from where it left off with
 * `--force` omitted.
 */
import { promises as fs } from 'fs';
import path from 'path';
import fetch from 'node-fetch';

export interface ArcgisSourceConfig {
  /** Human-readable id, used for filenames and logging, e.g. "dallas-city". */
  id: string;
  /** Base query URL, e.g. ".../MapServer/0/query" (no querystring). */
  queryUrl: string;
  /** Fields to request. Use ['*'] for all fields. */
  outFields: string[];
  /** Optional WHERE clause. Defaults to '1=1' (everything). */
  where?: string;
  /** Field to order by for stable pagination (usually the OID field). */
  orderByField?: string;
}

async function getLayerMeta(queryUrl: string): Promise<{ maxRecordCount: number; oidField: string }> {
  const infoUrl = queryUrl.replace(/\/query$/, '');
  const resp = await fetch(`${infoUrl}?f=json`);
  const data: any = await resp.json();
  const oidField = (data.fields || []).find((f: any) => f.type === 'esriFieldTypeOID')?.name || 'OBJECTID';
  return { maxRecordCount: data.maxRecordCount || 1000, oidField };
}

export async function downloadArcgisLayer(config: ArcgisSourceConfig, outDir: string, delayMs = 300) {
  await fs.mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, `${config.id}.jsonl`);
  const checkpointFile = path.join(outDir, `${config.id}.checkpoint.json`);

  const { maxRecordCount, oidField } = await getLayerMeta(config.queryUrl);
  const pageSize = Math.min(maxRecordCount, 2000);
  const orderBy = config.orderByField || oidField;

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
      where: config.where || '1=1',
      outFields: config.outFields.join(','),
      resultRecordCount: String(pageSize),
      resultOffset: String(offset),
      orderByFields: orderBy,
      returnGeometry: 'false',
      f: 'json',
    });
    const url = `${config.queryUrl}?${params.toString()}`;
    let data: any;
    try {
      const resp = await fetch(url);
      data = await resp.json();
    } catch (err) {
      console.error(`[${config.id}] fetch error at offset ${offset}:`, (err as Error).message);
      await sleep(2000);
      continue;
    }

    if (data.error) {
      console.error(`[${config.id}] API error at offset ${offset}:`, JSON.stringify(data.error));
      break;
    }

    const features = data.features || [];
    if (features.length === 0) break;

    const lines = features.map((f: any) => JSON.stringify(f.attributes)).join('\n') + '\n';
    await fileHandle.appendFile(lines);
    totalWritten += features.length;
    offset += features.length;
    page += 1;

    await fs.writeFile(checkpointFile, JSON.stringify({ offset, totalWritten, updatedAt: new Date().toISOString() }, null, 2));

    if (page % 10 === 0) console.log(`[${config.id}] ${totalWritten} rows written (offset ${offset})...`);

    if (features.length < pageSize) break; // last page
    await sleep(delayMs);
  }

  await fileHandle.close();
  await fs.rm(checkpointFile, { force: true }); // mark as fully complete
  console.log(`[${config.id}] Done. Total rows: ${totalWritten}. Output: ${outFile}`);
  return totalWritten;
}

async function countExistingLines(file: string): Promise<number> {
  try {
    const content = await fs.readFile(file, 'utf-8');
    return content.split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
