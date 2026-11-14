"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowDownToLine, ArrowUpRight, BellRing, ChevronLeft, ChevronRight, Clock3, Info, MapPin, RefreshCw, ShieldCheck, Telescope } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { type Forecast, getAreaRisk, getForecast, getOutlookBlocks, getRisk, getRiskGridCount, type OutlookBlocks, type OutlookLead, type Polygon, type RiskCell, type RiskGridKm, type RiskLevel, type RiskReport, type RiskView } from "@/lib/api";
import { blockKey, byNowThenOutlook, OUTLOOK_STYLE, outlookExpired, outlookFeatures, outlookIndex } from "@/lib/outlook";
import { areaBox, riskAreaKey, RISK_COUNTRIES, RISK_PLACES, type RiskArea } from "@/lib/fire-areas";
import { selectionReport } from "@/lib/risk-summary";
import { visiblePriorities } from "@/lib/risk-view";
import { HIGH_PRIORITY_SHADES, highPriorityColor } from "@/lib/risk-colors";
import { AppHeader } from "./app-header";
import { ForecastView } from "./forecast";
import { RiskMap } from "./risk-map";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const LEVELS: Record<RiskLevel, { label: string; dot: string; badge: string }> = {
  high: { label: "High priority", dot: "bg-[#ce4638]", badge: "border-[#ce4638]/25 bg-[#ce4638]/8 text-[#a33529]" },
  elevated: { label: "Elevated priority", dot: "bg-[#dd911d]", badge: "border-[#dd911d]/30 bg-[#dd911d]/10 text-[#8d5708]" },
  watch: { label: "Watch", dot: "bg-[#83948b]", badge: "border-border bg-muted text-muted-foreground" },
};
const number = (value: number) => value.toLocaleString("en-GB");
const monthName = (month: string) => `${MONTHS[+month.slice(5, 7) - 1]} ${month.slice(0, 4)}`;
type CellOutlook = { lead: OutlookLead; target: string };

/** The outlook of the 1 degree block a cell sits in. Violet, never the alert colours. */
function OutlookChip({ outlook }: { outlook: CellOutlook }) {
  const style = OUTLOOK_STYLE[outlook.lead.level];
  return <span className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium" style={{ background: style.fill, color: style.ink }}
    title={`Outlook for ${monthName(outlook.target)}: ${Math.round(outlook.lead.prob * 100)}% chance of an unusually active month in this 1° block`}>
    <Telescope className="size-3" aria-hidden="true" />{style.label} outlook
  </span>;
}
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

