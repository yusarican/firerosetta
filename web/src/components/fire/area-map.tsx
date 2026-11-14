"use client";

import "maplibre-gl/dist/maplibre-gl.css";

import * as maplibregl from "maplibre-gl";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import type { Area, Point, Polygon } from "@/lib/api";
import { addCountryHighlight, showCountryHighlight } from "./country-highlight";
import { createMapStyleSync } from "./map-style-sync";

const STYLE = "https://tiles.openfreemap.org/styles/positron";
// v6 ships its worker as a separate module; serve it from /public (copied on npm install)
maplibregl.setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");
const EMPTY = { type: "FeatureCollection" as const, features: [] };

function bboxOf(area: Area): [number, number, number, number] {
  if (area.kind === "country") return area.bbox;
  const ring = area.geometry.coordinates[0];
  const xs = ring.map((c) => c[0]);
  const ys = ring.map((c) => c[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export function AreaMap({
  area,
  points,
  onDraw,
}: {
  area: Area;
  points: Point[];
  onDraw: (geometry: Polygon) => void;
}) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const styleSync = useRef<ReturnType<typeof createMapStyleSync> | null>(null);
  const draft = useRef<number[][]>([]);
  const drawingRef = useRef(false);
  const onDrawRef = useRef(onDraw);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const [vertices, setVertices] = useState(0);

  useEffect(() => {
    onDrawRef.current = onDraw;
  }, [onDraw]);

  const setData = (id: string, data: unknown) => {
    const instance = map.current;
    if (!instance) return;
    styleSync.current?.update(`data-${id}`, () =>
      (instance.getSource(id) as maplibregl.GeoJSONSource | undefined)?.setData(data as never));
  };

  const paintDraft = () => {
    const pts = draft.current;
    setVertices(pts.length);
    setData("draft", {
      type: "FeatureCollection",
      features: [
        ...(pts.length > 1
          ? [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [...pts, pts[0]] } }]
          : []),
        ...pts.map((c) => ({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: c } })),
      ],
    });
  };

  const stop = (commit: boolean) => {
    const pts = draft.current;
    drawingRef.current = false;
    setDrawing(false);
    draft.current = [];
    paintDraft();
    if (map.current) {
      map.current.getCanvas().style.cursor = "";
      map.current.doubleClickZoom.enable();
    }
    if (commit && pts.length >= 3) {
      onDrawRef.current({ type: "Polygon", coordinates: [[...pts, pts[0]]] });
    }
  };
  const stopRef = useRef(stop);
  useEffect(() => {
    stopRef.current = stop;
  });

  useEffect(() => {
    if (!el.current) return;
    let m: maplibregl.Map;
    try {
      m = new maplibregl.Map({
        container: el.current,
        style: STYLE,
        center: [32, 39],
        zoom: 4,
        attributionControl: { compact: true },
      });
    } catch {
      // no WebGL (old GPU, remote desktop): the calendar still works from presets and the lat/lon box
      queueMicrotask(() => setFailed(true));
      return;
    }
    map.current = m;
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    const sync = createMapStyleSync(m, (loaded) => { if (map.current === m) setReady(loaded); });
    styleSync.current = sync;
    queueMicrotask(() => { if (styleSync.current === sync) setReady(sync.ready); });
    sync.update("bootstrap", () => {
      if (!m.getSource("aoi")) m.addSource("aoi", { type: "geojson", data: EMPTY });
      if (!m.getSource("pts")) m.addSource("pts", { type: "geojson", data: EMPTY });
      if (!m.getSource("draft")) m.addSource("draft", { type: "geojson", data: EMPTY });
      if (!m.getLayer("aoi-fill")) m.addLayer({ id: "aoi-fill", type: "fill", source: "aoi", paint: { "fill-color": "#1d5a48", "fill-opacity": 0.06 } });
      if (!m.getLayer("aoi-line")) m.addLayer({ id: "aoi-line", type: "line", source: "aoi", paint: { "line-color": "#1d5a48", "line-width": 2 } });
      addCountryHighlight(m);
      if (!m.getLayer("pts")) m.addLayer({
        id: "pts",
        type: "circle",
        source: "pts",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 2, 9, 4.5],
          "circle-color": ["case", ["get", "modis"], "#2a78d6", "#eb6834"],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 0.6,
          "circle-opacity": 0.85,
        },
      });
      if (!m.getLayer("draft-line")) m.addLayer({ id: "draft-line", type: "line", source: "draft", filter: ["==", "$type", "LineString"], paint: { "line-color": "#15211d", "line-width": 1.5, "line-dasharray": [2, 2] } });
      if (!m.getLayer("draft-pt")) m.addLayer({ id: "draft-pt", type: "circle", source: "draft", filter: ["==", "$type", "Point"], paint: { "circle-radius": 4.5, "circle-color": "#ffffff", "circle-stroke-color": "#15211d", "circle-stroke-width": 2 } });
    });
    m.on("click", (e) => {
      if (!drawingRef.current) return;
      draft.current = [...draft.current, [+e.lngLat.lng.toFixed(4), +e.lngLat.lat.toFixed(4)]];
      paintDraft();
    });
    m.on("dblclick", () => {
      if (!drawingRef.current) return;
      draft.current = draft.current.slice(0, -1); // the double-click's second click added a duplicate
      stopRef.current(true);
    });
    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 8 });
    m.on("mousemove", "pts", (e) => {
      if (drawingRef.current || !e.features?.length) return;
      const p = e.features[0].properties as { date: string; platform: string; frp: number; dn: string };
      m.getCanvas().style.cursor = "pointer";
      popup
        .setLngLat(e.lngLat)
        .setText(`${p.date} · ${p.platform} · ${p.dn === "D" ? "day" : "night"}${p.frp != null ? ` · ${p.frp} MW` : ""}`)
        .addTo(m);
    });
    m.on("mouseleave", "pts", () => {
      if (!drawingRef.current) m.getCanvas().style.cursor = "";
      popup.remove();
    });
    const key = (e: KeyboardEvent) => {
      if (!drawingRef.current) return;
      if (e.key === "Escape") stopRef.current(false);
      if (e.key === "Enter") stopRef.current(true);
    };
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("keydown", key);
      sync.dispose();
      if (styleSync.current === sync) styleSync.current = null;
      m.remove();
      if (map.current === m) map.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const instance = map.current, sync = styleSync.current;
    if (!instance || !sync) return;
    const [w, s, e, n] = bboxOf(area);
    const geometry =
      area.kind === "polygon"
        ? area.geometry
        : { type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] };
    sync.update("area", () => {
      showCountryHighlight(instance, area.kind === "country" ? area.name : undefined);
      (instance.getSource("aoi") as maplibregl.GeoJSONSource).setData({
        type: "FeatureCollection",
        features: area.kind === "polygon" ? [{ type: "Feature", properties: {}, geometry }] : [],
      } as never);
    });
    sync.update("bounds", () => instance.fitBounds([[w, s], [e, n]], { padding: 36, duration: 600, maxZoom: 10 }), false);
    return () => { sync.cancel("area"); sync.cancel("bounds"); };
  }, [area]);

  useEffect(() => {
    setData("pts", {
      type: "FeatureCollection",
      features: points.map(([lon, lat, date, platform, frp, dn]) => ({
        type: "Feature",
        properties: { date, platform, frp, dn, modis: platform === "Terra" || platform === "Aqua" },
        geometry: { type: "Point", coordinates: [lon, lat] },
      })),
    });
  }, [points]);

  const start = () => {
    if (!map.current || !styleSync.current?.ready) return;
    drawingRef.current = true;
    setDrawing(true);
    draft.current = [];
    paintDraft();
    map.current.getCanvas().style.cursor = "crosshair";
    map.current.doubleClickZoom.disable();
  };

  return (
    <div className="relative h-full min-h-[320px] overflow-hidden rounded-lg border bg-muted">
      {/* maplibre's stylesheet forces position:relative on its container, so size it explicitly */}
      <div ref={el} className="h-full w-full" />
      {failed && (
        <p className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-muted-foreground">
          This browser cannot draw the map (WebGL is off). Pick a place below or enter a lat/lon box; the calendar and CSV work without it.
        </p>
      )}
      <div className="absolute left-3 top-3 flex items-center gap-2">
        {drawing ? (
          <>
            <Button size="sm" onClick={() => stop(true)} disabled={vertices < 3}>
              Use this area
            </Button>
            <Button size="sm" variant="outline" onClick={() => stop(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button size="sm" onClick={start} disabled={!ready} className={failed ? "hidden" : ""}>
            Draw an area
          </Button>
        )}
      </div>
      {drawing && (
        <p className="absolute bottom-3 left-3 rounded-md bg-card/95 px-2.5 py-1.5 text-xs shadow-sm">
          {vertices < 3
            ? `Click the map to place corners (${vertices} of at least 3).`
            : "Double-click or press Enter to finish. Esc cancels."}
        </p>
      )}
    </div>
  );
}
