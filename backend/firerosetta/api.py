"""Step 5 - HTTP API over the harmonized table.

    uv run uvicorn firerosetta.api:app --port 8000
"""
from __future__ import annotations

import functools
import io
import json
import math
from typing import Any

import duckdb
import joblib
import numpy as np
import pandas as pd
import shapely
import sklearn
from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from starlette.middleware.gzip import GZipMiddleware

from .config import COUNTRIES, GRID_DEG, MANIFEST, MODELS, PROCESSED, STAGED
from .risk import GRID_LEVELS_KM, RiskMonitor, StaticSites, count_visible_grid, site_codes

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

# --- early-warning model: optional, the rest of the API works without it ---
# Each cell's all-time harmonized total, used to split a 1 deg block forecast over the
# part of the block the user actually selected.
CELLS = CELLS.merge(con.sql("SELECT country, gx, gy, sum(harmonized) tot FROM h GROUP BY 1,2,3").df(),
                    on=["country", "gx", "gy"], how="left")
CELLS["tot"] = CELLS.tot.fillna(0.0)
CELLS["bx"] = np.floor(CELLS.lon).astype(int)
CELLS["by"] = np.floor(CELLS.lat).astype(int)
BLOCK_TOT = CELLS.groupby(["bx", "by"]).tot.sum()


def _load_forecast():
    bundle_path = MODELS / "earlywarn.joblib"
    feats_path = PROCESSED / "forecast_features.parquet"
    back_path = PROCESSED / "forecast_backtest.parquet"
    if not (bundle_path.exists() and feats_path.exists() and back_path.exists()):
        return None
    meta = json.loads((MODELS / "earlywarn.json").read_text())
    built_with = meta.get("env", {}).get("sklearn")
    if built_with and built_with != sklearn.__version__:
        # pickled estimators are not guaranteed across versions; say so rather than
        # let it fail somewhere deep in the unpickler
        print(f"warning: early-warning model was trained with scikit-learn {built_with}, "
              f"this environment has {sklearn.__version__}. Retrain if loading fails.")
    try:
        bundle = joblib.load(bundle_path)
    except Exception as e:  # noqa: BLE001 - a bad pickle must not take the whole API down
        print(f"warning: could not load the early-warning model ({e}); /forecast disabled.")
        return None
    feats = con.sql(f"SELECT * FROM '{feats_path}'").df()
    feats["month"] = pd.to_datetime(feats.month)
    back = con.sql(f"SELECT * FROM '{back_path}'").df()
    back["target_month"] = pd.to_datetime(back.target_month)
    return {"bundle": bundle, "feats": feats, "back": back, "meta": meta,
            "basis": feats.month.max()}


FORECAST = _load_forecast()
WARN_LEVELS = [(0.50, "high"), (0.25, "elevated"), (0.10, "watch")]
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
        "has_forecast": FORECAST is not None,
        "has_static_sources": STATIC is not None,
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


def _block_share(cells: pd.DataFrame) -> pd.Series:
    """How much of each 1 deg block's historical burning falls inside the selected area.

    The model predicts whole blocks; this is what turns a block forecast into a forecast
    for an arbitrary drawn area, and it is the area's own history that does the splitting.
    """
    mine = cells.groupby(["bx", "by"]).tot.sum()
    share = (mine / BLOCK_TOT.reindex(mine.index)).fillna(0.0)
    return share[share > 0]


def _warn_level(prob: float) -> str:
    return next((name for cut, name in WARN_LEVELS if prob >= cut), "normal")


def _expected_counts(bundle: dict, lead: int, X: pd.DataFrame) -> np.ndarray:
    """The bundle's two-step regression head: log1p trees, then isotonic back to counts.

    Kept as two plain sklearn estimators so the published model loads without this project;
    the same recipe is recorded in bundle["predict_recipe"].
    """
    gbm, iso = bundle[f"reg_h{lead}_gbm"], bundle[f"reg_h{lead}_iso"]
    return iso.predict(gbm.predict(X)).clip(0)


def _lead_frame(rows: pd.DataFrame, lead: int) -> pd.DataFrame:
    """Swap in the lead-specific target-month normals (climatology, known in advance)."""
    X = rows.copy()
    X["y_clim"] = X[f"y_clim_h{lead}"]
    for col in ("t2m", "precip", "vpd"):
        X[f"{col}_clim_target"] = X[f"{col}_clim_target_h{lead}"]
    return X