function downloadReport(report: RiskReport, cells: RiskCell[], label: string, outlookOf: (cell: RiskCell) => CellOutlook | null) {
  const rows = [
    ["analysis_date", "data_through", "selected_area", "cell_width_km", "latitude", "longitude", "priority", "detections_7d", "detections_30d", "historically_active_years", "historical_monthly_mean", "last_seen", "current_evidence_enabled",
      "outlook_target_month", "outlook_level_1deg_block", "outlook_probability_1deg_block"],
    ...cells.map((cell) => {
      const outlook = outlookOf(cell);
      return [report.as_of, report.data_through, label, report.grid_km, cell.lat, cell.lon,
        LEVELS[cell.level].label, cell.recent_7d, cell.recent_30d, cell.active_years, cell.seasonal_mean,
        cell.last_seen ?? "", report.current_evidence_enabled ? "yes" : "no",
        outlook?.target ?? "", outlook?.lead.level ?? "", outlook?.lead.prob ?? ""];
    }),
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
  const [mapView, setMapView] = useState<{ areaKey: string; view: RiskView } | null>(null);
  const layerCache = useRef(new Map<string, RiskReport>());
  const requestedGrid = useRef<RiskGridKm>(10);
  const [preloaded, setPreloaded] = useState<RiskReport[]>([]);
  const [bbox, setBbox] = useState({ w: "", s: "", e: "", n: "" });
  const [areaError, setAreaError] = useState<string | null>(null);
  const [drawRequest, setDrawRequest] = useState(0);
  const [clientDay, setClientDay] = useState<string | null>(null);
  // Two layers on one map: what satellites saw (cells) and what the model expects (blocks).
  const [showNow, setShowNow] = useState(true);
  const [showOutlook, setShowOutlook] = useState(true);
  const [leadIndex, setLeadIndex] = useState(0);
  // null = not loaded or the model is not built in this deployment; the page works without it
  const [blocks, setBlocks] = useState<OutlookBlocks | null>(null);
  const [forecast, setForecast] = useState<{ key: string; data: Forecast | null; error: string | null } | null>(null);
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
    const controller = new AbortController();
    getOutlookBlocks(controller.signal).then(setBlocks).catch(() => {});
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!blocks) return;
    const controller = new AbortController();
    const ring = area.geometry.coordinates[0];
    getForecast(area.country ? { kind: "country", name: area.country, bbox: [ring[0][0], ring[0][1], ring[2][0], ring[2][1]] }
      : { kind: "polygon", label: area.label, geometry: area.geometry }, controller.signal)
      .then((data) => setForecast({ key: areaKey, data, error: null }))
      .catch((error) => { if ((error as Error).name !== "AbortError") setForecast({ key: areaKey, data: null, error: (error as Error).message }); });
    return () => controller.abort();
  }, [blocks, area, areaKey]);

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
      const levels = [...new Set<RiskGridKm>([requestedGrid.current, 10, 5, 20])];
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
  const index = useMemo(() => outlookIndex(blocks, leadIndex), [blocks, leadIndex]);
  const target = blocks?.leads[leadIndex]?.target_month ?? "";
  const outlookOf = useCallback((cell: RiskCell): CellOutlook | null => {
    const lead = index.get(blockKey(cell.lon, cell.lat));
    return lead ? { lead, target } : null;
  }, [index, target]);
  const outlookLayer = useMemo(() => blocks ? outlookFeatures(blocks, leadIndex) : null, [blocks, leadIndex]);
  const expired = outlookExpired(blocks, today);
  const areaForecast = forecast?.key === areaKey ? forecast : null;
  const cells = useMemo(() => byNowThenOutlook(report?.cells.filter((cell) => filter === "all" || cell.level === filter) ?? [], index), [report, filter, index]);
  const mapLayers = useMemo(() => preloaded.filter((layer) => layer.grid_km <= 20).map((layer) => selectionReport(layer, today)), [preloaded, today]);
  const selected = report?.cells.find((cell) => cell.id === selectedId) ?? null;
  const fresh = report?.current_evidence_enabled ?? false;
  const outlookChip = (cell: RiskCell) => {
    const outlook = outlookOf(cell);
    return outlook && outlook.lead.level !== "normal" ? <OutlookChip outlook={outlook} /> : null;
  };
  const refresh = () => { setState((previous) => ({ ...previous, busy: true })); setRevision((value) => value + 1); };
  const changeView = useCallback((next: RiskView) => {
    setMapView((previous) => previous?.areaKey === areaKey && previous.view.gridKm === next.gridKm &&
      previous.view.bounds.join(",") === next.bounds.join(",") ? previous : { areaKey, view: next });
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
    setArea(next); setGridKm(10); setMapView(null); setSelectedId(null); setFilter("all"); setVisible(20);
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
            <p className="flex items-center gap-2 text-[11px] font-semibold tracking-[0.16em] text-primary"><BellRing className="size-3.5" /> EARLY WARNING</p>
            <h1 className="display mt-2 text-3xl leading-tight sm:text-[36px]">Where it is burning, and where it may</h1>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">Two layers on one map: <strong className="font-medium text-foreground">Now</strong> ranks 5–20 km cells by what satellites detected in the last days and in this month of past years. <strong className="font-medium text-foreground">Outlook</strong> shows, per 1° block, how likely the coming months are to burn far more than usual.</p>
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
          <p><strong className="font-medium text-foreground">Two different kinds of evidence, kept apart.</strong> Now is a screening priority built from observed detections; it is not a probability. Outlook is a model probability at 1° resolution, driven by fire history and the weather of the preceding months; it cannot place a fire inside a block. They are shown side by side and never merged into one score. Satellite detections can include agricultural burning.</p>
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

          {!!report.static_filtered && <p className="mt-3 text-xs text-muted-foreground"><span className="num font-medium text-foreground">{number(report.static_filtered)}</span> detections from the last 30 days sit on sites flagged as permanent heat sources (chimneys, gas flares, steel mills) and raise no alert here. They stay visible, greyed, on the Calendar map.</p>}

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

          <section className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-3 rounded-lg border bg-card px-4 py-3 text-sm" aria-label="Map layers">
            <h2 className="text-xs font-semibold text-muted-foreground">Map layers</h2>
            <label className="flex cursor-pointer items-center gap-2"><Switch checked={showNow} onCheckedChange={setShowNow} /><span className="size-2.5 rounded-sm bg-[#ce4638]" />Now · observed activity</label>
            <label className={`flex items-center gap-2 ${blocks ? "cursor-pointer" : "text-muted-foreground"}`}><Switch checked={showOutlook && !!blocks} disabled={!blocks} onCheckedChange={setShowOutlook} /><span className="size-2.5 rounded-sm" style={{ background: OUTLOOK_STYLE.high.fill }} />Outlook · model forecast</label>
            {blocks ? <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Outlook month">
              {blocks.leads.map((lead, position) => <Button key={lead.lead} size="sm" aria-pressed={leadIndex === position} variant={leadIndex === position ? "default" : "secondary"} disabled={!showOutlook} onClick={() => setLeadIndex(position)}>{monthName(lead.target_month)}</Button>)}
            </div> : <span className="text-xs text-muted-foreground">The forecast model is not available in this deployment.</span>}
          </section>
          {blocks && expired && <div role="status" className="mt-3 flex items-start gap-2.5 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <p>The outlook model was last given weather through {monthName(blocks.basis_month)}, so its forecasts cover {monthName(blocks.leads[0].target_month)}–{monthName(blocks.leads.at(-1)!.target_month)}, which have already passed. They show how the layer works; they are not a forecast for the coming months until the weather inputs are refreshed.</p>
          </div>}

          <div className="mt-3 grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
            <div>
              <div className="flex h-[calc(100dvh-1.5rem)] min-h-[440px] flex-col" aria-label="Map and visible-area summary">
                <RiskMap className="min-h-[220px] flex-1 rounded-b-none" layers={mapLayers} outlook={outlookLayer} showNow={showNow} showOutlook={showOutlook} levelFilter={filter} bbox={report?.bbox ?? areaBounds} selected={selected} onSelect={setSelectedId}
                  area={area.geometry} country={area.country} drawRequest={drawRequest} onDraw={(geometry) => chooseArea({ label: "Drawn area", geometry })}
                  gridKm={report?.grid_km ?? gridKm} busy={state.busy} onViewChange={changeView} />
                <ViewportSummary areaKey={areaKey} geometry={area.geometry} selectionBounds={areaBounds} report={report} filter={filter}
                  view={mapView?.areaKey === areaKey ? mapView.view : null} selectedId={selectedId} onSelect={setSelectedId} />
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
                <Legend level="high" label="Recent 7-day detections" /><Legend level="elevated" label="Seasonal / recent priority" /><Legend level="watch" label="Historical activity · watch" />
                {area.country && <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm border border-[#2563eb] bg-[#2563eb]/15" />Selected country</span>}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-muted-foreground" aria-label="Red intensity by detections in the last 7 days">
                <span>Darker red = more detections in 7 days:</span>{HIGH_PRIORITY_SHADES.map((shade) => <span key={shade.min} className="inline-flex items-center gap-1"><span className="size-3 rounded-sm" style={{ backgroundColor: shade.color }} />{shade.label}</span>)}
              </div>
              {blocks && showOutlook && <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-muted-foreground" aria-label="Outlook colours">
                <span>Outlook for {monthName(target)} · chance of an unusually active month per 1° block:</span>
                {(["watch", "elevated", "high"] as const).map((level) => <span key={level} className="inline-flex items-center gap-1"><span className="size-3 rounded-sm" style={{ backgroundColor: OUTLOOK_STYLE[level].fill }} />{OUTLOOK_STYLE[level].label} ≥ {Math.round((blocks.levels[level] ?? 0) * 100)}%</span>)}
                {blocks.base_rate !== null && <span>· typical: {(blocks.base_rate * 100).toFixed(1)}%</span>}
              </div>}
              <p className="mt-2 text-[11px] text-muted-foreground">20 → 10 → 5 km · 20 km cells appear only in wider, zoomed-out views. All layers are preloaded. Uncoloured cells are not necessarily risk-free; cells are not fire boundaries.</p>
              {selected && report && <CellDetails cell={selected} report={report} outlook={outlookOf(selected)} />}
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
                {cells.slice(0, visible).map((cell, position) => <button key={cell.id} type="button" aria-pressed={selectedId === cell.id} onClick={() => setSelectedId(cell.id)}
                  className={`block w-full border-b px-4 py-3 text-left transition-colors last:border-0 hover:bg-secondary/70 focus-visible:outline-2 focus-visible:outline-primary focus-visible:-outline-offset-2 ${selectedId === cell.id ? "bg-secondary ring-1 ring-inset ring-primary/30" : ""}`}>
                  <div className="flex items-center justify-between gap-2"><span className="flex flex-wrap items-center gap-1.5"><Badge level={cell.level} detections={cell.recent_7d} />{outlookChip(cell)}</span><span className="num text-[10px] text-muted-foreground">{position + 1}</span></div>
                  <p className="num mt-2 flex items-center justify-between gap-2 text-sm font-medium">{coordinates(cell)}<ArrowUpRight className="size-3.5 text-muted-foreground" /></p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{reason(cell, fresh)}</p>
                </button>)}
                {cells.length > visible && <div className="p-3"><Button variant="outline" className="w-full" onClick={() => setVisible((count) => count + 20)}>Show 20 more cells</Button></div>}
              </div>
              <div className="border-t bg-background/50 p-3"><Button variant="ghost" className="w-full" disabled={!cells.length} onClick={() => downloadReport(report, cells, area.label, outlookOf)}><ArrowDownToLine />Download alert list (CSV)</Button></div>
            </section> : <section className="rounded-lg border bg-card p-4 text-sm text-muted-foreground"><h2 className="font-semibold text-foreground">{area.label}</h2><p className="mt-2">{state.busy ? "Preparing alerts for the selected area. You can draw another area while this loads." : "Change the area using the map or the options above."}</p></section>}
          </div>

          {blocks && <section className="mt-8" aria-label="Outlook for the selected area">
            <p className="flex items-center gap-2 text-[11px] font-semibold tracking-[0.16em]" style={{ color: OUTLOOK_STYLE.high.fill }}><Telescope className="size-3.5" /> OUTLOOK · {area.label.toUpperCase()}</p>
            <div className="mt-3">
              {areaForecast?.data ? <ForecastView data={areaForecast.data} label={area.label} />
                : areaForecast?.error ? <p role="status" className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">{areaForecast.error}</p>
                : <Skeleton className="h-[320px] rounded-lg" />}
            </div>
          </section>}

          {report && <details className="mt-6 rounded-lg border bg-card p-4 text-sm">
            <summary className="cursor-pointer font-medium">How are these priorities determined?</summary>
            <div className="mt-4 max-w-[100ch] space-y-3 text-sm leading-relaxed text-muted-foreground">
              <p><strong className="text-foreground">High priority:</strong> At least one nominal- or high-confidence NOAA-20 VIIRS detection in the last 7 days. Known static heat sources are screened twice: with a mask from standard historical records, and with the sites the unsupervised detector flagged as permanent industrial heat. Darker red means more screened detections in this window. Detections need field verification and are not a count of separate fires.</p>
              <p><strong className="text-foreground">Elevated priority:</strong> Activity in the last 30 days, or observations in {MONTHS[report.season_month - 1]} across at least 3 years during {report.history_first}–{report.history_last}, with a monthly mean in the top quarter of positive means for this selection (at least {number(report.seasonal_threshold)} detections/month). Means use all {report.history_years} complete years, including zero years. Historical context uses S-NPP only.</p>
              <p><strong className="text-foreground">When data become stale:</strong> If coverage is more than 1 day old, recent detections no longer raise priority. If the live connection fails, the dated local copy is used. Refreshing does not retrain the historical calendar.</p>
              <p><strong className="text-foreground">Zoom and totals:</strong> Broad, zoomed-out views use 20 × 20 km cells. Closer views use 10 × 10 km and then 5 × 5 km. Each square splits into four smaller cells. Detections are regrouped at their actual coordinates; parent-cell alerts are not copied into child cells. Totals, the list and CSV cover the entire selected area at the displayed grid size. Panning does not change them. Cell counts can change with grid size. Dimensions are measured in the map projection, with small differences on the ground.</p>
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

function ViewportSummary({ areaKey, geometry, selectionBounds, report, filter, view, selectedId, onSelect }: {
  areaKey: string; geometry: Polygon; selectionBounds: RiskView["bounds"]; report: RiskReport | null; filter: "all" | RiskLevel;
  view: RiskView | null; selectedId: string | null; onSelect: (id: string) => void;
}) {
  const cache = useRef(new Map<string, number>());
  const [countState, setCountState] = useState<{ key: string; total: number | null; error: boolean }>({ key: "", total: null, error: false });
  const [retry, setRetry] = useState(0);
  const [shown, setShown] = useState({ key: "", count: 8 });
  const strip = useRef<HTMLDivElement>(null);
  const stripKey = useRef("");
  const [navigation, setNavigation] = useState({ previous: false, next: false });
  const viewKey = view ? `${areaKey}:${view.gridKm}:${view.bounds.join(",")}` : "";
  const listKey = `${viewKey}:${filter}`;
  const limit = shown.key === listKey ? shown.count : 8;
  const inView = useMemo(() => report && view && report.grid_km === view.gridKm
    ? visiblePriorities(report.cells, view.bounds, filter, selectionBounds) : null, [report, view, filter, selectionBounds]);

  useEffect(() => {
    const lane = strip.current;
    if (!lane) return;
    const updateNavigation = () => {
      const next = { previous: lane.scrollLeft > 1, next: lane.scrollLeft + lane.clientWidth < lane.scrollWidth - 1 };
      setNavigation((previous) => previous.previous === next.previous && previous.next === next.next ? previous : next);
    };
    const frame = window.requestAnimationFrame(() => {
      if (stripKey.current !== listKey) { lane.scrollLeft = 0; stripKey.current = listKey; }
      updateNavigation();
    });
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || lane.scrollWidth <= lane.clientWidth) return;
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (!delta) return;
      event.preventDefault();
      lane.scrollLeft += delta * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? lane.clientWidth : 1);
    };
    const observer = new ResizeObserver(updateNavigation);
    observer.observe(lane);
    lane.addEventListener("scroll", updateNavigation, { passive: true });
    lane.addEventListener("wheel", wheel, { passive: false });
    return () => {
      window.cancelAnimationFrame(frame); observer.disconnect();
      lane.removeEventListener("scroll", updateNavigation); lane.removeEventListener("wheel", wheel);
    };
  }, [listKey, limit, inView?.priorities.length]);

  const scrollCards = (direction: number) => {
    const lane = strip.current;
    if (lane) lane.scrollBy({ left: direction * Math.max(264, lane.clientWidth * 0.85), behavior: "smooth" });
  };

  useEffect(() => {
    if (!view) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const cached = cache.current.get(viewKey);
        const total = cached ?? (await getRiskGridCount(geometry, view, controller.signal)).total_cells;
        if (controller.signal.aborted) return;
        cache.current.delete(viewKey);
        cache.current.set(viewKey, total);
        while (cache.current.size > 32) cache.current.delete(cache.current.keys().next().value!);
        setCountState({ key: viewKey, total, error: false });
      } catch (error) {
        if (!controller.signal.aborted && (error as Error).name !== "AbortError") setCountState({ key: viewKey, total: null, error: true });
      }
    }, cache.current.has(viewKey) ? 0 : 150);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [geometry, view, viewKey, retry]);

  const total = countState.key === viewKey ? countState.total : null;
  const countError = countState.key === viewKey && countState.error;
  return <section className="shrink-0 rounded-b-lg border border-t-0 bg-card p-3" aria-label="Current map view">
    <div className="flex items-center justify-between gap-2">
      <h2 className="flex items-center gap-1.5 text-xs font-semibold"><MapPin className="size-3.5 text-primary" />Current map view</h2>
      {view && <span className="num text-[10px] text-muted-foreground">{view.gridKm} × {view.gridKm} km · updates as you pan</span>}
    </div>
    {!view ? <p role="status" className="mt-4 text-sm text-muted-foreground">Waiting for the map view…</p> : <>
      <div className="mt-2 grid grid-cols-3 divide-x rounded-md border bg-background/50 py-1.5" aria-live="polite" aria-atomic="true">
        <ViewCount title="Grid cells in view" value={total} color="text-primary" hint={total === null && !countError ? "Updating visible grid count…" : "Includes uncoloured and partially visible cells inside the selected area"} />
        <ViewCount title="High priority in view" value={inView?.high ?? null} color="text-[#b43b2f]" hint="Recent 7-day detections" />
        <ViewCount title="Elevated priority in view" value={inView?.elevated ?? null} color="text-[#986316]" hint="Seasonal or recent activity" />
      </div>
      {countError && <div role="status" className="mt-2 flex flex-wrap items-center gap-2 text-xs text-destructive"><span>Visible grid count could not be loaded.</span><Button size="sm" variant="outline" onClick={() => setRetry((value) => value + 1)}>Try again</Button></div>}
      <div className="mt-2 flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold">Priority cells in this view{inView && <span className="num ml-1 font-normal text-muted-foreground">({number(inView.priorities.length)})</span>}<span className="ml-2 hidden font-normal text-muted-foreground sm:inline">Highest priority first</span></h3>
        <div className="flex shrink-0 items-center gap-1">
          <span className="mr-1 hidden text-[10px] text-muted-foreground sm:inline" title={inView ? `${number(inView.dataCells)} visible cells with observations match this filter` : "Loading priorities for this grid size…"}>{filter === "all" ? "All priorities" : LEVELS[filter].label}</span>
          <Button size="icon" variant="outline" className="size-6" aria-label="Scroll priority cells left" aria-controls="visible-priority-strip" disabled={!navigation.previous} onClick={() => scrollCards(-1)}><ChevronLeft className="size-3.5" /></Button>
          <Button size="icon" variant="outline" className="size-6" aria-label="Scroll priority cells right" aria-controls="visible-priority-strip" disabled={!navigation.next} onClick={() => scrollCards(1)}><ChevronRight className="size-3.5" /></Button>
        </div>
      </div>
      <div ref={strip} id="visible-priority-strip" className="mt-1.5 flex h-[104px] snap-x snap-proximity items-start gap-2 overflow-x-auto overflow-y-hidden overscroll-x-contain pb-1 focus-visible:outline-2 focus-visible:outline-primary" role="region" aria-label="Visible priority cells" tabIndex={0} onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); scrollCards(event.key === "ArrowLeft" ? -1 : 1); }
        if (event.key === "Home" || event.key === "End") { event.preventDefault(); strip.current?.scrollTo({ left: event.key === "Home" ? 0 : event.currentTarget.scrollWidth, behavior: "smooth" }); }
      }}>
      {inView && inView.priorities.length === 0 && <p className="py-3 text-xs text-muted-foreground">No priority cells in the current view for this filter.</p>}
        {inView?.priorities.slice(0, limit).map((cell, index) => <button key={cell.id} type="button" aria-pressed={selectedId === cell.id} onClick={() => onSelect(cell.id)}
          className={`w-64 shrink-0 snap-start rounded-md border p-2 text-left transition-colors hover:bg-secondary/60 focus-visible:outline-2 focus-visible:outline-primary ${selectedId === cell.id ? "border-primary bg-secondary" : ""}`}>
          <div className="flex items-center gap-2"><span className="num text-sm font-semibold text-primary">{index + 1}.</span><Badge level={cell.level} detections={cell.recent_7d} /><ArrowUpRight className="ml-auto size-3.5 shrink-0 text-muted-foreground" /></div>
          <p className="num mt-1 text-xs font-medium">{coordinates(cell)}</p><p className="mt-0.5 truncate text-[10px] text-muted-foreground" title={reason(cell, report?.current_evidence_enabled ?? false)}>{reason(cell, report?.current_evidence_enabled ?? false)}</p>
        </button>)}
      {inView && inView.priorities.length > limit && <Button size="sm" variant="outline" className="h-[80px] w-40 shrink-0 snap-start whitespace-normal" onClick={() => setShown({ key: listKey, count: limit + 8 })}>Show 8 more visible cells</Button>}
      </div>
    </>}
  </section>;
}

