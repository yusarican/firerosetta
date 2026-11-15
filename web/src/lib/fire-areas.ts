import type { Polygon } from "./api";

export const areaBox = (w: number, s: number, e: number, n: number): Polygon => ({
  type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]],
});

export type RiskArea = { label: string; geometry: Polygon; country?: string };

// The same archive names and coverage boxes used by /meta and the Calendar.
export const RISK_COUNTRIES: RiskArea[] = [
  { label: "Türkiye", country: "Turkey", geometry: areaBox(25.6, 35.8, 44.9, 42.2) },
  { label: "Greece", country: "Greece", geometry: areaBox(19.3, 34.7, 29.7, 41.8) },
  { label: "Portugal", country: "Portugal", geometry: areaBox(-9.6, 36.9, -6.1, 42.2) },
  { label: "Spain", country: "Spain", geometry: areaBox(-9.4, 35.9, 4.4, 43.9) },
  { label: "Italy", country: "Italy", geometry: areaBox(6.6, 35.4, 18.6, 47.1) },
  { label: "Argentina", country: "Argentina", geometry: areaBox(-73.6, -55.1, -53.6, -21.7) },
];

export const riskAreaKey = (area: RiskArea) => area.country ? `country:${area.country}` : JSON.stringify(area.geometry);

export const RISK_PLACES: RiskArea[] = [
  { label: "Muğla coast", geometry: areaBox(27.4, 36.5, 29.6, 37.5) },
  { label: "Konya region", geometry: areaBox(31.5, 37.0, 34.5, 39.0) },
  { label: "Evia", geometry: areaBox(22.8, 38.3, 24.3, 39.1) },
  { label: "Central Portugal", geometry: areaBox(-8.6, 39.6, -7.2, 40.6) },
  { label: "Galicia", geometry: areaBox(-9.1, 41.9, -6.8, 43.6) },
  { label: "Sicily", geometry: areaBox(12.3, 36.6, 15.7, 38.4) },
  { label: "Paraná Delta", geometry: areaBox(-60.9, -34.3, -58.3, -32.0) },
];
