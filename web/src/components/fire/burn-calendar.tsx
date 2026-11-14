"use client";

import { useMemo, useState } from "react";

import type { Calendar, MonthRow } from "@/lib/api";
import {
  anomalyColor, DIVERGE, DIVERGE_LABELS, fmt, full, HEAT, heatBreaks, heatColor, type HeatScale, heatScale, inkOn,
  MONTHS, MONTHS_LONG, ZERO,
} from "@/lib/scale";

export type CalendarMode = "count" | "anomaly";

const ERA_TEXT: Record<MonthRow["era"], string> = {
  terra: "Estimated from MODIS Terra",
  modis: "Estimated from MODIS Terra + Aqua",
  snpp: "Observed by VIIRS (S-NPP)",
  noaa20: "Observed by VIIRS (NOAA-20), scaled to S-NPP",
};

export function BurnCalendar({
  data,
  mode,
  selected,
  onSelectMonth,
  onSelectYear,
}: {
  data: Calendar;
  mode: CalendarMode;
  selected: { start: string; end: string };
  onSelectMonth: (month: string) => void;
  onSelectYear: (year: number) => void;
}) {
  const [hover, setHover] = useState<{ row: MonthRow; x: number; y: number } | null>(null);

  const { byYear, years, max, yearMax } = useMemo(() => {
    const byYear = new Map<number, (MonthRow | undefined)[]>();
    for (const r of data.months) {
      if (!byYear.has(r.year)) byYear.set(r.year, Array(12).fill(undefined));
      byYear.get(r.year)![r.moy - 1] = r;
    }
    const totals = new Map(data.years.map((y) => [y.year, y]));
    return {
      byYear,
      years: [...byYear.keys()].sort((a, b) => b - a).map((y) => ({ year: y, stat: totals.get(y) })),
      max: heatScale(data.months.map((r) => r.harmonized)),
      yearMax: Math.max(...data.years.map((y) => y.total), 1),
    };
  }, [data]);

  const fill = (r: MonthRow) =>
    mode === "count" ? heatColor(r.harmonized, max) : anomalyColor(r.harmonized, r.median);
  const isSel = (r: MonthRow) => `${r.month}-01` >= selected.start && `${r.month}-01` <= selected.end;
  const firstObserved = years.findLast((y) => byYear.get(y.year)!.some((r) => r?.era === "snpp"))?.year;

  return (
    <div className="relative">
      <div
        role="grid"
        aria-label="Hotspots per month, by year"
        className="grid gap-[2px] text-[11px] num"
        style={{ gridTemplateColumns: "3.1rem repeat(12, minmax(0, 1fr)) minmax(4.5rem, 0.9fr)" }}
        onMouseLeave={() => setHover(null)}
      >
        <div />
        {MONTHS.map((m) => (
          <div key={m} className="pb-1 text-center text-muted-foreground">{m}</div>
        ))}
        <div className="pb-1 pl-2 text-muted-foreground">Year total</div>

        {years.map(({ year, stat }) => (
          <div key={year} role="row" className="contents">
            <button
              type="button"
              onClick={() => onSelectYear(year)}
              className="rounded-sm pr-2 text-right text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
              title={`Show ${year} on the map and in the season chart`}
            >
              {year}
            </button>
            {byYear.get(year)!.map((r, i) =>
              r ? (
                <button
                  key={i}
                  type="button"
                  role="gridcell"
                  aria-label={`${MONTHS_LONG[i]} ${year}: ${full(r.harmonized)} hotspots${r.partial ? ", month in progress" : r.provisional ? ", provisional" : ""}`}
                  onClick={() => onSelectMonth(r.month)}
                  onMouseEnter={(e) => {
                    const box = e.currentTarget.getBoundingClientRect();
                    const host = e.currentTarget.offsetParent!.getBoundingClientRect();
                    setHover({ row: r, x: box.left - host.left + box.width / 2, y: box.bottom - host.top });
                  }}
                  onFocus={() => setHover(null)}
                  className="h-[22px] rounded-[3px] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
                  style={{
                    background: fill(r),
                    color: inkOn(fill(r)),
                    fontStyle: r.era === "snpp" || r.era === "noaa20" ? "normal" : "italic",
                    boxShadow: isSel(r) ? "0 0 0 2px #15211d" : undefined,
                    outline: !isSel(r) && (r.provisional || r.partial) ? "1.5px dashed #15211d" : undefined,
                    outlineOffset: -2,
                    opacity: r.partial ? 0.65 : undefined,
                    position: isSel(r) ? "relative" : undefined,
                    zIndex: isSel(r) ? 1 : undefined,
                  }}
                >
                  {r.harmonized >= 0.5 ? fmt(r.harmonized) : ""}
                </button>
              ) : (
                <div key={i} className="h-[22px] rounded-[3px] border border-dashed border-border" />
              ),
            )}
            <div className="flex items-center gap-1.5 pl-2">
              {stat ? (
                <>
                  <div className="h-[10px] flex-1">
                    <div
                      className="h-full rounded-r-[3px] bg-foreground/70"
                      style={{ width: `${Math.max(2, (stat.total / yearMax) * 100)}%` }}
                    />
                  </div>
                  <span className="w-9 text-right">{fmt(stat.total)}</span>
                </>
              ) : (
                <span className="text-muted-foreground">partial</span>
              )}
            </div>
            {year === firstObserved && (
              <div className="col-span-full my-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                <span className="h-px flex-1 bg-border" />
                <span>
                  Above: observed by VIIRS. Below (italic): estimated from MODIS on the VIIRS scale.
                </span>
                <span className="h-px flex-1 bg-border" />
              </div>
            )}
          </div>
        ))}

        <div className="pt-1.5 pr-2 text-right text-muted-foreground">Median</div>
        {data.climatology.map((c) => {
          const bg = heatColor(c.median, max);
          return (
            <div
              key={c.moy}
              className="mt-1.5 flex h-[22px] items-center justify-center rounded-[3px]"
              style={{ background: mode === "count" ? bg : ZERO, color: mode === "count" ? inkOn(bg) : "#15211d" }}
              title={`Median ${MONTHS_LONG[c.moy - 1]}: ${full(c.median)} hotspots`}
            >
              {fmt(c.median)}
            </div>
          );
        })}
        <div className="pt-1.5 pl-2">{fmt(data.year_median)}</div>
      </div>

      <Legend mode={mode} max={max} />

      {hover && (
        <div
          role="status"
          className="pointer-events-none absolute z-20 w-60 -translate-x-1/2 rounded-md border bg-popover p-2.5 text-xs shadow-md"
          style={{ left: Math.min(Math.max(hover.x, 130), 9999), top: hover.y + 6 }}
        >
          <p className="font-semibold">
            {MONTHS_LONG[hover.row.moy - 1]} {hover.row.year}
          </p>
          <p className="mt-1 text-base font-semibold num">{full(hover.row.harmonized)} hotspots</p>
          {hover.row.lo !== hover.row.hi && (
            <p className="num text-muted-foreground">
              90% range {full(hover.row.lo)} to {full(hover.row.hi)}
            </p>
          )}
          <p className="mt-1.5 text-muted-foreground">{ERA_TEXT[hover.row.era]}</p>
          {hover.row.partial ? (
            <p className="mt-1 font-medium">Month in progress, so this count is not final.</p>
          ) : hover.row.provisional ? (
            <p className="mt-1 font-medium">Provisional: near-real-time data, replaced when the standard product is published.</p>
          ) : null}
          <dl className="mt-1.5 grid grid-cols-[1fr_auto] gap-x-3 num">
            <dt>Median {MONTHS[hover.row.moy - 1]}</dt>
            <dd className="text-right">{full(hover.row.median)}</dd>
            <dt>Rank among all {MONTHS[hover.row.moy - 1]}s</dt>
            <dd className="text-right">{Math.round(hover.row.pct)}th pct.</dd>
            <dt>MODIS as detected</dt>
            <dd className="text-right">{full(hover.row.modis)}</dd>
            {hover.row.snpp > 0 && (
              <>
                <dt>VIIRS S-NPP as detected</dt>
                <dd className="text-right">{full(hover.row.snpp)}</dd>
              </>
            )}
            {hover.row.era === "noaa20" && (
              <>
                <dt>VIIRS NOAA-20 as detected</dt>
                <dd className="text-right">{full(hover.row.noaa20)}</dd>
              </>
            )}
          </dl>
        </div>
      )}
    </div>
  );
}

function Legend({ mode, max }: { mode: CalendarMode; max: HeatScale }) {
  const breaks = heatBreaks(max);
  const colors = mode === "count" ? [ZERO, ...HEAT] : DIVERGE;
  const labels =
    mode === "count" ? ["0", ...breaks.map((b) => `≤${fmt(b)}`)] : DIVERGE_LABELS;
  return (
    <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
      <span>{mode === "count" ? "Hotspots in the month (log steps)" : "Compared with the median for that calendar month"}</span>
      <span className="flex items-center gap-1.5">
        <span className="block h-2.5 w-5 rounded-[2px] border-[1.5px] border-dashed border-foreground" />
        Provisional or month in progress
      </span>
      <div className="flex">
        {colors.map((c, i) => (
          <div key={c} className="flex flex-col items-center">
            <span className="block h-2.5 w-11 border-r-2 border-card" style={{ background: c }} />
            <span className="num mt-0.5">{labels[i]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
