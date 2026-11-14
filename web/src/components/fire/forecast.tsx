"use client";

import { useState } from "react";

import type { Forecast, LeadForecast, WarnLevel } from "@/lib/api";
import { fmt, full, MONTHS_LONG, niceMax } from "@/lib/scale";

import { useWidth } from "./use-size";

const M = { top: 12, right: 16, bottom: 26, left: 44 };
const H = 230;

const LEVEL: Record<WarnLevel, { label: string; fill: string; ink: string }> = {
  normal: { label: "Normal", fill: "var(--muted)", ink: "var(--muted-foreground)" },
  watch: { label: "Watch", fill: "#f9d79f", ink: "#5a3b0b" },
  elevated: { label: "Elevated", fill: "#ee933c", ink: "#3d1b06" },
  high: { label: "High", fill: "#bd4416", ink: "#ffffff" },
};

const monthLabel = (m: string) => {
  const [y, mo] = m.split("-").map(Number);
  return `${MONTHS_LONG[mo - 1]} ${y}`;
};

/** One lead time: how much is expected, how that compares to normal, and the warning. */
function LeadCard({ f }: { f: LeadForecast }) {
  const lv = LEVEL[f.level];
  return (
    <div className="rounded-lg border bg-background p-3.5">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[13px] font-semibold">{monthLabel(f.target_month)}</p>
        <span className="text-[11px] text-muted-foreground">
          +{f.lead} {f.lead === 1 ? "month" : "months"}
        </span>
      </div>
      <p className="num mt-2 text-[26px] leading-none font-semibold">{full(f.expected)}</p>
      <p className="num mt-1 text-xs text-muted-foreground">
        hotspots expected
        {f.lo !== null && f.hi !== null && ` · 80% range ${full(f.lo)}–${full(f.hi)}`}
      </p>
      <p className="num mt-2 text-xs">
        Usually {full(f.normal)}
        {f.ratio !== null && (
          <span className={f.ratio >= 1.25 ? "font-semibold" : ""}>
            {" "}· {f.ratio.toFixed(1)}× normal
          </span>
        )}
      </p>
      <div
        className="mt-3 flex items-center justify-between rounded-md px-2.5 py-1.5"
        style={{ background: lv.fill, color: lv.ink }}
      >
        <span className="text-xs font-semibold">{lv.label}</span>
        <span className="num text-xs">{Math.round(f.warn_prob * 100)}%</span>
      </div>
    </div>
  );
}

