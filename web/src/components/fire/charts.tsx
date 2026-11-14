"use client";

import { useState } from "react";

import type { Calendar } from "@/lib/api";
import { fmt, full, MONTHS, MONTHS_LONG, niceMax } from "@/lib/scale";

import { useWidth } from "./use-size";

const M = { top: 12, right: 16, bottom: 24, left: 44 };
const H = 220;

function YAxis({ max, y, width }: { max: number; y: (v: number) => number; width: number }) {
  return (
    <g>
      {[0, 0.25, 0.5, 0.75, 1].map((t) => (
        <g key={t}>
          <line x1={M.left} x2={width - M.right} y1={y(max * t)} y2={y(max * t)} stroke="var(--grid)" />
          <text x={M.left - 6} y={y(max * t) + 3.5} textAnchor="end" fontSize={11} fill="var(--axis)" className="num">
            {fmt(max * t)}
          </text>
        </g>
      ))}
    </g>
  );
}

function Tip({ x, width, children }: { x: number; width: number; children: React.ReactNode }) {
  const left = x > width / 2;
  return (
    <div
      className="pointer-events-none absolute top-1 z-10 w-52 rounded-md border bg-popover p-2.5 text-xs shadow-md"
      style={left ? { right: width - x + 12 } : { left: x + 12 }}
    >
      {children}
    </div>
  );
}

function Key({ items }: { items: { label: string; swatch: React.ReactNode }[] }) {
  return (
    <ul data-chart-key className="mb-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5">
          <svg width="18" height="10" aria-hidden>{i.swatch}</svg>
          {i.label}
        </li>
      ))}
    </ul>
  );
}

