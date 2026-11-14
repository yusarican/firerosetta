"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowDownToLine, ArrowUpRight, BellRing, Clock3, Info, MapPin, RefreshCw, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getAreaRisk, type Polygon, type RiskCell, type RiskGridKm, type RiskLevel, type RiskReport, type RiskView } from "@/lib/api";
import { areaBox, RISK_PLACES } from "@/lib/fire-areas";
import { AppHeader } from "./app-header";
import { RiskMap } from "./risk-map";

const MONTHS = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];
const LEVELS: Record<RiskLevel, { label: string; dot: string; badge: string }> = {
  high: { label: "Yüksek öncelik", dot: "bg-[#ce4638]", badge: "border-[#ce4638]/25 bg-[#ce4638]/8 text-[#a33529]" },
  elevated: { label: "Artmış öncelik", dot: "bg-[#dd911d]", badge: "border-[#dd911d]/30 bg-[#dd911d]/10 text-[#8d5708]" },
  watch: { label: "İzleme", dot: "bg-[#83948b]", badge: "border-border bg-muted text-muted-foreground" },
};
const number = (value: number) => value.toLocaleString("tr-TR");
const date = (value: string) => new Date(`${value}T12:00:00Z`).toLocaleDateString("tr-TR", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Istanbul" });
const coordinates = (cell: RiskCell) => `${Math.abs(cell.lat).toFixed(2)}°${cell.lat >= 0 ? "K" : "G"}, ${Math.abs(cell.lon).toFixed(2)}°${cell.lon >= 0 ? "D" : "B"}`;
const intersects = (cell: RiskCell, box: RiskView["bounds"]) => cell.bbox[2] > box[0] && cell.bbox[0] < box[2] && cell.bbox[3] > box[1] && cell.bbox[1] < box[3];

function currentReport(base: RiskReport, today: string): RiskReport {
  const age = Math.max(base.data_age_days, Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${base.data_through}T00:00:00Z`)) / 86_400_000));
  if (age <= 1) return base;
  return { ...base, data_age_days: age, current_evidence_enabled: false,
    cells: base.cells.map((cell) => ({ ...cell, level: cell.seasonal ? "elevated" : "watch" })) };
}

function visibleReport(base: RiskReport, bounds?: RiskView["bounds"]): RiskReport {
  const cells = bounds ? base.cells.filter((cell) => intersects(cell, bounds)) : base.cells;
  return { ...base, cells, summary: {
    high: cells.filter((cell) => cell.level === "high").length,
    elevated: cells.filter((cell) => cell.level === "elevated").length,
    watch: cells.filter((cell) => cell.level === "watch").length,
    recent_7d: cells.reduce((sum, cell) => sum + cell.recent_7d, 0), total_cells: cells.length,
  } };
}

function Badge({ level }: { level: RiskLevel }) {
  return <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] font-medium ${LEVELS[level].badge}`}>
    <span className={`size-1.5 rounded-full ${LEVELS[level].dot}`} />{LEVELS[level].label}
  </span>;
}

function reason(cell: RiskCell, fresh: boolean) {
  if (fresh && cell.recent_7d) return `Son 7 günde ${number(cell.recent_7d)} uydu tespiti · ${cell.active_days_7d} farklı gün`;
  if (cell.seasonal) return `Aynı ayda ${cell.active_years} farklı yılda faaliyet · mevsimsel öncelik`;
  if (fresh && cell.recent_30d) return `Son 30 günde ${number(cell.recent_30d)} tespit · yakın dönem izleme`;
  return `Aynı ayda ${cell.active_years} farklı yılda faaliyet kaydı`;
}

function downloadReport(report: RiskReport, cells: RiskCell[], label: string) {
  const rows = [
    ["analiz_tarihi", "veri_tarihi", "secilen_alan", "hucre_genisligi_km", "enlem", "boylam", "oncelik", "son_7_gun_tespit", "son_30_gun_tespit", "gecmiste_aktif_yil", "aylik_gecmis_ortalama", "son_tespit", "guncel_veri"],
    ...cells.map((cell) => [report.as_of, report.data_through, label, report.grid_km, cell.lat, cell.lon,
      LEVELS[cell.level].label, cell.recent_7d, cell.recent_30d, cell.active_years, cell.seasonal_mean,
      cell.last_seen ?? "", report.current_evidence_enabled ? "evet" : "hayir"]),
  ];
  const csv = "\uFEFF" + rows.map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `firerosetta_onlem_${label.replace(/[^\p{L}\d]+/gu, "_")}_${report.as_of}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

export function RiskDashboard() {
  const [area, setArea] = useState(RISK_PLACES[0]);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{ report: RiskReport | null; error: string | null; busy: boolean }>({ report: null, error: null, busy: true });
  const [filter, setFilter] = useState<"all" | RiskLevel>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [visible, setVisible] = useState(20);
  const [view, setView] = useState<RiskView | null>(null);
  const layerCache = useRef(new Map<string, RiskReport>());
  const requestedGrid = useRef<RiskGridKm>(20);
  const [preloaded, setPreloaded] = useState<RiskReport[]>([]);
  const [bbox, setBbox] = useState({ w: "", s: "", e: "", n: "" });
  const [areaError, setAreaError] = useState<string | null>(null);
  const [drawRequest, setDrawRequest] = useState(0);
  const [clientDay, setClientDay] = useState<string | null>(null);
  const areaKey = JSON.stringify(area.geometry);
  const areaBounds = useMemo<RiskView["bounds"]>(() => {
    const ring = area.geometry.coordinates[0];
    return [Math.min(...ring.map((point) => point[0])), Math.min(...ring.map((point) => point[1])),
      Math.max(...ring.map((point) => point[0])), Math.max(...ring.map((point) => point[1]))];
  }, [area.geometry]);

  useEffect(() => {
    const updateDay = () => setClientDay(new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Istanbul" }).format(new Date()));
    const initial = window.setTimeout(updateDay, 0);
    const interval = window.setInterval(updateDay, 60_000);
    return () => { window.clearTimeout(initial); window.clearInterval(interval); };
  }, []);

  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem("firerosetta-selected-area") ?? "null");
      if (saved?.kind === "polygon" && saved.geometry?.type === "Polygon" && Array.isArray(saved.geometry.coordinates?.[0])) {
        queueMicrotask(() => setArea({ label: saved.label || "Takvimde seçilen alan", geometry: saved.geometry }));
      }
    } catch {}
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const load = async (force = false) => {
      const levels = [...new Set<RiskGridKm>([requestedGrid.current, 20, 10, 5])];
      await Promise.all(levels.map(async (gridKm) => {
        const key = `${areaKey}:${gridKm}`;
        try {
          const cached = layerCache.current.get(key);
          const valid = cached && Date.now() - Date.parse(cached.checked_at) < 300_000;
          const report = valid && !force ? cached : await getAreaRisk(area.geometry, gridKm, controller.signal);
          if (controller.signal.aborted) return;
          layerCache.current.delete(key);
          layerCache.current.set(key, report);
          while (layerCache.current.size > 10) layerCache.current.delete(layerCache.current.keys().next().value!);
          setPreloaded((previous) => [...previous.filter((layer) => layer.country === report.country && layer.grid_km !== gridKm), report]);
          if (requestedGrid.current === gridKm) setState({ report, error: null, busy: false });
        } catch (error) {
          if (controller.signal.aborted || (error as Error).name === "AbortError" || requestedGrid.current !== gridKm) return;
          setState((previous) => previous.report ? { ...previous, busy: false, report: { ...previous.report,
            live_error: "Güncelleme yapılamadı. Son alınan rapor gösteriliyor; veri tarihini kontrol edin." } }
            : { report: null, error: (error as Error).message || "Uyarı verileri alınamadı. Yeniden deneyin.", busy: false });
        }
      }));
    };
    void load();
    const interval = window.setInterval(() => { if (document.visibilityState === "visible") void load(true); }, 300_000);
    const onVisible = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { controller.abort(); window.clearInterval(interval); document.removeEventListener("visibilitychange", onVisible); };
  }, [area.geometry, areaKey, revision]);

  const today = clientDay ?? state.report?.as_of ?? "1970-01-01";
  const baseReport = useMemo(() => state.report ? currentReport(state.report, today) : null, [state.report, today]);
  const report = useMemo(() => baseReport ? visibleReport(baseReport, view?.bounds) : null, [baseReport, view]);
  const cells = useMemo(() => report?.cells.filter((cell) => filter === "all" || cell.level === filter) ?? [], [report, filter]);
  const mapLayers = useMemo(() => preloaded.filter((layer) => layer.grid_km <= 20).map((layer) => currentReport(layer, today)), [preloaded, today]);
  const selected = baseReport?.cells.find((cell) => cell.id === selectedId) ?? null;
  const fresh = report?.current_evidence_enabled ?? false;
  const refresh = () => { setState((previous) => ({ ...previous, busy: true })); setRevision((value) => value + 1); };
  const changeView = useCallback((next: RiskView) => {
    if (view?.gridKm === next.gridKm && view.bounds.join(",") === next.bounds.join(",")) return;
    if (requestedGrid.current !== next.gridKm) {
      requestedGrid.current = next.gridKm;
      setSelectedId(null);
      const cached = layerCache.current.get(`${areaKey}:${next.gridKm}`);
      setState((previous) => cached ? { report: cached, error: null, busy: false } : { ...previous, busy: true });
    }
    setView(next);
    setVisible(20);
  }, [areaKey, view]);
  const chooseArea = (next: { label: string; geometry: Polygon }) => {
    if (JSON.stringify(next.geometry) === areaKey) { setAreaError(null); return; }
    requestedGrid.current = 20;
    setArea(next); setView(null); setSelectedId(null); setFilter("all"); setVisible(20);
    setPreloaded([]); setAreaError(null); setDrawRequest(0); setState({ report: null, error: null, busy: true });
    try { sessionStorage.setItem("firerosetta-selected-area", JSON.stringify({ kind: "polygon", ...next })); } catch {}
  };
  const applyBbox = () => {
    const values = [bbox.w, bbox.s, bbox.e, bbox.n];
    const [w, s, e, n] = values.map(Number);
    if (values.some((value) => value.trim() === "") || [w, s, e, n].some((value) => !Number.isFinite(value)) ||
      w >= e || s >= n || w < -180 || e > 180 || s < -85 || n > 85) {
      setAreaError("Geçerli koordinatlar girin: batı < doğu ve güney < kuzey."); return;
    }
    chooseArea({ label: `${s}°, ${w}° — ${n}°, ${e}°`, geometry: areaBox(w, s, e, n) });
  };

  return (
    <div lang="tr" className="mx-auto w-full max-w-[1400px] px-4 pb-14 sm:px-6">
      <AppHeader active="risk" />
      <main>
        <div className="flex flex-wrap items-end justify-between gap-5 py-2">
          <div className="max-w-[680px]">
            <p className="flex items-center gap-2 text-[11px] font-semibold tracking-[0.16em] text-primary"><BellRing className="size-3.5" /> RİSK UYARILARI</p>
            <h1 className="display mt-2 text-3xl leading-tight sm:text-[36px]">Önlem alınacak alanlar</h1>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">Yakın dönem uydu tespitleri ve aynı aya ait yangın geçmişiyle, gözetim ve önleyici kontroller için öncelik taşıyan alanlar.</p>
          </div>
          <div className="flex items-end gap-2">
            <Button variant="outline" size="lg" disabled={state.busy} onClick={refresh} title="Uyarı raporunu yeniden kontrol et">
              <RefreshCw className={state.busy ? "animate-spin" : ""} />{state.busy ? "Kontrol ediliyor" : "Yenile"}
            </Button>
          </div>
        </div>

        <section className="mt-4 rounded-lg border bg-card p-4" aria-label="Uyarı alanını seç">
          <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-sm font-semibold">İncelenen alan · {area.label}</h2><p className="mt-1 text-xs text-muted-foreground">Haritada alan çizin, bir bölge seçin veya koordinat kutusu girin.</p></div><Button variant="outline" onClick={() => setDrawRequest((value) => value + 1)}><MapPin />Haritada alan çiz</Button></div>
          <div className="mt-3 flex flex-wrap gap-1.5">{RISK_PLACES.map((place) => <Button key={place.label} size="sm" variant={area.label === place.label ? "default" : "secondary"} onClick={() => chooseArea(place)}>{place.label}</Button>)}</div>
          <details className="mt-3 text-xs"><summary className="cursor-pointer text-muted-foreground">Koordinat kutusuyla alan seç</summary><form className="mt-3 grid grid-cols-2 items-end gap-2 sm:grid-cols-[repeat(4,minmax(0,1fr))_auto]" onSubmit={(event) => { event.preventDefault(); applyBbox(); }}>
            {([['w','Batı'],['s','Güney'],['e','Doğu'],['n','Kuzey']] as const).map(([key, label]) => <label key={key} className="flex flex-col gap-1">{label}<input type="number" step="any" required value={bbox[key]} onChange={(event) => setBbox((previous) => ({ ...previous, [key]: event.target.value }))} className="h-8 min-w-0 rounded-md border bg-background px-2" /></label>)}
            <Button type="submit" variant="outline">Bu alanı kullan</Button>
          </form></details>
          {areaError && <p role="alert" className="mt-2 text-xs text-destructive">{areaError}</p>}
        </section>

        <div className="mt-5 flex items-start gap-2.5 rounded-lg border bg-card px-4 py-3 text-xs leading-relaxed text-muted-foreground">
          <Info className="mt-0.5 size-4 shrink-0 text-primary" />
          <p><strong className="font-medium text-foreground">Önlem önceliği göstergesidir.</strong> Yangın çıkma olasılığı veya meteorolojik tahmin değildir. Hava durumu, bitki örtüsü ve arazi koşulları bu sürümde değerlendirilmez. Uydu tespitleri tarımsal yakmaları da içerebilir.</p>
        </div>

        {state.error && <div role="alert" className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm"><p>{state.error}</p><Button variant="outline" onClick={refresh}>Yeniden dene</Button></div>}
        {!report && state.busy && <div role="status" className="mt-5 space-y-4">
          <p className="text-sm text-muted-foreground">NASA’nın yakın dönem verileri kontrol ediliyor ve mevsimsel geçmişle eşleştiriliyor…</p>
          <div className="grid gap-3 sm:grid-cols-3">{[0, 1, 2].map((id) => <Skeleton key={id} className="h-24 rounded-lg" />)}</div>
        </div>}

        {report && <>
          {report.coverage_partial && <p role="status" className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950">Seçimin bir kısmı yüklenmiş geçmiş veri kapsamının dışında. Bu kesimlerde geçmiş kaydı olmaması düşük risk anlamına gelmez.</p>}
          {(!fresh || report.live_error || report.source === "local") && <div role="status" className="mt-4 flex items-start gap-2.5 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <p>{!fresh ? `Veri ${report.data_age_days} gündür güncel değil. Güncel tespit uyarıları devre dışı; harita yalnızca mevsimsel önceliği gösteriyor.` : report.live_error ?? "Canlı NASA bağlantısı kullanılamıyor. Son hazırlanmış yerel veri gösteriliyor."} <span className="font-medium">Veri sonu: {date(report.data_through)}.</span></p>
          </div>}

          <p className="mt-5 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><span>Görünen karelerde · yaklaşık <strong className="text-foreground">{report.grid_km} × {report.grid_km} km</strong></span><span>{state.busy ? "Harita alanı yeniden hesaplanıyor…" : "Yakınlaştırdıkça 5 km’ye kadar ayrıntı"}</span></p>
          <div className="mt-2 grid gap-3 sm:grid-cols-3" aria-busy={state.busy}>
            <SummaryCard title="Yüksek öncelikli alan" value={report.summary.high} color="text-[#b43b2f]" note={fresh ? "Son 7 günde uydu tespiti var" : "Güncel veri olmadan değerlendirilmez"} icon={<BellRing className="size-4" />} />
            <SummaryCard title="Artmış öncelikli alan" value={report.summary.elevated} color="text-[#986316]" note="Tekrarlayan mevsimsel faaliyet veya son 30 gün" icon={<ShieldCheck className="size-4" />} />
            <SummaryCard title="Son 7 günün tespitleri" value={fresh ? report.summary.recent_7d : null} color="text-primary" note={`${report.recent_sensor} · tek sensör, taranmış kayıtlar`} icon={<MapPin className="size-4" />} />
          </div>

          <div className="mt-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-xs text-muted-foreground">
            <p className="inline-flex flex-wrap items-center gap-x-3 gap-y-1"><span className={`inline-flex items-center gap-1.5 font-medium ${fresh && report.source === "live" ? "text-primary" : "text-amber-800"}`}><span className={`size-1.5 rounded-full ${fresh && report.source === "live" ? "bg-primary" : "bg-amber-600"}`} />{report.source === "live" ? "NASA bağlantısı" : "Yerel veri"}</span>Veri: {date(report.data_through)}<span>Analiz: {date(report.as_of)}</span></p>
            <span className="inline-flex items-center gap-1.5"><Clock3 className="size-3.5" />5 dakikada bir kontrol · {new Date(report.checked_at).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Istanbul" })}</span>
          </div>
        </>}

          <div className="mt-3 grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
            <div>
              <RiskMap layers={mapLayers} levelFilter={filter} bbox={report?.bbox ?? areaBounds} selected={selected} onSelect={setSelectedId}
                area={area.geometry} drawRequest={drawRequest} onDraw={(geometry) => chooseArea({ label: "Haritada çizilen alan", geometry })}
                gridKm={report?.grid_km ?? view?.gridKm ?? 20} busy={state.busy} onViewChange={changeView} />
              <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
                <Legend level="high" label="Son 7 gün tespiti" /><Legend level="elevated" label="Mevsimsel / yakın dönem önceliği" /><Legend level="watch" label="Geçmiş kaydı · izleme" />
              </div>
              <p className="mt-2 text-[11px] text-muted-foreground">20 → 10 → 5 km · Katmanlar ve ekran çevresi önceden yüklenir. Renksiz kareler risksiz kabul edilmez; hücreler yangın sınırı değildir.</p>
              {selected && report && <CellDetails cell={selected} report={report} />}
            </div>

            {report ? <section className="overflow-hidden rounded-lg border bg-card" aria-label="Uyarı listesi">
              <div className="border-b p-4">
                <div className="flex items-center justify-between gap-3"><h2 className="text-sm font-semibold">{area.label} · uyarı listesi</h2><span className="num text-xs text-muted-foreground">{number(cells.length)} alan</span></div>
                <label className="sr-only" htmlFor="risk-filter">Öncelik filtresi</label>
                <select id="risk-filter" className="mt-3 h-8 w-full rounded-md border bg-background px-2 text-xs" value={filter} onChange={(event) => { setFilter(event.target.value as typeof filter); setVisible(20); setSelectedId(null); }}>
                  <option value="all">Tüm öncelikler</option><option value="high">Yüksek öncelik</option><option value="elevated">Artmış öncelik</option><option value="watch">İzleme</option>
                </select>
              </div>
              <div className="max-h-[440px] overflow-y-auto lg:max-h-[420px]">
                {cells.length === 0 && <div className="p-6 text-center text-sm text-muted-foreground"><MapPin className="mx-auto mb-2 size-5" /><p>Bu filtrede işaretlenecek alan yok.</p><p className="mt-2 text-xs">Tespit olmaması yangın riski bulunmadığını göstermez.</p></div>}
                {cells.slice(0, visible).map((cell, index) => <button key={cell.id} type="button" aria-pressed={selectedId === cell.id} onClick={() => setSelectedId(cell.id)}
                  className={`block w-full border-b px-4 py-3 text-left transition-colors last:border-0 hover:bg-secondary/70 focus-visible:outline-2 focus-visible:outline-primary focus-visible:-outline-offset-2 ${selectedId === cell.id ? "bg-secondary ring-1 ring-inset ring-primary/30" : ""}`}>
                  <div className="flex items-center justify-between gap-2"><Badge level={cell.level} /><span className="num text-[10px] text-muted-foreground">{index + 1}</span></div>
                  <p className="num mt-2 flex items-center justify-between gap-2 text-sm font-medium">{coordinates(cell)}<ArrowUpRight className="size-3.5 text-muted-foreground" /></p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{reason(cell, fresh)}</p>
                </button>)}
                {cells.length > visible && <div className="p-3"><Button variant="outline" className="w-full" onClick={() => setVisible((count) => count + 20)}>20 alan daha göster</Button></div>}
              </div>
              <div className="border-t bg-background/50 p-3"><Button variant="ghost" className="w-full" disabled={!cells.length} onClick={() => downloadReport(report, cells, area.label)}><ArrowDownToLine />Uyarı listesini CSV indir</Button></div>
            </section> : <section className="rounded-lg border bg-card p-4 text-sm text-muted-foreground"><h2 className="font-semibold text-foreground">{area.label}</h2><p className="mt-2">{state.busy ? "Seçilen alanın uyarıları hazırlanıyor. Bu sırada haritada yeni bir alan çizebilirsiniz." : "Alanı haritada veya yukarıdaki seçeneklerle değiştirebilirsiniz."}</p></section>}
          </div>

          {report && <details className="mt-6 rounded-lg border bg-card p-4 text-sm">
            <summary className="cursor-pointer font-medium">Bu uyarılar nasıl belirleniyor?</summary>
            <div className="mt-4 max-w-[100ch] space-y-3 text-sm leading-relaxed text-muted-foreground">
              <p><strong className="text-foreground">Yüksek öncelik:</strong> Son 7 günde nominal veya yüksek güvenli en az bir NOAA-20 VIIRS tespiti. Bilinen sabit ısı kaynakları geçmiş standart kayıtların maskesiyle ayıklanır. Bu, sahada doğrulanması gereken bir gözlemdir; bağımsız yangın sayısı değildir.</p>
              <p><strong className="text-foreground">Artmış öncelik:</strong> Son 30 günde faaliyet veya {report.history_first}–{report.history_last} döneminin {MONTHS[report.season_month - 1]} aylarında en az 3 farklı yılda gözlem ve seçilen alandaki pozitif aylık ortalamaların üst çeyreğinde yer alma (en az {number(report.seasonal_threshold)} tespit/ay). Ortalama {report.history_years} tam yıla bölünür; sıfır yıllar dahildir. Geçmiş bağlam yalnız S-NPP gözlemlerini kullanır.</p>
              <p><strong className="text-foreground">Veri eskidiğinde:</strong> Son veri tarihi 1 günden daha eskiyse yakın dönem tespitleri önceliği yükseltmez. Canlı bağlantı kurulamazsa tarih bilgisiyle yerel kopyaya geçilir. Yenileme tarihsel takvimi yeniden eğitmez.</p>
              <p><strong className="text-foreground">Yakınlaştırma:</strong> Aynı metre tabanlı ızgara her adımda dört küçük kareye ayrılır; en küçük kare 5 × 5 km’dir. Geçmiş ve güncel tespitler gerçek koordinatlarıyla yeniden gruplanır. Üst karenin uyarısı alt karelere kopyalanmaz. Sayılar görünen karelere aittir. Boyutlar harita projeksiyonunda ölçülür; arazi üzerindeki genişlik küçük farklar gösterebilir.</p>
              <p>Bu eşikler ön tarama içindir; gerçek yangınlarla doğrulanmış bir tahmin modeli veya resmî alarm değildir. Bulut, uydu geçiş saati ve örtü nedeniyle tespit eksik kalabilir. Yerel resmî uyarılar ve saha doğrulamasıyla birlikte değerlendirin.</p>
              <p className="text-xs"><a href="https://firms.modaps.eosdis.nasa.gov/" target="_blank" rel="noreferrer" className="underline underline-offset-2">NASA FIRMS</a> · <a href="https://confluence.ecmwf.int/spaces/CKB/pages/283569774/Fire+Weather+Index+FWI+%E2%80%93+Dataset+Description" target="_blank" rel="noreferrer" className="underline underline-offset-2">Meteorolojik yangın tehlikesi ve FWI girdileri</a></p>
            </div>
          </details>}
      </main>
    </div>
  );
}

function SummaryCard({ title, value, note, color, icon }: { title: string; value: number | null; note: string; color: string; icon: React.ReactNode }) {
  return <section className="rounded-lg border bg-card p-4"><div className="flex items-center justify-between gap-3 text-xs text-muted-foreground"><h2>{title}</h2><span className={color}>{icon}</span></div><p className={`num mt-2 text-[32px] font-semibold leading-none ${color}`}>{value === null ? "—" : number(value)}</p><p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{note}</p></section>;
}

function Legend({ level, label }: { level: RiskLevel; label: string }) {
  return <span className="inline-flex items-center gap-1.5"><span className={`size-2.5 rounded-sm ${LEVELS[level].dot}`} />{label}</span>;
}

function CellDetails({ cell, report }: { cell: RiskCell; report: RiskReport }) {
  const high = cell.level === "high";
  return <section className="mt-4 rounded-lg border bg-card p-4" aria-label="Seçili alanın uyarı ayrıntıları" aria-live="polite">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="num text-sm font-semibold">Seçili alan · {coordinates(cell)} · {report.grid_km} km kare</h2><Badge level={cell.level} /></div>
    <p className="mt-2 text-sm">{reason(cell, report.current_evidence_enabled)}</p>
    <div className="mt-3 grid gap-3 border-y py-3 text-xs sm:grid-cols-3">
      <div className="text-muted-foreground">Son tespit<p className="mt-1 font-medium text-foreground">{cell.last_seen ? date(cell.last_seen) : "Yakın dönemde tespit yok"}</p></div>
      <div className="text-muted-foreground">{MONTHS[report.season_month - 1]} geçmişi<p className="mt-1 font-medium text-foreground">{cell.active_years} / {report.history_years} yılda faaliyet</p></div>
      <div className="text-muted-foreground">Geçmiş aylık ortalama<p className="mt-1 font-medium text-foreground">{cell.seasonal_mean.toLocaleString("tr-TR", { maximumFractionDigits: 1 })} uydu tespiti</p></div>
    </div>
    <p className="mt-3 text-xs leading-relaxed text-muted-foreground"><strong className="font-medium text-foreground">Önerilen kontrol: </strong>{high ? "Yakın dönem tespitini yerel ekiplerle veya saha gözlemiyle doğrulayın; bölgedeki gözetimi önceliklendirin." : cell.level === "elevated" ? "Mevsimsel faaliyet geçmişini yerel resmî uyarılarla birlikte değerlendirin; önleyici kontroller ve gözetim için öncelikli inceleme planlayın." : "Mevsimsel geçmişi ve yeni tespitleri izleyin. Bu sınıf güvenli alan veya risk yok anlamına gelmez."}</p>
  </section>;
}
