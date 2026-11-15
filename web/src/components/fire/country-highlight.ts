import type { Map as MapLibreMap } from "maplibre-gl";

export const COUNTRY_HIGHLIGHT_COLOR = "#2563eb";
const SOURCE = "country-boundaries";
const FILL = "country-highlight-fill";
const OUTLINE = "country-highlight-outline";

/** Call only after this map's style has loaded, and replay on style restoration. */
export function addCountryHighlight(map: MapLibreMap) {
  if (!map.getSource(SOURCE)) map.addSource(SOURCE, {
    type: "geojson", data: "/data/country-boundaries.geojson",
    attribution: '<a href="https://www.naturalearthdata.com/" target="_blank" rel="noreferrer">Natural Earth</a>',
  });
  // Keep place names above the tint. Risk cells and point markers are added later.
  const firstLabel = map.getStyle().layers.find((layer) => layer.type === "symbol")?.id;
  if (!map.getLayer(FILL)) map.addLayer({
    id: FILL, type: "fill", source: SOURCE, filter: ["==", ["get", "country"], ""],
    paint: { "fill-color": COUNTRY_HIGHLIGHT_COLOR, "fill-opacity": 0.13 },
  }, firstLabel);
  if (!map.getLayer(OUTLINE)) map.addLayer({
    id: OUTLINE, type: "line", source: SOURCE, filter: ["==", ["get", "country"], ""],
    paint: { "line-color": COUNTRY_HIGHLIGHT_COLOR, "line-width": 2, "line-opacity": 0.8 },
  });
}

export function showCountryHighlight(map: MapLibreMap, country?: string) {
  for (const layer of [FILL, OUTLINE]) map.setFilter(layer, ["==", ["get", "country"], country ?? ""]);
}
