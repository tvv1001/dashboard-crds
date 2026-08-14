# GEMINI.md — FINRA + SEC Data Intelligence & AI Engine

## Project Overview

This repository (`Data-finra-sec`) is a data ingestion, entity resolution, and intelligence platform for **FINRA BrokerCheck** and **SEC AdviserInfo** records. It retrieves source JSON payloads for financial individuals and firms, structures and merges records by shared **CRD (Central Registration Depository)** number, and provides both a Next.js dashboard UI and Google Gemini AI-driven analytical capabilities.

---

## Core Architecture & Data Principles

### 1. Redis is the Single Source of Truth for Reading & Writing Cache
- **No Local Raw Disk Storage**: Raw payload disk persistence (`data/raw/`) has been removed. **Redis is the single source of truth** for all saved FINRA and SEC payloads.
- **Direct Redis Operations**: All data reading, writing, updates, and indexing must use the Redis cache abstraction layer in `pages/api/_lib.ts`:
  - `loadSavedPayload(key)` — Reads raw source payload for a given key.
  - `saveRawPayload(key, payload)` — Writes raw source payload to Redis cache.
  - `loadCombinedSavedPayloadBundle(key)` — Reads both FINRA and SEC payloads for a given CRD and returns a merged bundle.
  - `deleteCacheKey(key)` — Removes a key from Redis cache.
  - `listSavedKeysWithStats(options)` — Retrieves indexed Redis key statistics.
- **Cache Key Standard**: Cache keys follow the strict pattern: `finra|sec:individual|firm:<CRD>` (e.g. `finra:individual:249`, `sec:firm:105267`).

### 2. STRICT: Preserve Redis JSON Payload Structure
- **Do NOT Change Redis JSON Structure**: **Another application uses the exact same Redis data payload schema.** Never alter, rekey, flatten, or transform the root JSON schema or field names stored in Redis.
- **Source-Fidelity Preserved**: Source JSON payloads must remain wrapped in their respective source-specific containers:
  - FINRA records: `{ "finraBrokerCheck": { ... } }`
  - SEC records: `{ "secInvestmentAdvisor": { ... } }`
- Any data enrichment or AI analysis must operate on retrieved copies or store auxiliary data in separate namespaces—**never modify the raw source payload schema in Redis**.

### 3. Dual-Source Entity Resolution (FINRA + SEC)
- **CRD is the primary join key**: A given `<CRD>` represents the same person or firm across both FINRA and SEC datasets.
- **Combined Bundle Loading**: `loadCombinedSavedPayloadBundle(key)` retrieves both FINRA and SEC payloads for a given CRD, merging registration status, disclosures, history, firm/individual connections, active states, and industry dates into a unified view for UI and AI workflows.

### 4. Redis Connection Modes & Health Probes
- Supported Redis backends:
  - **Upstash REST (Recommended)**: `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`
  - **Native Redis URL**: `REDIS_URL` (+ optional `REDIS_PASSWORD`)
- Connectivity probe endpoint: `/api/redis-health` reports connection state, active mode (`upstash-rest`, `redis-url`), and latency.

---

## Missing & Corrupt CRD Handling (Upstream Fallback & Hydration)

When inspecting or requesting a CRD (individual or firm), always verify payload integrity before processing:

### 1. Detection of Missing or Corrupt CRDs
- **Missing CRD**: Redis key `finra|sec:individual|firm:<CRD>` returns `null`, `undefined`, or does not exist in Redis cache.
- **Corrupt CRD**: Cached payload meets any of the following criteria:
  - Invalid JSON / JSON parse failure.
  - Empty JSON object (`{}`) or payload size is 0 bytes.
  - Contains blocking/rate-limit error indicators (e.g. `{"message": "Forbidden"}`, `Access Denied`, or HTML error markup).
  - Missing expected top-level container keys (`finraBrokerCheck` or `secInvestmentAdvisor`) or required entity data fields.

### 2. Upstream External API Querying (FINRA + SEC)
If a CRD is missing or corrupt in Redis cache, query both upstream detail endpoints to fetch fresh, authoritative records (replace `<CRD>` with numeric ID):

- **FINRA Individual Detail**: `https://api.brokercheck.finra.org/search/individual/<CRD>?includePrevious=true`
- **SEC Individual Detail**: `https://api.adviserinfo.sec.gov/search/individual/<CRD>?includePrevious=true`
- **FINRA Firm Detail**: `https://api.brokercheck.finra.org/search/firm/<CRD>`
- **SEC Firm Detail**: `https://api.adviserinfo.sec.gov/search/firm/<CRD>?wt=json`

