"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowDownToLine, ArrowUpRight, BellRing, Clock3, Info, MapPin, RefreshCw, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getAreaRisk, getRisk, type RiskCell, type RiskGridKm, type RiskLevel, type RiskReport, type RiskView } from "@/lib/api";
import { areaBox, riskAreaKey, RISK_COUNTRIES, RISK_PLACES, type RiskArea } from "@/lib/fire-areas";
import { selectionReport } from "@/lib/risk-summary";
import { HIGH_PRIORITY_SHADES, highPriorityColor } from "@/lib/risk-colors";
import { AppHeader } from "./app-header";
import { RiskMap } from "./risk-map";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const LEVELS: Record<RiskLevel, { label: string; dot: string; badge: string }> = {
  high: { label: "High priority", dot: "bg-[#ce4638]", badge: "border-[#ce4638]/25 bg-[#ce4638]/8 text-[#a33529]" },
  elevated: { label: "Elevated priority", dot: "bg-[#dd911d]", badge: "border-[#dd911d]/30 bg-[#dd911d]/10 text-[#8d5708]" },
  watch: { label: "Watch", dot: "bg-[#83948b]", badge: "border-border bg-muted text-muted-foreground" },
};
const number = (value: number) => value.toLocaleString("en-GB");
const date = (value: string) => new Date(`${value}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Istanbul" });
const coordinates = (cell: RiskCell) => `${Math.abs(cell.lat).toFixed(2)}°${cell.lat >= 0 ? "N" : "S"}, ${Math.abs(cell.lon).toFixed(2)}°${cell.lon >= 0 ? "E" : "W"}`;
function Badge({ level, detections = 0 }: { level: RiskLevel; detections?: number }) {
  return <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] font-medium ${LEVELS[level].badge}`}>
    <span className={`size-1.5 rounded-full ${LEVELS[level].dot}`} style={level === "high" ? { backgroundColor: highPriorityColor(detections) } : undefined} />{LEVELS[level].label}
  </span>;
}

function reason(cell: RiskCell, fresh: boolean) {
  if (fresh && cell.recent_7d) return `${number(cell.recent_7d)} satellite detections in 7 days · ${cell.active_days_7d} active days`;
  if (cell.seasonal) return `Activity in this month across ${cell.active_years} years · seasonal priority`;
  if (fresh && cell.recent_30d) return `${number(cell.recent_30d)} detections in 30 days · recent activity`;
  return `Activity recorded in this month across ${cell.active_years} years`;
}

