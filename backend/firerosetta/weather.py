"""Step 5 - monthly fire-weather indices per 1 deg block, from NASA POWER (MERRA-2).

FIRMS serves fire detections and nothing else. Fire *history* on its own reproduces the
seasonal cycle but not which year burns: at 1 deg x month a climatology-only forecast
scores R2 0.20, while country-year totals swing 0.25x - 2.1x around that climatology.
Those swings are weather-driven, so an early-warning model needs meteorology too.

What matters for fire is not the monthly mean but the *extremes and their persistence* -
runs of rainless days, how many days passed 35 C, how dry the root zone got. So this
fetches POWER's **daily** record (8 parameters, 2000-, one request per block, no key) and
reduces each month to indices built from those dailies, including a Keetch-Byram drought
index integrated day by day.

    uv run python -m firerosetta.weather [--force]
"""
from __future__ import annotations

import argparse
import datetime as dt
import gzip
import hashlib
import json
import time
from concurrent.futures import ThreadPoolExecutor

import duckdb
import httpx
import numpy as np
import pandas as pd

from .config import GRID_DEG, MANIFEST, MODELS, PROCESSED, RAW, STAGED

POWER = "https://power.larc.nasa.gov/api/temporal/daily/point"
UA = {"User-Agent": "hotspot-harmonization-research/0.1"}

PARAMS = [
    "T2M",          # mean air temperature, C
    "T2M_MAX",      # daily maximum, C
    "T2MDEW",       # dew point, C -> vapour pressure deficit
    "PRECTOTCORR",  # bias-corrected precipitation, mm/day
    "RH2M",         # relative humidity, %
    "WS2M",         # mean wind at 2 m, m/s
    "WS2M_MAX",     # peak daily wind - what actually spreads a fire
    "GWETROOT",     # root-zone soil wetness, 0-1 - a direct fuel-dryness proxy
]
RENAME = {"T2M": "t2m", "T2M_MAX": "t2m_max", "T2MDEW": "t2mdew", "PRECTOTCORR": "precip",
          "RH2M": "rh2m", "WS2M": "ws2m", "WS2M_MAX": "ws2m_max", "GWETROOT": "gwetroot"}
FIRST_YEAR = 2000
FILL = -999.0

KBDI_CAP = 203.2   # mm, the metric saturation point of the index
WET_SPELL = 5.08   # mm; the first 5.08 mm of a wet spell runs off and does not wet the soil


def _blocks() -> list[tuple[int, int]]:
    rows = duckdb.sql(f"""SELECT DISTINCT floor((gx + 0.5) * {GRID_DEG})::INT bx,
                                          floor((gy + 0.5) * {GRID_DEG})::INT byy
                          FROM '{PROCESSED / 'cells.parquet'}' ORDER BY 1, 2""").fetchall()
    return [(int(bx), int(by)) for bx, by in rows]


def _fetch_block(client: httpx.Client, block: tuple[int, int], last_year: int,
                 force: bool) -> tuple[bytes, bool]:
    bx, by = block
    dest = RAW / "power" / f"daily_{bx}_{by}_{FIRST_YEAR}_{last_year}.json.gz"
    if dest.exists() and not force:
        return gzip.decompress(dest.read_bytes()), True
    query = {
        "parameters": ",".join(PARAMS), "community": "ag", "format": "json",
        "latitude": by + 0.5, "longitude": bx + 0.5,
        "start": f"{FIRST_YEAR}0101", "end": f"{last_year}1231",
    }
    for attempt in range(5):
        try:
            r = client.get(POWER, params=query)
            if r.status_code in (429, 502, 503, 504):
                raise httpx.TransportError(f"status {r.status_code}")
            r.raise_for_status()
            body = r.content
            if b'"parameter"' not in body:
                raise RuntimeError(f"POWER refused block {block}: {body[:300]!r}")
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(gzip.compress(body))
            return body, False
        except (httpx.TransportError, httpx.HTTPStatusError):
            if attempt == 4:
                raise
            time.sleep(2 ** attempt * 3)
    raise RuntimeError("unreachable")


def _daily(body: bytes) -> pd.DataFrame:
    doc = json.loads(body)["properties"]["parameter"]
    df = pd.DataFrame({RENAME[p]: pd.Series(doc[p]) for p in PARAMS})
    df.index = pd.to_datetime(df.index, format="%Y%m%d")
    return df.replace(FILL, np.nan).sort_index()


def _kbdi(tmax: np.ndarray, precip: np.ndarray, mean_annual_mm: float) -> np.ndarray:
    """Keetch-Byram drought index, metric form, integrated daily (Crane 1982).

    A cumulative soil-moisture deficit: it climbs with heat and falls only when rain beats
    the runoff threshold, so it carries drought memory across months the way fuels do.
    """
    denom = 1.0 + 10.88 * np.exp(-0.001736 * mean_annual_mm)
    out = np.empty(len(tmax))
    q, spell = 0.0, 0.0
    for i in range(len(tmax)):
        rain = precip[i] if np.isfinite(precip[i]) else 0.0
        if rain > 0:
            spell += rain
            # only the rain beyond the spell's first WET_SPELL mm reaches the soil
            q = max(0.0, q - max(0.0, min(rain, spell - WET_SPELL)))
        else:
            spell = 0.0
        t = tmax[i] if np.isfinite(tmax[i]) else 0.0
        dq = (KBDI_CAP - q) * (0.968 * np.exp(0.0875 * t + 1.5552) - 8.30) * 1e-3 / denom
        q = min(KBDI_CAP, max(0.0, q + max(dq, 0.0)))
        out[i] = q
    return out


