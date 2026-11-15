"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowDownToLine, ChevronDown, MapPin, PenLine, RefreshCw, Satellite, Telescope } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { type Forecast, getAreaRisk, getForecast, getOutlookBlocks, getRisk, type OutlookBlocks, type OutlookLead, type RiskCell, type RiskGridKm, type RiskLevel, type RiskReport, type RiskView } from "@/lib/api";
import { blockKey, blocksInView, byNowThenOutlook, OUTLOOK_STYLE, outlookExpired, outlookFeatures, outlookIndex } from "@/lib/outlook";
import { areaBox, riskAreaKey, RISK_COUNTRIES, RISK_PLACES, type RiskArea } from "@/lib/fire-areas";
import { selectionReport } from "@/lib/risk-summary";
import { cellsInView, clipBounds } from "@/lib/risk-view";
import { HIGH_PRIORITY_SHADES, highPriorityColor } from "@/lib/risk-colors";
import { AppHeader } from "./app-header";
import { ForecastView } from "./forecast";
import { RiskMap } from "./risk-map";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const LEVELS: Record<RiskLevel, { label: string; short: string; dot: string; badge: string }> = {
  high: { label: "High priority", short: "High", dot: "bg-[#ce4638]", badge: "border-[#ce4638]/25 bg-[#ce4638]/8 text-[#a33529]" },
  elevated: { label: "Elevated priority", short: "Elevated", dot: "bg-[#dd911d]", badge: "border-[#dd911d]/30 bg-[#dd911d]/10 text-[#8d5708]" },
  watch: { label: "Watch", short: "Watch", dot: "bg-[#83948b]", badge: "border-border bg-muted text-muted-foreground" },
};
type Tab = "now" | "outlook";
const FILTERS: { key: "all" | RiskLevel; label: string; hint: string; ink: string; dot?: string }[] = [
  { key: "all", label: "All", hint: "Every flagged cell in the current view", ink: "" },
  { key: "high", label: "High", hint: "Several detections, or detections on more than one day, in the last 7 days", ink: "text-[#a33529]", dot: LEVELS.high.dot },
  { key: "elevated", label: "Elevated", hint: "Recurring seasonal activity, or isolated detections in the last 30 days", ink: "text-[#8d5708]", dot: LEVELS.elevated.dot },
  { key: "watch", label: "Watch", hint: "Historical activity in this month", ink: "", dot: LEVELS.watch.dot },
];
const number = (value: number) => value.toLocaleString("en-GB");
const count = (value: number, noun: string) => `${number(value)} ${noun}${value === 1 ? "" : "s"}`;
const monthName = (month: string) => `${MONTHS[+month.slice(5, 7) - 1]} ${month.slice(0, 4)}`;
type CellOutlook = { lead: OutlookLead; target: string };

/** The outlook of the 1 degree block a cell sits in. Violet, never the alert colours. */
function OutlookChip({ outlook }: { outlook: CellOutlook }) {
  const style = OUTLOOK_STYLE[outlook.lead.level];
  return <span className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium" style={{ background: style.fill, color: style.ink }}
    title={`Outlook for ${monthName(outlook.target)}: ${Math.round(outlook.lead.prob * 100)}% chance of an unusually active month in this 1° block`}>
    <Telescope className="size-3" aria-hidden="true" />{style.label} outlook · {MONTHS[+outlook.target.slice(5, 7) - 1].slice(0, 3)}
  </span>;
}
const date = (value: string) => new Date(`${value}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Istanbul" });
const blockLabel = (bx: number, by: number) => `${Math.abs(by + 0.5)}°${by >= 0 ? "N" : "S"}, ${Math.abs(bx + 0.5)}°${bx >= 0 ? "E" : "W"}`;
const coordinates = (cell: RiskCell) => `${Math.abs(cell.lat).toFixed(2)}°${cell.lat >= 0 ? "N" : "S"}, ${Math.abs(cell.lon).toFixed(2)}°${cell.lon >= 0 ? "E" : "W"}`;
function Badge({ level, detections = 0 }: { level: RiskLevel; detections?: number }) {
  return <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] font-medium ${LEVELS[level].badge}`}>
    <span className={`size-1.5 rounded-full ${LEVELS[level].dot}`} style={level === "high" ? { backgroundColor: highPriorityColor(detections) } : undefined} />{LEVELS[level].short}
  </span>;
}

