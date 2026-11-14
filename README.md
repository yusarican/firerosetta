# FireRosetta — MODIS + VIIRS tek ölçekte yanma takvimi

NASA Space Apps 2026, **"Harmonization of MODIS and VIIRS Hot Spots"** challenge'ı için MostrAI takımının projesi.

Bir alan seç (çiz, hazır bölge, ya da enlem/boylam kutusu) → 2000'den bugüne aylık hotspot takvimi,
medyana göre anomali, yıllık karşılaştırma, ham hotspot CSV'si; analizler (aylık seri, yıllık
toplam/anomali, tipik sezon) CSV, takvim ve grafikler PNG olarak indirilebilir. 2012 öncesi MODIS sayımları,
VIIRS'in sayacağı değere çevrilmiş durumda; her tahminin belirsizlik aralığı var.

## Çalıştırma

En hızlı yol: `./start.sh`. Veri yoksa önce hazır veri + eğitilmiş modeli bir GitHub Release'den
indirmeyi dener (`data/staged` + `data/processed`, ~birkaç yüz MB) — böylece her klon FIRMS'ten
aynı 727 MB'ı indirip aynı ~10 dakikalık eğitimi tekrarlamak zorunda kalmaz. Release indirilemezse
(ağ yok, henüz yayınlanmamış vb.) otomatik olarak aşağıdaki tam hattı çalıştırır. Veriyi/modeli
gerçekten FIRMS'ten taze üretmek için `./start.sh --rebuild` kullan.

Adım adım (ya da `start.sh` içinde ne olduğunu görmek için):

```bash
# 1) Veri + model (ilk seferde ~10 dk, 727 MB indirir)
cd backend
uv sync
uv run python -m firerosetta.fetch       # FIRMS arşivi (anahtar gerekmez)
uv run python -m firerosetta.ingest      # tek şemalı hotspots.parquet
uv run python -m firerosetta.grid        # 0.1° hücre × ay tablosu
uv run python -m firerosetta.harmonize   # hiperparametre arama + çapraz doğrulama + harmonized.parquet

# 1b) Erken uyarı modeli (gözetimli öğrenme) - isteğe bağlı, ~6 dk
uv run python -m firerosetta.weather     # NASA POWER günlük veri -> aylık yangın-hava indeksleri
uv run python -m firerosetta.forecast    # 1-3 ay ileriye tahmin + ileri-doğrulama + taşınabilir model

# 1c) Sabit ısı kaynağı dedektörü (gözetimsiz) - isteğe bağlı, ~1 dk
uv run python -m firerosetta.static      # kalıcı baca/flare/tesis noktalarını işaretler

# 2) API
uv run uvicorn firerosetta.api:app --port 8000

# 3) Arayüz
cd ../web && npm install && npm run dev   # http://localhost:3000
```

### GPU / CUDA

Cihaz seçimi tek yerde: `firerosetta/gpu.py`. Her eğitim adımı başlarken hangi donanımda
çalıştığını yazar, böylece sessizce CPU'ya düşmek fark edilmeden kalmaz.

```bash
uv sync --extra gpu                       # torch + CUDA tekerlekleri (~2.5 GB, zorunlu değil)
uv run --extra gpu python -m firerosetta.gpu   # ne bulduğunu ve kaç TFLOP/s verdiğini yazar
FIREROSETTA_DEVICE=cpu uv run ...         # GPU varken bile CPU'ya zorla (tekrarlanabilirlik testi)
```

Dürüst kapsam: `harmonize` ve `forecast` scikit-learn `HistGradientBoosting` kullanıyor ve bunun
CUDA yolu **yok**; bu adımlar tasarım gereği CPU'da kalıyor ve bunu ekrana yazıyor. Girdileri
(~2×10⁵ satır) zaten PCIe transferini amorti edecek boyutta değil. Sabit kaynak dedektörü de
ölçüm sonucu CPU'da kaldı (aşağıya bakın). GPU gerçekten `--benchmark-deep` altında çalışıyor.

