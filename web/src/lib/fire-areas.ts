import type { Polygon } from "./api";

export const areaBox = (w: number, s: number, e: number, n: number): Polygon => ({
  type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]],
});

export const RISK_PLACES: { label: string; geometry: Polygon }[] = [
  { label: "Muğla kıyısı", geometry: areaBox(27.4, 36.5, 29.6, 37.5) },
  { label: "Konya çevresi", geometry: areaBox(31.5, 37.0, 34.5, 39.0) },
  { label: "Evia", geometry: areaBox(22.8, 38.3, 24.3, 39.1) },
  { label: "Orta Portekiz", geometry: areaBox(-8.6, 39.6, -7.2, 40.6) },
  { label: "Galicia", geometry: areaBox(-9.1, 41.9, -6.8, 43.6) },
  { label: "Sicilya", geometry: areaBox(12.3, 36.6, 15.7, 38.4) },
  { label: "Paraná Deltası", geometry: areaBox(-60.9, -34.3, -58.3, -32.0) },
];
