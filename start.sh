#!/usr/bin/env bash
# FireRosetta: API + arayüzü birlikte başlatır. Ctrl+C ikisini de kapatır.
#   ./start.sh                  -> veri yoksa GitHub Release'den indirir (yoksa baştan üretir), sonra API + web
#   ./start.sh --rebuild        -> veriyi FIRMS'ten baştan üretir (~10 dk, 727 MB) ve modeli yeniden eğitir
#   ./start.sh --with-forecast  -> ek olarak erken uyarı modelini de eğitir (NASA POWER, ~9 dk)
#   ./start.sh --with-static    -> sabit ısı kaynağı (baca/fabrika) dedektörünü eğitir (~1 dk)
# Modeller yoksa önce GitHub Release'den indirilir; indirilemezse eğitim yolu gösterilir.
# Erken uyarı modeli yoksa site yine çalışır; "Early warning" sekmesi nasıl üretileceğini söyler.
# Sabit kaynak dedektörü yoksa /static-sources uç noktası 503 döner, gerisi etkilenmez.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_PORT="${API_PORT:-8000}"
WEB_PORT="${WEB_PORT:-3000}"
# Herkesin kendi klonunda aynı ~10 dk'lık eğitimi tekrarlamaması için üç model GitHub
# Release olarak yayınlanıyor; indirme/doğrulama/açma işini scripts/release.sh yapıyor.
# --rebuild bunu atlar ve her şeyi FIRMS'ten taze veriyle yeniden üretir.
RELEASE="$ROOT/scripts/release.sh"

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

run_pipeline() {
  echo "==> Veri hattı çalışıyor (fetch → ingest → grid → harmonize)"
  fetch_args=()
  [[ "${1:-}" == "--rebuild" ]] && fetch_args=(--force)   # gerçekten yeniden indir
  echo "--> firerosetta.fetch"
  uv run python -m firerosetta.fetch "${fetch_args[@]+"${fetch_args[@]}"}"
  for step in ingest grid harmonize; do
    echo "--> firerosetta.$step"
    uv run python -m "firerosetta.$step"
  done
}

try_download_release() {
  # Checksum doğrulaması ve açma scripts/release.sh içinde; burada sadece sonucu raporluyoruz.
  echo "==> Hazır veri + modeller indiriliyor (GitHub Release)"
  if "$RELEASE" fetch data; then
    echo "==> Hazır veri kuruldu (harmonizasyon eğitimi atlandı)"
    return 0
  fi
  echo "==> Release indirilemedi, FIRMS'ten üretilecek (daha uzun sürer)" >&2
  return 1
}

run_forecast() {
  # Gözetimli erken uyarı modeli: NASA POWER günlük veri + ileri-doğrulamalı eğitim.
  # Bilerek ayrı: ~9 dk sürüyor ve takvim arayüzü onsuz da tam çalışıyor.
  echo "==> Erken uyarı modeli eğitiliyor (weather → forecast)"
  for step in weather forecast; do
    echo "--> firerosetta.$step"
    uv run python -m "firerosetta.$step"
  done
  # Yayınlanan model iki üyenin harmanı; ikinci üye (XGBoost) CUDA ister. GPU yoksa
  # scikit-learn modeli tek başına kalır ve her şey çalışır, sadece biraz daha zayıf.
  if uv run python -c "import sys; from firerosetta import gpu; sys.exit(0 if gpu.pick_device()[0] == 'cuda' else 1)" 2>/dev/null; then
    echo "--> firerosetta.forecast_gpu (CUDA bulundu; harman model eğitiliyor, ~12 dk)"
    uv run python -m firerosetta.forecast_gpu
  else
    echo "--> CUDA yok; harman adımı atlanıyor (scikit-learn modeli tek başına kullanılacak)."
    echo "    GPU'da: uv sync --extra gpu && uv run python -m firerosetta.forecast_gpu"
  fi
}

run_static() {
  # Gözetimsiz sabit ısı kaynağı dedektörü: baca, flare, demir-çelik tesisi gibi
  # FIRMS'in "type" etiketinin kaçırdığı kalıcı noktaları işaretler. Sadece CPU, ~1 dk.
  echo "==> Sabit ısı kaynağı dedektörü eğitiliyor (static)"
  uv run python -m firerosetta.static
}

if [[ "${1:-}" == "--rebuild" ]]; then
  run_pipeline --rebuild
elif [[ ! -f "$ROOT/data/processed/harmonized.parquet" ]]; then
  mkdir -p "$ROOT/data/staged" "$ROOT/data/processed"
  try_download_release || run_pipeline
fi

if [[ "${1:-}" == "--with-forecast" || "${1:-}" == "--rebuild" ]]; then
  run_forecast
elif [[ ! -f "$ROOT/data/models/earlywarn.joblib" ]]; then
  "$RELEASE" fetch earlywarn || {
    echo "==> Erken uyarı modeli yok; takvim çalışır, tahmin sekmesi kapalı."
    echo "    Eğitmek için: ./start.sh --with-forecast"; }
fi

if [[ "${1:-}" == "--with-static" || "${1:-}" == "--rebuild" ]]; then
  run_static
elif [[ ! -f "$ROOT/data/processed/static_sites.parquet" ]]; then
  "$RELEASE" fetch static || {
    echo "==> Sabit ısı kaynağı dedektörü yok; /static-sources kapalı."
    echo "    Eğitmek için: ./start.sh --with-static"; }
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