function ViewCount({ title, value, color, hint }: { title: string; value: number | null; color: string; hint: string }) {
  return <div className="min-w-0 px-2" title={hint}><h3 className="text-[10px] leading-tight text-muted-foreground">{title}</h3><p className={`num mt-0.5 text-xl font-semibold leading-none ${color}`}>{value === null ? "—" : number(value)}</p></div>;
}

function CellDetails({ cell, report, outlook }: { cell: RiskCell; report: RiskReport; outlook: CellOutlook | null }) {
  const high = cell.level === "high";
  return <section className="mt-4 rounded-lg border bg-card p-4" aria-label="Selected cell alert details" aria-live="polite">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="num text-sm font-semibold">Selected cell · {coordinates(cell)} · {report.grid_km} km cell</h2><Badge level={cell.level} detections={cell.recent_7d} /></div>
    <p className="mt-2 text-sm">{reason(cell, report.current_evidence_enabled)}</p>
    <div className="mt-3 grid gap-3 border-y py-3 text-xs sm:grid-cols-3">
      <div className="text-muted-foreground">Last detection<p className="mt-1 font-medium text-foreground">{cell.last_seen ? date(cell.last_seen) : "No recent detection"}</p></div>
      <div className="text-muted-foreground">{MONTHS[report.season_month - 1]} history<p className="mt-1 font-medium text-foreground">Activity in {cell.active_years} / {report.history_years} years</p></div>
      <div className="text-muted-foreground">Historical monthly mean<p className="mt-1 font-medium text-foreground">{cell.seasonal_mean.toLocaleString("en-GB", { maximumFractionDigits: 1 })} satellite detections</p></div>
    </div>
    {outlook && <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
      <OutlookChip outlook={outlook} />
      <span>{monthName(outlook.target)} · <span className="num font-medium text-foreground">{Math.round(outlook.lead.prob * 100)}%</span> chance of an unusually active month
        {outlook.lead.ratio !== null && <> · expected <span className="num font-medium text-foreground">{outlook.lead.ratio.toFixed(1)}×</span> normal</>}
        {" "}· for the whole 1° block around this cell, not the cell itself</span>
    </div>}
    <p className="mt-3 text-xs leading-relaxed text-muted-foreground"><strong className="font-medium text-foreground">Suggested check: </strong>{high ? "Verify recent detections with local teams or field observations and prioritise monitoring in the area." : cell.level === "elevated" ? "Review seasonal activity alongside local official warnings and plan preventive checks and monitoring." : "Monitor seasonal activity and new detections. This category does not imply a safe or risk-free area."}</p>
  </section>;
}