function reason(cell: RiskCell, fresh: boolean) {
  if (fresh && cell.recent_7d) return `${count(cell.recent_7d, "satellite detection")} in 7 days · ${count(cell.active_days_7d, "active day")}`;
  if (cell.seasonal) return `Activity in this month across ${cell.active_years} years · seasonal priority`;
  if (fresh && cell.recent_30d) return `${count(cell.recent_30d, "detection")} in 30 days · recent activity`;
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
  // One map, two tabs: what satellites saw (cells) and what the model expects (blocks).
  const [tab, setTab] = useState<Tab>("now");
  const [areaOpen, setAreaOpen] = useState(false);
  const list = useRef<HTMLDivElement>(null);
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
  const ranked = useMemo(() => byNowThenOutlook(report?.cells ?? [], index), [report, index]);
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
  const pickArea = (next: RiskArea) => { chooseArea(next); setAreaOpen(false); };
  const applyBbox = () => {
    const values = [bbox.w, bbox.s, bbox.e, bbox.n];
    const [w, s, e, n] = values.map(Number);
    if (values.some((value) => value.trim() === "") || [w, s, e, n].some((value) => !Number.isFinite(value)) ||
      w >= e || s >= n || w < -180 || e > 180 || s < -85 || n > 85) {
      setAreaError("Enter valid coordinates: west < east and south < north."); return;
    }
    pickArea({ label: `${s}°, ${w}° — ${n}°, ${e}°`, geometry: areaBox(w, s, e, n) });
  };


  const activeTab: Tab = blocks ? tab : "now";
  const view = mapView?.areaKey === areaKey ? mapView.view : null;
  // While the map is between zoom levels the report still holds the previous grid.
  const settled = !!report && (!view || report.grid_km === view.gridKm);
  const inView = useMemo(() => !report ? [] : view ? cellsInView(ranked, view.bounds, areaBounds) : ranked, [report, ranked, view, areaBounds]);
  const counts = useMemo(() => ({
    all: inView.length,
    high: inView.filter((cell) => cell.level === "high").length,
    elevated: inView.filter((cell) => cell.level === "elevated").length,
    watch: inView.filter((cell) => cell.level === "watch").length,
    recent: inView.reduce((sum, cell) => sum + cell.recent_7d, 0),
  }), [inView]);
  const listed = useMemo(() => filter === "all" ? inView : inView.filter((cell) => cell.level === filter), [inView, filter]);
  const limit = Math.max(visible, listed.findIndex((cell) => cell.id === selectedId) + 1);
  const viewBlocks = useMemo(() => blocksInView(blocks, leadIndex, view ? clipBounds(view.bounds, areaBounds) : areaBounds), [blocks, leadIndex, view, areaBounds]);

  // A cell picked on the map opens in the list; bring it into the list's own scroll window.
  useEffect(() => {
    const lane = list.current;
    const row = selectedId && lane ? [...lane.querySelectorAll<HTMLElement>("[data-cell]")].find((item) => item.dataset.cell === selectedId) : null;
    if (!lane || !row) return;
    if (row.offsetTop >= lane.scrollTop && row.offsetTop + row.offsetHeight <= lane.scrollTop + lane.clientHeight) return;
    lane.scrollTo({ top: row.offsetTop - 8, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [selectedId]);

  const live = fresh && report?.source === "live";
  const panel = "flex min-h-0 flex-col overflow-hidden rounded-lg border bg-card lg:h-full";

  return (
    <div lang="en" className="mx-auto w-full max-w-[1400px] px-4 pb-14 sm:px-6">
      <AppHeader active="risk" />
      <main>
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <h1 className="display text-2xl sm:text-[28px]">Early warning</h1>
          {report && <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
            <span className={`inline-flex items-center gap-1.5 font-medium ${live ? "text-primary" : "text-amber-800"}`}><span className={`size-1.5 rounded-full ${live ? "bg-primary" : "bg-amber-600"}`} />{report.source === "live" ? "NASA connected" : "Local data"}</span>
            <span>Data through {date(report.data_through)}</span>
            <span title="The report is re-checked every 5 minutes">Checked {new Date(report.checked_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Istanbul" })}</span>
          </p>}
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <Tabs value={activeTab} onValueChange={(value) => setTab(value as Tab)}>
            <TabsList className="h-10!" aria-label="Early warning layer">
              <TabsTrigger value="now" className="px-3.5"><Satellite />Observed now</TabsTrigger>
              <TabsTrigger value="outlook" className="px-3.5" disabled={!blocks} title={blocks ? undefined : "The forecast model is not available in this deployment."}><Telescope />Outlook · 1–3 months</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="flex items-center gap-2">
            <Popover open={areaOpen} onOpenChange={setAreaOpen}>
              <PopoverTrigger render={<Button variant="outline" size="lg" />}><MapPin /><span className="max-w-[16rem] truncate">{area.label}</span><ChevronDown className="text-muted-foreground" /></PopoverTrigger>
              <PopoverContent align="end" className="w-[min(92vw,26rem)] gap-3 p-4">
                <PopoverTitle>Choose an area</PopoverTitle>
                <AreaChips title="Countries" areas={RISK_COUNTRIES} activeKey={areaKey} onChoose={pickArea} />
                <AreaChips title="Regions" areas={RISK_PLACES} activeKey={areaKey} onChoose={pickArea} />
                <form className="border-t pt-3" onSubmit={(event) => { event.preventDefault(); applyBbox(); }}>
                  <p className="text-xs font-medium text-muted-foreground">Bounding box</p>
                  <div className="mt-1.5 grid grid-cols-4 gap-1.5">
                    {([["w", "West"], ["s", "South"], ["e", "East"], ["n", "North"]] as const).map(([key, label]) => <Input key={key} type="number" step="any" required aria-label={label} placeholder={label} value={bbox[key]} onChange={(event) => setBbox((previous) => ({ ...previous, [key]: event.target.value }))} />)}
                  </div>
                  {areaError && <p role="alert" className="mt-2 text-xs text-destructive">{areaError}</p>}
                  <div className="mt-2.5 flex gap-2">
                    <Button type="submit" variant="secondary" className="flex-1">Use coordinates</Button>
                    <Button type="button" variant="secondary" className="flex-1" onClick={() => { setAreaOpen(false); setDrawRequest((value) => value + 1); }}><PenLine />Draw on map</Button>
                  </div>
                </form>
              </PopoverContent>
            </Popover>
            <Button variant="outline" size="icon-lg" disabled={state.busy} onClick={refresh} aria-label="Refresh the alert report" title="Refresh"><RefreshCw className={state.busy ? "animate-spin" : ""} /></Button>
          </div>
        </div>

        <p className="mt-3 text-sm text-muted-foreground">
          {activeTab === "now"
            ? "Cells ranked by what satellites detected in the last 7 days and in this month of past years. A screening priority, not a probability."
            : "How likely each 1° block is to burn far more than usual in the coming months. A model probability; it cannot place a fire inside a block."}
        </p>

        {activeTab === "now" && report && <>
          {report.coverage_partial && <Notice>Part of the selection is outside the loaded historical coverage. Missing history there does not imply low risk.</Notice>}
          {(!fresh || report.live_error || report.source === "local") && <Notice>
            {!fresh ? `Data are ${report.data_age_days} days old, so recent detections raise no alert; only seasonal priority is shown.` : report.live_error ?? "The live NASA connection is unavailable. Showing the latest prepared local data."}
          </Notice>}
        </>}
        {activeTab === "now" && state.error && <div role="alert" className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm"><p>{state.error}</p><Button variant="outline" onClick={refresh}>Try again</Button></div>}
        {activeTab === "outlook" && blocks && expired && <Notice>
          The model was last given weather through {monthName(blocks.basis_month)}, so {monthName(blocks.leads[0].target_month)}–{monthName(blocks.leads.at(-1)!.target_month)} have already passed. This shows how the layer works until the weather inputs are refreshed.
        </Notice>}

        <div className="mt-3 grid gap-4 lg:h-[clamp(520px,calc(100dvh-18.5rem),860px)] lg:grid-cols-[minmax(0,1fr)_380px]">
          <div className="flex min-h-0 min-w-0 flex-col">
            <RiskMap className="h-[420px] lg:h-auto lg:min-h-0 lg:flex-1" layers={mapLayers} outlook={outlookLayer} showNow={activeTab === "now"} showOutlook={activeTab === "outlook"} levelFilter={filter} bbox={report?.bbox ?? areaBounds} selected={selected} onSelect={setSelectedId}
              area={area.geometry} country={area.country} drawRequest={drawRequest} onDraw={(geometry) => chooseArea({ label: "Drawn area", geometry })}
              gridKm={report?.grid_km ?? gridKm} busy={state.busy} onViewChange={changeView} />
            <div className="mt-2.5 flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
              {activeTab === "now" ? <>
                <span className="inline-flex items-center gap-1.5">High · detections in 7 days
                  <span className="inline-flex items-center gap-2">{HIGH_PRIORITY_SHADES.map((shade) => <span key={shade.min} className="num inline-flex items-center gap-1"><span className="size-2.5 rounded-sm" style={{ backgroundColor: shade.color }} />{shade.label}</span>)}</span>
                </span>
                <Swatch color="#dd911d" label="Elevated" /><Swatch color="#83948b" label="Watch" />
                {area.country && <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm border border-[#2563eb] bg-[#2563eb]/15" />Selected country</span>}
              </> : blocks && <>
                <span>Chance of an unusually active {monthName(target)}</span>
                {(["watch", "elevated", "high"] as const).map((level) => <Swatch key={level} color={OUTLOOK_STYLE[level].fill} label={`${OUTLOOK_STYLE[level].label} ≥ ${Math.round((blocks.levels[level] ?? 0) * 100)}%`} />)}
                {blocks.base_rate !== null && <span className="num">Typical month {(blocks.base_rate * 100).toFixed(1)}%</span>}
              </>}
            </div>
          </div>

          {activeTab === "now" ? <section className={panel} aria-label="Cells in the current map view">
            <div className="border-b p-4">
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="text-sm font-semibold">{view ? "In this view" : area.label}</h2>
                {report && <span className="num text-xs text-muted-foreground">{report.grid_km} km cells{fresh && settled && <> · {number(counts.recent)} detections in 7 days</>}</span>}
              </div>
              <div className="mt-3 grid grid-cols-4 gap-1.5" role="group" aria-label="Filter by priority" aria-busy={!settled}>
                {FILTERS.map((item) => <button key={item.key} type="button" aria-pressed={filter === item.key} title={item.hint} disabled={!report}
                  onClick={() => { setFilter(item.key); setVisible(20); setSelectedId(null); }}
                  className="rounded-md border bg-background px-2.5 py-2 text-left transition-colors hover:bg-secondary/70 focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-60 aria-pressed:border-primary aria-pressed:bg-secondary">
                  <span className={`num block text-xl font-semibold leading-none ${item.ink}`}>{settled ? number(counts[item.key]) : "–"}</span>
                  <span className="mt-1.5 flex items-center gap-1 text-[11px] text-muted-foreground">{item.dot && <span className={`size-1.5 rounded-full ${item.dot}`} />}{item.label}</span>
                </button>)}
              </div>
            </div>
            <div ref={list} className="relative max-h-[60dvh] min-h-0 flex-1 overflow-y-auto lg:max-h-none">
              {!settled ? (state.error ? <p className="p-6 text-center text-sm text-muted-foreground">Alerts could not be loaded for this area.</p>
                : <div role="status" aria-label="Loading alerts" className="space-y-2 p-4">{[0, 1, 2, 3, 4].map((id) => <Skeleton key={id} className="h-16 rounded-md" />)}</div>)
                : listed.length === 0 ? <div className="p-8 text-center text-sm text-muted-foreground">
                  <MapPin className="mx-auto mb-2 size-5" />
                  <p>{inView.length ? "No cells at this priority in the current view." : "No flagged cells in the current view."}</p>
                  <p className="mt-1.5 text-xs">Pan or zoom out to see more. No detections does not mean no fire risk.</p>
                </div>
                : <ol>
                  {listed.slice(0, limit).map((cell, position) => {
                    const open = selectedId === cell.id;
                    return <li key={cell.id} data-cell={cell.id} className="border-b last:border-0">
                      <button type="button" aria-expanded={open} onClick={() => setSelectedId(open ? null : cell.id)}
                        className={`flex w-full gap-3 px-4 py-3 text-left transition-colors hover:bg-secondary/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary ${open ? "bg-secondary/70" : ""}`}>
                        <span className="num w-5 shrink-0 pt-0.5 text-right text-[11px] text-muted-foreground">{position + 1}</span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center justify-between gap-2"><span className="num text-sm font-medium">{coordinates(cell)}</span><Badge level={cell.level} detections={cell.recent_7d} /></span>
                          <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{reason(cell, fresh)}</span>
                          {outlookChip(cell) && <span className="mt-1.5 block">{outlookChip(cell)}</span>}
                        </span>
                      </button>
                      {open && report && <CellDetails cell={cell} report={report} outlook={outlookOf(cell)} />}
                    </li>;
                  })}
                </ol>}
              {settled && listed.length > limit && <div className="p-3"><Button variant="outline" className="w-full" onClick={() => setVisible(limit + 20)}>Show 20 more</Button></div>}
            </div>
            <div className="border-t p-2"><Button variant="ghost" className="w-full" disabled={!settled || !listed.length} onClick={() => report && downloadReport(report, listed, area.label, outlookOf)}><ArrowDownToLine />Download these {settled && listed.length ? number(listed.length) : ""} cells (CSV)</Button></div>
          </section>

          : <section className={panel} aria-label="Outlook blocks in the current map view">
            <div className="border-b p-4">
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="text-sm font-semibold">{view ? "In this view" : area.label}</h2>
                <span className="num text-xs text-muted-foreground">{number(viewBlocks.length)} {viewBlocks.length === 1 ? "block" : "blocks"} · 1° each</span>
              </div>
              <div className="mt-3 grid gap-1.5" style={{ gridTemplateColumns: `repeat(${blocks!.leads.length}, minmax(0, 1fr))` }} role="group" aria-label="Outlook month">
                {blocks!.leads.map((lead, position) => <button key={lead.lead} type="button" aria-pressed={leadIndex === position} onClick={() => setLeadIndex(position)}
                  className="rounded-md border bg-background px-2.5 py-2 text-left transition-colors hover:bg-secondary/70 focus-visible:outline-2 focus-visible:outline-primary aria-pressed:border-primary aria-pressed:bg-secondary">
                  <span className="block text-sm font-semibold leading-none">{MONTHS[+lead.target_month.slice(5, 7) - 1]}</span>
                  <span className="num mt-1.5 block text-[11px] text-muted-foreground">{lead.target_month.slice(0, 4)} · +{lead.lead} mo</span>
                </button>)}
              </div>
            </div>
            <div className="max-h-[60dvh] min-h-0 flex-1 overflow-y-auto lg:max-h-none">
              {viewBlocks.length === 0 ? <div className="p-8 text-center text-sm text-muted-foreground">
                <Telescope className="mx-auto mb-2 size-5" />
                <p>The model has no forecast for this part of the map.</p>
                <p className="mt-1.5 text-xs">Pan or zoom out to reach covered blocks.</p>
              </div> : <ol>
                {viewBlocks.map(({ bx, by, lead }) => {
                  const style = OUTLOOK_STYLE[lead.level];
                  return <li key={`${bx}:${by}`} className="flex items-center gap-3 border-b px-4 py-2.5 last:border-0">
                    <span className="num grid h-9 w-12 shrink-0 place-items-center rounded-md text-sm font-semibold" style={{ background: style.fill, color: style.ink }}>{Math.round(lead.prob * 100)}%</span>
                    <span className="min-w-0 flex-1">
                      <span className="num block text-sm font-medium">{blockLabel(bx, by)}</span>
                      <span className="num mt-0.5 block text-xs text-muted-foreground">{style.label}{lead.ratio !== null && <> · expected {lead.ratio.toFixed(1)}× normal</>}</span>
                    </span>
                  </li>;
                })}
              </ol>}
            </div>
          </section>}
        </div>

        {activeTab === "outlook" && <section className="mt-8" aria-label="Forecast for the selected area">
          <h2 className="text-sm font-semibold">Area forecast · {area.label}</h2>
          <div className="mt-3">
            {areaForecast?.data ? <ForecastView data={areaForecast.data} label={area.label} />
              : areaForecast?.error ? <p role="status" className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">{areaForecast.error}</p>
              : <Skeleton className="h-[320px] rounded-lg" />}
          </div>
        </section>}

        {report && <details className="mt-6 rounded-lg border bg-card p-4 text-sm">
          <summary className="cursor-pointer font-medium">How are these priorities determined?</summary>
          <div className="mt-4 max-w-[100ch] space-y-3 text-sm leading-relaxed text-muted-foreground">
            <p><strong className="text-foreground">Two kinds of evidence, kept apart:</strong> Observed now is a screening priority built from satellite detections; it is not a probability. Outlook is a model probability at 1° resolution, driven by fire history and the weather of the preceding months. They are shown side by side and never merged into one score. Satellite detections can include agricultural burning.</p>
            <p><strong className="text-foreground">High priority:</strong> At least {report.high_min_detections ?? 3} nominal- or high-confidence NOAA-20 VIIRS detections in the last 7 days, or detections on at least {report.high_min_days ?? 2} separate days. A single detection is often a short burn or a false alarm, so on its own it raises Elevated, not High.{report.border_clipped ? " Detections outside the country's border (with about 5 km of tolerance for the simplified outline) are not counted: there is no history or heat-source screen for them." : ""} Known static heat sources are screened twice: with a mask from standard historical records, and with the sites the unsupervised detector flagged as permanent industrial heat{report.static_filtered ? ` (${number(report.static_filtered)} detections from the last 30 days were dropped this way; they stay visible, greyed, on the Calendar map)` : ""}. Darker red means more screened detections in this window. Detections need field verification and are not a count of separate fires.</p>
            <p><strong className="text-foreground">Elevated priority:</strong> Any detection in the last 30 days that does not reach High, or observations in {MONTHS[report.season_month - 1]} across at least 3 years during {report.history_first}–{report.history_last}, with a monthly mean in the top quarter of positive means for this selection (at least {number(report.seasonal_threshold)} detections/month). Means use all {report.history_years} complete years, including zero years. Historical context uses S-NPP only.</p>
            <p><strong className="text-foreground">When data become stale:</strong> If coverage is more than 1 day old, recent detections no longer raise priority. If the live connection fails, the dated local copy is used. Refreshing does not retrain the historical calendar.</p>
            <p><strong className="text-foreground">Zoom and the list:</strong> Broad, zoomed-out views use 20 × 20 km cells. Closer views use 10 × 10 km and then 5 × 5 km. Each square splits into four smaller cells. Detections are regrouped at their actual coordinates; parent-cell alerts are not copied into child cells. The counts, the list and the CSV cover the cells of the selected area that the map currently shows, so they change as you pan and zoom. Uncoloured cells are not necessarily risk-free, and cells are not fire boundaries.</p>
            <p>These thresholds support screening; they are not an official alarm or a forecast validated against actual fires. Clouds, overpass timing and cover can hide activity. Use local official warnings and field verification alongside this information.</p>
            <p className="text-xs"><a href="https://firms.modaps.eosdis.nasa.gov/" target="_blank" rel="noreferrer" className="underline underline-offset-2">NASA FIRMS</a> · <a href="https://confluence.ecmwf.int/spaces/CKB/pages/283569774/Fire+Weather+Index+FWI+%E2%80%93+Dataset+Description" target="_blank" rel="noreferrer" className="underline underline-offset-2">Fire weather danger and FWI inputs</a></p>
          </div>
        </details>}
      </main>
    </div>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return <div role="status" className="mt-3 flex items-start gap-2.5 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-950">
    <AlertTriangle className="mt-0.5 size-4 shrink-0" /><p>{children}</p>
  </div>;
}

function Swatch({ color, label }: { color: string; label: string }) {
  return <span className="num inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm" style={{ backgroundColor: color }} />{label}</span>;
}

function AreaChips({ title, areas, activeKey, onChoose }: { title: string; areas: RiskArea[]; activeKey: string; onChoose: (area: RiskArea) => void }) {
  return <div>
    <p className="text-xs font-medium text-muted-foreground">{title}</p>
    <div className="mt-1.5 flex flex-wrap gap-1.5">{areas.map((item) => <Button key={item.label} size="sm" aria-pressed={activeKey === riskAreaKey(item)} variant={activeKey === riskAreaKey(item) ? "default" : "secondary"} onClick={() => onChoose(item)}>{item.label}</Button>)}</div>
  </div>;
}

function CellDetails({ cell, report, outlook }: { cell: RiskCell; report: RiskReport; outlook: CellOutlook | null }) {
  return <div className="bg-secondary/40 py-3 pl-12 pr-4 text-xs" aria-live="polite">
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
      <dt className="text-muted-foreground">Last detection</dt><dd className="font-medium">{cell.last_seen ? date(cell.last_seen) : "None recently"}</dd>
      <dt className="text-muted-foreground">{MONTHS[report.season_month - 1]} history</dt><dd className="font-medium">Active in {cell.active_years} of {report.history_years} years</dd>
      <dt className="text-muted-foreground">Monthly mean</dt><dd className="num font-medium">{cell.seasonal_mean.toLocaleString("en-GB", { maximumFractionDigits: 1 })} detections</dd>
      {outlook && <><dt className="text-muted-foreground">Outlook</dt><dd><span className="num font-medium">{Math.round(outlook.lead.prob * 100)}%</span> chance of an unusually active {monthName(outlook.target)}
        {outlook.lead.ratio !== null && <>, expected <span className="num font-medium">{outlook.lead.ratio.toFixed(1)}×</span> normal</>} (whole 1° block)</dd></>}
    </dl>
    <p className="mt-2.5 leading-relaxed text-muted-foreground"><strong className="font-medium text-foreground">Suggested check: </strong>{cell.level === "high" ? "Verify recent detections with local teams or field observations and prioritise monitoring here." : cell.level === "elevated" ? "Review seasonal activity alongside local official warnings and plan preventive checks." : "Monitor seasonal activity and new detections. Watch does not mean safe."}</p>
  </div>;
}