@functools.cache
def _block_outlook() -> dict:
    """The model run once for every block it has inputs for - the map's outlook layer.

    /forecast answers "what about my area"; this answers "where", at the model's own
    resolution, so nothing here is disaggregated below the 1 deg unit it was validated on.
    """
    bundle, feats, basis = FORECAST["bundle"], FORECAST["feats"], FORECAST["basis"]
    rows = feats[feats.month == basis].reset_index(drop=True)
    blocks = [{"bx": int(r.bx), "by": int(r.by), "leads": []} for r in rows.itertuples()]
    leads = []
    for lead in bundle["leads"]:
        X = _lead_frame(rows, lead)
        Xf = X[bundle["features"]]
        expected = _expected_counts(bundle, lead, Xf)
        prob = bundle[f"clf_h{lead}"].predict_proba(Xf)[:, 1]
        normal = X.y_clim.fillna(0).to_numpy()
        for block, e, p, n in zip(blocks, expected, prob, normal):
            block["leads"].append({
                "prob": round(float(p), 3), "level": _warn_level(float(p)),
                "expected": _q(float(e)), "normal": _q(float(n)),
                "ratio": round(float(e / n), 2) if n > 0.5 else None,
            })
        leads.append({"lead": lead, "target_month": (basis + pd.DateOffset(months=lead)).strftime("%Y-%m")})
    meta = FORECAST["meta"]
    return {
        "basis_month": basis.strftime("%Y-%m"), "leads": leads, "unit": meta["unit"],
        "warning_definition": meta["warning_definition"],
        "base_rate": meta["leads_detail"]["1"]["with_weather"].get("warning", {}).get("base_rate"),
        "levels": {name: cut for cut, name in WARN_LEVELS},
        "blocks": blocks,
    }


@app.get("/forecast/blocks")
def forecast_blocks():
    if FORECAST is None:
        raise HTTPException(503, "The early-warning model is not built.")
    return _block_outlook()


@app.post("/forecast")
def forecast(area: Area):
    """Run the early-warning model for this area, for each lead time it was trained on."""
    if FORECAST is None:
        raise HTTPException(503, "The early-warning model is not built. Run "
                                 "`uv run python -m firerosetta.weather` then "
                                 "`uv run python -m firerosetta.forecast` in backend/.")
    bundle, feats, back = FORECAST["bundle"], FORECAST["feats"], FORECAST["back"]
    cells = _cells(area)
    if cells.empty:
        raise HTTPException(404, "No fire detections were ever recorded in this area "
                                 "(or it lies outside the loaded countries).")
    share = _block_share(cells)
    if share.empty:
        raise HTTPException(404, "This area has no burning on record, so there is nothing to forecast.")

    basis = FORECAST["basis"]
    # Keep the blocks present in both, without dropping NaN features: a standardised
    # anomaly is undefined wherever the normal has zero spread (no August heat in
    # January), and the trees were trained with exactly those gaps.
    at_basis = feats[feats.month == basis].set_index(["bx", "by"])
    idx = share.index.intersection(at_basis.index)
    if idx.empty:
        raise HTTPException(503, "The model has no inputs for this area at the latest month.")
    rows = at_basis.loc[idx]
    w = share.loc[idx].to_numpy()

    # --- the area's own backtest: hindcasts the model made for years it never trained on ---
    mine = back[back.set_index(["bx", "by"]).index.isin(share.index)].copy()
    mine["w"] = share.reindex(pd.MultiIndex.from_frame(mine[["bx", "by"]])).to_numpy()
    for col in ("target", "pred", "pred_hist_only", "y_clim"):
        mine[col] = mine[col] * mine.w
    agg = mine.groupby(["lead", "target_month"], as_index=False).agg(
        actual=("target", "sum"), pred=("pred", "sum"),
        hist_only=("pred_hist_only", "sum"), normal=("y_clim", "sum"))

    leads_out, skill = [], {}
    for lead in bundle["leads"]:
        X = _lead_frame(rows, lead)
        Xf = X[bundle["features"]]
        block_pred = _expected_counts(bundle, lead, Xf)
        prob = bundle[f"clf_h{lead}"].predict_proba(Xf)[:, 1]

        expected = float((block_pred * w).sum())
        normal = float((X.y_clim.to_numpy() * w).sum())
        warn_prob = float((prob * w).sum() / max(w.sum(), 1e-9))

        # 80 % band from this area's own hindcast residuals in log space
        h = agg[(agg.lead == lead) & (agg.actual.notna())]
        lo = hi = None
        if len(h) >= 12:
            res = np.log1p(h.actual.to_numpy()) - np.log1p(h.pred.to_numpy())
            q10, q90 = np.quantile(res, [0.1, 0.9])
            lo = max(float(np.expm1(np.log1p(expected) + q10)), 0.0)
            hi = float(np.expm1(np.log1p(expected) + q90))
            obs, pred = h.actual.to_numpy(), h.pred.to_numpy()
            var = float(((obs - obs.mean()) ** 2).sum())
            skill[str(lead)] = {
                "n_months": int(len(h)),
                "wape": _q(100 * np.abs(pred - obs).sum() / obs.sum()) if obs.sum() else None,
                "r2": round(float(1 - ((pred - obs) ** 2).sum() / var), 3) if var else None,
                "clim_r2": (round(float(1 - ((h.normal.to_numpy() - obs) ** 2).sum() / var), 3)
                            if var else None),
                "hist_only_r2": (round(float(1 - ((h.hist_only.to_numpy() - obs) ** 2).sum() / var), 3)
                                 if var else None),
            }
        target = (basis + pd.DateOffset(months=lead)).strftime("%Y-%m")
        leads_out.append({
            "lead": lead, "target_month": target,
            "expected": _q(expected), "lo": None if lo is None else _q(lo),
            "hi": None if hi is None else _q(hi),
            "normal": _q(normal),
            "ratio": round(expected / normal, 2) if normal > 0.5 else None,
            "warn_prob": round(warn_prob, 3), "level": _warn_level(warn_prob),
        })

    hist = agg[agg.lead == bundle["leads"][0]].sort_values("target_month")
    return {
        "area": {"cells": int(len(cells)), "blocks": int(len(rows)),
                 "countries": sorted(cells.country.unique())},
        "basis_month": basis.strftime("%Y-%m"),
        "leads": leads_out,
        "skill": skill,
        "backtest": [
            {"month": r.target_month.strftime("%Y-%m"), "actual": _q(r.actual), "pred": _q(r.pred),
             "hist_only": _q(r.hist_only), "normal": _q(r.normal)}
            for r in hist.itertuples()
        ],
        "model": {
            "unit": FORECAST["meta"]["unit"],
            "cv": FORECAST["meta"]["cv"],
            "trained_at": FORECAST["meta"]["trained_at"],
            "warning_definition": FORECAST["meta"]["warning_definition"],
            "weather_source": FORECAST["meta"]["weather_source"],
            "base_rate": FORECAST["meta"]["leads_detail"]["1"]["with_weather"]
                         .get("warning", {}).get("base_rate"),
            "levels": {name: cut for cut, name in WARN_LEVELS},
        },
    }


