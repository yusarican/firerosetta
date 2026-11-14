"use client";

import "maplibre-gl/dist/maplibre-gl.css";

import * as maplibregl from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import { LoaderCircle, MapPin } from "lucide-react";
import type { Polygon, RiskCell, RiskGridKm, RiskLevel, RiskReport, RiskView } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { createMapStyleSync } from "./map-style-sync";
import { RISK_FILL_COLOR } from "@/lib/risk-colors";
import { addCountryHighlight, showCountryHighlight } from "./country-highlight";
import { cn } from "@/lib/utils";
import { riskGridForZoom } from "@/lib/risk-view";

maplibregl.setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");

export function RiskMap({ layers, levelFilter, bbox, selected, gridKm, busy, area, country, drawRequest, onDraw, onSelect, onViewChange, className }: {
  className?: string;
  layers: RiskReport[];
  levelFilter: "all" | RiskLevel;
  bbox: [number, number, number, number];
  selected: RiskCell | null;
  gridKm: RiskGridKm;
  busy: boolean;
  area: Polygon;
  country?: string;
  drawRequest: number;
  onDraw: (geometry: Polygon) => void;
  onSelect: (id: string) => void;
  onViewChange: (view: RiskView) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const styleSync = useRef<ReturnType<typeof createMapStyleSync> | null>(null);
  const select = useRef(onSelect);
  const viewChange = useRef(onViewChange);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const loadedLayers = useRef(new Map<number, RiskReport>());
  const loadedArea = useRef("");
  const drawingRef = useRef(false);
  const draft = useRef<number[][]>([]);
  const drawCallback = useRef(onDraw);
  const finishRef = useRef<(commit: boolean) => void>(() => {});
  const [drawing, setDrawing] = useState(false);
  const [vertices, setVertices] = useState(0);
  useEffect(() => { select.current = onSelect; }, [onSelect]);
  useEffect(() => { viewChange.current = onViewChange; }, [onViewChange]);
  useEffect(() => { drawCallback.current = onDraw; }, [onDraw]);
  const paintDraft = () => {
    const points = draft.current;
    setVertices(points.length);
    const instance = map.current;
    if (!instance) return;
    styleSync.current?.update("draft", () => (instance.getSource("draft") as maplibregl.GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection", features: [
        ...(points.length > 1 ? [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [...points, points[0]] } }] : []),
        ...points.map((point) => ({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: point } })),
      ],
    } as never));
  };
  const finishDraw = (commit: boolean) => {
    const points = draft.current;
    drawingRef.current = false; draft.current = []; setDrawing(false); paintDraft();
    if (map.current) { map.current.doubleClickZoom.enable(); map.current.getCanvas().style.cursor = ""; }
    if (commit && points.length >= 3) drawCallback.current({ type: "Polygon", coordinates: [[...points, points[0]]] });
  };
  useEffect(() => { finishRef.current = finishDraw; });
  const startDraw = () => {
    if (!map.current || !styleSync.current?.ready) return;
    drawingRef.current = true; draft.current = []; setDrawing(true); paintDraft();
    map.current.doubleClickZoom.disable(); map.current.getCanvas().style.cursor = "crosshair";
  };
  useEffect(() => {
    if (drawRequest <= 0 || !ready) return;
    queueMicrotask(() => {
      const instance = map.current;
      if (!instance || !styleSync.current?.ready) return;
      drawingRef.current = true; draft.current = []; setDrawing(true); setVertices(0);
      styleSync.current.update("draft", () => (instance.getSource("draft") as maplibregl.GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: [] }));
      instance?.doubleClickZoom.disable();
      if (instance) instance.getCanvas().style.cursor = "crosshair";
    });
  }, [drawRequest, ready]);

  useEffect(() => {
    if (!container.current) return;
    let instance: maplibregl.Map;
    try {
      instance = new maplibregl.Map({ container: container.current, style: "https://tiles.openfreemap.org/styles/positron",
        center: [35, 39], zoom: 4, renderWorldCopies: false, attributionControl: { compact: true } });
    } catch {
      queueMicrotask(() => setFailed(true));
      return;
    }
    map.current = instance;
    const layerStore = loadedLayers.current;
    instance.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    const sync = createMapStyleSync(instance, (loaded) => {
      if (map.current !== instance) return;
      setReady(loaded);
      if (loaded) { window.clearTimeout(timeout); setFailed(false); }
    });
    styleSync.current = sync;
    // React may retain ready=true across Fast Refresh/Strict Mode. It must never
    // authorize updates to this new instance before its own style.load event.
    queueMicrotask(() => { if (styleSync.current === sync) { setReady(sync.ready); setFailed(false); } });
    const timeout = window.setTimeout(() => { if (!sync.ready) setFailed(true); }, 20000);
    sync.update("bootstrap", () => {
      layerStore.clear();
      if (!instance.getSource("selection")) instance.addSource("selection", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      if (!instance.getSource("draft")) instance.addSource("draft", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      if (!instance.getLayer("selection-line")) instance.addLayer({ id: "selection-line", type: "line", source: "selection", paint: { "line-color": "#164c39", "line-width": 2.5 } });
      addCountryHighlight(instance);
      if (!instance.getLayer("draft-line")) instance.addLayer({ id: "draft-line", type: "line", source: "draft", filter: ["==", "$type", "LineString"], paint: { "line-color": "#164c39", "line-width": 2, "line-dasharray": [2, 2] } });
      if (!instance.getLayer("draft-points")) instance.addLayer({ id: "draft-points", type: "circle", source: "draft", filter: ["==", "$type", "Point"], paint: { "circle-color": "#ffffff", "circle-radius": 5, "circle-stroke-color": "#164c39", "circle-stroke-width": 2 } });
    });
    let viewTimer: number | undefined;
    const flushView = () => {
      window.clearTimeout(viewTimer);
      viewTimer = undefined;
      const zoom = instance.getZoom();
      const gridKm = riskGridForZoom(zoom);
      const extent = instance.getBounds();
      const bounds = [Math.max(-180, extent.getWest()), Math.max(-85, extent.getSouth()),
        Math.min(180, extent.getEast()), Math.min(85, extent.getNorth())].map((value) => +value.toFixed(4)) as RiskView["bounds"];
      if (bounds[0] < bounds[2] && bounds[1] < bounds[3]) viewChange.current({ gridKm, bounds });
    };
    const reportView = () => { if (viewTimer === undefined) viewTimer = window.setTimeout(flushView, 50); };
    instance.on("move", reportView);
    instance.on("moveend", flushView);
    let resizeFrame = 0;
    const resizeObserver = new ResizeObserver(() => {
      window.cancelAnimationFrame(resizeFrame);
      resizeFrame = window.requestAnimationFrame(() => instance.resize());
    });
    resizeObserver.observe(container.current);
    instance.on("click", (event) => {
      if (!sync.ready) return;
      if (drawingRef.current) {
        draft.current = [...draft.current, [+event.lngLat.lng.toFixed(5), +event.lngLat.lat.toFixed(5)]];
        const points = draft.current;
        setVertices(points.length);
        sync.update("draft", () => (instance.getSource("draft") as maplibregl.GeoJSONSource).setData({ type: "FeatureCollection", features: [
          ...(points.length > 1 ? [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [...points, points[0]] } }] : []),
          ...points.map((point) => ({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: point } })),
        ] } as never));
        return;
      }
      const active = [...layerStore.keys()].filter((km) => instance.getLayoutProperty(`fill-${km}`, "visibility") === "visible");
      if (!active.length) return;
      const feature = instance.queryRenderedFeatures(event.point, { layers: active.map((km) => `fill-${km}`) })[0];
      const id = feature?.properties?.id;
      if (typeof id === "string") select.current(id);
    });
    instance.on("dblclick", () => { if (drawingRef.current) { draft.current = draft.current.slice(0, -1); finishRef.current(true); } });
    const key = (event: KeyboardEvent) => {
      if (!drawingRef.current) return;
      if (event.target instanceof HTMLElement && event.target.closest("input,textarea,select")) return;
      if (event.key === "Escape") finishRef.current(false);
      if (event.key === "Enter" && draft.current.length >= 3) finishRef.current(true);
    };
    window.addEventListener("keydown", key);
    return () => {
      window.clearTimeout(timeout); window.clearTimeout(viewTimer); window.removeEventListener("keydown", key);
      resizeObserver.disconnect(); window.cancelAnimationFrame(resizeFrame);
      sync.dispose();
      if (styleSync.current === sync) styleSync.current = null;
      instance.remove();
      if (map.current === instance) map.current = null;
      layerStore.clear(); loadedArea.current = "";
    };
  }, []);

  useEffect(() => {
    const instance = map.current;
    const sync = styleSync.current;
    if (!instance || !sync) return;
    sync.update("risk-layers", () => {
      for (const km of loadedLayers.current.keys()) {
        if (km > 20) for (const id of [`grid-lines-${km}`, `fill-${km}`, `outline-${km}`, `selected-${km}`]) if (instance.getLayer(id)) instance.setLayoutProperty(id, "visibility", "none");
      }
      const regionKey = JSON.stringify(area);
      if (loadedArea.current !== regionKey) {
        for (const km of loadedLayers.current.keys()) {
          for (const id of [`selected-${km}`, `outline-${km}`, `fill-${km}`, `grid-lines-${km}`]) if (instance.getLayer(id)) instance.removeLayer(id);
          for (const id of [`risk-${km}`, `grid-${km}`]) if (instance.getSource(id)) instance.removeSource(id);
        }
        loadedLayers.current.clear(); loadedArea.current = regionKey;
        if (drawingRef.current) queueMicrotask(() => finishRef.current(false));
      }
      for (const report of layers) {
        const km = report.grid_km;
        const source = `risk-${km}`, latticeSource = `grid-${km}`;
        if (loadedLayers.current.get(km) !== report) {
          const data = { type: "FeatureCollection" as const, features: report.cells.map((cell) => ({
            type: "Feature" as const, properties: { id: cell.id, level: cell.level, recent_7d: cell.recent_7d }, geometry: cell.geometry,
          })) };
          if (!instance.getSource(source)) instance.addSource(source, { type: "geojson", data });
          else (instance.getSource(source) as maplibregl.GeoJSONSource).setData(data);
          if (!instance.getSource(latticeSource)) instance.addSource(latticeSource, { type: "geojson", data: report.lattice });
          else (instance.getSource(latticeSource) as maplibregl.GeoJSONSource).setData(report.lattice);
          if (!instance.getLayer(`grid-lines-${km}`)) instance.addLayer({ id: `grid-lines-${km}`, type: "line", source: latticeSource, layout: { visibility: "none" },
              paint: { "line-color": "#65786d", "line-width": 0.65, "line-opacity": 0.35 } }, "selection-line");
          if (!instance.getLayer(`fill-${km}`)) instance.addLayer({ id: `fill-${km}`, type: "fill", source, layout: { visibility: "none" }, paint: {
              "fill-color": RISK_FILL_COLOR,
              "fill-opacity": ["match", ["get", "level"], "high", 0.82, "elevated", 0.5, 0.2],
            } }, "selection-line");
          if (!instance.getLayer(`outline-${km}`)) instance.addLayer({ id: `outline-${km}`, type: "line", source, layout: { visibility: "none" },
              paint: { "line-color": "#ffffff", "line-width": 0.65, "line-opacity": 0.7 } }, "selection-line");
          if (!instance.getLayer(`selected-${km}`)) instance.addLayer({ id: `selected-${km}`, type: "line", source, layout: { visibility: "none" },
              paint: { "line-color": "#163f33", "line-width": 3 } }, "selection-line");
          loadedLayers.current.set(km, report);
        }
        const visibility = km === gridKm ? "visible" : "none";
        for (const id of [`grid-lines-${km}`, `fill-${km}`, `outline-${km}`, `selected-${km}`]) instance.setLayoutProperty(id, "visibility", visibility);
        const filter: maplibregl.FilterSpecification | null = levelFilter === "all" ? null : ["==", ["get", "level"], levelFilter];
        instance.setFilter(`fill-${km}`, filter);
        instance.setFilter(`outline-${km}`, filter);
        instance.setFilter(`selected-${km}`, ["==", ["get", "id"], selected?.id ?? ""]);
      }
    });
    return () => sync.cancel("risk-layers");
  }, [area, layers, gridKm, levelFilter, selected?.id]);

  const [west, south, east, north] = bbox;
  useEffect(() => {
    const instance = map.current, sync = styleSync.current;
    if (!instance || !sync) return;
    sync.update("selection", () => (instance.getSource("selection") as maplibregl.GeoJSONSource | undefined)?.setData({ type: "Feature", properties: {}, geometry: area }));
    return () => sync.cancel("selection");
  }, [area]);
  useEffect(() => {
    const instance = map.current, sync = styleSync.current;
    if (!instance || !sync) return;
    sync.update("country-highlight", () => {
      showCountryHighlight(instance, country);
      instance.setPaintProperty("selection-line", "line-color", country ? "#64748b" : "#164c39");
      instance.setPaintProperty("selection-line", "line-width", country ? 1.25 : 2.5);
      instance.setPaintProperty("selection-line", "line-dasharray", country ? [4, 3] : [1, 0]);
    });
    return () => sync.cancel("country-highlight");
  }, [country]);
  useEffect(() => {
    const instance = map.current, sync = styleSync.current;
    if (!instance || !sync) return;
    sync.update("bounds", () => instance.fitBounds([[west, south], [east, north]], { padding: 40, duration: 500 }), false);
    return () => sync.cancel("bounds");
  }, [west, south, east, north]);

  return (
    <div className={cn("relative overflow-hidden rounded-lg border bg-muted", className ?? "h-[410px] sm:h-[480px] lg:h-[520px]")}>
      <div ref={container} className="h-full w-full" role="region" aria-label="Fire alert map. You can also select cells from the alert list." />
      <div className="absolute left-3 top-3 flex gap-2">
        {drawing ? <><Button onClick={() => finishDraw(true)} disabled={vertices < 3}>Finish selection ({vertices})</Button><Button variant="outline" onClick={() => finishDraw(false)}>Cancel</Button></> : <Button variant="outline" disabled={!ready} onClick={startDraw}>Draw area</Button>}
      </div>
      {drawing && <p className="absolute bottom-16 left-3 max-w-[85%] rounded-md bg-white/95 px-3 py-2 text-xs shadow">Mark at least 3 corners. Click Finish or press Enter to select; press Esc to cancel.</p>}
      {(!ready || failed) && <div className={`absolute inset-0 flex flex-col items-center justify-center gap-3 px-10 text-center text-sm ${failed ? "bg-muted/95" : "pointer-events-none bg-muted/80"}`}>
        {failed ? <MapPin className="size-6 text-muted-foreground" /> : <LoaderCircle className="size-6 animate-spin text-primary" />}
        <p>{failed ? "The map could not load. You can review cells and coordinates in the alert list." : "Preparing alert map…"}</p>
      </div>}
      <div className="pointer-events-none absolute bottom-7 left-3 rounded-md border bg-white/95 px-3 py-2 text-xs text-muted-foreground shadow-sm">
        <strong className="text-foreground">Approx. {gridKm} × {gridKm} km</strong> · {busy ? "updating…" : gridKm === 5 ? "finest detail" : "zoom in for smaller cells"}
      </div>
    </div>
  );
}
