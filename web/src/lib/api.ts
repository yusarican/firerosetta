export type Era = "terra" | "modis" | "snpp" | "noaa20";

export type MonthRow = {
  month: string; // YYYY-MM
  year: number;
  moy: number;
  era: Era;
  harmonized: number;
  lo: number;
  hi: number;
  modis: number;
  snpp: number;
  noaa20: number;
  model: number;
  oof: number | null;
  median: number;
  pct: number;
  provisional: boolean; // near-real-time data, replaced once the standard product is published
  partial: boolean; // the month is not over yet
};

export type YearRow = {
  year: number;
  total: number;
  lo: number;
  hi: number;
  modis: number;
  rank: number;
  peak_moy: number;
  anomaly_pct: number | null;
};

export type LinkSkill = {
  wape: number | null;
  bias: number | null;
  r2: number | null;
  interval90: [number, number];
};

export type Calendar = {
  area: { cells: number; countries: string[]; approx_km2: number };
  months: MonthRow[];
  climatology: { moy: number; median: number; mean: number; p10: number; p90: number; max: number }[];
  years: YearRow[];
  year_median: number;
  skill: { modis: LinkSkill; terra: LinkSkill; raw_modis_wape: number | null; n_months: number };
};

export type Polygon = { type: "Polygon"; coordinates: number[][][] };
export type Area =
  | { kind: "country"; name: string; bbox: [number, number, number, number] }
  | { kind: "polygon"; label: string; geometry: Polygon };

export type Meta = {
  countries: { name: string; bbox: [number, number, number, number] }[];
  first_month: string;
  last_month: string;
  grid_deg: number;
  hotspots: number;
  source_files: number;
  source_bytes: number;
  reference: string;
  data_through: string; // YYYY-MM-DD
  nrt_from: Record<string, string>; // platform -> first near-real-time day
};

// [lon, lat, date, platform, frp, day/night]
export type Point = [number, number, string, string, number | null, string];
export type Hotspots = {
  total: number;
  returned: number;
  by_platform: Record<string, number>;
  points: Point[];
};

type Score = { wape: number; bias: number; r2: number };
export type ScaleScore = {
  n: number;
  raw_modis: Score;
  global_ratio: Score;
  model_full: Score;
  model_terra: Score;
};
export type Validation = {
  reference: string;
  grid_deg: number;
  overlap: [string, string];
  cv: string;
  features: Record<string, string[]>;
  train_rows: number;
  scales: Record<string, ScaleScore>;
  per_country: Record<string, ScaleScore & { country_month: ScaleScore }>;
  noaa20_link: { k: number; country_month_wape: number; overlap: [string, string] };
  modis_to_viirs_ratio_by_year: Record<string, { viirs_per_modis: number; terra_per_aqua: number }>;
  scatter_country_month: { country: string; month: string; obs: number; raw: number; full: number; terra: number }[];
};

const areaBody = (a: Area) =>
  a.kind === "country" ? { country: a.name } : { geometry: a.geometry };

async function call<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: body ? "POST" : "GET",
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new Error("The data service is not reachable. Start it with `uv run uvicorn firerosetta.api:app --port 8000` in backend/.");
  }
  if (!res.ok) {
    const detail = await res.json().then((j) => j.detail).catch(() => null);
    throw new Error(
      detail ?? (res.status >= 500
        ? "The data service is not responding. Start it with `uv run uvicorn firerosetta.api:app --port 8000` in backend/."
        : `Request failed (${res.status}).`),
    );
  }
  return res.json();
}

export const getMeta = () => call<Meta>("/meta");

export type RiskLevel = "high" | "elevated" | "watch";
export type RiskGridKm = 5 | 10;
export type RiskView = { gridKm: RiskGridKm; bounds: [number, number, number, number] };
export type RiskCell = {
  id: string;
  lon: number;
  lat: number;
  bbox: [number, number, number, number];
  geometry: { type: "Polygon"; coordinates: number[][][] } | { type: "MultiPolygon"; coordinates: number[][][][] };
  level: RiskLevel;
  seasonal: boolean;
  seasonal_mean: number;
  active_years: number;
  recent_7d: number;
  recent_30d: number;
  active_days_7d: number;
  last_seen: string | null;
};
export type RiskReport = {
  country: string;
  selection_geometry?: Polygon;
  coverage_countries?: string[];
  coverage_partial?: boolean;
  bbox: [number, number, number, number];
  as_of: string;
  checked_at: string;
  data_through: string;
  data_age_days: number;
  source: "live" | "local";
  live_error: string | null;
  current_evidence_enabled: boolean;
  grid_km: RiskGridKm;
  lattice: { type: "FeatureCollection"; features: { type: "Feature"; properties: Record<string, never>; geometry: { type: "MultiLineString"; coordinates: number[][][] } }[] };
  history_first: number;
  history_last: number;
  history_years: number;
  season_month: number;
  seasonal_threshold: number;
  recent_sensor: string;
  refresh_seconds: number;
  summary: Record<RiskLevel, number> & { recent_7d: number; total_cells: number };
  cells: RiskCell[];
};
export const getRisk = (country: string, signal?: AbortSignal, view?: { gridKm: RiskGridKm; bounds?: RiskView["bounds"] } | null) => {
  const query = new URLSearchParams({ country, grid_km: String(view?.gridKm ?? 10) });
  if (view?.bounds) query.set("view", view.bounds.join(","));
  return call<RiskReport>(`/risk?${query}`, undefined, signal);
};
export const getAreaRisk = (geometry: Polygon, gridKm: RiskGridKm, signal?: AbortSignal) =>
  call<RiskReport>("/risk", { geometry, grid_km: gridKm }, signal);
export const getValidation = () => call<Validation>("/validation");
export const getCalendar = (a: Area, s?: AbortSignal) => call<Calendar>("/calendar", areaBody(a), s);
export const getHotspots = (a: Area, start: string, end: string, s?: AbortSignal) =>
  call<Hotspots>("/hotspots", { ...areaBody(a), start, end }, s);

export async function downloadCsv(a: Area, start: string, end: string) {
  const res = await fetch("/api/hotspots.csv", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...areaBody(a), start, end }),
  });
  if (!res.ok) throw new Error("The CSV could not be generated. Try a shorter date range.");
  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = `hotspots_${start}_${end}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}