@app.get("/forecast/metrics")
def forecast_metrics():
    if FORECAST is None:
        raise HTTPException(503, "The early-warning model is not built.")
    return FORECAST["meta"]


def _load_static():
    """Flagged persistent non-fire sources. Optional, like the early-warning model."""
    sites, meta = PROCESSED / "static_sites.parquet", MODELS / "static.json"
    if not (sites.exists() and meta.exists()):
        return None
    # cursor(), not con: by this point in module setup the shared connection still holds an
    # unfinished result from the fetchone() calls above.
    cur = con.cursor()
    df = cur.sql(f"SELECT * FROM '{sites}' WHERE flag").df()
    for c in ("first_seen", "last_seen"):
        df[c] = df[c].astype(str).str[:10]
    m = json.loads(meta.read_text())
    # A real table rather than register(): each request runs on its own cursor, and a cursor
    # sees tables in the shared catalog but not a dataframe registered on a different cursor.
    cur.register("flagged", df[["veg", "sx", "sy"]])
    cur.execute("CREATE OR REPLACE TABLE static_flag AS SELECT DISTINCT veg, sx, sy FROM flagged")
    cur.unregister("flagged")
    # the site grid the bundle was built on, not a constant copied from static.py
    return {"sites": df, "meta": m, "site_deg": float(m["site_deg"])}


STATIC = _load_static()
if STATIC is not None:
    # The alert layer screens the same sites the hotspot feed greys out, so a steel mill
    # cannot raise a "detections in the last 7 days" alert or pass as a seasonal hotspot.
    _s = STATIC["sites"]
    RISK_MONITOR.static_sites = StaticSites(
        STATIC["site_deg"], site_codes(_s.sx[_s.veg], _s.sy[_s.veg]), site_codes(_s.sx, _s.sy))


