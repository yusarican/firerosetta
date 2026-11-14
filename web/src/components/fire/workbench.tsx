"use client";

import Link from "next/link";
import { Download } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  type Area, type Calendar, downloadCsv, type Forecast, getCalendar, getForecast, getHotspots, getMeta,
  type Hotspots, isStatic, type Meta, type Polygon,
} from "@/lib/api";
import { calendarPng, monthlyCsv, seasonCsv, slug, svgPng, yearlyCsv } from "@/lib/export";
import { fmt, full, monthRange, MONTHS_LONG } from "@/lib/scale";

import { AreaMap } from "./area-map";
import { BurnCalendar, type CalendarMode } from "./burn-calendar";
import { SeasonChart, SkillChart, YearChart } from "./charts";
import { ForecastView } from "./forecast";

type View = "calendar" | "forecast";

const box = (w: number, s: number, e: number, n: number): Polygon => ({
  type: "Polygon",
  coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]],
});

// places with a fire history worth opening first
const PLACES: { label: string; geometry: Polygon }[] = [
  { label: "Muğla coast, Türkiye", geometry: box(27.4, 36.5, 29.6, 37.5) },
  { label: "Evia, Greece", geometry: box(22.8, 38.3, 24.3, 39.1) },
  { label: "Central Portugal", geometry: box(-8.6, 39.6, -7.2, 40.6) },
  { label: "Galicia, Spain", geometry: box(-9.1, 41.9, -6.8, 43.6) },
  { label: "Sicily, Italy", geometry: box(12.3, 36.6, 15.7, 38.4) },
  { label: "Paraná Delta, Argentina", geometry: box(-60.9, -34.3, -58.3, -32.0) },
  { label: "Corrientes, Argentina", geometry: box(-59.7, -30.8, -55.6, -27.2) },
];

const DEFAULT: Area = { kind: "country", name: "Turkey", bbox: [25.6, 35.8, 44.9, 42.2] };

function PngButton({ onClick, label }: { onClick: () => Promise<void>; label: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      aria-label={label}
      title={label}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await onClick();
        } finally {
          setBusy(false);
        }
      }}
    >
      <Download data-icon="inline-start" />
      PNG
    </Button>
  );
}

