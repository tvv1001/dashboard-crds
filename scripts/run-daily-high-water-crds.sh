#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

mkdir -p data/derived

echo "[$(date -Is)] starting daily high-water CRD check"
npm run query-high-water-crds
echo "[$(date -Is)] finished daily high-water CRD check"