def _es(t: np.ndarray | pd.Series):
    """Saturation vapour pressure, kPa (Tetens)."""
    return 0.6108 * np.exp(17.27 * t / (t + 237.3))


def monthly_indices(daily: pd.DataFrame) -> pd.DataFrame:
    """Reduce one block's daily record to monthly fire-weather indices."""
    d = daily.copy()
    d["vpd"] = (_es(d.t2m) - _es(d.t2mdew)).clip(lower=0)
    d["dry"] = (d.precip < 1.0).astype(float)          # a rainless day for fuel purposes
    d["hot30"] = (d.t2m_max >= 30).astype(float)
    d["hot35"] = (d.t2m_max >= 35).astype(float)
    d["lowrh"] = (d.rh2m < 30).astype(float)
    d["hotdry"] = ((d.t2m_max >= 30) & (d.precip < 1.0) & (d.rh2m < 40)).astype(float)

    # consecutive dry days, counted on the continuous series so a run can cross a month end
    run = d.dry.copy().to_numpy()
    cdd = np.zeros(len(run))
    acc = 0.0
    for i, v in enumerate(run):
        acc = acc + 1 if v else 0.0
        cdd[i] = acc
    d["cdd"] = cdd
    mean_annual = float(d.precip.mean() * 365.25)
    d["kbdi"] = _kbdi(d.t2m_max.to_numpy(float), d.precip.to_numpy(float), mean_annual)

    g = d.groupby(pd.Grouper(freq="MS"))
    out = pd.DataFrame({
        "t2m": g.t2m.mean(), "t2m_max": g.t2m_max.mean(), "precip": g.precip.mean(),
        "rh2m": g.rh2m.mean(), "ws2m": g.ws2m.mean(), "gwetroot": g.gwetroot.mean(),
        "vpd": g.vpd.mean(),
        # extremes: the part a monthly mean throws away
        "t2m_max_p90": g.t2m_max.quantile(0.9), "vpd_p90": g.vpd.quantile(0.9),
        "vpd_max": g.vpd.max(), "ws_p90": g.ws2m_max.quantile(0.9), "ws_max": g.ws2m_max.max(),
        "gwet_min": g.gwetroot.min(), "rh_min": g.rh2m.min(),
        "hot30": g.hot30.sum(), "hot35": g.hot35.sum(), "dry_days": g.dry.sum(),
        "lowrh_days": g.lowrh.sum(), "hotdry_days": g.hotdry.sum(),
        "cdd_max": g.cdd.max(), "cdd_end": g.cdd.last(),
        "kbdi_end": g.kbdi.last(), "kbdi_max": g.kbdi.max(), "kbdi_mean": g.kbdi.mean(),
    })
    out.index.name = "month"
    return out.reset_index()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="re-download instead of using the cache")
    ap.add_argument("--last-year", type=int, default=dt.date.today().year - 1)
    args = ap.parse_args()

    t0 = time.time()
    blocks = _blocks()
    print(f"{len(blocks)} blocks x {len(PARAMS)} daily parameters, {FIRST_YEAR}-{args.last_year}")

    parts: list[pd.DataFrame] = []
    cached = 0
    with httpx.Client(headers=UA, timeout=300, follow_redirects=True) as client:
        def run(block):
            body, from_cache = _fetch_block(client, block, args.last_year, args.force)
            part = monthly_indices(_daily(body))
            part.insert(0, "bx", block[0])
            part.insert(1, "by", block[1])
            return part, from_cache

        with ThreadPoolExecutor(6) as pool:
            for i, (part, from_cache) in enumerate(pool.map(run, blocks), 1):
                parts.append(part)
                cached += from_cache
                if i % 50 == 0 or i == len(blocks):
                    print(f"  {i}/{len(blocks)} blocks ({time.time() - t0:.0f}s)", flush=True)

    wx = pd.concat(parts, ignore_index=True).sort_values(["bx", "by", "month"]).reset_index(drop=True)
    wx["month"] = wx.month.dt.date

    STAGED.mkdir(parents=True, exist_ok=True)
    out = STAGED / "weather.parquet"
    duckdb.sql(f"COPY wx TO '{out}' (FORMAT parquet, COMPRESSION zstd)")

    manifest = json.loads(MANIFEST.read_text()) if MANIFEST.exists() else {"files": {}}
    manifest["files"]["staged/weather.parquet"] = {
        "path": "staged/weather.parquet",
        "url": f"{POWER}?parameters={','.join(PARAMS)}&community=ag"
               f"&latitude=<LAT>&longitude=<LON>&start={FIRST_YEAR}0101&end={args.last_year}1231",
        "bytes": out.stat().st_size,
        "sha256": hashlib.sha256(out.read_bytes()).hexdigest(),
        "fetched_at": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
        "product": "NASA POWER daily (MERRA-2 reanalysis) reduced to monthly fire-weather indices",
        "parameters": PARAMS,
        "coverage": f"{FIRST_YEAR}-01..{args.last_year}-12, {len(blocks)} blocks at 1 deg centroids",
        "license": "NASA POWER - freely available, cite MERRA-2 / NASA POWER",
    }
    manifest["updated_at"] = dt.datetime.now(dt.UTC).isoformat(timespec="seconds")
    tmp = MANIFEST.with_suffix(".tmp")
    tmp.write_text(json.dumps(manifest, indent=1, sort_keys=True))
    tmp.replace(MANIFEST)
    MODELS.mkdir(parents=True, exist_ok=True)

    print(f"-> {out} ({out.stat().st_size / 1e6:.1f} MB) {len(wx):,} block-months, "
          f"{wx.month.min()}..{wx.month.max()}, {cached}/{len(blocks)} from cache, "
          f"{time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