*Note*: Search endpoints (`search/firm?query=<QUERY>`, `search/individual?query=<QUERY>`) are for discovery only. Never persist generic search query wrappers as detail records.

### 3. Cache Repair & Writes
Upon fetching valid upstream payloads:
1. Validate that the payload is non-empty and free of blocking indicators using `isEmptyPayload()` and `hasBlockingIndicators()`.
2. Format payload into the exact expected JSON wrapper (`{ finraBrokerCheck: data }` or `{ secInvestmentAdvisor: data }`).
3. Save directly to Redis cache using `saveRawPayload(key, payload)`.
4. Do NOT mutate or reformat the JSON schema before writing to Redis.

---

## Google Gemini AI Integration

The application integrates Google Gemini AI (`@google/generative-ai`) for entity record analysis, disclosure audits, professional summaries, and cross-domain data Q&A.

### Configuration
- Set `GOOGLE_API_KEY` in `.env`.

### API & CLI Workflows
- **Web UI AI Q&A Endpoint**: `pages/api/ai-qa.ts`
  - Leverages Gemini (`gemini-2.0-flash` / `gemini-2.5-flash`) to answer queries combining cached FINRA/SEC financial data stats, real estate data index, and historical events.
- **CLI Analysis Script**: `scripts/analyze-with-gemini.ts`
  - Run via: `pnpm analyze-with-gemini <key> [custom_prompt]`
  - Example: `pnpm analyze-with-gemini finra:individual:249 "Summarize disciplinary history"`
- **AI Hydration Flow**: If a Gemini AI task requires reading a specific CRD key that is missing or corrupt in Redis, the workflow must first execute the upstream API check (FINRA + SEC), save the clean raw payload to Redis, and then provide the payload to Gemini for inference.

---

## Front-End & UI Guidance

- **Framework**: Next.js (Pages Router) + React + TypeScript.
- **Styling System**: Pure Vanilla CSS in `public/styles.css`.
  - Avoid inline CSS or ad-hoc style objects. Add rules to `public/styles.css`.
  - Dark-mode friendly, clean data-dense panels, status badges (`src/lib/statusBadge.ts`), and graph network views.
- **Key UI Components**:
  - `src/components/Dashboard.tsx` — Main dashboard layout.
  - `src/components/panel/Panel.tsx` — Detailed entity view (individual/firm).
  - `src/components/panel/PanelHeader.tsx` — Header with Redis status, top entity badges, and Gemini analysis trigger (`✨ Analyze with Gemini`).
  - `src/components/sidebar/KeyList.tsx` — Key search, filters, and list navigation.
  - `src/components/new-crds/NewCrdItem.tsx` — Redis-backed highest CRD feed.

---

## Key Development Commands

```bash
# Spin up local Redis cache using Docker
docker-compose up -d

# Start Express API (port 3000) and Next.js dev server (port 3001) concurrently
pnpm dev

# Run Gemini CLI analysis on a saved key
pnpm analyze-with-gemini <key> [prompt]

# Run Redis-backed CRD Discovery and Frontier Crawls
npm run query-derived-crds
npm run query-high-water-crds
npm run audit-external-crds

# Upload legacy local JSON files from data/raw/ to the new Redis cache
npx tsx scripts/upload-local-to-redis.ts
```

---

## Guidelines for AI Assistants & Coding Tools

1. **Focus on Redis Cache Reading & Writing**: All data payload persistence and reads MUST use Redis helper functions in `pages/api/_lib.ts`. Never reintroduce disk-based raw JSON reads/writes in `data/raw/`.
2. **STRICT JSON Schema Preservation**: Never change, reformat, or alter the JSON payload structure saved in Redis. Another application relies on the exact same schema structure (`finraBrokerCheck` and `secInvestmentAdvisor` wrappers).
3. **Missing or Corrupt CRD Hydration**: If a requested or analyzed CRD is missing or corrupt in Redis, immediately fetch the firm/person CRD details from external upstream APIs (FINRA + SEC detail endpoints) and write the valid raw payload back to Redis cache.
4. **Preserve Dual-Source Fidelity**: Keep FINRA and SEC raw responses separate in their respective source containers.
5. **Use Placeholders in Docs & Prompts**: Always use `<CRD>`, `<QUERY>`, `<NROWS>` instead of hardcoding specific entity IDs.
6. **CSS Centralization**: Keep all layout, typography, animations, and color tokens in `public/styles.css`.
7. **Verify Local Runtime**: Before declaring tasks complete, verify API responses or UI components using local dev endpoints (`http://localhost:3001` or `/api/key?name=...`).
