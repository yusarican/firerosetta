"""Step 4 - learn MODIS -> VIIRS-equivalent counts on the overlap years and validate it.

Reference ruler: S-NPP VIIRS 375 m hotspots (vegetation fires, confidence >= nominal)
per 0.1 deg cell per month. Three links put the whole record on that ruler:

  2000-11 .. 2002-06   Terra only          -> model "terra"
  2002-07 .. 2012-01   Terra + Aqua        -> model "full"
  2012-02 .. 2026-10   S-NPP observed      -> used as is (training/CV only on standard-product
                                              months; NRT months are served but marked provisional)
  2026-11 ..           NOAA-20             -> x k (k learned on 2018-2025 overlap)

Validation is year-blocked 5-fold CV: every overlap month is predicted by a model
that never saw its year. Those out-of-fold predictions are stored next to the
observations so the API can show model skill for *any* user-drawn area.

    uv run python -m firerosetta.harmonize
"""
from __future__ import annotations

import json
import time
import warnings

import duckdb
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.isotonic import IsotonicRegression

from .config import GRID_DEG, PROCESSED, STAGED

warnings.filterwarnings("ignore")

OVERLAP_START = "2012-02-01"   # S-NPP science data starts 2012-01-20; first full month
AQUA_START = "2002-07-01"
SNPP_LAST_MONTH = "2026-10-01"  # S-NPP delivery ended 2026-11-02

FEATURES = {
    "full": ["m_n", "m_terra", "m_aqua", "m_night", "m_frp", "m_nb3", "m_nb7", "m_clim", "seas", "lat", "lon"],
    "terra": ["m_terra", "m_terra_night", "m_terra_frp", "t_nb3", "t_nb7", "t_clim", "seas", "lat", "lon"],
}
N_FOLDS = 5


class Link:
    """Gradient-boosted trees on log1p(count), then isotonic recalibration back to counts
    (a log-target model alone under-predicts big fire months; isotonic removes that bias)."""

    def fit(self, X, y, w):
        self.gbm = HistGradientBoostingRegressor(
            max_iter=150, learning_rate=0.1, max_leaf_nodes=63, min_samples_leaf=100,
            l2_regularization=1.0, random_state=0)
        self.gbm.fit(X, np.log1p(y), sample_weight=w)
        self.iso = IsotonicRegression(y_min=0, out_of_bounds="clip").fit(self.gbm.predict(X), y, sample_weight=w)
        return self

    def predict(self, X):
        return self.iso.predict(self.gbm.predict(X))


def _score(df: pd.DataFrame, keys: list[str], cols: dict[str, str]) -> dict:
    a = df.groupby(keys, observed=True)[["v_snpp", *cols.values()]].sum()
    out = {"n": int(len(a))}
    for name, c in cols.items():
        e = a[c] - a.v_snpp
        out[name] = {
            "wape": round(float(100 * e.abs().sum() / a.v_snpp.sum()), 2),
            "bias": round(float(100 * e.sum() / a.v_snpp.sum()), 2),
            "r2": round(float(1 - (e**2).sum() / ((a.v_snpp - a.v_snpp.mean()) ** 2).sum()), 4),
        }
    return out