function downloadReport(report: RiskReport, cells: RiskCell[], label: string) {
  const rows = [
    ["analysis_date", "data_through", "selected_area", "cell_width_km", "latitude", "longitude", "priority", "detections_7d", "detections_30d", "historically_active_years", "historical_monthly_mean", "last_seen", "current_evidence_enabled"],
    ...cells.map((cell) => [report.as_of, report.data_through, label, report.grid_km, cell.lat, cell.lon,
      LEVELS[cell.level].label, cell.recent_7d, cell.recent_30d, cell.active_years, cell.seasonal_mean,
      cell.last_seen ?? "", report.current_evidence_enabled ? "yes" : "no"]),
  ];
  const csv = "\uFEFF" + rows.map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `firerosetta_alerts_${label.replace(/[^\p{L}\d]+/gu, "_")}_${report.as_of}.csv`;
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
  const [gridKm, setGridKm] = useState<RiskGridKm>(10);
  const layerCache = useRef(new Map<string, RiskReport>());
  const requestedGrid = useRef<RiskGridKm>(10);
  const [preloaded, setPreloaded] = useState<RiskReport[]>([]);
  const [bbox, setBbox] = useState({ w: "", s: "", e: "", n: "" });
  const [areaError, setAreaError] = useState<string | null>(null);
  const [drawRequest, setDrawRequest] = useState(0);
  const [clientDay, setClientDay] = useState<string | null>(null);
  const areaKey = riskAreaKey(area);
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
      const country = saved?.kind === "country" ? RISK_COUNTRIES.find((item) => item.country === saved.name) : null;
      if (country) queueMicrotask(() => setArea(country));
      else if (saved?.kind === "polygon" && saved.geometry?.type === "Polygon" && Array.isArray(saved.geometry.coordinates?.[0])) {
        const preset = RISK_PLACES.find((item) => JSON.stringify(item.geometry) === JSON.stringify(saved.geometry));
        queueMicrotask(() => setArea(preset ?? { label: "Custom area", geometry: saved.geometry }));
      }
    } catch {}
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const load = async (force = false) => {
      requestedGrid.current = requestedGrid.current === 5 ? 5 : 10;
      const levels = [...new Set<RiskGridKm>([requestedGrid.current, 10, 5])];
      await Promise.all(levels.map(async (gridKm) => {
        const key = `${areaKey}:${gridKm}`;
        try {
          const cached = layerCache.current.get(key);
          const valid = cached && Date.now() - Date.parse(cached.checked_at) < 300_000;
          const report = valid && !force ? cached : area.country
            ? await getRisk(area.country, controller.signal, { gridKm })
            : await getAreaRisk(area.geometry, gridKm, controller.signal);
          if (controller.signal.aborted) return;
          layerCache.current.delete(key);
          layerCache.current.set(key, report);
          while (layerCache.current.size > 10) layerCache.current.delete(layerCache.current.keys().next().value!);
          setPreloaded((previous) => [...previous.filter((layer) => layer.country === report.country && layer.grid_km !== gridKm), report]);
          if (requestedGrid.current === gridKm) setState({ report, error: null, busy: false });
        } catch (error) {
          if (controller.signal.aborted || (error as Error).name === "AbortError" || requestedGrid.current !== gridKm) return;
          setState((previous) => previous.report ? { ...previous, busy: false, report: { ...previous.report,
            live_error: "Refresh failed. Showing the last report; check the data date." } }
            : { report: null, error: (error as Error).message || "Could not load alerts. Please try again.", busy: false });
        }
      }));
    };
    void load();
    const interval = window.setInterval(() => { if (document.visibilityState === "visible") void load(true); }, 300_000);
    const onVisible = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { controller.abort(); window.clearInterval(interval); document.removeEventListener("visibilitychange", onVisible); };
  }, [area.geometry, area.country, areaKey, revision]);

  const today = clientDay ?? state.report?.as_of ?? "1970-01-01";
  const report = useMemo(() => state.report ? selectionReport(state.report, today) : null, [state.report, today]);
  const cells = useMemo(() => report?.cells.filter((cell) => filter === "all" || cell.level === filter) ?? [], [report, filter]);
  const mapLayers = useMemo(() => preloaded.filter((layer) => layer.grid_km <= 10).map((layer) => selectionReport(layer, today)), [preloaded, today]);
  const selected = report?.cells.find((cell) => cell.id === selectedId) ?? null;
  const fresh = report?.current_evidence_enabled ?? false;
  const refresh = () => { setState((previous) => ({ ...previous, busy: true })); setRevision((value) => value + 1); };
  const changeView = useCallback((next: RiskView) => {
    if (requestedGrid.current === next.gridKm) return;
    requestedGrid.current = next.gridKm;
    setGridKm(next.gridKm);
    setSelectedId(null);
    const cached = layerCache.current.get(`${areaKey}:${next.gridKm}`);
    setState((previous) => cached ? { report: cached, error: null, busy: false } : { ...previous, busy: true });
    setVisible(20);
  }, [areaKey]);
  const chooseArea = (next: RiskArea) => {
    if (riskAreaKey(next) === areaKey) { setAreaError(null); return; }
    requestedGrid.current = 10;
    setArea(next); setGridKm(10); setSelectedId(null); setFilter("all"); setVisible(20);
    setPreloaded([]); setAreaError(null); setDrawRequest(0); setState({ report: null, error: null, busy: true });
    try { sessionStorage.setItem("firerosetta-selected-area", JSON.stringify(next.country
      ? { kind: "country", name: next.country, bbox: [next.geometry.coordinates[0][0][0], next.geometry.coordinates[0][0][1], next.geometry.coordinates[0][2][0], next.geometry.coordinates[0][2][1]] }
      : { kind: "polygon", ...next })); } catch {}
  };
  const applyBbox = () => {
    const values = [bbox.w, bbox.s, bbox.e, bbox.n];
    const [w, s, e, n] = values.map(Number);
    if (values.some((value) => value.trim() === "") || [w, s, e, n].some((value) => !Number.isFinite(value)) ||
      w >= e || s >= n || w < -180 || e > 180 || s < -85 || n > 85) {
      setAreaError("Enter valid coordinates: west < east and south < north."); return;
    }
    chooseArea({ label: `${s}°, ${w}° — ${n}°, ${e}°`, geometry: areaBox(w, s, e, n) });
  };

  return (
    <div lang="en" className="mx-auto w-full max-w-[1400px] px-4 pb-14 sm:px-6">
      <AppHeader active="risk" />
      <main>
        <div className="flex flex-wrap items-end justify-between gap-5 py-2">
          <div className="max-w-[680px]">
            <p className="flex items-center gap-2 text-[11px] font-semibold tracking-[0.16em] text-primary"><BellRing className="size-3.5" /> RISK ALERTS</p>
            <h1 className="display mt-2 text-3xl leading-tight sm:text-[36px]">Areas to prioritise</h1>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">Prioritise monitoring and preventive checks using recent satellite detections and fire activity from the same month in past years.</p>
          </div>
          <div className="flex items-end gap-2">
            <Button variant="outline" size="lg" disabled={state.busy} onClick={refresh} title="Refresh the alert report">
              <RefreshCw className={state.busy ? "animate-spin" : ""} />{state.busy ? "Checking" : "Refresh"}
            </Button>
          </div>
        </div>

        <section className="mt-4 rounded-lg border bg-card p-4" aria-label="Select an alert area">
          <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-sm font-semibold">Selected area · {area.label}</h2><p className="mt-1 text-xs text-muted-foreground">Choose a country or region, draw on the map, or enter a bounding box.</p></div><Button variant="outline" onClick={() => setDrawRequest((value) => value + 1)}><MapPin />Draw on map</Button></div>
          <p className="mt-3 text-[11px] font-medium text-muted-foreground">Countries</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">{RISK_COUNTRIES.map((country) => <Button key={country.country} size="sm" aria-pressed={areaKey === riskAreaKey(country)} variant={areaKey === riskAreaKey(country) ? "default" : "secondary"} onClick={() => chooseArea(country)}>{country.label}</Button>)}</div>
          <p className="mt-3 text-[11px] font-medium text-muted-foreground">Regions</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">{RISK_PLACES.map((place) => <Button key={place.label} size="sm" aria-pressed={areaKey === riskAreaKey(place)} variant={areaKey === riskAreaKey(place) ? "default" : "secondary"} onClick={() => chooseArea(place)}>{place.label}</Button>)}</div>
          {area.country && <p className="mt-2 text-[11px] text-muted-foreground">The selected country is highlighted in blue. Recent satellite data use the dashed coverage box; historical data use the country archive.</p>}
          <details className="mt-3 text-xs"><summary className="cursor-pointer text-muted-foreground">Select by coordinates</summary><form className="mt-3 grid grid-cols-2 items-end gap-2 sm:grid-cols-[repeat(4,minmax(0,1fr))_auto]" onSubmit={(event) => { event.preventDefault(); applyBbox(); }}>
            {([['w','West'],['s','South'],['e','East'],['n','North']] as const).map(([key, label]) => <label key={key} className="flex flex-col gap-1">{label}<input type="number" step="any" required value={bbox[key]} onChange={(event) => setBbox((previous) => ({ ...previous, [key]: event.target.value }))} className="h-8 min-w-0 rounded-md border bg-background px-2" /></label>)}
            <Button type="submit" variant="outline">Use this area</Button>
          </form></details>
          {areaError && <p role="alert" className="mt-2 text-xs text-destructive">{areaError}</p>}
        </section>

        <div className="mt-5 flex items-start gap-2.5 rounded-lg border bg-card px-4 py-3 text-xs leading-relaxed text-muted-foreground">
          <Info className="mt-0.5 size-4 shrink-0 text-primary" />
          <p><strong className="font-medium text-foreground">A screening priority indicator.</strong> This does not estimate the probability of a fire or forecast weather. Weather, vegetation and terrain are not assessed in this version. Satellite detections can include agricultural burning.</p>
        </div>

        {state.error && <div role="alert" className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm"><p>{state.error}</p><Button variant="outline" onClick={refresh}>Try again</Button></div>}
        {!report && state.busy && <div role="status" className="mt-5 space-y-4">
          <p className="text-sm text-muted-foreground">Checking recent NASA data and matching it with seasonal history…</p>
          <div className="grid gap-3 sm:grid-cols-3">{[0, 1, 2].map((id) => <Skeleton key={id} className="h-24 rounded-lg" />)}</div>
        </div>}

        {report && <>
          {report.coverage_partial && <p role="status" className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950">Part of the selection is outside the loaded historical coverage. Missing historical records in these areas do not imply low risk.</p>}
          {(!fresh || report.live_error || report.source === "local") && <div role="status" className="mt-4 flex items-start gap-2.5 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <p>{!fresh ? `Data are ${report.data_age_days} days old. Recent-detection alerts are disabled; only seasonal priority is shown.` : report.live_error ?? "The live NASA connection is unavailable. Showing the latest prepared local data."} <span className="font-medium">Data through: {date(report.data_through)}.</span></p>
          </div>}

          <p className="mt-5 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><span>Entire selected area · approx. <strong className="text-foreground">{report.grid_km} × {report.grid_km} km</strong></span><span>{state.busy ? "Updating grid detail…" : "Zoom for detail down to 5 km"}</span></p>
          <p className="mt-1 text-[11px] text-muted-foreground">Totals, the list and CSV include off-screen cells throughout {area.label}. Panning does not change them.</p>
          <div className="mt-2 grid gap-3 sm:grid-cols-3" aria-busy={state.busy}>
            <SummaryCard title="High-priority cells" value={report.summary.high} color="text-[#b43b2f]" note={fresh ? "Satellite detections in the last 7 days" : "Unavailable without current evidence"} icon={<BellRing className="size-4" />} />
            <SummaryCard title="Elevated-priority cells" value={report.summary.elevated} color="text-[#986316]" note="Recurring seasonal or recent 30-day activity" icon={<ShieldCheck className="size-4" />} />
            <SummaryCard title="Detections in the last 7 days" value={fresh ? report.summary.recent_7d : null} color="text-primary" note={`${report.recent_sensor} · one sensor, screened records`} icon={<MapPin className="size-4" />} />
          </div>

          <div className="mt-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-xs text-muted-foreground">
            <p className="inline-flex flex-wrap items-center gap-x-3 gap-y-1"><span className={`inline-flex items-center gap-1.5 font-medium ${fresh && report.source === "live" ? "text-primary" : "text-amber-800"}`}><span className={`size-1.5 rounded-full ${fresh && report.source === "live" ? "bg-primary" : "bg-amber-600"}`} />{report.source === "live" ? "NASA connected" : "Local data"}</span>Data: {date(report.data_through)}<span>Analysis: {date(report.as_of)}</span></p>
            <span className="inline-flex items-center gap-1.5"><Clock3 className="size-3.5" />Checked every 5 minutes · {new Date(report.checked_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Istanbul" })}</span>
          </div>
        </>}

          <div className="mt-3 grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
            <div>
              <RiskMap layers={mapLayers} levelFilter={filter} bbox={report?.bbox ?? areaBounds} selected={selected} onSelect={setSelectedId}
                area={area.geometry} country={area.country} drawRequest={drawRequest} onDraw={(geometry) => chooseArea({ label: "Drawn area", geometry })}
                gridKm={report?.grid_km ?? gridKm} busy={state.busy} onViewChange={changeView} />
              <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
                <Legend level="high" label="Recent 7-day detections" /><Legend level="elevated" label="Seasonal / recent priority" /><Legend level="watch" label="Historical activity · watch" />
                {area.country && <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm border border-[#2563eb] bg-[#2563eb]/15" />Selected country</span>}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-muted-foreground" aria-label="Red intensity by detections in the last 7 days">
                <span>Darker red = more detections in 7 days:</span>{HIGH_PRIORITY_SHADES.map((shade) => <span key={shade.min} className="inline-flex items-center gap-1"><span className="size-3 rounded-sm" style={{ backgroundColor: shade.color }} />{shade.label}</span>)}
              </div>
              <p className="mt-2 text-[11px] text-muted-foreground">10 → 5 km · All selected-area layers are preloaded, including off-screen cells. Uncoloured cells are not necessarily risk-free; cells are not fire boundaries.</p>
              {selected && report && <CellDetails cell={selected} report={report} />}
            </div>

            {report ? <section className="overflow-hidden rounded-lg border bg-card" aria-label="Alert list">
              <div className="border-b p-4">
                <div className="flex items-center justify-between gap-3"><h2 className="text-sm font-semibold">{area.label} · alert list</h2><span className="num text-xs text-muted-foreground">{number(cells.length)} cells</span></div>
                <label className="sr-only" htmlFor="risk-filter">Priority filter</label>
                <select id="risk-filter" className="mt-3 h-8 w-full rounded-md border bg-background px-2 text-xs" value={filter} onChange={(event) => { setFilter(event.target.value as typeof filter); setVisible(20); setSelectedId(null); }}>
                  <option value="all">All priorities</option><option value="high">High priority</option><option value="elevated">Elevated priority</option><option value="watch">Watch</option>
                </select>
              </div>
              <div className="max-h-[440px] overflow-y-auto lg:max-h-[420px]">
                {cells.length === 0 && <div className="p-6 text-center text-sm text-muted-foreground"><MapPin className="mx-auto mb-2 size-5" /><p>No cells match this filter.</p><p className="mt-2 text-xs">No detections does not mean there is no fire risk.</p></div>}
                {cells.slice(0, visible).map((cell, index) => <button key={cell.id} type="button" aria-pressed={selectedId === cell.id} onClick={() => setSelectedId(cell.id)}
                  className={`block w-full border-b px-4 py-3 text-left transition-colors last:border-0 hover:bg-secondary/70 focus-visible:outline-2 focus-visible:outline-primary focus-visible:-outline-offset-2 ${selectedId === cell.id ? "bg-secondary ring-1 ring-inset ring-primary/30" : ""}`}>
                  <div className="flex items-center justify-between gap-2"><Badge level={cell.level} detections={cell.recent_7d} /><span className="num text-[10px] text-muted-foreground">{index + 1}</span></div>
                  <p className="num mt-2 flex items-center justify-between gap-2 text-sm font-medium">{coordinates(cell)}<ArrowUpRight className="size-3.5 text-muted-foreground" /></p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{reason(cell, fresh)}</p>
                </button>)}
                {cells.length > visible && <div className="p-3"><Button variant="outline" className="w-full" onClick={() => setVisible((count) => count + 20)}>Show 20 more cells</Button></div>}
              </div>
              <div className="border-t bg-background/50 p-3"><Button variant="ghost" className="w-full" disabled={!cells.length} onClick={() => downloadReport(report, cells, area.label)}><ArrowDownToLine />Download alert list (CSV)</Button></div>
            </section> : <section className="rounded-lg border bg-card p-4 text-sm text-muted-foreground"><h2 className="font-semibold text-foreground">{area.label}</h2><p className="mt-2">{state.busy ? "Preparing alerts for the selected area. You can draw another area while this loads." : "Change the area using the map or the options above."}</p></section>}
          </div>

          {report && <details className="mt-6 rounded-lg border bg-card p-4 text-sm">
            <summary className="cursor-pointer font-medium">How are these priorities determined?</summary>
            <div className="mt-4 max-w-[100ch] space-y-3 text-sm leading-relaxed text-muted-foreground">
              <p><strong className="text-foreground">High priority:</strong> At least one nominal- or high-confidence NOAA-20 VIIRS detection in the last 7 days. Known static heat sources are screened using a mask from standard historical records. Darker red means more screened detections in this window. Detections need field verification and are not a count of separate fires.</p>
              <p><strong className="text-foreground">Elevated priority:</strong> Activity in the last 30 days, or observations in {MONTHS[report.season_month - 1]} across at least 3 years during {report.history_first}–{report.history_last}, with a monthly mean in the top quarter of positive means for this selection (at least {number(report.seasonal_threshold)} detections/month). Means use all {report.history_years} complete years, including zero years. Historical context uses S-NPP only.</p>
              <p><strong className="text-foreground">When data become stale:</strong> If coverage is more than 1 day old, recent detections no longer raise priority. If the live connection fails, the dated local copy is used. Refreshing does not retrain the historical calendar.</p>
              <p><strong className="text-foreground">Zoom and totals:</strong> The metre-based grid splits each square into four smaller cells, from 10 × 10 km down to 5 × 5 km. Detections are regrouped at their actual coordinates; parent-cell alerts are not copied into child cells. Totals, the list and CSV cover the entire selected area at the displayed grid size. Panning does not change them. Cell counts can change with grid size. Dimensions are measured in the map projection, with small differences on the ground.</p>
              <p>These thresholds support screening; they are not an official alarm or a forecast validated against actual fires. Clouds, overpass timing and cover can hide activity. Use local official warnings and field verification alongside this information.</p>
              <p className="text-xs"><a href="https://firms.modaps.eosdis.nasa.gov/" target="_blank" rel="noreferrer" className="underline underline-offset-2">NASA FIRMS</a> · <a href="https://confluence.ecmwf.int/spaces/CKB/pages/283569774/Fire+Weather+Index+FWI+%E2%80%93+Dataset+Description" target="_blank" rel="noreferrer" className="underline underline-offset-2">Fire weather danger and FWI inputs</a></p>
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
  return <section className="mt-4 rounded-lg border bg-card p-4" aria-label="Selected cell alert details" aria-live="polite">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="num text-sm font-semibold">Selected cell · {coordinates(cell)} · {report.grid_km} km cell</h2><Badge level={cell.level} detections={cell.recent_7d} /></div>
    <p className="mt-2 text-sm">{reason(cell, report.current_evidence_enabled)}</p>
    <div className="mt-3 grid gap-3 border-y py-3 text-xs sm:grid-cols-3">
      <div className="text-muted-foreground">Last detection<p className="mt-1 font-medium text-foreground">{cell.last_seen ? date(cell.last_seen) : "No recent detection"}</p></div>
      <div className="text-muted-foreground">{MONTHS[report.season_month - 1]} history<p className="mt-1 font-medium text-foreground">Activity in {cell.active_years} / {report.history_years} years</p></div>
      <div className="text-muted-foreground">Historical monthly mean<p className="mt-1 font-medium text-foreground">{cell.seasonal_mean.toLocaleString("en-GB", { maximumFractionDigits: 1 })} satellite detections</p></div>
    </div>
    <p className="mt-3 text-xs leading-relaxed text-muted-foreground"><strong className="font-medium text-foreground">Suggested check: </strong>{high ? "Verify recent detections with local teams or field observations and prioritise monitoring in the area." : cell.level === "elevated" ? "Review seasonal activity alongside local official warnings and plan preventive checks and monitoring." : "Monitor seasonal activity and new detections. This category does not imply a safe or risk-free area."}</p>
  </section>;
}