@app.post("/static-sources")
def static_sources(area: Area):
    """Persistent non-fire heat sources inside the area - chimneys, flares, steel mills.

    These sit in the *fire* stream: FIRMS did not tag them, so the calendar still counts them
    as burning. Returned so the map can show what the detector would remove and the user can
    judge it, rather than the pipeline silently deleting data on a model's say-so.
    """
    if STATIC is None:
        raise HTTPException(503, "The static-source detector has not been run. "
                                 "Train it with: uv run python -m firerosetta.static")
    df = STATIC["sites"]
    g = _geom(area)
    if g is None:
        if area.country not in COUNTRIES:
            raise HTTPException(400, f"Pick one of {list(COUNTRIES)} or send a geometry.")
        df = df[df.country == area.country]
    else:
        df = df[shapely.contains_xy(g, df.lon.values, df.lat.values)]

    untagged = df[df.veg]  # the ones still counted as fire; df also holds already-tagged sites
    return {
        "n_sites": int(len(df)),
        "n_untagged_by_firms": int(len(untagged)),
        "detections_still_counted_as_fire": int(untagged.n_det.sum()),
        "modis_detections": int(untagged.n_modis.sum()),
        "viirs_detections": int(untagged.n_viirs.sum()),
        "skill": {"auc_stratified": STATIC["meta"]["eval"]["auc_stratified"],
                  "auc": STATIC["meta"]["eval"]["auc"],
                  "recall_known_static": STATIC["meta"]["flag"]["recall_known_static"]},
        "sites": [{"lon": round(r.lon, 4), "lat": round(r.lat, 4),
                   "score": round(r.static_score, 3),
                   "detections": int(r.n_det), "months_active": int(r.n_months),
                   "years_active": int(r.n_years), "months_of_year": int(r.n_moy),
                   "night_frac": round(r.night_frac, 2),
                   "frp_med": None if pd.isna(r.frp_med) else round(r.frp_med, 1),
                   "first_seen": r.first_seen, "last_seen": r.last_seen,
                   "tagged_by_firms": not bool(r.veg)}
                  for r in df.nlargest(500, "n_det").itertuples()],
    }


@app.get("/static-sources/metrics")
def static_metrics():
    if STATIC is None:
        raise HTTPException(503, "The static-source detector has not been run.")
    return STATIC["meta"]


def _static_tag() -> tuple[str, str]:
    """(join, expression) marking detections that sit on a flagged persistent heat source.

    Keyed exactly as static.py keyed its sites: the ~1.1 km cell *and* the FIRMS type split,
    so a site the detector found in the untagged stream only flags untagged detections.
    """
    if STATIC is None:
        return "", "FALSE"
    d = STATIC["site_deg"]
    return (f" LEFT JOIN static_flag f ON f.veg = (hs.type = 0)"
            f" AND f.sx = floor(hs.lon/{d})::INT AND f.sy = floor(hs.lat/{d})::INT",
            "f.sx IS NOT NULL")


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
    join, flag = _static_tag()
    return (f"SELECT {HOTSPOT_COLS}, {flag} AS static_source FROM hs{join} "
            f"WHERE {' AND '.join(where)} ORDER BY acq_date, acq_time"), params


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
    stat = df[df.static_source]
    if total > MAX_POINTS:  # the map gets an even sample; the CSV always gets everything
        df = df.iloc[np.linspace(0, total - 1, MAX_POINTS).astype(int)]
    return {
        "total": total, "returned": len(df),
        "by_platform": by_platform,
        # Detections on sites the detector flagged as permanent non-fire heat sources. They stay
        # inside `total` - that is what the satellites reported - but each point carries the flag
        # so the map can show them as something other than a fire.
        "has_static_sources": STATIC is not None,
        "static_total": int(len(stat)),
        "static_by_platform": {k: int(v) for k, v in stat.platform.value_counts().items()},
        "points": [[round(r.longitude, 4), round(r.latitude, 4), str(r.acq_date)[:10], r.platform,
                    None if pd.isna(r.frp) else round(r.frp, 1), r.daynight, int(r.static_source)]
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
    buf.write("# static_source: true where the detection sits on a site the unsupervised detector flagged as a\n"
              "#   permanent non-fire heat source (chimney, gas flare, steel mill). Nothing is dropped; judge it yourself.\n"
              if STATIC is not None else
              "# static_source: always false - the static-source detector has not been run in this deployment.\n")
    df.to_csv(buf, index=False)
    buf.seek(0)
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv", headers={
        "Content-Disposition": f'attachment; filename="hotspots_{q.start}_{q.end}.csv"'})