def main() -> None:
    t0 = time.time()
    df = duckdb.sql(f"SELECT * FROM '{PROCESSED / 'cell_month.parquet'}'").df()
    hs = STAGED / "hotspots.parquet"
    nrt_from = {p: str(d) for p, d in duckdb.sql(
        f"SELECT platform, min(acq_date) FROM '{hs}' WHERE is_nrt GROUP BY 1 ORDER BY 1").fetchall()}
    data_through = str(duckdb.sql(f"SELECT max(acq_date) FROM '{hs}'").fetchall()[0][0])
    # train / validate only on months whose S-NPP counts are entirely standard product
    train_last = SNPP_LAST_MONTH
    if "SNPP" in nrt_from:
        train_last = str((pd.Timestamp(nrt_from["SNPP"]).to_period("M") - 1).to_timestamp().date())
    df["lat"] = (df.gy + 0.5) * GRID_DEG
    df["lon"] = (df.gx + 0.5) * GRID_DEG
    # season index: southern-hemisphere months shifted by six so "summer" lines up
    df["seas"] = np.where(df.lat < 0, (df.moy + 5) % 12 + 1, df.moy)
    month = pd.to_datetime(df.month)
    ov = (month >= OVERLAP_START).values & (month <= train_last).values
    snpp_obs = (month >= OVERLAP_START).values & (month <= SNPP_LAST_MONTH).values
    y = df.v_snpp.to_numpy(float)

    # Most cell-months are empty for every sensor. Keep all informative rows, 10 % of the
    # empty ones with weight 10: same expectation, a third of the training time.
    rng = np.random.default_rng(0)
    active = ((df.m_nb7 > 0) | (y > 0)).values
    pool = ov & (active | (rng.random(len(df)) < 0.1))
    w = np.where(active, 1.0, 10.0)

    years = np.sort(df.year[ov].unique())
    folds = [years[i::N_FOLDS] for i in range(N_FOLDS)]
    for name, feats in FEATURES.items():
        oof = np.full(len(df), np.nan)
        for held in folds:
            te = ov & df.year.isin(held).values
            tr = pool & ~te
            oof[te] = Link().fit(df.loc[tr, feats], y[tr], w[tr]).predict(df.loc[te, feats])
        df[f"oof_{name}"] = oof
        df[f"pred_{name}"] = Link().fit(df.loc[pool, feats], y[pool], w[pool]).predict(df[feats])
        print(f"{name}: CV + final fit done ({time.time() - t0:.0f}s)", flush=True)

    # NOAA-20 -> S-NPP: same instrument design, ~50 min apart; a scalar is enough
    n20 = (month >= "2018-05-01").values & ov
    k_n20 = float(df.v_snpp[n20].sum() / df.v_n20[n20].sum())

    has_aqua = (month >= AQUA_START).values
    after_snpp = (month > SNPP_LAST_MONTH).values
    df["era"] = np.select([after_snpp, snpp_obs, has_aqua], ["noaa20", "snpp", "modis"], "terra")
    df["harmonized"] = np.select(
        [after_snpp, snpp_obs, has_aqua], [df.v_n20 * k_n20, y, df.pred_full], df.pred_terra)
    df["model"] = np.where(has_aqua, df.pred_full, df.pred_terra)  # MODIS-based estimate, every month

    # ---------- validation ----------
    v = df[ov].copy()
    v["b1x"], v["b1y"] = np.floor(v.lon), np.floor(v.lat)
    v["raw"] = v.m_n.astype(float)
    v["ratio"] = np.nan
    for held in folds:  # one global scale factor, also out-of-fold: the fair simple baseline
        te = v.year.isin(held)
        v.loc[te, "ratio"] = v.m_n[te] * v.v_snpp[~te].sum() / v.m_n[~te].sum()
    cols = {"raw_modis": "raw", "global_ratio": "ratio", "model_full": "oof_full", "model_terra": "oof_terra"}
    scales = {
        "cell_month": ["country", "gx", "gy", "month"],
        "block1deg_month": ["country", "b1x", "b1y", "month"],
        "country_month": ["country", "month"],
        "country_year": ["country", "year"],
    }
    cm = v.groupby(["country", "month"], observed=True)[["v_snpp", "raw", "oof_full", "oof_terra"]].sum().reset_index()
    by_year = v.groupby("year")[["v_snpp", "m_n", "m_terra", "m_aqua"]].sum()
    v20 = df[n20].groupby(["country", "month"])[["v_snpp", "v_n20"]].sum()
    metrics = {
        "reference": "S-NPP VIIRS 375 m, type=0 (vegetation fire), confidence >= nominal",
        "grid_deg": GRID_DEG,
        "overlap": [OVERLAP_START, str(month[ov].max().date())],
        "cv": f"{N_FOLDS}-fold, blocked by calendar year",
        "features": FEATURES,
        "train_rows": int(pool.sum()),
        "provisional": {
            "nrt_from": nrt_from,
            "data_through": data_through,
            "note": "NRT (near-real-time) rows replace the standard product until it is published. "
                    "NRT has no `type` field; static sources are masked from the standard record "
                    "(held-out 2025 check: VIIRS vegetation-count error +12.8% -> -1.5%).",
        },
        "scales": {s: _score(v, k, cols) for s, k in scales.items()},
        "per_country": {
            c: _score(g, ["b1x", "b1y", "month"], cols) | {"country_month": _score(g, ["month"], cols)}
            for c, g in v.groupby("country")
        },
        "noaa20_link": {
            "k": round(k_n20, 4),
            "country_month_wape": round(float(100 * (v20.v_n20 * k_n20 - v20.v_snpp).abs().sum() / v20.v_snpp.sum()), 2),
            "overlap": ["2018-05-01", str(month[n20].max().date())],
        },
        "modis_to_viirs_ratio_by_year": {
            int(yr): {"viirs_per_modis": round(float(r.v_snpp / r.m_n), 3),
                      "terra_per_aqua": round(float(r.m_terra / r.m_aqua), 3)}
            for yr, r in by_year.iterrows()
        },
        "scatter_country_month": [
            {"country": r.country, "month": str(r.month)[:7], "obs": int(r.v_snpp), "raw": int(r.raw),
             "full": round(float(r.oof_full), 1), "terra": round(float(r.oof_terra), 1)}
            for r in cm.itertuples()
        ],
    }
    (PROCESSED / "metrics.json").write_text(json.dumps(metrics, indent=1))

    keep = ["country", "gx", "gy", "month", "year", "moy", "m_n", "m_terra", "m_aqua", "m_frp",
            "v_snpp", "v_n20", "model", "oof_full", "oof_terra", "harmonized", "era"]
    out = PROCESSED / "harmonized.parquet"
    duckdb.sql(f"""COPY (SELECT {', '.join(keep)} FROM df
                   WHERE m_n > 0 OR v_snpp > 0 OR v_n20 > 0 OR harmonized > 0.005 OR oof_full > 0.005)
                   TO '{out}' (FORMAT parquet, COMPRESSION zstd)""")
    cells = PROCESSED / "cells.parquet"
    duckdb.sql(f"COPY (SELECT DISTINCT country, gx, gy FROM df) TO '{cells}' (FORMAT parquet)")
    for s in ("block1deg_month", "country_month", "country_year"):
        print(s, {k: v_ for k, v_ in metrics["scales"][s].items() if k != "n"})
    print("noaa20", metrics["noaa20_link"])
    print(f"-> {out} ({out.stat().st_size / 1e6:.0f} MB) in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
