# FireRosetta — MODIS + VIIRS tek ölçekte yanma takvimi

NASA Space Apps 2026, **"Harmonization of MODIS and VIIRS Hot Spots"** challenge'ı için MostrAI takımının projesi.

Bir alan seç (çiz, hazır bölge, ya da enlem/boylam kutusu) → 2000'den bugüne aylık hotspot takvimi,
medyana göre anomali, yıllık karşılaştırma, ham hotspot CSV'si; analizler (aylık seri, yıllık
toplam/anomali, tipik sezon) CSV, takvim ve grafikler PNG olarak indirilebilir. 2012 öncesi MODIS sayımları,
VIIRS'in sayacağı değere çevrilmiş durumda; her tahminin belirsizlik aralığı var.

## Çalıştırma

```bash
# 1) Veri + model (ilk seferde ~10 dk, 727 MB indirir)
cd backend
uv sync
uv run python -m firerosetta.fetch       # FIRMS arşivi (anahtar gerekmez)
uv run python -m firerosetta.ingest      # tek şemalı hotspots.parquet
uv run python -m firerosetta.grid        # 0.1° hücre × ay tablosu
uv run python -m firerosetta.harmonize   # model + çapraz doğrulama + harmonized.parquet

# 2) API
uv run uvicorn firerosetta.api:app --port 8000

# 3) Arayüz
cd ../web && npm install && npm run dev   # http://localhost:3000
```

