"""Step 5 - HTTP API over the harmonized table.

    uv run uvicorn firerosetta.api:app --port 8000
"""
from __future__ import annotations

import io
import json
import math
from typing import Any

import duckdb
import numpy as np
import pandas as pd
import shapely
from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from starlette.middleware.gzip import GZipMiddleware

from .config import COUNTRIES, GRID_DEG, MANIFEST, PROCESSED, STAGED
from .risk import GRID_LEVELS_KM, RiskMonitor, count_visible_grid

app = FastAPI(title="FireRosetta - harmonized MODIS/VIIRS burning calendar")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
app.add_middleware(GZipMiddleware, minimum_size=1000, compresslevel=3)

# Read only the needed parquet columns/regions instead of retaining the entire model
# in RAM alongside the calendar and alert queries.
con = duckdb.connect(config={"memory_limit": "1GB", "threads": 4})
con.execute(f"CREATE VIEW h AS SELECT * FROM '{PROCESSED / 'harmonized.parquet'}'")
con.execute(f"CREATE VIEW hs AS SELECT * FROM '{STAGED / 'hotspots.parquet'}'")
CELLS = con.sql(f"SELECT * FROM '{PROCESSED / 'cells.parquet'}'").df()
CELLS["lon"] = (CELLS.gx + 0.5) * GRID_DEG
CELLS["lat"] = (CELLS.gy + 0.5) * GRID_DEG
METRICS = json.loads((PROCESSED / "metrics.json").read_text())
N_HOTSPOTS = con.execute("SELECT count(*) FROM hs").fetchone()[0]
FIRST, LAST = con.execute("SELECT min(month), max(month) FROM h").fetchone()
TRAIN_LAST = METRICS["overlap"][1]
NRT_FROM = METRICS.get("provisional", {}).get("nrt_from", {})
DATA_THROUGH = METRICS.get("provisional", {}).get("data_through", "9999-12-31")
RISK_MONITOR = RiskMonitor(con, DATA_THROUGH)

MAX_POINTS = 25_000
HOTSPOT_COLS = ("lat AS latitude, lon AS longitude, acq_date, acq_time, sensor, platform, daynight, "
                "conf AS confidence, frp, bright_mir, scan, track, type, country")


class Area(BaseModel):
    country: str | None = None
    geometry: dict[str, Any] | None = None  # GeoJSON Polygon / MultiPolygon, lon-lat


class HotspotQuery(Area):
    start: str
    end: str
    sensors: list[str] = ["MODIS", "VIIRS"]
    screened: bool = True  # same quality screen as the calendar (vegetation fires, conf >= nominal)


class RiskQuery(Area):
    grid_km: int = 10


class RiskViewQuery(RiskQuery):
    bounds: list[float]


def _geom(area: Area):
    if not area.geometry:
        return None
    try:
        g = shapely.geometry.shape(area.geometry)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"Invalid GeoJSON geometry: {e}") from e
    if g.is_empty or not g.is_valid:
        g = g.buffer(0)
    if g.is_empty:
        raise HTTPException(400, "Geometry is empty.")
    return g


def _cells(area: Area) -> pd.DataFrame:
    g = _geom(area)
    if g is None:
        if area.country not in COUNTRIES:
            raise HTTPException(400, f"Pick one of {list(COUNTRIES)} or send a geometry.")
        return CELLS[CELLS.country == area.country]
    inside = shapely.contains_xy(g, CELLS.lon.values, CELLS.lat.values)
    if not inside.any():  # area smaller than a cell: take the cells it touches
        half = GRID_DEG / 2
        boxes = shapely.box(CELLS.lon.values - half, CELLS.lat.values - half,
                            CELLS.lon.values + half, CELLS.lat.values + half)
        inside = shapely.intersects(boxes, g)
    return CELLS[inside]


def _q(v: float) -> float:
    return round(float(v), 1)