function Panel({ title, note, children, className = "", png }: {
  title: string; note?: string; children: React.ReactNode; className?: string; png?: { area: string; file: string };
}) {
  const ref = useRef<HTMLElement>(null);
  return (
    <section ref={ref} className={`rounded-lg border bg-card p-4 sm:p-5 ${className}`}>
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-[15px] font-semibold">{title}</h2>
        {png && (
          <PngButton
            label={`Download "${title}" as PNG`}
            onClick={async () => {
              const svg = ref.current?.querySelector<SVGSVGElement>('svg[role="img"]');
              if (svg) await svgPng(svg, ref.current!.querySelector<HTMLElement>("[data-chart-key]"), title, png.area, `firerosetta_${slug(png.area)}_${png.file}.png`);
            }}
          />
        )}
      </div>
      {note && <p className="mt-0.5 max-w-[72ch] text-sm text-muted-foreground">{note}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function Workbench() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [area, setArea] = useState<Area>(DEFAULT);
  const [cal, setCal] = useState<Calendar | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<CalendarMode>("count");
  const [range, setRange] = useState<{ start: string; end: string } | null>(null);
  const [spots, setSpots] = useState<Hotspots | null>(null);
  const [busyCsv, setBusyCsv] = useState(false);
  const [bbox, setBbox] = useState({ w: "", s: "", e: "", n: "" });
  // flagged persistent heat sources are drawn, greyed, by default: hiding them by default would
  // delete data from the map on a model's say-so. The toggle lets the user take them out.
  const [hideStatic, setHideStatic] = useState(false);
  const [view, setView] = useState<View>("calendar");
  // tagged with the area they belong to, so a stale result reads as "still loading"
  // instead of needing a synchronous reset inside the effect
  const [fc, setFc] = useState<{ key: string; data: Forecast } | null>(null);
  const [fcError, setFcError] = useState<{ key: string; message: string } | null>(null);
  const areaKey = useMemo(() => JSON.stringify(area), [area]);

  useEffect(() => {
    getMeta().then(setMeta).catch((e) => setError(e.message));
  }, []);

  // only asked for once the tab is open: running the model is work the calendar does not need
  useEffect(() => {
    if (view !== "forecast") return;
    const ctl = new AbortController();
    getForecast(area, ctl.signal)
      .then((data) => setFc({ key: areaKey, data }))
      .catch((e) => e.name !== "AbortError" && setFcError({ key: areaKey, message: e.message }));
    return () => ctl.abort();
  }, [area, areaKey, view]);

  useEffect(() => {
    const ctl = new AbortController();
    getCalendar(area, ctl.signal)
      .then((c) => {
        setError(null);
        setCal(c);
        // open on the month that defines this place: the largest on record
        const peak = c.months.reduce((a, b) => (b.harmonized > a.harmonized ? b : a));
        const [start, end] = monthRange(peak.month);
        setRange({ start, end });
      })
      .catch((e) => {
        if (e.name !== "AbortError") {
          setCal(null);
          setError(e.message);
        }
      });
    return () => ctl.abort();
  }, [area]);

  useEffect(() => {
    if (!range || range.start > range.end) return;
    const ctl = new AbortController();
    getHotspots(area, range.start, range.end, ctl.signal)
      .then(setSpots)
      .catch((e) => e.name !== "AbortError" && setSpots(null));
    return () => ctl.abort();
  }, [area, range]);

  const selectMonth = useCallback((month: string) => {
    const [start, end] = monthRange(month);
    setRange({ start, end });
  }, []);
  const selectYear = useCallback((y: number) => setRange({ start: `${y}-01-01`, end: `${y}-12-31` }), []);

  const shown = useMemo(() => {
    const pts = spots?.points ?? [];
    return hideStatic ? pts.filter((p) => !isStatic(p)) : pts;
  }, [spots, hideStatic]);

  const year = range ? +range.start.slice(0, 4) : 0;
  const story = useMemo(() => (cal ? describe(cal) : null), [cal]);
  const label = area.kind === "country" ? area.name : area.label;

  const applyBbox = () => {
    const [w, s, e, n] = [bbox.w, bbox.s, bbox.e, bbox.n].map(Number);
    if ([w, s, e, n].some(Number.isNaN) || w >= e || s >= n) {
      setError("Enter west < east and south < north, in decimal degrees.");
      return;
    }
    setArea({ kind: "polygon", label: `${s}°, ${w}° to ${n}°, ${e}°`, geometry: box(w, s, e, n) });
  };

  return (
    <div className="mx-auto w-full max-w-[1400px] px-4 pb-16 sm:px-6">
      <header className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 py-5">
        <div className="flex items-baseline gap-3">
          <span className="display text-xl">FireRosetta</span>
          <span className="text-sm text-muted-foreground">
            Burning calendar from MODIS and VIIRS, on one scale
          </span>
        </div>
        <nav className="flex gap-5 text-sm">
          <span className="font-semibold">Calendar</span>
          <Link href="/method" className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
            How the harmonization works
          </Link>
        </nav>
      </header>

      {error && (
        <p role="alert" className="mb-4 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">
          {error}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div className="flex flex-col gap-4">
          <div className="h-[380px] lg:h-[440px]">
            <AreaMap
              area={area}
              points={shown}
              onDraw={(geometry) => setArea({ kind: "polygon", label: "Drawn area", geometry })}
            />
          </div>

          <section className="rounded-lg border bg-card p-4">
            <h2 className="text-[15px] font-semibold">Area</h2>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {PLACES.map((p) => (
                <Button
                  key={p.label}
                  size="sm"
                  variant={label === p.label ? "default" : "outline"}
                  onClick={() => setArea({ kind: "polygon", ...p })}
                >
                  {p.label}
                </Button>
              ))}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {meta?.countries.map((c) => (
                <Button
                  key={c.name}
                  size="sm"
                  variant={label === c.name ? "default" : "secondary"}
                  onClick={() => setArea({ kind: "country", name: c.name, bbox: c.bbox })}
                >
                  All of {c.name}
                </Button>
              ))}
            </div>
            <form
              className="mt-4 grid grid-cols-[repeat(4,minmax(0,1fr))_auto] items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                applyBbox();
              }}
            >
              {(["w", "s", "e", "n"] as const).map((k) => (
                <div key={k}>
                  <Label htmlFor={`bbox-${k}`} className="text-xs text-muted-foreground">
                    {{ w: "West", s: "South", e: "East", n: "North" }[k]}
                  </Label>
                  <Input
                    id={`bbox-${k}`}
                    inputMode="decimal"
                    placeholder={{ w: "27.4", s: "36.5", e: "29.6", n: "37.5" }[k]}
                    value={bbox[k]}
                    onChange={(e) => setBbox({ ...bbox, [k]: e.target.value })}
                    className="mt-1 num"
                  />
                </div>
              ))}
              <Button type="submit" variant="outline">Use box</Button>
            </form>
          </section>

          <section className="rounded-lg border bg-card p-4">
            <h2 className="text-[15px] font-semibold">Hotspots on the map</h2>
            <div className="mt-3 grid grid-cols-[1fr_1fr_auto] items-end gap-2">
              <div>
                <Label htmlFor="start" className="text-xs text-muted-foreground">From</Label>
                <Input id="start" type="date" className="mt-1 num" value={range?.start ?? ""}
                  min="2000-11-01" onChange={(e) => range && setRange({ ...range, start: e.target.value })} />
              </div>
              <div>
                <Label htmlFor="end" className="text-xs text-muted-foreground">To</Label>
                <Input id="end" type="date" className="mt-1 num" value={range?.end ?? ""}
                  onChange={(e) => range && setRange({ ...range, end: e.target.value })} />
              </div>
              <Button
                disabled={!range || busyCsv || !spots?.total}
                onClick={async () => {
                  if (!range) return;
                  setBusyCsv(true);
                  try {
                    await downloadCsv(area, range.start, range.end);
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusyCsv(false);
                  }
                }}
              >
                {busyCsv ? "Preparing…" : "Download CSV"}
              </Button>
            </div>
            {spots && (
              <div className="mt-3 text-sm">
                <p className="num">
                  <span className="font-semibold">{full(spots.total)}</span> detections as the satellites reported them
                  {spots.returned < spots.total && ` (map shows an even sample of ${full(spots.returned)}; the CSV has all)`}
                </p>
                <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground num">
                  {(["Terra", "Aqua", "SNPP", "NOAA20"] as const).map((p) => (
                    <li key={p} className="flex items-center gap-1.5">
                      <span className="size-2.5 rounded-full" style={{ background: p === "Terra" || p === "Aqua" ? "var(--series-modis)" : "var(--series-viirs)" }} />
                      {{ Terra: "MODIS Terra", Aqua: "MODIS Aqua", SNPP: "VIIRS S-NPP", NOAA20: "VIIRS NOAA-20" }[p]} {full(spots.by_platform[p] ?? 0)}
                    </li>
                  ))}
                  {spots.static_total > 0 && (
                    <li className="flex items-center gap-1.5">
                      <span className="size-2.5 rounded-full border border-[#3d4650] bg-[#8d95a0]" />
                      Not a fire {full(spots.static_total)}
                    </li>
                  )}
                </ul>
                {spots.has_static_sources && spots.static_total > 0 && (
                  <div className="mt-3 rounded-md border border-border bg-muted/40 px-3 py-2">
                    <p className="text-xs leading-relaxed">
                      <span className="num font-semibold">{full(spots.static_total)}</span> of these (
                      <span className="num">{((100 * spots.static_total) / spots.total).toFixed(1)}%</span>) land on sites
                      flagged as permanent heat sources — factory chimneys, gas flares, steel mills — so they are burning
                      every month rather than on fire. They are greyed on the map, not deleted.
                    </p>
                    <label className="mt-2 flex cursor-pointer items-center gap-2 text-xs">
                      <Switch size="sm" checked={hideStatic} onCheckedChange={setHideStatic} />
                      Hide them on the map
                    </label>
                  </div>
                )}
              </div>
            )}
          </section>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Tabs value={view} onValueChange={(v) => setView(v as View)}>
            <TabsList>
              <TabsTrigger value="calendar">Burning calendar</TabsTrigger>
              <TabsTrigger value="forecast">Early warning</TabsTrigger>
            </TabsList>
          </Tabs>

          {view === "forecast" ? (
            fcError?.key === areaKey ? (
              <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">
                {fcError.message}
              </p>
            ) : fc?.key !== areaKey ? (
              <Skeleton className="h-[720px] rounded-lg" />
            ) : (
              <ForecastView data={fc.data} label={label} />
            )
          ) : !cal || !story ? (
            <Skeleton className="h-[720px] rounded-lg" />
          ) : (
            <>
              <section className="rounded-lg border bg-card p-4 sm:p-5">
                <p className="text-sm text-muted-foreground">
                  {label}, about {full(cal.area.approx_km2)} km² of land that has burned at least once
                </p>
                <h1 className="display mt-1 max-w-[30ch] text-[26px] leading-[1.15] sm:text-[30px]">{story.headline}</h1>
                <p className="mt-2 max-w-[70ch] text-sm leading-relaxed">{story.latest}</p>

                <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
                  <h2 className="text-[15px] font-semibold">Hotspots per month, {cal.months[0].year} to {cal.months.at(-1)!.year}</h2>
                  <div className="flex items-center gap-1">
                    <Tabs value={mode} onValueChange={(v) => setMode(v as CalendarMode)}>
                      <TabsList>
                        <TabsTrigger value="count">Hotspot count</TabsTrigger>
                        <TabsTrigger value="anomaly">Against the usual</TabsTrigger>
                      </TabsList>
                    </Tabs>
                    <PngButton label="Download the burning calendar as PNG" onClick={() => calendarPng(cal, mode, label)} />
                  </div>
                </div>
                <div className="mt-3 overflow-x-auto">
                  <div className="min-w-[620px]">
                    <BurnCalendar data={cal} mode={mode} selected={range ?? { start: "", end: "" }}
                      onSelectMonth={selectMonth} onSelectYear={selectYear} />
                  </div>
                </div>
              </section>

              <Panel title={`${year} against a typical year`} png={{ area: label, file: `season_${year}` }} note="Pick a year in the calendar or the chart below to compare it.">
                <SeasonChart data={cal} year={year} />
              </Panel>

              <Panel
                title="Every year on the VIIRS scale"
                png={{ area: label, file: "yearly" }}
                note={`Counted by MODIS alone, this area's record before 2012 would sit about ${story.undercount}× too low next to today's VIIRS numbers. Green bars are the corrected estimate.`}
              >
                <YearChart data={cal} year={year} onSelectYear={selectYear} />
              </Panel>

              <Panel
                title="Can the estimate be trusted here?"
                png={{ area: label, file: "validation" }}
                note={story.trust}
              >
                <SkillChart data={cal} />
              </Panel>

              <Panel
                title="Download analytics"
                note="The numbers behind the calendar and charts for this area, as CSV. Values are on the VIIRS scale; before 2012 they are estimates with a 90% range."
              >
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" onClick={() => monthlyCsv(cal, label)}>
                    <Download data-icon="inline-start" />
                    Monthly series ({cal.months.length} months)
                  </Button>
                  <Button variant="outline" onClick={() => yearlyCsv(cal, label)}>
                    <Download data-icon="inline-start" />
                    Yearly totals and anomalies
                  </Button>
                  <Button variant="outline" onClick={() => seasonCsv(cal, label)}>
                    <Download data-icon="inline-start" />
                    Typical season (median, p10–p90)
                  </Button>
                </div>
              </Panel>
            </>
          )}
        </div>
      </div>

      {meta && (
        <footer className="mt-8 max-w-[90ch] text-xs leading-relaxed text-muted-foreground">
          Built on {full(meta.hotspots)} active-fire detections from NASA FIRMS (MODIS Collection 6.1 on Terra and Aqua;
          VIIRS 375 m on S-NPP and NOAA-20), {meta.first_month} to {meta.data_through}, from {meta.source_files} source
          files with recorded checksums. Months after the standard product ends use FIRMS near-real-time data
          (MCD14DL, VNP14IMGT_NRT, VJ114IMGT_NRT) and are marked provisional. Counts are vegetation fires at nominal or high confidence, on a {meta.grid_deg}° grid.
          A hotspot is a satellite pixel flagged as burning, not a fire incident.
        </footer>
      )}
    </div>
  );
}

function describe(cal: Calendar) {
  const peakMoy = cal.climatology.reduce((a, b) => (b.median > a.median ? b : a)).moy;
  const top = cal.years.reduce((a, b) => (b.total > a.total ? b : a));
  const times = cal.year_median > 0 ? top.total / cal.year_median : 0;
  const last = cal.months.findLast((m) => !m.partial) ?? cal.months.at(-1)!;
  const ratio = last.median > 0 ? last.harmonized / last.median : null;
  const overlap = cal.months.filter((m) => m.era === "snpp");
  const undercount = overlap.reduce((s, m) => s + m.snpp, 0) / Math.max(1, overlap.reduce((s, m) => s + m.modis, 0));
  const sk = cal.skill.modis;

  const headline =
    times >= 2
      ? `${MONTHS_LONG[peakMoy - 1]} is the usual peak. ${top.year} burned ${times >= 10 ? Math.round(times) : times.toFixed(1)} times the median year.`
      : `${MONTHS_LONG[peakMoy - 1]} is the usual peak, and ${top.year} was the most active year on record.`;
  const latest =
    `Latest complete month, ${MONTHS_LONG[last.moy - 1]} ${last.year}${last.provisional ? " (provisional)" : ""}: ${full(last.harmonized)} hotspots` +
    (ratio === null
      ? "."
      : ratio > 1.25
        ? `, ${ratio.toFixed(1)} times the ${MONTHS_LONG[last.moy - 1]} median of ${full(last.median)}. Higher than ${Math.round(last.pct)}% of all ${MONTHS_LONG[last.moy - 1]}s since 2000.`
        : ratio < 0.8
          ? `, below the ${MONTHS_LONG[last.moy - 1]} median of ${full(last.median)}.`
          : `, close to the ${MONTHS_LONG[last.moy - 1]} median of ${full(last.median)}.`);
  const trust =
    sk.wape === null
      ? "There are too few VIIRS detections in this area to test the estimate. Treat pre-2012 values as indicative."
      : `For 2012 onwards both sensors exist, so the estimate can be checked against VIIRS in years it never trained on. ` +
        `Here its monthly error is ${Math.round(sk.wape)}% of total hotspots; raw MODIS counts are off by ${Math.round(cal.skill.raw_modis_wape ?? 0)}%. ` +
        (sk.wape > 35 ? "That is a loose fit: this area is small or its fires are too small for MODIS, so read early years as rough." : "");
  return { headline, latest, trust, undercount: undercount.toFixed(1), fmt };
}
