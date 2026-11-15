"""Step 6 - supervised early-warning model: how much will burn next month?

Unit of prediction is a 1 deg block x month. That is deliberately coarser than the 0.1 deg
harmonization grid: at 0.1 deg a monthly fire count is close to random, while at 1 deg the
seasonal and drought signal is strong enough to forecast. An arbitrary user area is served
by combining the blocks it overlaps, weighted by the area's historical share of each block.

Everything the model sees is known at the end of month t; the target is month t+h for
h = 1, 2, 3. Weather therefore enters only as *antecedent* conditions (how dry/hot has it
been), never as a forecast of the target month - that is how real seasonal fire outlooks
work, and it keeps the evaluation honest.

Two heads per horizon:
  regression     expected harmonized count in the target month (log1p target)
  classification P(target month is an anomalous fire month) -> the actual "warning"

Validated by expanding-window (forward) CV: a fold only ever trains on years strictly
before the years it predicts, and the climatology features are recomputed from each fold's
training years alone, so no fold can see its own future. Reported against four baselines,
including a fire-history-only model, so the contribution of weather is explicit.

    uv run python -m firerosetta.forecast
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import platform
import tarfile
import time
import warnings

import duckdb
import joblib
import numpy as np
import pandas as pd
import sklearn
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
from sklearn.metrics import average_precision_score, brier_score_loss, roc_auc_score

from . import gpu
from .config import GRID_DEG, MODELS, PROCESSED, STAGED
from .model import Link

# everything a fresh clone needs to run the model without retraining
BUNDLE_FILES = [
    (MODELS, "earlywarn.joblib"),      # the fitted estimators
    (MODELS, "earlywarn.json"),        # metrics + provenance
    (PROCESSED, "forecast_features.parquet"),  # per-block inputs, incl. the latest month
    (PROCESSED, "forecast_backtest.parquet"),  # held-out hindcasts, for per-area skill
]

warnings.filterwarnings("ignore")

LEADS = (1, 2, 3)           # months of lead time
KEYS = ["bx", "by"]         # 1 deg block
# expanding-window folds: (last training year, test years)
FOLDS = [(2015, (2016, 2017)), (2017, (2018, 2019)), (2019, (2020, 2021)),
         (2021, (2022, 2023)), (2023, (2024, 2025))]
WARN_RATIO = 2.0            # "anomalous" = more than 2x the block's normal for that month ...
WARN_FLOOR = 10.0           # ... and at least this many fires, so we don't warn on 1 vs 0.3

PARAM_GRID = [
    dict(learning_rate=0.05, max_leaf_nodes=31, min_samples_leaf=40, l2_regularization=1.0),
    dict(learning_rate=0.05, max_leaf_nodes=63, min_samples_leaf=20, l2_regularization=0.5),
    dict(learning_rate=0.10, max_leaf_nodes=31, min_samples_leaf=40, l2_regularization=1.0),
    dict(learning_rate=0.10, max_leaf_nodes=63, min_samples_leaf=20, l2_regularization=2.0),
]

# Monthly indices from weather.py that get a standardised per-block anomaly. Extremes
# (dry-day runs, hot days, drought index) matter far more than monthly means for fire.
WEATHER = ["t2m_max", "precip", "rh2m", "vpd", "gwetroot", "kbdi_end",
           "cdd_max", "hot35", "hotdry_days", "ws_p90"]
# raw (un-anomalised) index levels: an absolute 40-day dry run means the same everywhere
WEATHER_RAW = ["cdd_end", "cdd_max", "hot30", "hot35", "hotdry_days", "dry_days",
               "lowrh_days", "kbdi_end", "kbdi_max", "gwet_min", "vpd_p90", "ws_max", "rh_min"]

# features built from fire history alone - the ablation that shows what weather adds
HIST_FEATURES = [
    "y_lag1", "y_lag2", "y_lag3", "y_lag12", "y_roll3", "y_roll6", "y_roll12",
    "y_clim", "y_clim_annual", "y_ratio12", "months_since_active", "active_frac12",
    "seas", "lat", "lon",
]
WX_FEATURES = (
    [f"{c}_a{lag}" for c in WEATHER for lag in (0, 1)]
    + [f"{c}_l0" for c in WEATHER_RAW]
    + ["spi3", "spi6", "spi12", "dry_months6", "precip_deficit12",
       "kbdi_roll3", "gwet_roll3", "hotdry_roll3", "hotdry_roll12",
       "t2m_clim_target", "precip_clim_target", "vpd_clim_target"]
)
FEATURES = HIST_FEATURES + WX_FEATURES


def build_panel() -> pd.DataFrame:
    """Complete block x month panel: harmonized fire counts joined to block fire weather."""
    fire = duckdb.sql(f"""
        SELECT floor((gx + 0.5) * {GRID_DEG})::INT bx,
               floor((gy + 0.5) * {GRID_DEG})::INT by_,
               "month"::DATE AS "month", sum(harmonized) y
        FROM '{PROCESSED / 'harmonized.parquet'}' GROUP BY 1, 2, 3
    """).df()
    # weather.py already reduces POWER's daily record to monthly indices per 1 deg block
    wx = duckdb.sql(f"SELECT * FROM '{STAGED / 'weather.parquet'}'").df()
    wx = wx.rename(columns={"by": "by_"})
    wx["month"] = pd.to_datetime(wx.month)

    # reindex onto the full cross product: the harmonized table drops all-zero rows, and a
    # missing row would silently corrupt every lag and rolling window below.
    blocks = fire[["bx", "by_"]].drop_duplicates()
    months = pd.date_range(fire.month.min(), fire.month.max(), freq="MS")
    panel = blocks.merge(pd.DataFrame({"month": months}), how="cross")
    panel = panel.merge(fire, on=["bx", "by_", "month"], how="left")
    panel = panel.merge(wx, on=["bx", "by_", "month"], how="left")
    panel["y"] = panel.y.fillna(0.0)
    panel = panel.rename(columns={"by_": "by"})

    panel["month"] = pd.to_datetime(panel.month)
    panel["year"] = panel.month.dt.year
    panel["moy"] = panel.month.dt.month
    panel["lat"] = panel.by + 0.5
    panel["lon"] = panel.bx + 0.5
    panel["seas"] = np.where(panel.lat < 0, (panel.moy + 5) % 12 + 1, panel.moy)
    return panel.sort_values([*KEYS, "month"]).reset_index(drop=True)


def _roll(df: pd.DataFrame, series: pd.Series, win: int, minp: int, how: str = "mean") -> pd.Series:
    """Rolling window applied strictly within each block.

    `series` must already be shifted if the current month has to be excluded. Rolling a
    plain Series would run straight across block boundaries, so it is regrouped here.
    """
    r = series.groupby([df[k] for k in KEYS], sort=False).rolling(win, min_periods=minp)
    return getattr(r, how)().reset_index(level=[0, 1], drop=True)


def add_history(panel: pd.DataFrame) -> pd.DataFrame:
    """Fire-history features. Every column is a shift/rolling of the past only."""
    df = panel.copy()
    g = df.groupby(KEYS, sort=False).y
    for lag in (1, 2, 3, 12):
        df[f"y_lag{lag}"] = g.shift(lag)
    for win in (3, 6, 12):
        df[f"y_roll{win}"] = _roll(df, g.shift(1), win, max(2, win // 2))
    active = df.groupby(KEYS, sort=False).y.shift(1).gt(0).astype(float)
    df["active_frac12"] = _roll(df, active, 12, 6)
    # months since the block last had any fire, capped: a long quiet spell means fuel build-up
    since = []
    for _, grp in df.groupby(KEYS, sort=False):
        counter, out = 99, []
        for val in grp.y.values:
            out.append(min(counter, 99))
            counter = 0 if val > 0 else counter + 1
        since.append(pd.Series(out, index=grp.index, dtype=float))
    df["months_since_active"] = pd.concat(since).sort_index()

    # Weather at month t and t-1. Month t is the last month fully observed when the
    # forecast is made, so lag 0 is legitimate; the target month is never used.
    for col in dict.fromkeys([*WEATHER, *WEATHER_RAW]):
        gw = df.groupby(KEYS, sort=False)[col]
        for lag in (0, 1):
            df[f"{col}_l{lag}"] = gw.shift(lag)
    # trailing windows *including* month t, which is known when the forecast is made
    for win in (3, 6, 12):
        df[f"precip_roll{win}"] = _roll(df, df.precip, win, max(2, win // 2))
    df["kbdi_roll3"] = _roll(df, df.kbdi_mean, 3, 2)
    df["gwet_roll3"] = _roll(df, df.gwetroot, 3, 2)
    df["hotdry_roll3"] = _roll(df, df.hotdry_days, 3, 2)
    df["hotdry_roll12"] = _roll(df, df.hotdry_days, 12, 6)
    return df


def add_clim(df: pd.DataFrame, train_years: np.ndarray, leads: tuple[int, ...]) -> pd.DataFrame:
    """Climatology-anchored features, fitted on `train_years` only.

    Called once per CV fold (train years = that fold's past) and once for the final model
    (all years), so a fold's features never encode anything from the years it predicts.
    """
    out = df.copy()
    tr = out[out.year.isin(train_years)]

    # fire normals
    clim = tr.groupby([*KEYS, "moy"]).y.mean().rename("y_clim_moy")
    annual = tr.groupby(KEYS).y.mean().rename("y_clim_annual")
    out = out.join(clim, on=[*KEYS, "moy"]).join(annual, on=KEYS)
    out["y_clim_annual"] = out.y_clim_annual.fillna(0.0)
    out["y_ratio12"] = out.y_roll12 / out.y_clim_annual.replace(0, np.nan)

    # weather normals and standardised anomalies
    for col in WEATHER:
        norm = tr.groupby([*KEYS, "moy"])[col].agg(["mean", "std"])
        norm.columns = [f"{col}_mean", f"{col}_std"]
        out = out.join(norm, on=[*KEYS, "moy"])
        for lag in (0, 1):
            # anomaly of the lagged value against ITS OWN calendar-month normal
            lag_moy = ((out.moy - 1 - lag) % 12) + 1
            lag_norm = out[[*KEYS]].assign(moy=lag_moy).join(norm, on=[*KEYS, "moy"])
            out[f"{col}_a{lag}"] = ((out[f"{col}_l{lag}"] - lag_norm[f"{col}_mean"].values)
                                    / lag_norm[f"{col}_std"].replace(0, np.nan).values)

    # drought: standardised trailing precipitation over 3/6/12 months
    for win in (3, 6, 12):
        roll_norm = tr.assign(r=tr[f"precip_roll{win}"]).groupby([*KEYS, "moy"]).r.agg(["mean", "std"])
        roll_norm.columns = ["m", "s"]
        j = out[[*KEYS, "moy"]].join(roll_norm, on=[*KEYS, "moy"])
        out[f"spi{win}"] = (out[f"precip_roll{win}"] - j.m.values) / j.s.replace(0, np.nan).values
    # trailing-year rainfall against the block's annual normal: multi-season drought
    annual_p = tr.groupby(KEYS).precip.mean().rename("precip_annual")
    out = out.join(annual_p, on=KEYS)
    out["precip_deficit12"] = out.precip_roll12 - out.precip_annual
    p25 = tr.groupby([*KEYS, "moy"]).precip.quantile(0.25).rename("p25")
    out = out.join(p25, on=[*KEYS, "moy"])
    out["dry_months6"] = _roll(out, out.precip.lt(out.p25).astype(float), 6, 3, how="sum")

    # the TARGET month's own normals are known in advance (they are climatology, not a forecast)
    for lead in leads:
        tgt_moy = ((out.moy - 1 + lead) % 12) + 1
        tgt = out[[*KEYS]].assign(moy=tgt_moy)
        out[f"y_clim_h{lead}"] = tgt.join(clim, on=[*KEYS, "moy"]).y_clim_moy.values
        for col in ("t2m", "precip", "vpd"):
            norm = tr.groupby([*KEYS, "moy"])[col].mean().rename("v")
            out[f"{col}_clim_target_h{lead}"] = tgt.join(norm, on=[*KEYS, "moy"]).v.values
    return out


def frame_for_lead(df: pd.DataFrame, lead: int) -> pd.DataFrame:
    """Attach the lead-specific target-month columns and the label for horizon `lead`."""
    out = df.copy()
    out["y_clim"] = out[f"y_clim_h{lead}"]
    for col in ("t2m", "precip", "vpd"):
        out[f"{col}_clim_target"] = out[f"{col}_clim_target_h{lead}"]
    g = out.groupby(KEYS, sort=False)
    out["target"] = g.y.shift(-lead)
    out["target_month"] = g.month.shift(-lead)
    out["warn"] = ((out.target > WARN_RATIO * out.y_clim) & (out.target >= WARN_FLOOR)).astype(int)
    return out


def _fit(params: dict, X, y):
    return Link(**params).fit(X, y)


def _wape(pred, obs):
    return float(100 * np.abs(pred - obs).sum() / max(obs.sum(), 1e-9))


def _r2(pred, obs):
    return float(1 - ((pred - obs) ** 2).sum() / max(((obs - obs.mean()) ** 2).sum(), 1e-9))


def tune(df: pd.DataFrame, feats: list[str]) -> dict:
    """Pick hyperparameters on the earliest fold only, so later folds stay clean."""
    last_train, test_years = FOLDS[0]
    best, best_score = PARAM_GRID[0], np.inf
    for params in PARAM_GRID:
        tr = df[(df.year <= last_train) & df.target.notna()]
        te = df[df.year.isin(test_years) & df.target.notna()]
        pred = _fit(params, tr[feats], tr.target).predict(te[feats]).clip(0)
        score = _wape(pred, te.target.values)
        if score < best_score:
            best, best_score = params, score
    return best


def run_cv(panel: pd.DataFrame, lead: int, feats: list[str], params: dict,
           want_clf: bool) -> tuple[pd.DataFrame, dict]:
    """Expanding-window hindcast. Returns per-row out-of-sample predictions and metrics."""
    parts = []
    for last_train, test_years in FOLDS:
        train_years = np.arange(panel.year.min(), last_train + 1)
        fold = frame_for_lead(add_clim(panel, train_years, (lead,)), lead)
        tr = fold[(fold.year <= last_train) & fold.target.notna()]
        te = fold[fold.year.isin(test_years) & fold.target.notna()].copy()
        if te.empty:
            continue
        te["pred"] = _fit(params, tr[feats], tr.target).predict(te[feats]).clip(0)
        if want_clf:
            clf = HistGradientBoostingClassifier(
                max_iter=300, early_stopping=True, n_iter_no_change=25, validation_fraction=0.12,
                random_state=0, **params)
            if tr.warn.nunique() > 1:
                clf.fit(tr[feats], tr.warn)
                te["warn_prob"] = clf.predict_proba(te[feats])[:, 1]
            else:
                te["warn_prob"] = 0.0
        parts.append(te)
    hind = pd.concat(parts, ignore_index=True)
    return hind, score_block_and_country(hind, want_clf)


def score_block_and_country(hind: pd.DataFrame, want_clf: bool) -> dict:
    """Skill of the forecast and of the baselines, at block and country-ish (5 deg) scale."""
    obs = hind.target.values
    out = {"n": int(len(hind)), "total_obs": round(float(obs.sum()))}
    cands = {"model": hind.pred.values, "climatology": hind.y_clim.fillna(0).values,
             "persistence": hind.y_lag1.fillna(0).values, "seasonal_naive": hind.y_lag12.fillna(0).values}
    out["block_month"] = {k: {"wape": round(_wape(v, obs), 1), "r2": round(_r2(v, obs), 3),
                              "bias": round(float(100 * (v - obs).sum() / max(obs.sum(), 1e-9)), 1)}
                          for k, v in cands.items()}
    # aggregate to 5 deg x month, the scale a regional outlook is actually read at
    agg = hind.assign(rx=(hind.bx // 5), ry=(hind.by // 5))
    gb = agg.groupby(["rx", "ry", "target_month"])
    a_obs = gb.target.sum().values
    out["region5_month"] = {}
    for k, col in (("model", "pred"), ("climatology", "y_clim"),
                   ("persistence", "y_lag1"), ("seasonal_naive", "y_lag12")):
        a_pred = gb[col].sum().values
        out["region5_month"][k] = {"wape": round(_wape(a_pred, a_obs), 1),
                                   "r2": round(_r2(a_pred, a_obs), 3)}
    if want_clf and hind.warn.nunique() > 1:
        out["warning"] = {
            "base_rate": round(float(hind.warn.mean()), 4),
            "roc_auc": round(float(roc_auc_score(hind.warn, hind.warn_prob)), 3),
            "avg_precision": round(float(average_precision_score(hind.warn, hind.warn_prob)), 3),
            "brier": round(float(brier_score_loss(hind.warn, hind.warn_prob)), 4),
            "definition": f"target month > {WARN_RATIO}x block normal for that calendar month "
                          f"and >= {WARN_FLOOR:.0f} fires",
        }
    return out


def package() -> None:
    """Tar the model with the tables it needs, so a clone can forecast without retraining."""
    missing = [n for d, n in BUNDLE_FILES if not (d / n).exists()]
    if missing:
        raise SystemExit(f"nothing to package, these are missing: {', '.join(missing)}")
    out = MODELS / "firerosetta-earlywarn.tar.gz"
    with tarfile.open(out, "w:gz") as tar:
        for d, name in BUNDLE_FILES:
            # Store each file under the data/ subdirectory it belongs in, so every release
            # bundle extracts the same way: tar -xzf <bundle> -C data. No per-bundle routing.
            tar.add(d / name, arcname=f"{'models' if d == MODELS else 'processed'}/{name}")
    digest = hashlib.sha256(out.read_bytes()).hexdigest()
    (MODELS / "firerosetta-earlywarn.sha256").write_text(f"{digest}  {out.name}\n")
    print(f"-> {out} ({out.stat().st_size / 1e6:.1f} MB)\n   sha256 {digest}")
    print("   publish with: ./scripts/release.sh publish earlywarn")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--package", action="store_true",
                    help="only re-tar the existing model for release, without retraining")
    args = ap.parse_args()
    if args.package:
        package()
        return

    # Says which hardware this is on. HistGradientBoosting is CPU-only in scikit-learn - there
    # is no CUDA path to switch on - so this reports rather than chooses.
    gpu.require("early-warning models (scikit-learn HistGradientBoosting: CPU only)")
    t0 = time.time()
    panel = build_panel()
    panel = add_history(panel)
    print(f"panel: {len(panel):,} block-months, {panel[KEYS].drop_duplicates().shape[0]} blocks, "
          f"{panel.month.min().date()}..{panel.month.max().date()} ({time.time() - t0:.0f}s)")
    wx_cov = panel[WEATHER].notna().all(axis=1).mean()
    print(f"weather coverage: {100 * wx_cov:.1f}% of block-months")

    all_years = np.sort(panel.year.unique())
    metrics: dict = {
        "unit": "1 deg block x month", "leads": list(LEADS),
        "trained_at": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
        "data": {"first_month": str(panel.month.min().date()), "last_month": str(panel.month.max().date()),
                 "blocks": int(panel[KEYS].drop_duplicates().shape[0])},
        "cv": "expanding-window: " + ", ".join(f"<={a}->{b[0]}-{b[1]}" for a, b in FOLDS),
        "warning_definition": f"target > {WARN_RATIO}x block normal for that month and >= {WARN_FLOOR:.0f}",
        "features": {"history": HIST_FEATURES, "weather": WX_FEATURES},
        "weather_source": "NASA POWER daily (MERRA-2) fire-weather indices, antecedent months only",
        # pickled estimators are tied to the library that made them; record it so a
        # mismatched clone gets a clear message instead of a confusing failure
        "env": {"python": platform.python_version(), "sklearn": sklearn.__version__,
                "numpy": np.__version__, "pandas": pd.__version__, "joblib": joblib.__version__},
        "leads_detail": {},
    }

    MODELS.mkdir(parents=True, exist_ok=True)
    # Only plain scikit-learn estimators and plain Python go in here: a bundle holding a
    # firerosetta class could only be opened inside this project, which defeats publishing it.
    bundle: dict = {"features": FEATURES, "hist_features": HIST_FEATURES, "leads": list(LEADS),
                    "keys": KEYS, "warn_ratio": WARN_RATIO, "warn_floor": WARN_FLOOR,
                    "predict_recipe": "expected counts = reg_h<lead>_iso.predict("
                                      "reg_h<lead>_gbm.predict(X[features])).clip(0); "
                                      "P(anomalous month) = clf_h<lead>.predict_proba(X[features])[:, 1]. "
                                      "For lead h, set X['y_clim'] = X['y_clim_h<h>'] and "
                                      "X['<c>_clim_target'] = X['<c>_clim_target_h<h>'] for c in "
                                      "(t2m, precip, vpd) before selecting `features`."}
    hindcasts = []

    for lead in LEADS:
        tuning = frame_for_lead(add_clim(panel, all_years[all_years <= FOLDS[0][0]], (lead,)), lead)
        params = tune(tuning, FEATURES)

        hind, sc = run_cv(panel, lead, FEATURES, params, want_clf=True)
        hist_hind, hist_sc = run_cv(panel, lead, HIST_FEATURES, params, want_clf=False)
        hind["pred_hist_only"] = hist_hind.set_index([*KEYS, "target_month"]).pred.reindex(
            pd.MultiIndex.from_frame(hind[[*KEYS, "target_month"]])).values

        full = frame_for_lead(add_clim(panel, all_years, (lead,)), lead)
        tr = full[full.target.notna()]
        reg = _fit(params, tr[FEATURES], tr.target)
        clf = HistGradientBoostingClassifier(max_iter=300, early_stopping=True, n_iter_no_change=25,
                                             validation_fraction=0.12, random_state=0, **params)
        clf.fit(tr[FEATURES], tr.warn)
        # stored as its two sklearn halves rather than as a Link, see model.py
        bundle[f"reg_h{lead}_gbm"], bundle[f"reg_h{lead}_iso"] = reg.gbm, reg.iso
        bundle[f"clf_h{lead}"] = clf

        metrics["leads_detail"][str(lead)] = {
            "hyperparams": params, "with_weather": sc,
            "history_only": {"block_month": hist_sc["block_month"]["model"],
                             "region5_month": hist_sc["region5_month"]["model"]},
        }
        hind["lead"] = lead
        hindcasts.append(hind)
        b, r = sc["block_month"], sc["region5_month"]
        print(f"\nlead {lead} ({params})")
        print(f"  block x month   model WAPE {b['model']['wape']:.1f}% R2 {b['model']['r2']:.3f} | "
              f"hist-only R2 {hist_sc['block_month']['model']['r2']:.3f} | "
              f"clim R2 {b['climatology']['r2']:.3f} | persist R2 {b['persistence']['r2']:.3f}")
        print(f"  5deg  x month   model WAPE {r['model']['wape']:.1f}% R2 {r['model']['r2']:.3f} | "
              f"hist-only R2 {hist_sc['region5_month']['model']['r2']:.3f} | "
              f"clim R2 {r['climatology']['r2']:.3f}")
        if "warning" in sc:
            w = sc["warning"]
            print(f"  warning         base {100 * w['base_rate']:.1f}%  AUC {w['roc_auc']:.3f}  "
                  f"AP {w['avg_precision']:.3f}  Brier {w['brier']:.4f}")

    # ---------- artefacts ----------
    joblib.dump(bundle, MODELS / "earlywarn.joblib", compress=3)

    feat_tbl = frame_for_lead(add_clim(panel, all_years, LEADS), LEADS[0])
    keep = [*KEYS, "month", "year", "moy", "y", *FEATURES,
            *[f"y_clim_h{h}" for h in LEADS],
            *[f"{c}_clim_target_h{h}" for h in LEADS for c in ("t2m", "precip", "vpd")]]
    feat_tbl = feat_tbl[[c for c in dict.fromkeys(keep)]].copy()
    for c in feat_tbl.columns:
        if feat_tbl[c].dtype == np.float64:
            feat_tbl[c] = feat_tbl[c].astype(np.float32)
    duckdb.sql(f"COPY feat_tbl TO '{PROCESSED / 'forecast_features.parquet'}' "
               f"(FORMAT parquet, COMPRESSION zstd)")

    hc = pd.concat(hindcasts, ignore_index=True)[
        [*KEYS, "lead", "month", "target_month", "target", "pred", "pred_hist_only",
         "y_clim", "y_lag1", "y_lag12", "warn", "warn_prob"]].copy()
    for c in ("target", "pred", "pred_hist_only", "y_clim", "y_lag1", "y_lag12", "warn_prob"):
        hc[c] = hc[c].astype(np.float32)
    duckdb.sql(f"COPY hc TO '{PROCESSED / 'forecast_backtest.parquet'}' "
               f"(FORMAT parquet, COMPRESSION zstd)")

    metrics["artefacts"] = {
        "model": "earlywarn.joblib",
        "features_table": "forecast_features.parquet",
        "backtest": "forecast_backtest.parquet",
    }
    (MODELS / "earlywarn.json").write_text(json.dumps(metrics, indent=1))
    (PROCESSED / "forecast_metrics.json").write_text(json.dumps(metrics, indent=1))

    size = (MODELS / "earlywarn.joblib").stat().st_size / 1e6
    print(f"\n-> {MODELS / 'earlywarn.joblib'} ({size:.1f} MB), features + backtest in {PROCESSED}")
    package()
    print(f"done in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
