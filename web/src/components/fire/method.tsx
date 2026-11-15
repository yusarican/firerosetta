"use client";

import { useEffect, useState } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getValidation, type Validation } from "@/lib/api";
import { fmt, full } from "@/lib/scale";

import { useWidth } from "./use-size";
import { AppHeader } from "./app-header";

const SCALES: [string, string][] = [
  ["block1deg_month", "1° × 1° block, one month"],
  ["country_month", "Whole country, one month"],
  ["country_year", "Whole country, one year"],
];

const ERAS = [
  { from: 2000.83, to: 2002.5, label: "Terra only", how: "estimated", color: "var(--series-model)" },
  { from: 2002.5, to: 2012.08, label: "Terra + Aqua", how: "estimated", color: "var(--series-model)" },
  { from: 2012.08, to: 2026.83, label: "S-NPP VIIRS", how: "observed", color: "var(--series-viirs)" },
  { from: 2026.83, to: 2027.4, label: "NOAA-20", how: "scaled", color: "var(--series-viirs)" },
];

export function Method() {
  const [v, setV] = useState<Validation | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    getValidation().then(setV).catch((e) => setError(e.message));
  }, []);

  return (
    <div className="mx-auto w-full max-w-[980px] px-4 pb-20 sm:px-6">
      <AppHeader active="method" />

      <h1 className="display mt-6 max-w-[24ch] text-[34px] leading-[1.1]">
        Two sensors counted the same fires differently. We put both on one ruler.
      </h1>
      <div className="mt-5 max-w-[68ch] space-y-3 text-[15px] leading-relaxed">
        <p>
          MODIS sees the ground in 1 km pixels and VIIRS in 375 m pixels. One fire front is a handful of MODIS hotspots
          and several times as many VIIRS hotspots, and VIIRS also catches small fires MODIS never sees. Put the two
          records end to end and fire activity appears to triple in 2012. It did not.
        </p>
        <p>
          The ruler is the S-NPP VIIRS count. For the years both sensors flew together we learn what VIIRS reports
          given what MODIS reported, then apply that to the MODIS-only years. Every figure before 2012 is therefore
          an estimate of what VIIRS would have counted, and it carries a range.
        </p>
      </div>

      {error && <p role="alert" className="mt-6 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">{error}</p>}
      {!v && !error && <Skeleton className="mt-8 h-96 rounded-lg" />}

      {v && (
        <>
          <Section title="Four stretches of record, one scale">
            <Timeline />
            <ol className="mt-5 max-w-[72ch] list-decimal space-y-2 pl-5 text-sm leading-relaxed">
              <li>
                <b>Same quality screen for every sensor.</b> Only detections typed as vegetation fire, at nominal or high
                confidence. This matters more than it sounds: VIIRS flags static industrial heat sources far more often
                than MODIS does (around a quarter of VIIRS detections in Türkiye and Italy), so unscreened counts
                inflate the VIIRS years on their own.
              </li>
              <li>
                <b>Same grid.</b> Hotspots are counted per {v.grid_deg}° cell per month, including the zeros.
              </li>
              <li>
                <b>MODIS to VIIRS.</b> Gradient-boosted trees predict the VIIRS count of a cell-month from the MODIS
                count, its Terra/Aqua and day/night split, radiative power, MODIS activity in neighbouring cells, the
                cell&apos;s long-run MODIS climatology, season and location. A second model uses Terra alone for the
                months before Aqua. Trained on {full(v.train_rows)} cell-months.
              </li>
              <li>
                <b>NOAA-20 to S-NPP.</b> S-NPP stopped delivering fire data on 2 November 2026. NOAA-20 carries the same
                instrument, and over {v.noaa20_link.overlap[0].slice(0, 4)} to {v.noaa20_link.overlap[1].slice(0, 4)} its
                counts are {v.noaa20_link.k.toFixed(3)}× S-NPP&apos;s, so the record continues with that factor
                (country-month difference {v.noaa20_link.country_month_wape}%).
              </li>
            </ol>
          </Section>

          <Section
            title="Tested on years the model never saw"
            note={`${v.cv}. Each year from ${v.overlap[0].slice(0, 4)} to ${v.overlap[1].slice(0, 4)} is predicted by a model trained on the other years, then compared with what VIIRS observed. Error is total absolute error as a share of total observed hotspots.`}
          >
            <Table className="num">
              <TableHeader>
                <TableRow>
                  <TableHead>Compared at</TableHead>
                  <TableHead className="text-right">MODIS as detected</TableHead>
                  <TableHead className="text-right">One global factor</TableHead>
                  <TableHead className="text-right">Model, Terra only</TableHead>
                  <TableHead className="text-right">Model, Terra + Aqua</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {SCALES.map(([k, label]) => {
                  const s = v.scales[k];
                  return (
                    <TableRow key={k}>
                      <TableCell>{label}</TableCell>
                      <TableCell className="text-right">{s.raw_modis.wape.toFixed(0)}%</TableCell>
                      <TableCell className="text-right">{s.global_ratio.wape.toFixed(0)}%</TableCell>
                      <TableCell className="text-right">{s.model_terra.wape.toFixed(0)}%</TableCell>
                      <TableCell className="text-right font-semibold">{s.model_full.wape.toFixed(0)}%</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            <div className="mt-6">
              <Scatter v={v} />
            </div>
          </Section>

          <Section title="By country" note="1° blocks are the size of a province; small areas are harder than whole countries because a single missed fire weighs more.">
            <Table className="num">
              <TableHeader>
                <TableRow>
                  <TableHead>Country</TableHead>
                  <TableHead className="text-right">1° block-month, raw</TableHead>
                  <TableHead className="text-right">1° block-month, model</TableHead>
                  <TableHead className="text-right">Country-month, model</TableHead>
                  <TableHead className="text-right">Model bias</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {Object.entries(v.per_country).map(([c, s]) => (
                  <TableRow key={c}>
                    <TableCell>{c}</TableCell>
                    <TableCell className="text-right">{s.raw_modis.wape.toFixed(0)}%</TableCell>
                    <TableCell className="text-right">{s.model_full.wape.toFixed(0)}%</TableCell>
                    <TableCell className="text-right font-semibold">{s.country_month.model_full.wape.toFixed(0)}%</TableCell>
                    <TableCell className="text-right">{s.model_full.bias > 0 ? "+" : ""}{s.model_full.bias.toFixed(1)}%</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Section>

          <Section title="What this does not do">
            <ul className="max-w-[72ch] list-disc space-y-2 pl-5 text-sm leading-relaxed">
              <li>It counts hotspots, not fires, burned area or emissions. A long-burning fire is many hotspots.</li>
              <li>
                The model assumes the MODIS-to-VIIRS relationship of 2012 to 2025 held in 2000 to 2011. If small
                agricultural burning changed in a place, the early estimate there inherits today&apos;s pattern.
              </li>
              <li>
                Terra and Aqua have drifted from their original overpass times since about 2021, which changes what
                MODIS sees late in the overlap. The VIIRS-per-MODIS ratio by year is in the validation file for anyone
                who wants to check.
              </li>
              <li>Ranges on the calendar are the 5th to 95th percentile of the model&apos;s own errors in the selected area. Yearly ranges add up monthly ones and are deliberately wide.</li>
              <li>Cloud and smoke hide fires from both sensors; no correction is made for that.</li>
            </ul>
          </Section>
        </>
      )}
    </div>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="mt-12">
      <h2 className="display text-xl">{title}</h2>
      {note && <p className="mt-1.5 max-w-[72ch] text-sm text-muted-foreground">{note}</p>}
      <div className="mt-5">{children}</div>
    </section>
  );
}

function Timeline() {
  const [ref, width] = useWidth<HTMLDivElement>(900);
  const x = (yr: number) => ((yr - 2000.5) / (2027.5 - 2000.5)) * width;
  return (
    <div ref={ref}>
      <svg width={width} height={74} role="img" aria-label="Which sensor supplies each part of the record">
        {ERAS.map((e) => (
          <g key={e.label}>
            <rect x={x(e.from) + 1} y={22} width={Math.max(4, x(e.to) - x(e.from) - 2)} height={18} rx={4} fill={e.color} />
            {x(e.to) - x(e.from) > 70 && (
              <text x={x(e.from) + 4} y={15} fontSize={12} fill="var(--foreground)">
                {e.label}, {e.how}
              </text>
            )}
          </g>
        ))}
        {[2000, 2005, 2010, 2015, 2020, 2025].map((yr) => (
          <text key={yr} x={x(yr + 0.5)} y={58} fontSize={11} textAnchor="middle" fill="var(--axis)" className="num">{yr}</text>
        ))}
      </svg>
      <p className="text-xs text-muted-foreground">
        Green: estimated from MODIS. Orange: counted by VIIRS. The short stretches at each end are Terra alone (2000 to mid-2002) and NOAA-20 (from November 2026).
      </p>
    </div>
  );
}

/** Observed vs predicted, log-log, country-months. */
function Scatter({ v }: { v: Validation }) {
  const [ref, width] = useWidth<HTMLDivElement>(900);
  const [hover, setHover] = useState<number | null>(null);
  const size = Math.min(width, 460);
  const pad = 44;
  const pts = v.scatter_country_month.filter((p) => p.obs > 0);
  const hi = Math.log10(Math.max(...pts.map((p) => Math.max(p.obs, p.full))) * 1.3);
  const s = (val: number) => pad + ((size - pad - 12) * Math.log10(Math.max(val, 1))) / hi;
  const X = (val: number) => s(val);
  const Y = (val: number) => size - s(val) + 12 - pad + pad;
  const ticks = [1, 10, 100, 1000, 10000, 100000].filter((t) => Math.log10(t) <= hi);
  const h = hover === null ? null : pts[hover];
  return (
    <div ref={ref} className="grid gap-6 sm:grid-cols-[auto_1fr]">
      <div className="relative" style={{ width: size }}>
        <svg width={size} height={size} role="img" aria-label="Observed VIIRS hotspots against estimates, per country and month"
          onMouseLeave={() => setHover(null)}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={X(t)} x2={X(t)} y1={Y(1)} y2={Y(10 ** hi)} stroke="var(--grid)" />
              <line x1={X(1)} x2={X(10 ** hi)} y1={Y(t)} y2={Y(t)} stroke="var(--grid)" />
              <text x={X(t)} y={size - 26} fontSize={11} textAnchor="middle" fill="var(--axis)" className="num">{fmt(t)}</text>
              <text x={pad - 6} y={Y(t) + 4} fontSize={11} textAnchor="end" fill="var(--axis)" className="num">{fmt(t)}</text>
            </g>
          ))}
          <line x1={X(1)} y1={Y(1)} x2={X(10 ** hi)} y2={Y(10 ** hi)} stroke="var(--foreground)" strokeDasharray="3 3" />
          {pts.map((p, i) => (
            <circle key={`r${i}`} cx={X(p.obs)} cy={Y(p.raw)} r={2.5} fill="var(--series-modis)" opacity={0.45} />
          ))}
          {pts.map((p, i) => (
            <circle key={`m${i}`} cx={X(p.obs)} cy={Y(p.full)} r={hover === i ? 5 : 2.5} fill="var(--series-model)"
              opacity={hover === null || hover === i ? 0.8 : 0.4} onMouseEnter={() => setHover(i)} />
          ))}
          <text x={(size + pad) / 2} y={size - 6} fontSize={12} textAnchor="middle" fill="var(--foreground)">VIIRS observed</text>
        </svg>
        {h && (
          <div className="pointer-events-none absolute left-14 top-2 rounded-md border bg-popover p-2 text-xs shadow-md num">
            <p className="font-semibold">{h.country}, {h.month}</p>
            <p>VIIRS observed {full(h.obs)}</p>
            <p>Estimate {full(h.full)}</p>
            <p>MODIS as detected {full(h.raw)}</p>
          </div>
        )}
      </div>
      <div className="max-w-[40ch] self-center text-sm leading-relaxed">
        <ul className="mb-3 space-y-1 text-xs text-muted-foreground">
          <li className="flex items-center gap-1.5"><span className="size-2.5 rounded-full" style={{ background: "var(--series-model)" }} /> Estimate from MODIS, year held out</li>
          <li className="flex items-center gap-1.5"><span className="size-2.5 rounded-full" style={{ background: "var(--series-modis)" }} /> MODIS as detected</li>
          <li className="flex items-center gap-1.5"><svg width="18" height="6"><line x1="0" x2="18" y1="3" y2="3" stroke="var(--foreground)" strokeDasharray="3 3" /></svg> Perfect agreement</li>
        </ul>
        <p>
          Each dot is one country in one month ({pts.length} of them), on log axes. Raw MODIS counts sit in a band below
          the line: consistently low, by a factor that changes with the size of the month. The estimates sit on it
          from about 200 hotspots a month upward. In very quiet months they run high, because the model keeps a small
          background of fires that MODIS cannot see; the vertical axis is the estimated or MODIS count.
        </p>
      </div>
    </div>
  );
}
