#!/usr/bin/env bash
# FireRosetta: API + arayüzü birlikte başlatır. Ctrl+C ikisini de kapatır.
#   ./start.sh            -> veri yoksa üretir, sonra API + web
#   ./start.sh --rebuild  -> veriyi baştan üretir (~10 dk, 727 MB)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_PORT="${API_PORT:-8000}"
WEB_PORT="${WEB_PORT:-3000}"

for cmd in uv npm; do
  command -v "$cmd" >/dev/null || { echo "Hata: '$cmd' bulunamadı." >&2; exit 1; }
done

port_busy() { lsof -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
for p in "$API_PORT" "$WEB_PORT"; do
  if port_busy "$p"; then
    echo "Hata: $p portu kullanımda. Kapat ya da API_PORT/WEB_PORT ile başka port ver." >&2
    exit 1
  fi
done

cd "$ROOT/backend"
uv sync --quiet

if [[ "${1:-}" == "--rebuild" || ! -f "$ROOT/data/processed/harmonized.parquet" ]]; then
  echo "==> Veri hattı çalışıyor (fetch → ingest → grid → harmonize)"
  fetch_args=()
  [[ "${1:-}" == "--rebuild" ]] && fetch_args=(--force)   # gerçekten yeniden indir
  echo "--> firerosetta.fetch"
  uv run python -m firerosetta.fetch "${fetch_args[@]+"${fetch_args[@]}"}"
  for step in ingest grid harmonize; do
    echo "--> firerosetta.$step"
    uv run python -m "firerosetta.$step"
  done
fi

if [[ ! -d "$ROOT/web/node_modules" ]]; then
  echo "==> npm install"
  (cd "$ROOT/web" && npm install)
fi

pids=()
cleanup() {
  trap - INT TERM EXIT
  echo
  echo "==> Kapatılıyor..."
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

echo "==> API: http://127.0.0.1:$API_PORT"
(cd "$ROOT/backend" && exec uv run uvicorn firerosetta.api:app --port "$API_PORT") &
pids+=($!)

echo "==> Web: http://localhost:$WEB_PORT"
(cd "$ROOT/web" && FIREROSETTA_API_URL="http://127.0.0.1:$API_PORT" exec npm run dev -- --port "$WEB_PORT") &
pids+=($!)

# Biri düşerse diğerini de kapat
while :; do
  for pid in "${pids[@]}"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "Bir süreç durdu; diğeri de kapatılıyor." >&2
      exit 1
    fi
  done
  sleep 1
done
