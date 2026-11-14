// Client-side exports of what the page already shows: analytics tables as CSV, visuals as PNG.
import type { Calendar, MonthRow } from "./api";
import {
  anomalyColor, DIVERGE, DIVERGE_LABELS, fmt, HEAT, heatBreaks, heatColor, heatScale, inkOn, MONTHS, ZERO,
} from "./scale";

const ERA_SOURCE: Record<MonthRow["era"], string> = {
  terra: "estimated_from_modis_terra",
  modis: "estimated_from_modis_terra_aqua",
  snpp: "observed_viirs_snpp",
  noaa20: "observed_viirs_noaa20_scaled",
};

export function slug(s: string) {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "").toLowerCase() || "area";
}

function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

type Cell = string | number | boolean | null | undefined;
const esc = (v: Cell) => {
  if (v === null || v === undefined) return "";
  const s = typeof v === "number" ? String(Math.round(v * 100) / 100) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function saveCsv(name: string, header: string[], rows: Cell[][], notes: string[]) {
  const text = [
    ...notes.map((n) => `# ${n}`),
    header.join(","),
    ...rows.map((r) => r.map(esc).join(",")),
  ].join("\n");
  save(new Blob([text + "\n"], { type: "text/csv;charset=utf-8" }), name);
}

function notes(cal: Calendar, label: string) {
  return [
    `FireRosetta harmonized burning calendar - ${label} (~${Math.round(cal.area.approx_km2)} km2, ${cal.area.cells} cells of 0.1 deg)`,
    "Unit: vegetation-fire hotspots per month on the S-NPP VIIRS 375 m scale (confidence >= nominal).",
    "Before 2012-02 values are estimated from MODIS; lo90/hi90 give the 90% range from this area's own validation.",
    `Area skill (unseen years): model error ${cal.skill.modis.wape ?? "n/a"}% vs raw MODIS ${cal.skill.raw_modis_wape ?? "n/a"}%.`,
    `Exported ${new Date().toISOString().slice(0, 10)}. Source: NASA FIRMS.`,
  ];
}

export function monthlyCsv(cal: Calendar, label: string) {
  saveCsv(
    `firerosetta_${slug(label)}_monthly.csv`,
    ["month", "year", "month_of_year", "source", "hotspots_harmonized", "lo90", "hi90", "modis_detected",
      "viirs_snpp_detected", "viirs_noaa20_detected", "median_same_month", "ratio_to_median",
      "percentile_same_month", "provisional", "partial"],
    cal.months.map((m) => [m.month, m.year, m.moy, ERA_SOURCE[m.era], m.harmonized, m.lo, m.hi, m.modis, m.snpp,
      m.noaa20, m.median, m.median > 0 ? m.harmonized / m.median : null, m.pct, m.provisional, m.partial]),
    notes(cal, label),
  );
}

export function yearlyCsv(cal: Calendar, label: string) {
  saveCsv(
    `firerosetta_${slug(label)}_yearly.csv`,
    ["year", "hotspots_harmonized", "lo90", "hi90", "modis_detected", "rank", "peak_month",
      "anomaly_pct_vs_median_year"],
    cal.years.map((y) => [y.year, y.total, y.lo, y.hi, y.modis, y.rank, MONTHS[y.peak_moy - 1], y.anomaly_pct]),
    [...notes(cal, label), `Median year: ${Math.round(cal.year_median)} hotspots. Only complete years are listed.`],
  );
}

export function seasonCsv(cal: Calendar, label: string) {
  saveCsv(
    `firerosetta_${slug(label)}_season.csv`,
    ["month", "median", "mean", "p10", "p90", "max"],
    cal.climatology.map((c) => [MONTHS[c.moy - 1], c.median, c.mean, c.p10, c.p90, c.max]),
    [...notes(cal, label), "Multi-year statistics for each calendar month, complete years only."],
  );
}

// ---------- PNG ----------

const INK = "#15211d";
const MUTED = "#5d6a64";
const FONT = () => getComputedStyle(document.body).fontFamily || "sans-serif";

function header(ctx: CanvasRenderingContext2D, title: string, sub: string, w: number, pad: number) {
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, ctx.canvas.height / (ctx.getTransform().a || 1));
  ctx.fillStyle = INK;
  ctx.font = `600 18px ${FONT()}`;
  ctx.fillText(title, pad, pad + 16);
  ctx.fillStyle = MUTED;
  ctx.font = `12px ${FONT()}`;
  ctx.fillText(sub, pad, pad + 36);
}