@app.get("/meta")
def meta():
    files = json.loads(MANIFEST.read_text())["files"] if MANIFEST.exists() else {}
    return {
        "countries": [{"name": c, "bbox": b} for c, b in COUNTRIES.items()],
        "first_month": str(FIRST)[:7], "last_month": str(LAST)[:7],
        "grid_deg": GRID_DEG,
        "hotspots": N_HOTSPOTS,
        "source_files": len(files),
        "source_bytes": sum(f["bytes"] for f in files.values()),
        "reference": METRICS["reference"],
        "data_through": DATA_THROUGH,
        "nrt_from": NRT_FROM,
    }


@app.get("/validation")
def validation():
    return METRICS


@app.get("/risk")
def risk(response: Response, country: str = "Turkey", grid_km: int = 10,
         view: str | None = None):
    if country not in COUNTRIES:
        raise HTTPException(400, "Select a supported country.")
    if grid_km not in GRID_LEVELS_KM:
        raise HTTPException(400, "Grid size must be 5, 10 or 20 km.")
    response.headers["Cache-Control"] = "no-store"
    bounds = None
    if view is not None:
        try:
            bounds = tuple(float(part) for part in view.split(","))
            if len(bounds) != 4 or not all(math.isfinite(v) for v in bounds):
                raise ValueError
            w, s, e, n = bounds
            if not (-180 <= w < e <= 180 and -85 <= s < n <= 85):
                raise ValueError
        except ValueError:
            raise HTTPException(400, "Invalid map bounds.") from None
    return RISK_MONITOR.get(country, grid_km=grid_km, bounds=bounds)


@app.post("/risk")
def risk_area(query: RiskQuery, response: Response):
    if query.grid_km not in GRID_LEVELS_KM:
        raise HTTPException(400, "Grid size must be 5, 10 or 20 km.")
    geometry = _geom(query)
    if geometry is None:
        raise HTTPException(400, "Draw an area on the map or select a bounding box.")
    response.headers["Cache-Control"] = "no-store"
    try:
        return RISK_MONITOR.get_area(geometry.__geo_interface__, grid_km=query.grid_km)
    except ValueError as error:
        raise HTTPException(400, str(error)) from None


@app.post("/risk/grid-count")
def risk_grid_count(query: RiskViewQuery):
    if query.grid_km not in GRID_LEVELS_KM:
        raise HTTPException(400, "Grid size must be 5, 10 or 20 km.")
    geometry = _geom(query)
    if geometry is None:
        if query.country not in COUNTRIES:
            raise HTTPException(400, "Select a supported country or draw an area.")
        geometry = shapely.box(*COUNTRIES[query.country])
    try:
        return {"total_cells": count_visible_grid(geometry.__geo_interface__, query.bounds, query.grid_km)}
    except ValueError as error:
        raise HTTPException(400, str(error)) from None