### Hazır veri yayınlamak (bakımcılar için)

`./start.sh` içindeki `DATA_RELEASE_URL`'in işaret ettiği GitHub Release'i güncellemek için,
veriyi üstten üretip paketleyip bir release'e asset olarak yükle:

```bash
./start.sh --rebuild                      # ya da zaten üretilmiş data/ varsa bu adımı atla
tar -czf firerosetta-data.tar.gz -C data staged/hotspots.parquet processed
gh release create data-v1 firerosetta-data.tar.gz \
  --title "FireRosetta data v1" \
  --notes "Prebuilt hotspots + harmonized model output, so clones skip the ~10 min FIRMS fetch + train."
```

Veri/model önemli ölçüde değiştiğinde (yeni ülke, yeni yıl, model değişikliği) tag'i artır (`data-v2`, ...)
ve `start.sh`'teki URL'i güncelle.

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
  weather.py     NASA POWER günlük (MERRA-2) → 1° blok × ay yangın-hava indeksleri
  forecast.py    Erken uyarı modeli: 1-3 ay ileriye tahmin, ileri-doğrulama, taşınabilir model
  static.py      Gözetimsiz sabit ısı kaynağı (baca/flare/tesis) dedektörü → static_sites.parquet
  gpu.py         Tüm eğitim adımları için tek cihaz seçimi (CUDA varsa kullanır, yoksa CPU)
  model.py       Eğitim zamanı regresyon başlığı (bilerek paketlenmiyor; forecast.py'ye bak)
  api.py         FastAPI + DuckDB: /meta /calendar /hotspots /hotspots.csv /validation
                 /forecast /static-sources
web/             Next.js 16 + shadcn/ui + MapLibre
data/            (git'e girmez) raw / staged / processed / models / manifest.json
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
   dönem MODIS klimatolojisi, mevsim, konum. Hiperparametreler (learning rate, yaprak sayısı, min
   örnek/yaprak, L2) küçük bir ızgara üzerinden bir tutma-yılı ile seçiliyor; seçilen değerler
   `metrics.json["hyperparams"]`'da. Eğitim hedefine (gerçek VIIRS sayısına değil, yalnız eğitimde
   kullanılan kopyasına) Poisson gürültüsü ekleniyor — uydu sayımları zaten sayma istatistiği
   gürültülü olduğundan model tam deterministik geçmiş sayıyı ezberlemek yerine bu gürültüye dayanıklı
   öğreniyor.
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

## Erken uyarı (gözetimli öğrenme)

Arayüzdeki **Early warning** sekmesi, seçilen alan için 1–3 ay ileriye tahmin üretir: beklenen
hotspot sayısı, %80 aralığı, "normale göre kaç kat" ve o ayın anormal bir yangın ayı olma olasılığı.

### Eldeki veri yetiyor mu?

Kısmen. FIRMS yalnızca yangın tespiti servis ediyor; hava/kuraklık verisi yok. Yangın geçmişi tek
başına **mevsim döngüsünü** öğrenir ama **hangi yılın yanacağını** öğrenemez: 1° blok × ayda yalnızca
klimatoloji R² 0,20 alıyor, buna karşılık ülke-yıl toplamları klimatolojinin 0,25–2,1 katı arasında
salınıyor (ör. İspanya 2025 = 2,14×, Portekiz 2021 = 0,25×). Erken uyarının bütün amacı bu salınım
olduğundan, dışarıdan meteoroloji eklendi.

**Eklenen veri:** [NASA POWER](https://power.larc.nasa.gov/) **günlük** MERRA-2 reanalizi
(anahtar gerekmez, 680 blok merkezi için tek istek, ~5 dk). Aylık ortalama yangın için zayıf bir
temsil — önemli olan uçlar ve sürekliliktir — bu yüzden günlükten aylık **yangın-hava indeksleri**
türetiliyor: ardışık yağışsız gün dizisi (ay sınırını aşarak), 30/35 °C üstü gün sayısı, RH < %30
gün sayısı, sıcak+kuru+düşük nem bileşik gün sayısı, VPD'nin p90/max değeri, tepe rüzgâr,
kök bölgesi toprak nemi ve gün gün entegre edilen **Keetch-Byram kuraklık indeksi (KBDI)**.

### Nasıl çalışıyor

1. **Birim: 1° blok × ay.** 0,1° hücrede aylık yangın sayısı neredeyse rastgele; 1°'de mevsim ve
   kuraklık sinyali tahmin edilebilir hale geliyor. Kullanıcının çizdiği alan, kapsadığı blokların
   tahminlerinin, **o alanın her bloktaki tarihsel yanma payıyla** ağırlıklı toplamı olarak sunuluyor.
2. **Nedensellik.** Modelin gördüğü her şey t ayının sonunda bilinebilir; hedef t+1, t+2, t+3.
   Hava yalnızca *öncül* koşul olarak giriyor (ne kadar kurak/sıcak geçti), tahmin edilen ayın
   havası asla kullanılmıyor — gerçek mevsimsel yangın tahminleri de böyle çalışır.
3. **İki çıktı.** log1p(sayı) üzerinde gradient boosting + **izotonik kalibrasyon** (ham log modeli
   büyük ayları %34 düşük tahmin ediyordu; harmonize.py'deki aynı düzeltme) → beklenen sayı;
   ayrıca bir sınıflandırıcı → anormal ay olasılığı.
4. **İleriye doğrulama.** Genişleyen pencere: her kat yalnızca tahmin ettiği yıllardan *önceki*
   yıllarla eğitiliyor ve **klimatoloji öznitelikleri de her katın kendi eğitim yıllarından**
   yeniden hesaplanıyor, böylece hiçbir kat kendi geleceğini göremiyor.

### Sonuçlar (2016–2025, görülmemiş yıllar, 1 ay ileriye)

| Ölçek | Kalıcılık (t-1) | Mevsimsel (t-12) | Klimatoloji | Yalnız yangın geçmişi | **Tam model** |
|---|---|---|---|---|---|
| 1° blok × ay (R²) | −0,50 | −0,48 | 0,20 | 0,28 | **0,30** |
| 5° bölge × ay (R²) | — | — | 0,44 | 0,52 | **0,55** |

Anormal ay sınıflandırıcısı: **ROC-AUC 0,77** (taban oran %6,6, ortalama kesinlik 0,19).
2 ay ileride R² 0,51 / AUC 0,76; 3 ay ileride R² 0,50 / AUC 0,75.

Aynı alan için API, o alanın kendi geriye-dönük testini de hesaplıyor (ülke × ay, 119 ay):

| Alan | Tam model | Klimatoloji | Yalnız geçmiş |
|---|---|---|---|
| İtalya | **0,75** | 0,66 | 0,66 |
| Türkiye | **0,62** | 0,26 | 0,55 |
| Arjantin | **0,58** | 0,40 | 0,54 |
| Yunanistan | **0,14** | 0,12 | 0,11 |
| Portekiz | 0,14 | **0,18** | 0,06 |
| İspanya | 0,02 | **0,11** | −0,00 |

**Dürüst okuma:** model klimatolojiyi 6 ülkenin 4'ünde geçiyor, İspanya ve Portekiz'de geçemiyor;
arayüz bu durumu ilgili alanda açıkça uyarı olarak gösteriyor. Kazancın büyük kısmı yangın
geçmişinden geliyor: hava verisi havuzun tamamında 1° blokta +0,019, 5° bölgede +0,031 R² ekliyor
(ülke ölçeğinde daha belirgin: İtalya +0,09, Türkiye +0,07). Aylık *ortalama* hava değişkenleriyle
bu katkı yalnızca +0,006'ydı ve 3 ay ileride **zarar** veriyordu; günlük uç indekslerine (ardışık
kurak gün, 35 °C üstü gün, KBDI) geçmek katkıyı üçe katladı ve işareti düzeltti. Yine de hava,
klimatolojinin üzerindeki toplam kazancın ~%20'si kadar.

Kalan bilinen sapma: izotonik kalibrasyondan sonra bile toplamda −%12 ve en yoğun %10'luk
dilimde 0,75× (kalibrasyondan önce −%34 ve 0,56×). En büyük yangın ayları hâlâ olduğundan
düşük tahmin ediliyor.

### Modeli taşımak / yayınlamak

Eğitim sonunda `data/models/firerosetta-earlywarn.tar.gz` (~35 MB) kendiliğinden paketleniyor:
eğitilmiş model, metrikler, çıkarım için blok öznitelik tablosu ve geriye-dönük test tablosu.
Yeniden eğitmeden sadece paketlemek için `--package`. `earlywarn.json` içinde scikit-learn/numpy
sürümleri yazılı; API farklı sürümde uyarı verir (pickle sürüme duyarlıdır).

```bash
uv run python -m firerosetta.forecast --package
gh release create earlywarn-v1 \
  ../data/models/firerosetta-earlywarn.tar.gz ../data/models/firerosetta-earlywarn.sha256 \
  --title "FireRosetta early-warning model v1" \
  --notes "Trained model + inputs; extract into data/."
```

## Sabit ısı kaynağı tespiti (gözetimsiz öğrenme)

Fabrika bacası, flare kulesi, demir-çelik tesisi veya rafineri yılın her haftası sıcaktır.
FIRMS bunların bir kısmını `type` 1/2/3 ile etiketliyor ve `grid.py` onları atıyor; ama bu
etiket bir **konum veritabanından** geliyor: eksik, ve sensörler arasında çok dengesiz
uygulanıyor (VIIRS'te Türkiye/İtalya tespitlerinin ~%25–30'u etiketli, MODIS'te ~%3).
Kaçanlar "bitki örtüsü yangını" akışında kalıyor ve yanma olarak sayılıyor.

### Nasıl çalışıyor

1. Tespitler ~1,1 km'lik **noktalara** toplanıyor (0,01°), her nokta *zaman içindeki
   davranışıyla* 21 öznitelikle tarif ediliyor: görülebileceği ayların kaçında görülmüş,
   her yıl tekrarlıyor mu, gece oranı, ışıma gücünün kararlılığı, tespitlerin aynı noktaya
   ne kadar sıkı yığıldığı, aynı gün komşu hücrelerde bir şey yanıyor mu.
2. Üç dedektör skoru sıra-ortalamasıyla birleşiyor: **isolation forest** (bu nokta sıra dışı
   mı?), **Mahalanobis** uzaklığı (kütleden ne kadar uzak?) ve **staticness indeksi** (sıra
   dışılığı bir bacanın olacağı *yönde* mi?). Üçüncüsü skoru yönlü yapıyor; ilk ikisi tek
   başına "tuhaf" olan her noktayı da işaretlerdi.
3. Eşik veriden okunuyor: staticness indeksinin çekirdeğine dayanıklı bir normal uyduruluyor
   ve 4σ ötesinde normalin asla üretemeyeceği kadar çok nokta sayılıyor. Bu fazlalık
   kirlilik oranı (%1,59). **Etiket kullanılmıyor** — bu önemli, çünkü modelin işaretleyip
   FIRMS'in etiketlemediği nokta tam da aradığımız şey; etikete göre kalibre etmek
   keşifleri hata saymak olurdu.

Eğitim yalnızca yangın akışında (`type = 0`), FIRMS'in etiketlediği noktalar tamamen dışarıda.
Yani model aramakla görevli olduğu şeyin tek bir örneğini bile görmüyor; o etiket sonradan
sadece **puanlamak** için kullanılıyor.

### Sonuçlar (1.441 etiketli nokta tutuldu, model hiç görmedi)

| Skor | AUC | Gün sayısına göre katmanlı AUC |
|---|---|---|
| **Üçlü topluluk (yayınlanan)** | **0,989** | **0,893** |
| yalnız isolation forest | 0,984 | 0,875 |
| yalnız staticness indeksi | 0,979 | 0,874 |
| yalnız Mahalanobis | 0,977 | 0,867 |
| yalnız `months_frac` (tek öznitelik) | 0,961 | 0,889 |
| basit kural (≥24 ay ve ≥10 farklı ay) | 0,707 | 0,568 |

Katmanlı AUC dürüst olanı: düz AUC kayırmalı, çünkü FIRMS **konumları** etiketliyor, o konumlar
da doğal olarak daha çok tespit taşıyor — "çok veriyi seven" her skor iyi görünür. Testi tespit
günü sayısı kovalarında tekrarlamak bu avantajı kaldırıyor. Dürüst okuma: tek bir öznitelik
(`months_frac`) katmanlı ölçüte göre işin neredeyse tamamını yapıyor; topluluğun kazancı düz
AUC'de (0,961 → 0,989) ve tek eksene bağlı kalmamakta.

İşaretlenen 2.866 noktanın 1.117'si FIRMS'in zaten etiketlediği noktalar (geri çağırma %77,5),
**1.749'u ise FIRMS'in etiketlemediği yeni adaylar.** Bunlar yangın akışında kalmış, yani
şu an takvimde yanma olarak sayılıyorlar.

En güçlü adaylar elle haritaya bakılarak doğrulandı ve gerçek tesisler çıktı:

| İşaretlenen nokta | Tesis | Yayımlanmış konum |
|---|---|---|
| 36,733 K / 36,214 D | İsdemir, Payas (demir-çelik) | 36,7330 / 36,1960 — **1,2 km** |
| 38,736 K / 26,946 D | Petkim/Tüpraş Aliağa petrokimya | Aliağa yarımadası |
| 43,537 K / −5,834 B | ArcelorMittal Asturias | Avilés 43,5547/−5,8726, Gijón 43,5251/−5,7319 arası |
| −38,054 G / −68,854 B | Vaca Muerta / Neuquén gaz flare'ları | Neuquén havzası |

### Harmonizasyona etkisi

İşaretler, "yangın" sayılan tespitlerin **VIIRS'te %2,46'sını, MODIS'te %1,77'sini** kaldırıyor.
Beklendiği gibi VIIRS'e kayık (375 m küçük nokta kaynakları görüyor, 1 km MODIS göremiyor) ama
her yerde değil — İtalya'da tersine dönüyor:

| Ülke | MODIS | VIIRS |
|---|---|---|
| İspanya | %4,23 | **%9,93** |
| İtalya | **%7,24** | %5,06 |
| Türkiye | %2,73 | %4,32 |
| Yunanistan | %0,73 | %2,11 |
| Arjantin | %1,19 | %1,55 |
| Portekiz | %0,10 | %1,06 |

Bu işaretler **hattı kendiliğinden değiştirmiyor**: `grid.py` hâlâ yalnız FIRMS'in `type`
etiketine göre eliyor. Dedektör çıktısı ayrı bir tabloda (`static_sites.parquet`) ve
`/static-sources` uç noktasında duruyor, böylece bir modelin kararıyla sessizce veri silinmiyor;
ne atılacağı görülüp değerlendirilebiliyor.

### Derin modeller neden yok

Önce onlar denendi: gürültü giderici autoencoder, Deep SVDD ve GPU'da tam kNN (1,2×10¹⁰ çift,
3,7 s — CPU'da ~41 s, ~11× hızlanma). Hepsi yukarıdaki üç ucuz dedektörden **kötü** çıktı ve
topluluğa eklendiklerinde topluluğu bozdular:

| Model | Katmanlı AUC | Yayınlanan topluluğa eklenince |
|---|---|---|
| autoencoder | 0,743 | 0,799 |
| Deep SVDD | 0,807 | 0,858 |
| kNN (k=100, GPU) | 0,830 | 0,859 |
| **yayınlanan topluluk** | **0,893** | — |

21 derli toplu öznitelik ve ~110 bin nokta varken derin bir ağın öğrenecek temsili kalmıyor.
İlk denemede Gauss karışımıyla kümeleyip "hangi küme statik" diye sormak da başarısız oldu:
%1 kirlilikte karışım 10 bileşenin hepsini kütleyi bölmeye harcıyor, statik noktaları yutuyor
(katmanlı AUC 0,59–0,81). Sayılar `static.json` içindeki `deep_benchmark` alanında;
`--benchmark-deep` ile tekrar üretilebilir.

### Modeli taşımak / yayınlamak

```bash
uv run python -m firerosetta.static --package
gh release create static-v1 \
  ../data/models/firerosetta-static.tar.gz ../data/models/firerosetta-static.sha256 \
  --title "FireRosetta static-source detector v1" \
  --notes "Unsupervised persistent non-fire heat source detector."
```

Paket (~14 MB) içinde model, metrikler ve puanlanmış nokta tablosu var. Tablo modelin **tüm
girdi özniteliklerini** taşıyor, yani indiren kişi skorları yeniden üretip doğrulayabiliyor.
Pakette yalnız düz numpy/scikit-learn nesneleri var: torch da, `firerosetta` kodu da gerekmiyor
(bir test tam olarak bunu doğruluyor — tarball açılıyor, tarif sıfırdan numpy ile uygulanıyor ve
yayınlanan skorlarla birebir aynı çıkıyor).

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
- **Erken uyarı:** hava verisi toplam beceriye yalnızca mütevazı katkı yapıyor (yukarıda); ana
  sinyal yangın geçmişi. Küçük alanlarda ve yangının seyrek olduğu bölgelerde beceri yok.
- **Erken uyarı:** tahmin, verinin bittiği aydan (şu an 2025-12) ileriye üretiliyor; canlı
  kullanım için `fetch` ile güncel ay çekilip hat yeniden çalıştırılmalı. Tahmin ayının hava
  tahmini kullanılmadığı için 2–3 ay ileride beceri doğal olarak düşüyor.
- **Erken uyarı:** 2000–2011 hedefleri gözlem değil, harmonizasyon modelinin çıktısı; test
  yılları (2016–2025) tamamen gözlem. Bitki örtüsü/yakıt durumu (NDVI) henüz girdi değil.
- **Erken uyarı:** blok merkezinden örneklendiği için 24 ada bloğunda toprak nemi (kara değişkeni)
  boş; ağaçlar eksik değeri doğal olarak işliyor.
- **Sabit kaynak:** yalnızca ≥10 tespit günü **ve** ≥1 yıl süre olan noktalar işaretlenebiliyor
  (111.565 nokta). Tek seferlik bir tespit hiçbir zaman fabrika sayılmaz; bunun bedeli, yeni
  açılmış bir tesisin birkaç yıl görünmez kalması.
- **Sabit kaynak:** ayrım, çok gözlenen noktalarda zorlaşıyor — AUC (9–25 gün) 0,99 iken
  (50–100 gün) kovasında 0,75'e düşüyor. Gerçekten çok yanan bir orman noktası ile bir tesisi
  ayırmak doğal olarak daha zor.
- **Sabit kaynak:** %1,59'luk kirlilik tahmini 4σ seçimine duyarlı (3σ'da %2,63, 5σ'da %0,95);
  eşik bu aralıkta oynatılabilir.
- **Sabit kaynak:** nokta ızgarası 0,01°, yani birbirine 1 km'den yakın iki ayrı tesis tek nokta
  sayılabiliyor; büyük bir tesis de birkaç komşu noktaya bölünebiliyor (Asturias'ta olduğu gibi).
- **Sabit kaynak:** doğrulama FIRMS'in kendi etiketine karşı yapılıyor, o etiket de eksik. "FIRMS
  etiketlemediği hâlde işaretlenen" 1.749 nokta hata değil aday; yalnız en güçlü birkaçı elle
  doğrulandı, tamamı değil.