function footer(ctx: CanvasRenderingContext2D, h: number, pad: number) {
  ctx.fillStyle = MUTED;
  ctx.font = `11px ${FONT()}`;
  ctx.fillText("FireRosetta · NASA FIRMS MODIS C6.1 + VIIRS 375 m, harmonized to the S-NPP VIIRS scale", pad, h - pad + 4);
}

function canvas(w: number, h: number) {
  const scale = 2;
  const c = document.createElement("canvas");
  c.width = w * scale;
  c.height = h * scale;
  const ctx = c.getContext("2d")!;
  ctx.scale(scale, scale);
  return { c, ctx };
}

const savePng = (c: HTMLCanvasElement, name: string) =>
  new Promise<void>((resolve) => c.toBlob((b) => { if (b) save(b, name); resolve(); }, "image/png"));

/** Redraws the burning calendar (an HTML grid on the page) as an image. */
export async function calendarPng(cal: Calendar, mode: "count" | "anomaly", label: string) {
  const pad = 24, rowH = 18, gap = 2, labelW = 44, cellW = 46, totalW = 70;
  const years = [...new Set(cal.months.map((m) => m.year))].sort((a, b) => b - a);
  const gridTop = pad + 60;
  const w = pad * 2 + labelW + 12 * (cellW + gap) + totalW;
  const h = gridTop + 18 + (years.length + 1) * (rowH + gap) + 16 + 52 + pad;
  const { c, ctx } = canvas(w, h);
  header(ctx, `Burning calendar · ${label}`,
    mode === "count" ? "Hotspots per month on the VIIRS scale. Italic = estimated from MODIS (before Feb 2012)."
      : "Each month against the median for that calendar month. Italic = estimated from MODIS.", w, pad);

  const sc = heatScale(cal.months.map((m) => m.harmonized));
  const fill = (m: MonthRow) => (mode === "count" ? heatColor(m.harmonized, sc) : anomalyColor(m.harmonized, m.median));
  const byKey = new Map(cal.months.map((m) => [`${m.year}-${m.moy}`, m]));
  const totals = new Map(cal.years.map((y) => [y.year, y.total]));
  const x0 = pad + labelW;

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `11px ${FONT()}`;
  ctx.fillStyle = MUTED;
  MONTHS.forEach((m, i) => ctx.fillText(m, x0 + i * (cellW + gap) + cellW / 2, gridTop + 6));
  ctx.textAlign = "left";
  ctx.fillText("Year total", x0 + 12 * (cellW + gap) + 6, gridTop + 6);

  const rowY = (i: number) => gridTop + 18 + i * (rowH + gap);
  years.forEach((y, i) => {
    const ry = rowY(i);
    ctx.textAlign = "right";
    ctx.fillStyle = MUTED;
    ctx.font = `11px ${FONT()}`;
    ctx.fillText(String(y), x0 - 8, ry + rowH / 2);
    for (let k = 1; k <= 12; k++) {
      const m = byKey.get(`${y}-${k}`);
      const cx = x0 + (k - 1) * (cellW + gap);
      if (!m) {
        ctx.strokeStyle = "#d8ddd9";
        ctx.setLineDash([2, 2]);
        ctx.strokeRect(cx + 0.5, ry + 0.5, cellW - 1, rowH - 1);
        ctx.setLineDash([]);
        continue;
      }
      const bg = fill(m);
      ctx.globalAlpha = m.partial ? 0.65 : 1;
      ctx.fillStyle = bg;
      ctx.fillRect(cx, ry, cellW, rowH);
      ctx.globalAlpha = 1;
      if (m.provisional || m.partial) {
        ctx.strokeStyle = INK;
        ctx.setLineDash([3, 2]);
        ctx.strokeRect(cx + 1, ry + 1, cellW - 2, rowH - 2);
        ctx.setLineDash([]);
      }
      if (m.harmonized >= 0.5) {
        ctx.fillStyle = inkOn(bg);
        ctx.textAlign = "center";
        ctx.font = `${m.era === "snpp" || m.era === "noaa20" ? "" : "italic "}11px ${FONT()}`;
        ctx.fillText(fmt(m.harmonized), cx + cellW / 2, ry + rowH / 2 + 0.5);
      }
    }
    ctx.textAlign = "left";
    ctx.fillStyle = INK;
    ctx.font = `11px ${FONT()}`;
    const t = totals.get(y);
    ctx.fillText(t === undefined ? "partial" : fmt(t), x0 + 12 * (cellW + gap) + 6, ry + rowH / 2);
  });

  // median row
  const my = rowY(years.length) + 6;
  ctx.textAlign = "right";
  ctx.fillStyle = MUTED;
  ctx.fillText("Median", x0 - 8, my + rowH / 2);
  cal.climatology.forEach((cl, i) => {
    const cx = x0 + i * (cellW + gap);
    const bg = mode === "count" ? heatColor(cl.median, sc) : ZERO;
    ctx.fillStyle = bg;
    ctx.fillRect(cx, my, cellW, rowH);
    ctx.fillStyle = inkOn(bg);
    ctx.textAlign = "center";
    ctx.fillText(fmt(cl.median), cx + cellW / 2, my + rowH / 2 + 0.5);
  });
  ctx.textAlign = "left";
  ctx.fillStyle = INK;
  ctx.fillText(fmt(cal.year_median), x0 + 12 * (cellW + gap) + 6, my + rowH / 2);

  // legend
  const ly = my + rowH + 20;
  const colors = mode === "count" ? [ZERO, ...HEAT] : DIVERGE;
  const labels = mode === "count" ? ["0", ...heatBreaks(sc).map((b) => `≤${fmt(b)}`)] : DIVERGE_LABELS;
  ctx.fillStyle = MUTED;
  ctx.fillText(mode === "count" ? "Hotspots in the month (log steps)" : "Against the median for that month", pad, ly);
  colors.forEach((col, i) => {
    const lx = pad + i * 48;
    ctx.fillStyle = col;
    ctx.fillRect(lx, ly + 10, 46, 10);
    ctx.fillStyle = MUTED;
    ctx.textAlign = "center";
    ctx.fillText(labels[i], lx + 23, ly + 30);
    ctx.textAlign = "left";
  });
  footer(ctx, h, pad);
  await savePng(c, `firerosetta_${slug(label)}_calendar_${mode}.png`);
}

