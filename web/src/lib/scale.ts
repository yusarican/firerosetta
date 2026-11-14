export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** 1234 -> "1.2k"; keeps small counts exact. */
export function fmt(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${Math.round(n / 1e3)}k`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return `${Math.round(n)}`;
}
export const full = (n: number) => Math.round(n).toLocaleString("en-US");

// Sequential: one warm family, lightness falls monotonically, so it survives
// greyscale printing and colour-vision deficiency. Zero gets the neutral surface.
export const HEAT = ["#fdf0d9", "#f9d79f", "#f5b866", "#ee933c", "#dd6a22", "#bd4416", "#8f2610", "#5a130b"];
export const ZERO = "#eceeea";

// Diverging: blue (quieter than usual) <-> red (more fire than usual), grey midpoint.
export const DIVERGE = ["#1c5cab", "#5598e7", "#b7d3f6", "#eeeeea", "#f4c0b4", "#e2705c", "#b02a2a"];
export const DIVERGE_LABELS = ["<¼×", "½×", "¾×", "typical", "1.5×", "2×", ">4×"];

/** Log scale stretched between the area's quietest and busiest burning months. */
export type HeatScale = { lo: number; hi: number };

export function heatScale(values: number[]): HeatScale {
  const v = values.filter((x) => x >= 0.5).sort((a, b) => a - b);
  if (!v.length) return { lo: 1, hi: 2 };
  const lo = Math.max(1, v[Math.floor(v.length * 0.05)]);
  return { lo, hi: Math.max(v[v.length - 1], lo * 2) };
}

export function heatColor(v: number, s: HeatScale): string {
  if (v < 0.5) return ZERO;
  const t = (Math.log(Math.max(v, s.lo)) - Math.log(s.lo)) / (Math.log(s.hi) - Math.log(s.lo));
  return HEAT[Math.min(HEAT.length - 1, Math.floor(t * HEAT.length))];
}

/** Upper bound of each heat class, for the legend. */
export function heatBreaks(s: HeatScale): number[] {
  return HEAT.map((_, i) => Math.exp(Math.log(s.lo) + ((i + 1) / HEAT.length) * (Math.log(s.hi) - Math.log(s.lo))));
}

export function anomalyColor(v: number, median: number): string {
  if (median < 0.5) return v < 0.5 ? DIVERGE[3] : DIVERGE[6];
  const r = v / median;
  if (r < 0.25) return DIVERGE[0];
  if (r < 0.5) return DIVERGE[1];
  if (r < 0.8) return DIVERGE[2];
  if (r <= 1.25) return DIVERGE[3];
  if (r <= 2) return DIVERGE[4];
  if (r <= 4) return DIVERGE[5];
  return DIVERGE[6];
}

/** Ink that stays readable on a given fill. */
export function inkOn(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const lum = (0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  return lum > 0.58 ? "#15211d" : "#ffffff";
}

export function monthRange(month: string): [string, string] {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return [`${month}-01`, `${month}-${String(last).padStart(2, "0")}`];
}

export function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}
