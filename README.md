# Data FINRA + SEC

This app focuses on **downloading source JSON payloads** from FINRA BrokerCheck and SEC AdviserInfo, then **structuring and merging records by shared CRD** so the same person or firm is represented as a single combined entity.

## Core goal

For any given `<CRD>`:

- fetch the raw FINRA record
- fetch the raw SEC record
- save both source payloads without losing source fidelity
- normalize shared identifiers and key fields
- merge the records into one canonical CRD document

The CRD is the primary join key. If FINRA and SEC return data for the same `<CRD>`, the app should treat those responses as two source views of the same underlying entity.

## Source-of-truth principles

- Keep the **source upstream JSON** from each source.
- Keep **source-specific metadata** so nothing is overwritten silently.
- Build a **merged layer** that is easy to query and compare.
- Prefer **detail endpoints by CRD** for record hydration.
- Use search endpoints only for discovery, search UX, or crawl seeding.

## Recommended upstream detail endpoints

Use the validated direct detail forms for record hydration:

- FINRA individual: `https://api.brokercheck.finra.org/search/individual/<CRD>?includePrevious=true`
- SEC individual: `https://api.adviserinfo.sec.gov/search/individual/<CRD>?includePrevious=true`
- FINRA firm: `https://api.brokercheck.finra.org/search/firm/<CRD>`
- SEC firm: `https://api.adviserinfo.sec.gov/search/firm/<CRD>?wt=json`

Use placeholders such as `<CRD>`, `<QUERY>`, `<NROWS>`, and `<START>` in docs and prompts.

## Suggested processing flow

1. Accept a target `<CRD>`.
2. Download the FINRA detail JSON for that CRD when available.
3. Download the SEC detail JSON for that CRD when available.
4. Persist each response using source-specific cache naming.
5. Normalize identifiers, names, registration state, and source timestamps.
6. Merge both source payloads into one CRD-centric structured document.
7. Preserve conflicts explicitly instead of dropping fields.

## Raw cache naming convention

When caching upstream payloads, use the existing repo convention:

- `api.brokercheck.finra.org_search_individual_<CRD>.json`
- `api.adviserinfo.sec.gov_search_individual_<CRD>.json`
- `api.brokercheck.finra.org_search_firm_<CRD>.json`
- `api.adviserinfo.sec.gov_search_firm_<CRD>.json`

## Quickstart (Local Development)

The easiest way to get started after cloning this repository is to use the provided `docker-compose.yml` to spin up a local Redis instance and run the app.

1. Start the local Redis container:
   ```bash
   docker-compose up -d
   ```
2. Create your `.env.local` or `.env` file and point it to the local Redis instance:
   ```env
   REDIS_URL=redis://localhost:6379
   ```
3. Install dependencies and start the app:
   ```bash
   pnpm install
   pnpm dev
   ```

When running with Redis/Upstash caching enabled, you can use either configuration:

- **Upstash REST (recommended):** `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`
- **Native Redis URL:** `REDIS_URL` and optionally `REDIS_PASSWORD`

The app caches upstream JSON responses by request URL, with a default TTL of `3600` seconds.

To quickly verify Redis connectivity from the browser, open:

- `http://localhost:3001/api/redis-health`

The response reports whether Redis is configured, which mode is active (`upstash-rest` or `redis-url`), and probe latency.

Uncached requests now start immediately so search results can stream back sooner. If you need to reintroduce a warm-up delay before the first upstream request, set `CRAWL_INITIAL_DELAY_MS`; retry backoff continues to use `CRAWL_DELAY_MS_MIN` and `CRAWL_DELAY_MS_MAX`.

When upstream returns `429 Too Many Requests`, the fetcher now waits and retries instead of failing immediately. By default that backoff is jittered to roughly 2-4 minutes (`CRAWL_429_DELAY_MS_MIN=120000`, `CRAWL_429_DELAY_MS_MAX=240000`), or it will honor an upstream `Retry-After` header when one is present.