@app.post("/calendar")
def calendar(area: Area):
    cells = _cells(area)[["country", "gx", "gy"]]
    if cells.empty:
        raise HTTPException(404, "No fire detections were ever recorded in this area "
                                 "(or it lies outside the loaded countries).")
    cur = con.cursor()
    cur.register("sel", cells)
    m = cur.execute("""
        WITH months AS (SELECT unnest(generate_series(?::DATE, ?::DATE, INTERVAL 1 MONTH))::DATE AS month),
        agg AS (
          SELECT month, sum(harmonized) harmonized, sum(model) model, sum(m_n) modis,
                 sum(v_snpp) snpp, sum(v_n20) noaa20, sum(oof_full) oof_full, sum(oof_terra) oof_terra,
                 any_value(era) era
          FROM h JOIN sel USING (country, gx, gy) GROUP BY month)
        SELECT month, coalesce(harmonized,0) harmonized, coalesce(model,0) model, coalesce(modis,0) modis,
               coalesce(snpp,0) snpp, coalesce(noaa20,0) noaa20, oof_full, oof_terra, era
        FROM months LEFT JOIN agg USING (month) ORDER BY month
    """, [FIRST, LAST]).df()
    mo = pd.to_datetime(m.month)
    m["year"], m["moy"] = mo.dt.year, mo.dt.month
    m["era"] = np.select([mo < "2002-07-01", mo < "2012-02-01", mo <= "2026-10-01"],
                         ["terra", "modis", "snpp"], "noaa20")
    # skill only on months the model was cross-validated on (standard product, never NRT)
    ov = m.era.eq("snpp").values & (m.month.astype(str) <= TRAIN_LAST).values
    obs = m.snpp.values.astype(float)
    month_end = (mo + pd.offsets.MonthEnd(0)).dt.date.astype(str)
    nrt_start = {"terra": NRT_FROM.get("Terra"), "modis": NRT_FROM.get("Aqua") or NRT_FROM.get("Terra"),
                 "snpp": NRT_FROM.get("SNPP"), "noaa20": NRT_FROM.get("NOAA20")}
    m["provisional"] = [bool(nrt_start[e]) and me >= nrt_start[e] for e, me in zip(m.era, month_end)]
    m["partial"] = (month_end > DATA_THROUGH).values

    # --- skill of the harmonization *in this area*, from out-of-fold predictions ---
    skill, resid = {}, {}
    for name, col in (("modis", "oof_full"), ("terra", "oof_terra")):
        p = m[col].fillna(0).values
        e = p[ov] - obs[ov]
        tot = obs[ov].sum()
        resid[name] = np.log1p(obs[ov]) - np.log1p(p[ov])
        var = ((obs[ov] - obs[ov].mean()) ** 2).sum()
        skill[name] = {
            "wape": _q(100 * np.abs(e).sum() / tot) if tot else None,
            "bias": _q(100 * e.sum() / tot) if tot else None,
            "r2": round(float(1 - (e**2).sum() / var), 3) if var else None,
            "interval90": [round(float(np.exp(np.quantile(resid[name], q))), 3) for q in (0.05, 0.95)],
        }
    raw_e = m.modis.values[ov] - obs[ov]
    skill["raw_modis_wape"] = _q(100 * np.abs(raw_e).sum() / obs[ov].sum()) if obs[ov].sum() else None
    skill["n_months"] = int(ov.sum())

    # 90 % band for modelled months: empirical residual quantiles from this area's own overlap months
    lo, hi = m.harmonized.values.copy(), m.harmonized.values.copy()
    for name in ("modis", "terra"):
        k = m.era.eq(name).values
        q05, q95 = np.quantile(resid[name], [0.05, 0.95])
        lo[k] = np.maximum(np.expm1(np.log1p(m.harmonized.values[k]) + q05), 0)
        hi[k] = np.expm1(np.log1p(m.harmonized.values[k]) + q95)
    m["lo"], m["hi"] = lo, hi

    # --- calendar statistics on the harmonized series ---
    full_years = m.groupby("year").moy.count()
    full_years = full_years[full_years == 12].index
    base = m[m.year.isin(full_years)]
    clim = base.groupby("moy").harmonized.agg(
        median="median", mean="mean", p10=lambda s: s.quantile(0.1), p90=lambda s: s.quantile(0.9),
        max="max").reindex(range(1, 13))
    m["median"] = m.moy.map(clim["median"])
    # percentile of each month among the same calendar month across all years
    m["pct"] = m.groupby("moy").harmonized.rank(pct=True) * 100
    yr = base.groupby("year").agg(total=("harmonized", "sum"), lo=("lo", "sum"), hi=("hi", "sum"),
                                  modis=("modis", "sum"), peak_moy=("harmonized", "idxmax"))
    yr["peak_moy"] = m.moy[yr.peak_moy].values
    yr_med = yr.total.median()
    yr["rank"] = yr.total.rank(ascending=False).astype(int)

    return {
        "area": {
            "cells": int(len(cells)), "countries": sorted(cells.country.unique()),
            "approx_km2": round(float((111.32 * GRID_DEG) ** 2
                                      * np.cos(np.deg2rad((cells.gy + 0.5) * GRID_DEG)).sum())),
        },
        "months": [
            {"month": str(r.month)[:7], "year": int(r.year), "moy": int(r.moy), "era": r.era,
             "harmonized": _q(r.harmonized), "lo": _q(r.lo), "hi": _q(r.hi),
             "modis": int(r.modis), "snpp": int(r.snpp), "noaa20": int(r.noaa20),
             "model": _q(r.model),
             "oof": None if pd.isna(r.oof_full) else _q(r.oof_full),
             "median": _q(r["median"]), "pct": _q(r.pct),
             "provisional": bool(r.provisional), "partial": bool(r.partial)}
            for _, r in m.iterrows()
        ],
        "climatology": [{"moy": int(i), **{k: _q(v) for k, v in r.items()}} for i, r in clim.iterrows()],
        "years": [
            {"year": int(y), "total": _q(r.total), "lo": _q(r.lo), "hi": _q(r.hi), "modis": int(r.modis),
             "rank": int(r["rank"]), "peak_moy": int(r.peak_moy),
             "anomaly_pct": _q(100 * (r.total / yr_med - 1)) if yr_med else None}
            for y, r in yr.iterrows()
        ],
        "year_median": _q(yr_med),
        "skill": skill,
    }