/** One year's months against the typical season for the area. */
export function SeasonChart({ data, year }: { data: Calendar; year: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const rows = data.months.filter((r) => r.year === year);
  const value = (i: number) => rows.find((r) => r.moy === i + 1)?.harmonized;
  const max = niceMax(Math.max(...data.climatology.map((c) => c.p90), ...rows.map((r) => r.harmonized)));
  const iw = width - M.left - M.right;
  const x = (i: number) => M.left + (iw * (i + 0.5)) / 12;
  const y = (v: number) => M.top + (H - M.top - M.bottom) * (1 - v / max);
  const band =
    data.climatology.map((c, i) => `${i ? "L" : "M"}${x(i)},${y(c.p90)}`).join("") +
    data.climatology.toReversed().map((c, i) => `L${x(11 - i)},${y(c.p10)}`).join("") + "Z";
  const median = data.climatology.map((c, i) => `${i ? "L" : "M"}${x(i)},${y(c.median)}`).join("");
  const seen = MONTHS.map((_, i) => i).filter((i) => value(i) !== undefined);
  const line = seen.map((i, k) => `${k ? "L" : "M"}${x(i)},${y(value(i)!)}`).join("");

  return (
    <div>
      <Key
        items={[
          { label: `${year}`, swatch: <line x1="0" x2="18" y1="5" y2="5" stroke="var(--series-viirs)" strokeWidth="2" /> },
          { label: "Median month", swatch: <line x1="0" x2="18" y1="5" y2="5" stroke="var(--foreground)" strokeWidth="1.5" strokeDasharray="3 3" /> },
          { label: "Usual range (10th to 90th percentile)", swatch: <rect width="18" height="10" rx="2" fill="var(--muted)" /> },
        ]}
      />
      <div ref={ref} className="relative" onMouseLeave={() => setHover(null)}>
        <svg
          width={width}
          height={H}
          role="img"
          aria-label={`Monthly hotspots in ${year} compared with the typical season`}
          onMouseMove={(e) => {
            const px = e.clientX - e.currentTarget.getBoundingClientRect().left;
            setHover(Math.min(11, Math.max(0, Math.floor(((px - M.left) / iw) * 12))));
          }}
        >
          <YAxis max={max} y={y} width={width} />
          <path d={band} fill="var(--muted)" />
          <path d={median} fill="none" stroke="var(--foreground)" strokeWidth={1.5} strokeDasharray="3 3" />
          <path d={line} fill="none" stroke="var(--series-viirs)" strokeWidth={2} strokeLinejoin="round" />
          {seen.map((i) => (
            <circle key={i} cx={x(i)} cy={y(value(i)!)} r={hover === i ? 4.5 : 3} fill="var(--series-viirs)" stroke="var(--card)" strokeWidth={2} />
          ))}
          {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={M.top} y2={H - M.bottom} stroke="var(--axis)" strokeDasharray="2 3" />}
          {MONTHS.map((m, i) => (
            <text key={m} x={x(i)} y={H - 7} textAnchor="middle" fontSize={11} fill="var(--axis)">{m}</text>
          ))}
        </svg>
        {hover !== null && (
          <Tip x={x(hover)} width={width}>
            <p className="font-semibold">{MONTHS_LONG[hover]} {year}</p>
            <dl className="mt-1 grid grid-cols-[1fr_auto] gap-x-3 num">
              <dt>{year}</dt>
              <dd className="text-right font-semibold">{value(hover) === undefined ? "no data" : full(value(hover)!)}</dd>
              <dt>Median</dt>
              <dd className="text-right">{full(data.climatology[hover].median)}</dd>
              <dt>Usual range</dt>
              <dd className="text-right">{full(data.climatology[hover].p10)} to {full(data.climatology[hover].p90)}</dd>
            </dl>
          </Tip>
        )}
      </div>
    </div>
  );
}

/** Yearly totals: the harmonized record next to what MODIS alone reported. */
export function YearChart({ data, year, onSelectYear }: { data: Calendar; year: number; onSelectYear: (y: number) => void }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const ys = data.years;
  const max = niceMax(Math.max(...ys.map((r) => r.total)));
  const iw = width - M.left - M.right;
  const step = iw / ys.length;
  const bw = Math.max(3, Math.min(22, step - 2));
  const x = (i: number) => M.left + step * (i + 0.5);
  const y = (v: number) => M.top + (H - M.top - M.bottom) * (1 - Math.min(v, max) / max);
  const observed = (yr: number) => yr >= 2013; // first full S-NPP year
  const modis = ys.map((r, i) => `${i ? "L" : "M"}${x(i)},${y(r.modis)}`).join("");
  const h = hover === null ? null : ys[hover];

  return (
    <div>
      <Key
        items={[
          { label: "Observed by VIIRS", swatch: <rect width="12" height="10" rx="2" fill="var(--series-viirs)" /> },
          { label: "Estimated from MODIS, VIIRS scale", swatch: <rect width="12" height="10" rx="2" fill="var(--series-model)" /> },
          { label: "MODIS as detected", swatch: <line x1="0" x2="18" y1="5" y2="5" stroke="var(--series-modis)" strokeWidth="2" /> },
          { label: "Median year", swatch: <line x1="0" x2="18" y1="5" y2="5" stroke="var(--foreground)" strokeWidth="1.5" strokeDasharray="3 3" /> },
        ]}
      />
      <div ref={ref} className="relative" onMouseLeave={() => setHover(null)}>
        <svg
          width={width}
          height={H}
          role="img"
          aria-label="Hotspots per year, harmonized, compared with raw MODIS counts"
          onMouseMove={(e) => {
            const px = e.clientX - e.currentTarget.getBoundingClientRect().left;
            setHover(Math.min(ys.length - 1, Math.max(0, Math.floor((px - M.left) / step))));
          }}
          onClick={() => h && onSelectYear(h.year)}
          className="cursor-pointer"
        >
          <YAxis max={max} y={y} width={width} />
          {ys.map((r, i) => {
            const top = y(r.total);
            const base = y(0);
            const rad = Math.min(4, bw / 2, base - top);
            return (
              <g key={r.year}>
                <path
                  d={`M${x(i) - bw / 2},${base}V${top + rad}q0,${-rad} ${rad},${-rad}h${bw - 2 * rad}q${rad},0 ${rad},${rad}V${base}Z`}
                  fill={observed(r.year) ? "var(--series-viirs)" : "var(--series-model)"}
                  opacity={hover === null || hover === i ? 1 : 0.55}
                />
                {r.year === year && <rect x={x(i) - bw / 2 - 2} y={base + 2} width={bw + 4} height={2} fill="var(--foreground)" />}
              </g>
            );
          })}
          <line x1={M.left} x2={width - M.right} y1={y(data.year_median)} y2={y(data.year_median)} stroke="var(--foreground)" strokeWidth={1.5} strokeDasharray="3 3" />
          <path d={modis} fill="none" stroke="var(--series-modis)" strokeWidth={2} strokeLinejoin="round" />
          {ys.map((r, i) =>
            i % (ys.length > 16 && width < 520 ? 4 : 2) === 0 ? (
              <text key={r.year} x={x(i)} y={H - 7} textAnchor="middle" fontSize={11} fill="var(--axis)" className="num">
                {r.year}
              </text>
            ) : null,
          )}
        </svg>
        {h && hover !== null && (
          <Tip x={x(hover)} width={width}>
            <p className="font-semibold">{h.year}</p>
            <dl className="mt-1 grid grid-cols-[1fr_auto] gap-x-3 num">
              <dt>{observed(h.year) ? "VIIRS observed" : "Harmonized estimate"}</dt>
              <dd className="text-right font-semibold">{full(h.total)}</dd>
              {h.lo !== h.hi && (
                <>
                  <dt>Cautious range</dt>
                  <dd className="text-right">{fmt(h.lo)} to {fmt(h.hi)}</dd>
                </>
              )}
              <dt>MODIS as detected</dt>
              <dd className="text-right">{full(h.modis)}</dd>
              <dt>Against median year</dt>
              <dd className="text-right">{h.anomaly_pct === null ? "n/a" : `${h.anomaly_pct > 0 ? "+" : ""}${Math.round(h.anomaly_pct)}%`}</dd>
              <dt>Rank</dt>
              <dd className="text-right">{h.rank} of {ys.length}</dd>
            </dl>
          </Tip>
        )}
      </div>
    </div>
  );
}

/** The honesty check: on months where VIIRS exists, how close does the MODIS-based estimate get? */
export function SkillChart({ data }: { data: Calendar }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const rows = data.months.filter((r) => r.oof !== null);
  const max = niceMax(Math.max(...rows.map((r) => Math.max(r.snpp, r.oof ?? 0))));
  const iw = width - M.left - M.right;
  const x = (i: number) => M.left + (iw * i) / Math.max(1, rows.length - 1);
  const y = (v: number) => M.top + (H - M.top - M.bottom) * (1 - Math.min(v, max) / max);
  const path = (get: (r: (typeof rows)[number]) => number) =>
    rows.map((r, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(get(r)).toFixed(1)}`).join("");
  const h = hover === null ? null : rows[hover];

  return (
    <div>
      <Key
        items={[
          { label: "VIIRS observed", swatch: <line x1="0" x2="18" y1="5" y2="5" stroke="var(--series-viirs)" strokeWidth="2" /> },
          { label: "Estimate from MODIS (year held out)", swatch: <line x1="0" x2="18" y1="5" y2="5" stroke="var(--series-model)" strokeWidth="2" /> },
          { label: "MODIS as detected", swatch: <line x1="0" x2="18" y1="5" y2="5" stroke="var(--series-modis)" strokeWidth="2" /> },
        ]}
      />
      <div ref={ref} className="relative" onMouseLeave={() => setHover(null)}>
        <svg
          width={width}
          height={H}
          role="img"
          aria-label="VIIRS observations compared with the estimate made from MODIS, 2012 onwards"
          onMouseMove={(e) => {
            const px = e.clientX - e.currentTarget.getBoundingClientRect().left;
            setHover(Math.min(rows.length - 1, Math.max(0, Math.round(((px - M.left) / iw) * (rows.length - 1)))));
          }}
        >
          <YAxis max={max} y={y} width={width} />
          <path d={path((r) => r.modis)} fill="none" stroke="var(--series-modis)" strokeWidth={2} strokeLinejoin="round" />
          <path d={path((r) => r.snpp)} fill="none" stroke="var(--series-viirs)" strokeWidth={2} strokeLinejoin="round" />
          <path d={path((r) => r.oof ?? 0)} fill="none" stroke="var(--series-model)" strokeWidth={2} strokeLinejoin="round" />
          {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={M.top} y2={H - M.bottom} stroke="var(--axis)" strokeDasharray="2 3" />}
          {rows.map((r, i) =>
            r.moy === 1 && r.year % 2 === 0 ? (
              <text key={r.month} x={x(i)} y={H - 7} textAnchor="middle" fontSize={11} fill="var(--axis)" className="num">
                {r.year}
              </text>
            ) : null,
          )}
        </svg>
        {h && hover !== null && (
          <Tip x={x(hover)} width={width}>
            <p className="font-semibold">{MONTHS_LONG[h.moy - 1]} {h.year}</p>
            <dl className="mt-1 grid grid-cols-[1fr_auto] gap-x-3 num">
              <dt>VIIRS observed</dt>
              <dd className="text-right font-semibold">{full(h.snpp)}</dd>
              <dt>Estimate from MODIS</dt>
              <dd className="text-right">{full(h.oof ?? 0)}</dd>
              <dt>MODIS as detected</dt>
              <dd className="text-right">{full(h.modis)}</dd>
            </dl>
          </Tip>
        )}
      </div>
    </div>
  );
}