const STYLE_PROPS = ["fill", "stroke", "stroke-width", "stroke-dasharray", "opacity", "fill-opacity", "font-size",
  "font-weight", "text-anchor", "dominant-baseline"];

async function rasterize(svg: SVGSVGElement) {
  const { width, height } = svg.getBoundingClientRect();
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const src = [svg, ...svg.querySelectorAll("*")];
  const dst = [clone, ...clone.querySelectorAll("*")];
  src.forEach((el, i) => {
    const cs = getComputedStyle(el);
    (dst[i] as SVGElement).setAttribute("style", STYLE_PROPS.map((p) => `${p}:${cs.getPropertyValue(p)}`).join(";")
      + `;font-family:${cs.fontFamily}`);
  });
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = rej; img.src = url; });
    return { img, width, height };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Rasterizes an on-page SVG chart, resolving CSS variables so colors survive outside the page.
 * `key` is the chart's HTML legend (items of swatch svg + label), redrawn under the title.
 */
export async function svgPng(svg: SVGSVGElement, key: HTMLElement | null, title: string, sub: string, name: string) {
  const chart = await rasterize(svg);
  const items = key
    ? await Promise.all([...key.querySelectorAll("li")].map(async (li) => {
      const sw = li.querySelector("svg");
      return { swatch: sw ? await rasterize(sw) : null, label: li.textContent?.trim() ?? "" };
    }))
    : [];
  const pad = 24;
  const w = Math.max(chart.width + pad * 2, 520);

  // lay legend items out in rows before sizing the canvas
  const measure = document.createElement("canvas").getContext("2d")!;
  measure.font = `12px ${FONT()}`;
  const placed: { x: number; row: number; item: (typeof items)[number] }[] = [];
  let x = pad, row = 0;
  for (const it of items) {
    const iw = 24 + measure.measureText(it.label).width + 18;
    if (x + iw > w - pad && x > pad) { x = pad; row++; }
    placed.push({ x, row, item: it });
    x += iw;
  }
  const keyH = items.length ? (row + 1) * 20 + 6 : 0;
  const top = pad + 56;
  const h = top + keyH + chart.height + 20 + pad;
  const { c, ctx } = canvas(w, h);
  header(ctx, title, sub, w, pad);
  ctx.font = `12px ${FONT()}`;
  ctx.textBaseline = "middle";
  for (const { x, row, item } of placed) {
    const cy = top + row * 20 + 7;
    if (item.swatch) ctx.drawImage(item.swatch.img, x, cy - 5, 18, 10);
    ctx.fillStyle = MUTED;
    ctx.fillText(item.label, x + 24, cy);
  }
  ctx.drawImage(chart.img, pad, top + keyH, chart.width, chart.height);
  ctx.textBaseline = "alphabetic";
  footer(ctx, h, pad);
  await savePng(c, name);
}
