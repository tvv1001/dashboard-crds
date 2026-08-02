/**
 * Generic downloader for Central Appraisal District (CAD) bulk data
 * published as a downloadable ZIP containing one large delimited text file
 * (pipe `|`, comma, or tab-delimited), which is the most common free
 * distribution format among Texas CADs (Tarrant, Harris, Williamson,
 * Nueces, Fort Bend, Bell, Galveston, Brazoria, etc.).
 *
 * Strategy (kept memory-safe for files that can be 500MB+ uncompressed):
 *   1. Download the ZIP to a scratch file (streamed, not buffered).
 *   2. Use the system `unzip -p <zip> <innerFile>` to stream-decompress the
 *      inner text file without ever extracting it fully to disk.
 *   3. Parse it line-by-line (first line = header row), converting each
 *      row into a JSON object keyed by the header column names, and
 *      appending to a JSONL output file.
 *
 * There is no fine-grained mid-file resume (unlike the ArcGIS/Socrata
 * helpers) because these are single-shot flat-file downloads rather than
 * paginated APIs; if interrupted, delete the (partial) output/checkpoint
 * and rerun with --force. A `.checkpoint.json` marks "download in
 * progress" so a completed run (checkpoint deleted) is never silently
 * skipped as already-done.
 */
import { createWriteStream, createReadStream, existsSync } from 'fs';
import fsSync from 'fs';
import { promises as fs } from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import readline from 'readline';
import fetch from 'node-fetch';

export interface CadZipSourceConfig {
  /** Human-readable id, used for filenames and logging. */
  id: string;
  /** Direct URL to the ZIP file. */
  zipUrl: string;
  /**
   * Name of the file inside the ZIP to parse. If omitted, the single file
   * in the archive is used (fails loudly if there's more than one).
   */
  innerFile?: string;
  /** Column delimiter in the inner text file. Defaults to '|'. */
  delimiter?: string;
  /**
   * When true, parses lines as RFC4180-style quoted CSV (handles embedded
   * delimiters/commas inside double-quoted fields) instead of a naive
   * split. Needed for CADs that export quoted CSV (e.g. Fort Bend).
   * NOTE: does not handle quoted fields containing literal newlines
   * (would require multi-line record buffering); good enough for the
   * address/legal-description fields these exports typically contain.
   */
  csv?: boolean;
  /** Extra headers (e.g. User-Agent) some CAD sites require. */
  headers?: Record<string, string>;
}

/** Minimal RFC4180 quoted-CSV line splitter (single physical line only). */
function splitCsvLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      cells.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells;
}

async function downloadZip(url: string, dest: string, headers?: Record<string, string>): Promise<void> {
  const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', ...headers } });
  if (!resp.ok || !resp.body) {
    throw new Error(`Failed to download ${url}: HTTP ${resp.status}`);
  }
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const out = createWriteStream(dest);
  await new Promise<void>((resolve, reject) => {
    resp.body!.pipe(out);
    resp.body!.on('error', reject);
    out.on('finish', () => resolve());
    out.on('error', reject);
  });
}

/** Count lines in an existing (possibly huge) JSONL file without buffering it. */
async function countLines(filePath: string): Promise<number> {
  const rl = readline.createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  let count = 0;
  for await (const line of rl) {
    if (line) count++;
  }
  return count;
}

async function listZipEntries(zipPath: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn('unzip', ['-Z1', zipPath]); // -Z1: just filenames, one per line
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => (out += d.toString()));
    proc.stderr.on('data', (d) => (err += d.toString()));
    proc.on('close', (code) => {
      if (code !== 0 && code !== 1) return reject(new Error(`unzip -Z1 failed: ${err}`)); // code 1 = warnings ok
      resolve(out.split('\n').filter(Boolean));
    });
  });
}