Detail files saved under `data/raw/` are stored in source-specific app-ready wrapper forms:

```json
{
  "finraBrokerCheck": { ...normalized FINRA detail payload... }
}
```

```json
{
  "secInvestmentAdvisor": { ...normalized SEC detail payload... }
}
```

Broker-only SEC individual shells (`iaScope: "NotInScope"` with no IA employment history) are not treated as saved SEC adviser detail files and are excluded from saved-key listings.

Whenever a saved detail file is written or refreshed, the same JSON is also mirrored to `data/raw/bak/<same-filename>.json`.

If you need to rewrite older raw files into those wrapper forms, run:

```bash
npm run normalize-raw-iacontent
```

## Gemini AI Integration

This project now includes Google Gemini AI integration for analyzing financial professional and firm data.

### Setup

1. Get a Google AI API key from the [Google AI Studio](https://aistudio.google.com/).
2. Add your API key to a `.env` file in the project root:
   ```env
   GOOGLE_API_KEY=your_api_key_here
   ```

### Usage (Web UI)

1. Select a record from the sidebar in the dashboard.
2. Click the **✨ Analyze with Gemini** button in the header.
3. The AI will generate a summary of the professional's registration status, disclosures, and employment history.

### Usage (CLI)

You can also run the analysis from the command line:

```bash
pnpm analyze-with-gemini <key> [custom_prompt]
```

Example:

```bash
pnpm analyze-with-gemini finra:individual:249 "What is their disciplinary history?"
```

## Merge rules

- Use `crd` as the canonical key.
- Store raw source payloads separately under their own namespaces.
- Convert numeric-looking CRDs to strings during normalization so joins are stable.
- Track which sources were present: FINRA, SEC, or both.
- Do not flatten away source differences when values disagree.
- Prefer explicit conflict fields or source-scoped sub-objects over destructive overwrites.

## Canonical merged record

The repository includes a draft schema at `data/crd-merged-record.schema.json` for the structured merged document.

High-level shape:

- `crd`: canonical CRD string
- `entityType`: `individual`, `firm`, or `unknown`
- `sources`: per-source fetch metadata and raw-cache references
- `raw`: preserved upstream payloads from FINRA and SEC
- `merged`: normalized cross-source view for app consumption
- `conflicts`: fields where FINRA and SEC disagree

## Current repository contents

- `README.md` — project scope and merge strategy
- `data/i18n-finra.json` — FINRA-facing text bundle
- `data/i18n-sec.json` — SEC-facing text bundle
- `data/crd-merged-record.schema.json` — canonical merged CRD schema draft

## Next implementation step

The next code milestone should be a small ingestion pipeline that:

- downloads raw detail JSON for a CRD from both sources
- writes source-specific raw files
- emits one merged CRD document that conforms to the schema

That keeps the project centered on the real mission: **raw JSON in, clean merged CRD records out**.

## Entity notes + SEC reference API

A dedicated endpoint is available for storing per-entity notes and resolving SEC company facts by CIK:

- `GET /api/entity-notes?action=load&entityType=individual&entityCrd=123456`
- `POST /api/entity-notes` with JSON body:

```json
{
	"action": "save",
	"entityType": "individual",
	"entityCrd": "123456",
	"entityName": "Example Person",
	"text": "Paste AI discussion notes here"
}
```

- `GET /api/entity-notes?action=lookup&entityCrd=123456&cik=320193`

The endpoint writes notes to `data/derived/entity-notes.json` and uses SEC company facts endpoints for lookup.

## Front-end (Next.js)

This repository now includes a minimal Next.js front-end. The `pnpm dev` command will start both the Express API server (port 3000) and the Next.js dev server (port 3001) using `concurrently`.

Run a single command during development:

```bash
pnpm dev
```

Open http://localhost:3001 to use the UI that connects to the SSE endpoint at http://localhost:3000/api/search-and-crawl-stream.

Client-side edits hot-reload in development (Fast Refresh), including updates to `public/styles.css` and React/TypeScript files under `pages/` and `src/components/`.

If you see an "address already in use" error, stop any previously running servers first. To find and kill processes listening on the ports (macOS / Linux), you can run:

```bash
lsof -iTCP:3000 -sTCP:LISTEN -t | xargs -r kill -9
lsof -iTCP:3001 -sTCP:LISTEN -t | xargs -r kill -9
```

Then re-run `pnpm dev`.

## Batch querying discovered CRDs

To scan every saved raw file for embedded `firmId` and `crdNumber` values and fetch those records as CRDs, run:

```bash
npm run query-derived-crds
```

By default this only fetches missing or invalid local detail files for both sources and writes progress to:

- `data/derived/query-derived-crds-targets.json`
- `data/derived/query-derived-crds-report.json`

Optional flags:

- `--refresh-existing` to re-fetch files that already exist locally
- `--limit=<N>` to cap how many discovered targets are processed
- `--sources=finra,sec` and `--types=firm,individual` to narrow the run

To audit the saved CRD detail files directly against the live FINRA and SEC detail endpoints, run:

```bash
npm run audit-external-crds
```

This audit bypasses the response cache, re-checks each saved `finra|sec:individual|firm:<CRD>` key against its canonical top-level detail endpoint, and keeps a resumable report in:

- `data/derived/audit-external-crds-targets.json`
- `data/derived/audit-external-crds-report.json`

Request pacing is randomized between each live fetch. If a source returns `429`, the audit pauses that source for **3 minutes**, then **4 minutes**, then **5 minutes**, and so on until it gets through again; after that, it keeps using the slower successful cadence until sustained success lets it relax gradually.

Optional flags:

- `--restart` to start from the beginning
- `--refresh-targets` to rebuild the saved-key list before the run
- `--limit=<N>` to process only part of the queue in one pass
- `--sources=finra,sec` and `--types=firm,individual` to narrow the audit
- `--request-delay-ms=<N>` or `--request-delay-ms-min=<N> --request-delay-ms-max=<N>` to change the randomized baseline cadence

To walk the numeric CRD gaps already implied by the local detail cache and probe those missing numbers in ascending order, run:

```bash
npm run query-sequential-gap-crds
```

This scan builds source-specific gap ranges from the saved detail files in `data/raw/`, skips CRDs that already returned empty or blocked responses in earlier runs, and writes progress to:

- `data/derived/query-sequential-gap-crds-targets.json`
- `data/derived/query-sequential-gap-crds-report.json`
- `data/derived/query-sequential-gap-crds-misses.json`

Optional flags:

- `--sources=finra,sec` and `--types=firm,individual` to narrow the scan
- `--start-crd=<N>` / `--end-crd=<N>` to scan only part of the observed range
- `--limit-gaps=<N>` to cap how many missing CRDs are probed per selected source/type range
- `--refresh-attempted` to retry CRDs previously recorded as empty or blocked
- `--request-delay-ms=<N>` or `--request-delay-ms-min=<N> --request-delay-ms-max=<N>` to add a fixed or jittered pause between each probe

The same pacing can be set with `SEQUENTIAL_GAP_DELAY_MS_MIN` / `SEQUENTIAL_GAP_DELAY_MS_MAX` environment variables for long-running background sweeps.

The firm ranges are practical to sweep end-to-end over time, but the observed individual range is very sparse and currently spans into the millions, so narrow `--start-crd`, `--end-crd`, or `--limit-gaps` is recommended there.

To check daily for newly-issued CRDs above the current local maximum, run:

```bash
npm run query-high-water-crds
```

This command determines the current maximum saved CRD per type, probes upward from the saved frontier, and keeps a resumable frontier state in:

- `data/derived/query-high-water-crds-report.json`
- `data/derived/query-high-water-crds-frontier.json`
- `data/derived/query-high-water-crds.log` when run from the daily wrapper

Defaults are intentionally bounded for a daily cron run:

- `--max-crds-per-type=<N>` limits how many larger CRD numbers are checked per selected type on each run
- `--stop-after-empty-misses=<N>` stops each type after `N` consecutive empty responses
- `--sources=finra,sec` and `--types=firm,individual` narrow the run
- `--refresh-frontier` resets the saved above-max frontier and starts again from the current max + 1

The local daily wrapper is `scripts/run-daily-high-water-crds.sh`. It is intended to be run under `flock` so overlapping cron runs are skipped instead of starting a second copy.

The dashboard also has a right-hand **New CRDs** column that now shows Redis-only high-water lists for individual and firm CRDs. When the UI loads it reads `/api/new-crds` and displays the highest CRD values currently saved in Redis, split into separate person and firm lists, rather than rebuilding the old item feed from `data/derived/new-crds-dashboard.json`.

To avoid scanning Redis on every request, the saved-key index is cached locally in `data/derived/raw-keys-index.json` and refreshed on a TTL (default 5 minutes, configurable with `RAW_KEYS_INDEX_CACHE_TTL_MS`).

To derive the most common three-letter fragments from saved person names, search both sources with those terms, and then hydrate the discovered CRDs, run:

```bash
npm run query-common-name-crds
```

Optional flags:

- `--limit-terms=<N>` to change how many top three-letter terms are used
- `--limit-crds=<N>` to cap the discovered CRDs that get hydrated
- `--refresh-existing` to re-fetch profiles that already exist locally

To search each letter of the alphabet and each digit (`a-z` and `0-9`), collect the CRDs returned by those searches, and then hydrate those CRDs, run:

```bash
npm run query-alnum-crds
```

Optional flags:

- `--limit-crds=<N>` to cap how many discovered CRDs get hydrated
- `--seeds=a,b,c,0,1,2` to run a smaller custom seed set
- `--refresh-existing` to re-fetch profiles that already exist locally

To do a slower crawl seeded by common bank names, while also reusing `firmId` and `crdNumber` values extracted from the existing raw downloads, run:

```bash
npm run query-bank-name-crds
```

Defaults:

- searches both `firm` and `individual` endpoints on FINRA and SEC
- uses a paced delay between search requests and detail requests
- folds the search-derived CRDs into the existing-download CRD set before hydrating

Optional flags:

- `--terms=wells fargo,jpmorgan,chase,bank of america`
- `--limit-targets=<N>`
- `--search-delay-min-ms=<N>` / `--search-delay-max-ms=<N>`
- `--detail-delay-min-ms=<N>` / `--detail-delay-max-ms=<N>`
- `--refresh-existing`

To keep retrying that bank-name crawl intermittently after any active crawl finishes, run:

```bash
npm run query-bank-name-crds-supervisor
```

Defaults:

- waits for any active `query-*-crds` crawl to finish
- runs the bank-name crawl
- sleeps a randomized `20-45` minutes before repeating

Optional flags are passed through to the bank-name crawl, plus:

- `--wait-poll-ms=<N>` to change how often the supervisor checks for active crawls
- `--sleep-min-ms=<N>` / `--sleep-max-ms=<N>` to change the intermittent retry window
- `--max-cycles=<N>` to stop after a fixed number of bank-crawl cycles

To keep expanding toward a target number of unique CRDs using multiple strategies (`derived`, `common-name`, `alphanumeric`, and `bank-name`), run:

```bash
npm run query-target-crds-supervisor
```

Defaults:

- target: `50,000` unique CRDs
- runs the four crawl strategies sequentially each cycle
- sleeps a randomized `20-45` minutes between cycles

Optional flags:

- `--target-unique-crds=<N>`
- `--sleep-min-ms=<N>` / `--sleep-max-ms=<N>`
- `--max-cycles=<N>`