İçinde bulunulan yıl FIRMS arşivinde yok; o yılı çekmek için ücretsiz bir MAP_KEY gerekir
(https://firms.modaps.eosdis.nasa.gov/api/map_key/). Anahtarı repo kökündeki `.env` dosyasına yaz
(`.env.example`'a bak; `.env` git'e girmez) ya da `FIRMS_MAP_KEY=...` ile ver. `fetch` önce FIRMS'in
veri uygunluk tablosuna bakar: standart ürünün yayımlandığı günlere kadar standart ürünü (`data/raw/current`),
sonrasında NRT'yi (`data/raw/nrt`) çeker. Akdeniz ülkeleri tek kutuda sorgulanır. Her istek 10 işlem
sayıyor, limit 10 dakikada 5000; 2026 çekimi ~3900 işlem tutuyor ve kod limite yaklaşınca kendisi bekliyor.

NRT ürünleri: MODIS C6.1 **MCD14DL** (doi:10.5067/FIRMS/MODIS/MCD14DL.NRT.0061), VIIRS 375 m
**VNP14IMGT_NRT** (S-NPP, doi:10.5067/FIRMS/VIIRS/VNP14IMGT_NRT.002) ve **VJ114IMGT_NRT**
(NOAA-20, doi:10.5067/FIRMS/VIIRS/VJ114IMGT_NRT.002).

## Yapı

```
backend/firerosetta/
  config.py      Ülkeler, sensörler, yollar
  fetch.py       FIRMS yıllık ülke CSV'leri → data/raw + manifest.json (URL, SHA-256, zaman)
  ingest.py      MODIS/VIIRS şema farklarını kapatır → data/staged/hotspots.parquet
  grid.py        Kalite filtresi + 0.1° × ay yoğun tablo (sıfırlar dahil)
  harmonize.py   MODIS→VIIRS modeli, yıl-bloklu 5 katlı CV, metrics.json
  api.py         FastAPI + DuckDB: /meta /calendar /hotspots /hotspots.csv /validation
web/             Next.js 16 + shadcn/ui + MapLibre
data/            (git'e girmez) raw / staged / processed / manifest.json
```

## Harmonizasyon nasıl çalışıyor

Referans cetvel: **S-NPP VIIRS 375 m** hotspot sayısı (bitki örtüsü yangını, güven ≥ nominal).

| Dönem | Kaynak | Yöntem |
|---|---|---|
| 2000-11 → 2002-06 | Yalnız Terra | "terra" modeli |
| 2002-07 → 2012-01 | Terra + Aqua | "full" modeli |
| 2012-02 → 2026-10 | S-NPP VIIRS | gözlem, olduğu gibi (2026-08'den itibaren NRT, "provisional") |
| 2026-11 → | NOAA-20 VIIRS | × 1.000 (2018-05 – 2026-07 örtüşmesinden) |

1. **Aynı kalite filtresi.** `type = 0` ve düşük güven hariç. VIIRS, Türkiye/İtalya'da tespitlerin
   ~%25-30'unu sabit endüstriyel kaynak olarak işaretliyor, MODIS ~%3; filtrelenmezse VIIRS dönemi kendi kendine şişer.
2. **Aynı ızgara.** 0.1° hücre × ay.
3. **Model.** log1p(sayı) üzerinde gradient boosting + izotonik kalibrasyon. Girdiler: MODIS sayısı,
   Terra/Aqua ve gece/gündüz ayrımı, FRP, komşu hücrelerdeki MODIS etkinliği (3×3, 7×7), hücrenin uzun
   dönem MODIS klimatolojisi, mevsim, konum.
4. **NRT'de `type` yok.** Sabit kaynaklar, standart kayıttan çıkarılan bir maskeyle ayıklanıyor: ~550 m'lik
   bir noktada ya da 8 komşusunda ≥3 bitki-dışı tespit varsa, NRT satırı o tipi alıyor (`type_inferred`).
   Görülmemiş 2025 verisinde bitki yangını sayısındaki hata VIIRS için +%12,8'den −%1,5'e, MODIS için +%6,5'ten +%1,5'e iniyor.
   Model yalnızca standart ürün aylarıyla (2012-02 – 2026-07) eğitilir ve doğrulanır.
5. **Doğrulama.** Her yıl, o yılı hiç görmemiş bir modelle tahmin edilir. Bu tahminler saklanır;
   API kullanıcının çizdiği **her alan için** yerel hata ve %90 aralık hesaplar.

### Sonuçlar (6 ülke, 2012-02 – 2026-07, görülmemiş yıllar; hata = toplam mutlak hata / toplam gözlem)

| Ölçek | Ham MODIS | Tek global katsayı | Model (yalnız Terra) | Model (Terra+Aqua) |
|---|---|---|---|---|
| 1° blok × ay | %71 | %35 | %40 | **%27** |
| Ülke × ay | %70 | %15 | %16 | **%9** |
| Ülke × yıl | %70 | %8 | %10 | **%5** |

## Bilinen sınırlar

- Yalnızca 6 ülke yüklü (Türkiye, Yunanistan, Portekiz, İspanya, İtalya, Arjantin). Eklemek için
  `config.py` → `COUNTRIES`. Brezilya/Avustralya/Kanada yılda ~100–150 MB VIIRS verisi demek.
- Ülke seçimi FIRMS'in ülke kırpmasına dayanıyor; sınır poligonu yok.
- Küçük alanlarda hata büyüyor (Muğla kıyısı ~%28). İspanya'da model %12 düşük tahmin ediyor.
- Çok sakin aylarda model yüksek tahmin ediyor (MODIS'in göremediği küçük yangınlar için taban değer).
- 2012–2026 MODIS↔VIIRS ilişkisinin 2000–2011'de de geçerli olduğu varsayılıyor.
- NRT ayları (VIIRS 2026-08 sonrası, MODIS 2026-09 sonrası) standart ürün yayımlanınca değişebilir;
  arayüzde kesik çizgiyle işaretli. İçinde bulunulan ay eksik (`partial`). Standart ürün çıkınca
  `fetch --force` + pipeline'ı yeniden çalıştırmak gerekiyor. NOAA-21 henüz kullanılmıyor.
- Yıllık aralıklar aylık aralıkların toplamı; bilerek geniş.
- Arayüz yalnız açık tema; mobilde takvim yatay kayıyor.