export async function downloadCadZipSource(config: CadZipSourceConfig, outDir: string): Promise<number> {
  const delimiter = config.delimiter ?? '|';
  const outFile = path.join(outDir, `${config.id}.jsonl`);
  const checkpointFile = path.join(outDir, `${config.id}.checkpoint.json`);
  const scratchZip = path.join(outDir, `.${config.id}.download.zip`);
  const lockFile = path.join(outDir, `.${config.id}.lock`);

  await fs.mkdir(outDir, { recursive: true });

  // Guard against overlapping/duplicate invocations (e.g. a stray detached
  // relaunch racing an earlier still-running process) stomping on each
  // other's scratch zip/checkpoint/output files.
  let lockFd: number;
  try {
    lockFd = fsSync.openSync(lockFile, 'wx');
  } catch (err: any) {
    if (err.code === 'EEXIST') {
      throw new Error(
        `[${config.id}] Lock file ${lockFile} already exists - another invocation appears to be running. ` +
          `Delete it manually if you're sure no process is active.`,
      );
    }
    throw err;
  }
  fsSync.writeSync(lockFd, String(process.pid));
  fsSync.closeSync(lockFd);

  // Synchronous, best-effort cleanup guaranteed to run even if the process
  // is torn down mid-flight (exit, SIGTERM, SIGINT) - relying purely on
  // trailing `await fs.rm(...)` calls risks losing that work if the event
  // loop is starved/killed before those microtasks flush.
  const cleanupSync = () => {
    try {
      if (fsSync.existsSync(lockFile)) fsSync.unlinkSync(lockFile);
    } catch {
      /* ignore */
    }
  };
  const removeScratchZipSync = () => {
    try {
      if (fsSync.existsSync(scratchZip)) fsSync.unlinkSync(scratchZip);
    } catch {
      /* ignore */
    }
  };
  const removeCheckpointSync = () => {
    try {
      if (fsSync.existsSync(checkpointFile)) fsSync.unlinkSync(checkpointFile);
    } catch {
      /* ignore */
    }
  };

  process.once('exit', cleanupSync);
  const onSignal = (signal: NodeJS.Signals) => {
    console.log(`[${config.id}] Received ${signal}, cleaning up lock before exit...`);
    cleanupSync();
    process.exit(1);
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);

  try {
    // Resume support: if a prior invocation was killed mid-stream (e.g. by
    // an external process time limit on long-running background jobs),
    // reuse the already-downloaded ZIP (avoids re-fetching 100s of MB) and
    // skip the rows already appended to outFile instead of starting over.
    const alreadyWrittenRows = existsSync(outFile) ? await countLines(outFile) : 0;
    const resuming = alreadyWrittenRows > 0;

    if (existsSync(scratchZip)) {
      console.log(`[${config.id}] Reusing already-downloaded ZIP at ${scratchZip} (resuming previous run)...`);
    } else {
      await fs.writeFile(checkpointFile, JSON.stringify({ status: 'downloading', startedAt: new Date().toISOString() }, null, 2));
      console.log(`[${config.id}] Downloading ZIP from ${config.zipUrl} ...`);
      await downloadZip(config.zipUrl, scratchZip, config.headers);
    }
    const stat = await fs.stat(scratchZip);
    console.log(`[${config.id}] ZIP is ${(stat.size / 1024 / 1024).toFixed(1)} MB. Listing archive contents...`);

    const entries = await listZipEntries(scratchZip);
    const innerFile = config.innerFile || (entries.length === 1 ? entries[0] : undefined);
    if (!innerFile) {
      throw new Error(`[${config.id}] ZIP has ${entries.length} entries, specify innerFile explicitly: ${entries.join(', ')}`);
    }
    if (resuming) {
      console.log(`[${config.id}] Resuming: ${alreadyWrittenRows} rows already written, skipping that many from inner file "${innerFile}"...`);
    } else {
      console.log(`[${config.id}] Streaming inner file "${innerFile}" (delimiter="${delimiter}")...`);
    }

    await fs.writeFile(
      checkpointFile,
      JSON.stringify({ status: 'parsing', innerFile, startedAt: new Date().toISOString() }, null, 2),
    );

    const unzipProc = spawn('unzip', ['-p', scratchZip, innerFile]);
    const rl = readline.createInterface({ input: unzipProc.stdout, crlfDelay: Infinity });

    const out = createWriteStream(outFile, { flags: resuming ? 'a' : 'w' });
    let header: string[] | null = null;
    let rowCount = 0;
    let skipped = 0;
    let unzipErr = '';
    unzipProc.stderr.on('data', (d) => (unzipErr += d.toString()));

    for await (const line of rl) {
      if (!line) continue;
      if (!header) {
        header = (config.csv ? splitCsvLine(line, delimiter) : line.split(delimiter)).map((h) => h.trim());
        continue;
      }
      if (skipped < alreadyWrittenRows) {
        skipped++;
        continue;
      }
      const cells = config.csv ? splitCsvLine(line, delimiter) : line.split(delimiter);
      const row: Record<string, string> = {};
      for (let i = 0; i < header.length; i++) {
        row[header[i]] = (cells[i] ?? '').trim();
      }
      out.write(JSON.stringify(row) + '\n');
      rowCount++;
      if (rowCount % 50000 === 0) {
        console.log(`[${config.id}] ${rowCount} new rows written (${rowCount + alreadyWrittenRows} total)...`);
      }
    }

    await new Promise<void>((resolve) => out.end(resolve));
    rowCount += alreadyWrittenRows;

    const exitCode: number = await new Promise((resolve) => unzipProc.on('close', resolve));
    if (exitCode !== 0 && exitCode !== 1) {
      throw new Error(`[${config.id}] unzip -p exited with code ${exitCode}: ${unzipErr}`);
    }

    removeScratchZipSync();
    removeCheckpointSync();
    console.log(`[${config.id}] Done. Total rows: ${rowCount}. Output: ${outFile}`);
    return rowCount;
  } finally {
    // Always drop the lock, whether we succeeded, threw, or the caller's
    // process is about to exit - the `process.once('exit', ...)` hook above
    // is a last-resort backstop for cases this finally block can't reach
    // (e.g. a hard kill), but this handles the normal throw/return paths.
    cleanupSync();
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGINT', onSignal);
  }
}