def _hotspot_sql(q: HotspotQuery) -> tuple[str, list]:
    where, params = ["acq_date BETWEEN ?::DATE AND ?::DATE"], [q.start, q.end]
    where.append("sensor IN (" + ",".join("?" * len(q.sensors)) + ")")
    params += q.sensors
    if q.screened:
        where.append("type = 0 AND conf <> 'l'")
    g = _geom(q)
    if g is None:
        if q.country not in COUNTRIES:
            raise HTTPException(400, "Send a country or a geometry.")
        where.append("country = ?")
        params.append(q.country)
    else:
        w, s, e, n = g.bounds
        where.append("lon BETWEEN ? AND ? AND lat BETWEEN ? AND ?")
        params += [w, e, s, n]
    return f"SELECT {HOTSPOT_COLS} FROM hs WHERE {' AND '.join(where)} ORDER BY acq_date, acq_time", params


def _hotspots(q: HotspotQuery) -> pd.DataFrame:
    sql, params = _hotspot_sql(q)
    df = con.cursor().execute(sql, params).df()
    g = _geom(q)
    if g is not None and len(df):
        df = df[shapely.contains_xy(g, df.longitude.values, df.latitude.values)]
    return df


@app.post("/hotspots")
def hotspots(q: HotspotQuery):
    df = _hotspots(q)
    total = len(df)
    by_platform = {k: int(v) for k, v in df.platform.value_counts().items()}
    if total > MAX_POINTS:  # the map gets an even sample; the CSV always gets everything
        df = df.iloc[np.linspace(0, total - 1, MAX_POINTS).astype(int)]
    return {
        "total": total, "returned": len(df),
        "by_platform": by_platform,
        "points": [[round(r.longitude, 4), round(r.latitude, 4), str(r.acq_date)[:10], r.platform,
                    None if pd.isna(r.frp) else round(r.frp, 1), r.daynight]
                   for r in df.itertuples()],
    }


@app.post("/hotspots.csv")
def hotspots_csv(q: HotspotQuery):
    df = _hotspots(q)
    df["acq_date"] = df.acq_date.astype(str).str[:10]
    buf = io.StringIO()
    buf.write("# NASA FIRMS active fire hotspots (MODIS Collection 6.1, VIIRS 375 m Collection 2)\n")
    buf.write(f"# {q.start} .. {q.end}; sensors={'+'.join(q.sensors)}; "
              f"quality screen={'vegetation fires, confidence >= nominal' if q.screened else 'none'}\n")
    df.to_csv(buf, index=False)
    buf.seek(0)
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv", headers={
        "Content-Disposition": f'attachment; filename="hotspots_{q.start}_{q.end}.csv"'})