/** Hindcast against what actually happened, on years the model never trained on. */
function BacktestChart({ data }: { data: Forecast }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const rows = data.backtest;
  if (!rows.length || width < 10) return <div ref={ref} style={{ height: H }} />;

  const max = niceMax(Math.max(...rows.map((r) => Math.max(r.actual, r.pred, r.normal)), 1));
  const iw = width - M.left - M.right;
  const x = (i: number) => M.left + (iw * (i + 0.5)) / rows.length;
  const y = (v: number) => M.top + (H - M.top - M.bottom) * (1 - v / max);
  const path = (pick: (r: (typeof rows)[number]) => number) =>
    rows.map((r, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(pick(r)).toFixed(1)}`).join("");
  const years = rows
    .map((r, i) => ({ i, y: r.month.slice(0, 4) }))
    .filter((d, k, a) => k === 0 || d.y !== a[k - 1].y);
  const h = hover === null ? null : rows[hover];

  return (
    <div>
      <ul data-chart-key className="mb-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {[
          { label: "What actually burned", color: "var(--series-viirs)", dash: "" },
          { label: "Forecast, one month ahead", color: "var(--series-model)", dash: "" },
          { label: "Normal for the month", color: "var(--axis)", dash: "3 3" },
        ].map((i) => (
          <li key={i.label} className="flex items-center gap-1.5">
            <svg width="18" height="10" aria-hidden>
              <line x1="0" x2="18" y1="5" y2="5" stroke={i.color} strokeWidth="2" strokeDasharray={i.dash} />
            </svg>
            {i.label}
          </li>
        ))}
      </ul>
      <div ref={ref} className="relative" onMouseLeave={() => setHover(null)}>
        <svg
          role="img"
          aria-label="Forecast against what actually burned, on held-out years"
          width="100%"
          height={H}
          viewBox={`0 0 ${width} ${H}`}
        >
          {[0, 0.25, 0.5, 0.75, 1].map((t) => (
            <g key={t}>
              <line x1={M.left} x2={width - M.right} y1={y(max * t)} y2={y(max * t)} stroke="var(--grid)" />
              <text x={M.left - 6} y={y(max * t) + 3.5} textAnchor="end" fontSize={11} fill="var(--axis)" className="num">
                {fmt(max * t)}
              </text>
            </g>
          ))}
          {years.map((d) => (
            <text key={d.y} x={x(d.i)} y={H - 8} textAnchor="middle" fontSize={11} fill="var(--axis)" className="num">
              {d.y}
            </text>
          ))}
          <path d={path((r) => r.normal)} fill="none" stroke="var(--axis)" strokeWidth="1.5" strokeDasharray="3 3" />
          <path d={path((r) => r.actual)} fill="none" stroke="var(--series-viirs)" strokeWidth="1.75" />
          <path d={path((r) => r.pred)} fill="none" stroke="var(--series-model)" strokeWidth="1.75" />
          {hover !== null && (
            <line x1={x(hover)} x2={x(hover)} y1={M.top} y2={H - M.bottom} stroke="var(--foreground)" strokeWidth="0.75" />
          )}
          <rect
            x={M.left}
            y={M.top}
            width={Math.max(iw, 0)}
            height={H - M.top - M.bottom}
            fill="transparent"
            onMouseMove={(e) => {
              const box = e.currentTarget.getBoundingClientRect();
              const t = (e.clientX - box.left) / box.width;
              setHover(Math.min(rows.length - 1, Math.max(0, Math.floor(t * rows.length))));
            }}
          />
        </svg>
        {h && (
          <div
            className="pointer-events-none absolute top-1 z-10 w-48 rounded-md border bg-popover p-2.5 text-xs shadow-md"
            style={x(hover!) > width / 2 ? { right: width - x(hover!) + 12 } : { left: x(hover!) + 12 }}
          >
            <p className="font-semibold">{monthLabel(h.month)}</p>
            <dl className="num mt-1 space-y-0.5">
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">Actual</dt><dd>{full(h.actual)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">Forecast</dt><dd>{full(h.pred)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">Normal</dt><dd>{full(h.normal)}</dd>
              </div>
            </dl>
          </div>
        )}
      </div>
    </div>
  );
}

export function ForecastView({ data, label }: { data: Forecast; label: string }) {
  const s1 = data.skill["1"];
  const beatsClim = s1?.r2 !== null && s1?.clim_r2 !== null && s1 !== undefined
    ? s1.r2! - s1.clim_r2!
    : null;
  const weatherAdds = s1?.r2 !== null && s1?.hist_only_r2 !== null && s1 !== undefined
    ? s1.r2! - s1.hist_only_r2!
    : null;
  const top = data.leads.reduce((a, b) => (b.warn_prob > a.warn_prob ? b : a), data.leads[0]);

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-lg border bg-card p-4 sm:p-5">
        <p className="text-sm text-muted-foreground">
          {label} · {data.area.blocks} forecast {data.area.blocks === 1 ? "block" : "blocks"} ·
          model given data through {monthLabel(data.basis_month)}
        </p>
        <h1 className="display mt-1 max-w-[34ch] text-[26px] leading-[1.15] sm:text-[30px]">
          {top.level === "normal"
            ? `No unusual fire month expected through ${monthLabel(data.leads.at(-1)!.target_month)}.`
            : `${LEVEL[top.level].label} fire risk for ${monthLabel(top.target_month)}.`}
        </h1>
        <p className="mt-2 max-w-[70ch] text-sm leading-relaxed">
          Each month is forecast from fire history and antecedent weather (how hot, dry and windy it has
          been) up to {monthLabel(data.basis_month)} — never from weather in the month being predicted.
          A warning means the model expects more than twice this area&apos;s normal burning for that
          calendar month, and at least 10 hotspots.
        </p>

        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {data.leads.map((f) => <LeadCard key={f.lead} f={f} />)}
        </div>
      </section>

      <section className="rounded-lg border bg-card p-4 sm:p-5">
        <h2 className="text-[15px] font-semibold">Did it work on years it never saw?</h2>
        <p className="mt-0.5 max-w-[72ch] text-sm text-muted-foreground">
          {s1
            ? `Every point is a one-month-ahead forecast made by a model trained only on earlier years. ` +
              `Over ${s1.n_months} such months in this area the error is ${Math.round(s1.wape ?? 0)}% of all ` +
              `hotspots (R² ${s1.r2?.toFixed(2)}), against R² ${s1.clim_r2?.toFixed(2)} for simply assuming ` +
              `a normal month.` +
              (weatherAdds !== null
                ? ` Dropping the weather inputs costs ${Math.abs(weatherAdds).toFixed(2)} R², so weather ` +
                  `${weatherAdds > 0.01 ? "is carrying real signal here" : "adds little in this area"}.`
                : "")
            : "This area has too few held-out months to measure skill; read the forecast as indicative."}
        </p>
        <div className="mt-4">
          <BacktestChart data={data} />
        </div>
        {beatsClim !== null && beatsClim <= 0 && (
          <p className="mt-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs">
            In this area the model does not beat a plain climatology. Treat these numbers as a seasonal
            expectation rather than a forecast — small areas and rare-fire regions are the hard case.
          </p>
        )}
      </section>

      <section className="rounded-lg border bg-card p-4 sm:p-5">
        <h2 className="text-[15px] font-semibold">How this forecast is made</h2>
        <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
          {[
            ["Unit", data.model.unit],
            ["Validation", data.model.cv],
            ["Warning", data.model.warning_definition],
            ["Weather", data.model.weather_source],
            ["Trained", data.model.trained_at.slice(0, 10)],
          ].map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="font-medium text-muted-foreground">{k}</dt>
              <dd className="max-w-[70ch]">{v}</dd>
            </div>
          ))}
        </dl>
        {data.model.base_rate !== null && (
          <p className="mt-3 text-xs text-muted-foreground num">
            Anomalous months are {(data.model.base_rate * 100).toFixed(1)}% of all block-months, so a
            warning probability well above that is the signal worth acting on.
          </p>
        )}
      </section>
    </div>
  );
}
