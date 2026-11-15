"""Step 6b - CUDA-trained replacement for the early-warning heads.

Why this exists
---------------
`forecast.py` is honest - its published numbers reproduce exactly from the stored
hindcast - but the *warning* head, the thing the app actually shows, was weak: ROC-AUC
0.770 and average precision 0.194 against a 6.6% base rate at lead 1, and at the UI's own
"high" cut (p >= 0.50) it fired on 0.23% of block-months and caught 1.7% of the real
anomalous months. Three fixable causes:

  1. `tune()` searched four hand-written configs, scored the *regressor* only, and handed
     the winner to the classifier unchanged. The classifier was never tuned at all.
  2. Both heads early-stopped on `validation_fraction=0.12`, which scikit-learn draws at
     *random*. In a block x month panel the neighbouring months of the same block land on
     both sides of that split, so early stopping was reading its own training signal.
  3. The isotonic recalibration was fitted on the model's own *training* predictions,
     where a boosted tree is near-perfect, so the curve came out close to the identity
     and left the -12% low bias in place. Nothing calibrated the warning probabilities at
     all, which is why p >= 0.50 almost never happened.

What CUDA buys
--------------
Nothing by itself. It buys search. XGBoost on this GPU fits this panel ~19x faster than
the CPU (measured, 80k x 58 x 400 trees: 41.5 s -> 2.2 s), which is what makes a
randomized search over both heads, three expanding inner splits per fit, and a separate
calibration stage affordable at all. The accuracy comes from the search, the temporal
splitting and the calibration; the GPU is what makes them cheap enough to run.

Cross-fitting
-------------
Each head is fitted three times on expanding inner splits *inside* the training window,
which yields (a) out-of-sample predictions over the window's last six years and (b) a
tree count. The final head is then grown on the whole training window at that tree count,
and its calibrator is fitted on the cross-fitted predictions. So no data is thrown away
and nothing is calibrated on itself. A first cut that simply held out the last two
training years lost to the incumbent by 7 WAPE points, because those are the two years
that matter most.

Everything else is held identical to `forecast.py` - same panel, same folds, same target,
same warning definition, same metrics - so the comparison printed at the end is a
like-for-like swap and not a change of yardstick. One difference runs *against* this
script: `forecast.py` picked its hyperparameters by scoring on 2016-2017, which are then
part of the pooled hindcast it reports, while this one tunes strictly inside fold 0's
training window. The incumbent's published numbers carry a small optimism that these
do not.

    uv run python -m firerosetta.forecast_gpu              # train, compare, install if better
    uv run python -m firerosetta.forecast_gpu --force      # install even if it loses
    uv run python -m firerosetta.forecast_gpu --package    # only re-tar the existing model
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import pathlib
import platform
import time
import warnings

import duckdb
import joblib
import numpy as np
import pandas as pd
import sklearn
from sklearn.isotonic import IsotonicRegression
from sklearn.metrics import average_precision_score, brier_score_loss, roc_auc_score

from . import gpu
from .config import MODELS, PROCESSED
from .forecast import (
    FOLDS, HIST_FEATURES, KEYS, LEADS, WARN_FLOOR, WARN_RATIO, WX_FEATURES,
    _r2, _wape, add_clim, add_history, build_panel, frame_for_lead, package,
)

warnings.filterwarnings("ignore")

# Neighbour context: a 1 deg block's fire season is not independent of the ring around it,
# and the incumbent feature set carries no spatial information beyond raw lat/lon. Every
# source column is already lagged or current-month, so this adds no look-ahead.
NB_SOURCE = ["y_lag1", "y_roll3", "y_roll12", "kbdi_end_l0", "vpd_l0", "gwetroot_l0",
             "hotdry_days_l0", "cdd_max_l0"]
NB_FEATURES = [f"nb_{c}" for c in NB_SOURCE]
FEATURES = HIST_FEATURES + WX_FEATURES + NB_FEATURES

N_SEARCH = 32           # random configs per head per lead
INNER_FOLDS = 3         # expanding inner splits for stopping + cross-fitted calibration
INNER_VAL_YEARS = 2     # years validated by each inner split
ES_ROUNDS = 50
TUNE_TREES = 1200
MAX_TREES = 2500

# Weight on the XGBoost member when blending it with the incumbent scikit-learn heads.
# Fixed at one half on purpose: two models, equal say. A sweep over the hindcast put the
# optimum near 0.4 (block R2 +0.007 instead of +0.006 at lead 1), but picking 0.4 would be
# selecting a parameter on the evaluation set to win by a thousandth, so 0.5 it is.
BLEND_W = 0.5
HGB_HINDCAST = "forecast_backtest_hgb.parquet"   # the incumbent's, kept for re-runs


def add_neighbours(df: pd.DataFrame) -> pd.DataFrame:
    """Mean of each source column over the 8 touching 1 deg blocks, same month.

    Built by relabelling every block's own row onto its 8 neighbours and averaging, not by
    8 joins. Blocks on the edge of the domain simply average over fewer rows.
    """
    base = df[[*KEYS, "month", *NB_SOURCE]]
    parts = []
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            if dx == 0 and dy == 0:
                continue
            p = base.copy()
            p["bx"] = p.bx + dx
            p["by"] = p.by + dy
            parts.append(p)
    nb = pd.concat(parts, ignore_index=True).groupby([*KEYS, "month"])[NB_SOURCE].mean()
    nb.columns = NB_FEATURES
    return df.join(nb, on=[*KEYS, "month"])


# ---------------------------------------------------------------- search space

def sample_reg(rng: np.random.Generator) -> dict:
    """One random regression config. `shape` chooses how the count target is modelled."""
    return {
        "shape": str(rng.choice(["log1p", "poisson", "tweedie"])),
        "tweedie_variance_power": float(rng.uniform(1.1, 1.9)),
        "learning_rate": float(np.exp(rng.uniform(np.log(0.03), np.log(0.20)))),
        "max_depth": int(rng.integers(4, 11)),
        "min_child_weight": float(np.exp(rng.uniform(np.log(1), np.log(64)))),
        "subsample": float(rng.uniform(0.6, 1.0)),
        "colsample_bytree": float(rng.uniform(0.4, 1.0)),
        "reg_lambda": float(np.exp(rng.uniform(np.log(0.5), np.log(50)))),
        "reg_alpha": float(np.exp(rng.uniform(np.log(1e-3), np.log(5)))),
        "max_bin": int(rng.choice([128, 256, 512])),
    }


def sample_clf(rng: np.random.Generator) -> dict:
    return {
        # the incumbent left this at 1 against a 6.6% base rate and never tuned it
        "scale_pos_weight": float(rng.choice([1.0, 2.0, 4.0, 8.0, 17.0])),
        "learning_rate": float(np.exp(rng.uniform(np.log(0.03), np.log(0.20)))),
        "max_depth": int(rng.integers(3, 10)),
        "min_child_weight": float(np.exp(rng.uniform(np.log(1), np.log(64)))),
        "subsample": float(rng.uniform(0.6, 1.0)),
        "colsample_bytree": float(rng.uniform(0.4, 1.0)),
        "reg_lambda": float(np.exp(rng.uniform(np.log(0.5), np.log(50)))),
        "reg_alpha": float(np.exp(rng.uniform(np.log(1e-3), np.log(5)))),
        "max_bin": int(rng.choice([128, 256, 512])),
    }


def _kw(p: dict, device: str, n_trees: int, early: bool) -> dict:
    out = {k: v for k, v in p.items() if k not in ("shape", "tweedie_variance_power")}
    out |= {"device": device, "tree_method": "hist", "n_estimators": n_trees,
            "verbosity": 0, "random_state": 0}
    if early:
        out["early_stopping_rounds"] = ES_ROUNDS
    return out


def _make(kind: str, p: dict, device: str, n_trees: int, early: bool):
    import xgboost as xgb

    kw = _kw(p, device, n_trees, early)
    if kind == "clf":
        return xgb.XGBClassifier(**kw, objective="binary:logistic", eval_metric="aucpr")
    obj = {"log1p": "reg:squarederror", "poisson": "count:poisson",
           "tweedie": "reg:tweedie"}[p["shape"]]
    if p["shape"] == "tweedie":
        kw["tweedie_variance_power"] = p["tweedie_variance_power"]
    return xgb.XGBRegressor(**kw, objective=obj)


def _label(kind: str, p: dict, df: pd.DataFrame) -> np.ndarray:
    if kind == "clf":
        return df.warn.values
    y = df.target.values.astype(float)
    return np.log1p(y) if p["shape"] == "log1p" else y


def _raw(kind: str, m, X) -> np.ndarray:
    return m.predict_proba(X)[:, 1] if kind == "clf" else m.predict(X)


def _inner_splits(last_train: int) -> list[tuple[int, int]]:
    """Expanding (train_through, validate_through) pairs inside the training window."""
    v = INNER_VAL_YEARS
    return [(last_train - v * (k + 1), last_train - v * k)
            for k in reversed(range(INNER_FOLDS))]


# ---------------------------------------------------------------- one head

def fit_head(kind: str, p: dict, fold: pd.DataFrame, feats: list[str], last_train: int,
             device: str, n_trees: int = MAX_TREES, cross_fit: bool = True):
    """Cross-fitted head: final model on the whole window + an honest calibrator.

    Returns (model, calibrator). `calibrator` maps the model's raw output onto the thing
    being predicted - counts for the regressor, a probability for the classifier - and is
    always fitted on predictions the fitting model had not seen.
    """
    ok = fold.target.notna()
    oof_p, oof_y, iters = [], [], []
    splits = _inner_splits(last_train) if cross_fit else _inner_splits(last_train)[-1:]
    for a, b in splits:
        tr = fold[ok & (fold.year <= a)]
        va = fold[ok & (fold.year > a) & (fold.year <= b)]
        if tr.empty or va.empty:
            continue
        ytr, yva = _label(kind, p, tr), _label(kind, p, va)
        if kind == "clf" and (len(np.unique(ytr)) < 2 or len(np.unique(yva)) < 2):
            continue
        m = _make(kind, p, device, n_trees, early=True)
        m.fit(tr[feats], ytr, eval_set=[(va[feats], yva)], verbose=False)
        iters.append(int(m.best_iteration) + 1)
        oof_p.append(_raw(kind, m, va[feats]))
        oof_y.append(va.warn.values if kind == "clf" else va.target.values)
    if not iters:
        return None, None

    tr_all = fold[ok & (fold.year <= last_train)]
    final = _make(kind, p, device, max(int(np.mean(iters)), 10), early=False)
    final.fit(tr_all[feats], _label(kind, p, tr_all), verbose=False)
    hi = 1.0 if kind == "clf" else None
    cal = IsotonicRegression(y_min=0, y_max=hi, out_of_bounds="clip").fit(
        np.concatenate(oof_p), np.concatenate(oof_y))
    return final, cal


def predict_head(kind: str, model, cal, X) -> np.ndarray:
    out = cal.predict(_raw(kind, model, X))
    return out.clip(0, 1) if kind == "clf" else out.clip(0)


def blend_counts(a: np.ndarray, b: np.ndarray, w: float = BLEND_W) -> np.ndarray:
    """Geometric mean in log1p space - the space the counts are modelled in."""
    return np.expm1((1 - w) * np.log1p(a) + w * np.log1p(b)).clip(0)


def blend_probs(a: np.ndarray, b: np.ndarray, w: float = BLEND_W) -> np.ndarray:
    return ((1 - w) * a + w * b).clip(0, 1)


def incumbent_hindcast() -> pd.DataFrame | None:
    """The scikit-learn model's stored hindcast, on the same rows and folds as ours.

    Read from a private copy when one exists, because a successful blend overwrites
    forecast_backtest.parquet with the *blended* hindcast and the original would otherwise
    be gone on the next run.
    """
    keep, live = PROCESSED / HGB_HINDCAST, PROCESSED / "forecast_backtest.parquet"
    src = keep if keep.exists() else live
    if not src.exists():
        return None
    df = duckdb.sql(f"SELECT * FROM '{src}'").df()
    if not keep.exists():
        duckdb.sql(f"COPY df TO '{keep}' (FORMAT parquet, COMPRESSION zstd)")
        print(f"kept the incumbent hindcast at {keep} before anything overwrites it")
    return df


# ---------------------------------------------------------------- tuning

def tune(fold0: pd.DataFrame, feats: list[str], device: str, n: int,
         seed: int) -> tuple[dict, dict]:
    """Randomized search inside fold 0's training window only.

    Nothing here sees 2016 or later, so every outer test year stays untouched by tuning.
    Scored on a single inner split to keep the search affordable; the chosen config is
    then cross-fitted properly in `run_cv`.
    """
    last_train = FOLDS[0][0]
    a, b = _inner_splits(last_train)[-1]
    ok = fold0.target.notna()
    tr = fold0[ok & (fold0.year <= a)]
    va = fold0[ok & (fold0.year > a) & (fold0.year <= b)]
    Xtr, Xva = tr[feats], va[feats]
    rng = np.random.default_rng(seed)
    best_r, best_rs, best_c, best_cs = None, np.inf, None, -np.inf
    t0 = time.time()
    for i in range(n):
        pr = sample_reg(rng)
        m = _make("reg", pr, device, TUNE_TREES, early=True)
        m.fit(Xtr, _label("reg", pr, tr), eval_set=[(Xva, _label("reg", pr, va))], verbose=False)
        iso = IsotonicRegression(y_min=0, out_of_bounds="clip").fit(m.predict(Xva), va.target.values)
        s = _wape(iso.predict(m.predict(Xva)).clip(0), va.target.values)
        if s < best_rs:
            best_r, best_rs = pr, s

        pc = sample_clf(rng)
        c = _make("clf", pc, device, TUNE_TREES, early=True)
        c.fit(Xtr, tr.warn.values, eval_set=[(Xva, va.warn.values)], verbose=False)
        # selected on average precision: at a 6% base rate that is what decides whether a
        # warning is worth showing on a map. AUC barely moves and does not.
        ap = average_precision_score(va.warn.values, c.predict_proba(Xva)[:, 1])
        if ap > best_cs:
            best_c, best_cs = pc, ap
        if (i + 1) % 8 == 0:
            print(f"    {i + 1}/{n} configs   best inner WAPE {best_rs:.1f}   "
                  f"best inner AP {best_cs:.3f}   ({time.time() - t0:.0f}s)", flush=True)
    print(f"    reg: {best_r['shape']} lr {best_r['learning_rate']:.3f} depth {best_r['max_depth']}")
    print(f"    clf: spw {best_c['scale_pos_weight']:.0f} lr {best_c['learning_rate']:.3f} "
          f"depth {best_c['max_depth']}")
    return best_r, best_c


# ---------------------------------------------------------------- hindcast

def run_cv(folds: dict, lead: int, feats: list[str], pr: dict, pc: dict | None,
           device: str) -> pd.DataFrame:
    """Expanding-window hindcast over the same outer folds forecast.py uses."""
    parts = []
    for last_train, test_years in FOLDS:
        fold = frame_for_lead(folds[last_train], lead)
        te = fold[fold.year.isin(test_years) & fold.target.notna()].copy()
        if te.empty:
            continue
        m, cal = fit_head("reg", pr, fold, feats, last_train, device)
        te["pred"] = predict_head("reg", m, cal, te[feats])
        if pc is not None:
            c, ccal = fit_head("clf", pc, fold, feats, last_train, device)
            te["warn_prob"] = 0.0 if c is None else predict_head("clf", c, ccal, te[feats])
        parts.append(te)
    return pd.concat(parts, ignore_index=True)


def score(hind: pd.DataFrame, want_clf: bool) -> dict:
    """Identical metric set to forecast.score_block_and_country, plus the operating points."""
    obs = hind.target.values
    out = {"n": int(len(hind)), "total_obs": round(float(obs.sum()))}
    cands = {"model": hind.pred.values, "climatology": hind.y_clim.fillna(0).values,
             "persistence": hind.y_lag1.fillna(0).values,
             "seasonal_naive": hind.y_lag12.fillna(0).values}
    out["block_month"] = {k: {"wape": round(_wape(v, obs), 1), "r2": round(_r2(v, obs), 3),
                              "bias": round(float(100 * (v - obs).sum() / max(obs.sum(), 1e-9)), 1)}
                          for k, v in cands.items()}
    agg = hind.assign(rx=(hind.bx // 5), ry=(hind.by // 5))
    gb = agg.groupby(["rx", "ry", "target_month"])
    a_obs = gb.target.sum().values
    out["region5_month"] = {
        k: {"wape": round(_wape(gb[c].sum().values, a_obs), 1),
            "r2": round(_r2(gb[c].sum().values, a_obs), 3)}
        for k, c in (("model", "pred"), ("climatology", "y_clim"),
                     ("persistence", "y_lag1"), ("seasonal_naive", "y_lag12"))}
    if want_clf and hind.warn.nunique() > 1:
        w, p = hind.warn.values, hind.warn_prob.fillna(0).values
        out["warning"] = {
            "base_rate": round(float(w.mean()), 4),
            "roc_auc": round(float(roc_auc_score(w, p)), 3),
            "avg_precision": round(float(average_precision_score(w, p)), 3),
            "brier": round(float(brier_score_loss(w, p)), 4),
            "definition": f"target month > {WARN_RATIO}x block normal for that calendar month "
                          f"and >= {WARN_FLOOR:.0f} fires",
            # What the app's three alert cuts actually deliver. The incumbent's "high" cut
            # fired on 0.23% of block-months and caught 1.7% of real events; a published
            # warning level is not worth showing unless these are stated.
            "operating_points": {
                f"{t:.2f}": {"fired_frac": round(float((p >= t).mean()), 4),
                             "precision": round(float(w[p >= t].mean()), 3) if (p >= t).any() else None,
                             "recall": round(float(w[p >= t].sum() / max(w.sum(), 1)), 3)}
                for t in (0.10, 0.25, 0.50)},
        }
    return out


def _show(tag: str, sc: dict) -> None:
    b, r = sc["block_month"], sc["region5_month"]
    print(f"  {tag:<9} block WAPE {b['model']['wape']:5.1f}  R2 {b['model']['r2']:.3f}  "
          f"bias {b['model']['bias']:+5.1f} | 5deg WAPE {r['model']['wape']:5.1f}  "
          f"R2 {r['model']['r2']:.3f}")
    if "warning" in sc:
        w = sc["warning"]
        print(f"  {'':<9} warning AUC {w['roc_auc']:.3f}  AP {w['avg_precision']:.3f}  "
              f"Brier {w['brier']:.4f}")
        ops = w.get("operating_points")
        if ops:
            print(f"  {'':<9} " + "  ".join(
                f"p>={k}: fires {100 * v['fired_frac']:.1f}% prec {v['precision']} rec {v['recall']}"
                for k, v in ops.items()))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--package", action="store_true", help="only re-tar the existing model")
    ap.add_argument("--force", action="store_true",
                    help="install the new model even if it does not clear the gate")
    ap.add_argument("--search", type=int, default=N_SEARCH, help="configs per head per lead")
    ap.add_argument("--params-from", metavar="JSON",
                    help="reuse the hyperparameters recorded in this metrics file instead of "
                         "searching again (the search is the expensive part; this makes a "
                         "re-measurement of the same configs cheap)")
    args = ap.parse_args()
    if args.package:
        package()
        return

    device = gpu.require("early-warning search (XGBoost: CUDA when available)")
    if device != "cuda":
        print("  note: running on CPU, where this search is ~19x slower. Use --search 6.")
    gpu.seed_all(0)
    t0 = time.time()

    panel = add_neighbours(add_history(build_panel()))
    print(f"panel: {len(panel):,} block-months, {panel[KEYS].drop_duplicates().shape[0]} blocks, "
          f"{panel.month.min().date()}..{panel.month.max().date()}, "
          f"{len(FEATURES)} features ({len(NB_FEATURES)} new) ({time.time() - t0:.0f}s)")

    all_years = np.sort(panel.year.unique())
    # add_clim is the expensive non-model step and depends only on the fold, not the lead;
    # forecast.py recomputed it 30 times, this computes each fold once.
    folds = {lt: add_clim(panel, np.arange(all_years.min(), lt + 1), LEADS) for lt, _ in FOLDS}
    full = add_clim(panel, all_years, LEADS)
    print(f"climatology frames built ({time.time() - t0:.0f}s)")

    reuse = json.loads(pathlib.Path(args.params_from).read_text()) if args.params_from else None
    prev_path = MODELS / "earlywarn.json"
    prev = json.loads(prev_path.read_text()) if prev_path.exists() else None
    if prev and prev.get("trainer", "").startswith("forecast_gpu"):
        print("note: the installed model already came from this script; "
              "the comparison below is against it.")

    metrics: dict = {
        "unit": "1 deg block x month", "leads": list(LEADS),
        "trained_at": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
        "data": {"first_month": str(panel.month.min().date()),
                 "last_month": str(panel.month.max().date()),
                 "blocks": int(panel[KEYS].drop_duplicates().shape[0])},
        "cv": "expanding-window: " + ", ".join(f"<={a}->{b[0]}-{b[1]}" for a, b in FOLDS),
        "tuning": (f"randomized search, {args.search} configs per head per lead, scored inside "
                   f"fold 0's training window only (train <={FOLDS[0][0] - INNER_VAL_YEARS}, "
                   f"score {FOLDS[0][0] - INNER_VAL_YEARS + 1}-{FOLDS[0][0]}); no outer test "
                   f"year is used for tuning"),
        "calibration": (f"{INNER_FOLDS} expanding inner splits per fit give cross-fitted "
                        f"predictions over the last {INNER_FOLDS * INNER_VAL_YEARS} training "
                        f"years; the final head is grown on the whole window at the mean tree "
                        f"count and its isotonic calibrator is fitted on those cross-fitted "
                        f"predictions, never on its own"),
        "warning_definition": f"target > {WARN_RATIO}x block normal for that month and >= {WARN_FLOOR:.0f}",
        "features": {"history": HIST_FEATURES, "weather": WX_FEATURES, "neighbour": NB_FEATURES},
        "weather_source": "NASA POWER daily (MERRA-2) fire-weather indices, antecedent months only",
        "trainer": f"forecast_gpu.py (XGBoost on {device})",
        "env": {"python": platform.python_version(), "sklearn": sklearn.__version__,
                "numpy": np.__version__, "pandas": pd.__version__, "joblib": joblib.__version__},
        "leads_detail": {},
    }
    import xgboost as xgb
    metrics["env"]["xgboost"] = xgb.__version__

    inc_hc = incumbent_hindcast()
    if inc_hc is None:
        raise SystemExit("no incumbent hindcast on disk to blend with; run "
                         "`python -m firerosetta.forecast` first.")
    if not prev:
        raise SystemExit("no earlywarn.json to compare against; run "
                         "`python -m firerosetta.forecast` first.")
    # Start from the incumbent's own bundle: its scikit-learn heads stay under their
    # original keys and the XGBoost heads are added beside them under a _x suffix.
    bundle: dict = dict(joblib.load(MODELS / "earlywarn.joblib"))
    bundle |= {
        "hist_features": HIST_FEATURES, "leads": list(LEADS),
        "keys": KEYS, "warn_ratio": WARN_RATIO, "warn_floor": WARN_FLOOR,
        "predict_recipe":
            "Two members, blended. sklearn member: c1 = reg_h<lead>_iso.predict("
            "reg_h<lead>_gbm.predict(X[features])).clip(0), "
            "p1 = clf_h<lead>.predict_proba(X[features])[:, 1]. xgboost member: "
            "c2 = reg_h<lead>_iso_x.predict(reg_h<lead>_gbm_x.predict(X[features_x])).clip(0), "
            "p2 = clf_h<lead>_iso_x.predict(clf_h<lead>_x.predict_proba(X[features_x])[:, 1]). "
            "With w = blend['weight_xgb']: expected counts = "
            "expm1((1-w)*log1p(c1) + w*log1p(c2)).clip(0) and "
            "P(anomalous month) = ((1-w)*p1 + w*p2).clip(0, 1). "
            "For lead h, set X['y_clim'] = X['y_clim_h<h>'] and "
            "X['<c>_clim_target'] = X['<c>_clim_target_h<h>'] for c in (t2m, precip, vpd) "
            "before selecting features. The _x estimators need xgboost installed.",
    }

    hindcasts, verdicts = [], []
    for lead in LEADS:
        print(f"\n=== lead {lead} ===", flush=True)
        if reuse:
            hp = reuse["leads_detail"][str(lead)]["hyperparams"]
            pr, pc = hp["regression"], hp["classification"]
            print(f"    reusing recorded hyperparameters: reg {pr['shape']}, "
                  f"clf spw {pc['scale_pos_weight']:.0f}")
        else:
            fold0 = frame_for_lead(folds[FOLDS[0][0]], lead)
            pr, pc = tune(fold0, FEATURES, device, args.search, seed=100 + lead)

        hind = run_cv(folds, lead, FEATURES, pr, pc, device)
        hist_hind = run_cv(folds, lead, HIST_FEATURES, pr, None, device)
        hind["pred_hist_only"] = hist_hind.set_index([*KEYS, "target_month"]).pred.reindex(
            pd.MultiIndex.from_frame(hind[[*KEYS, "target_month"]])).values
        sc_x = score(hind, want_clf=True)

        # ---- align the incumbent's hindcast onto exactly these rows and blend ----
        inc = inc_hc[inc_hc.lead == lead].set_index([*KEYS, "target_month"])
        ix = pd.MultiIndex.from_frame(hind[[*KEYS, "target_month"]])
        inc_pred = inc.pred.reindex(ix).to_numpy(dtype=float)
        inc_prob = inc.warn_prob.reindex(ix).to_numpy(dtype=float)
        inc_hist = inc.pred_hist_only.reindex(ix).to_numpy(dtype=float)
        inc_tgt = inc.target.reindex(ix).to_numpy(dtype=float)
        miss = int(np.isnan(inc_pred).sum())
        if miss:
            raise SystemExit(f"lead {lead}: {miss} rows have no incumbent hindcast; the two "
                             "models are not on the same folds, refusing to blend.")
        # the two runs must be scoring the same thing, or the comparison is meaningless
        if not np.allclose(inc_tgt, hind.target.to_numpy(dtype=float), rtol=1e-4, atol=1e-4):
            raise SystemExit(f"lead {lead}: the incumbent hindcast's targets differ from ours.")

        bl = hind.copy()
        bl["pred"] = blend_counts(inc_pred, hind.pred.to_numpy(dtype=float))
        bl["warn_prob"] = blend_probs(inc_prob, hind.warn_prob.to_numpy(dtype=float))
        bl["pred_hist_only"] = blend_counts(inc_hist, hind.pred_hist_only.to_numpy(dtype=float))
        sc = score(bl, want_clf=True)

        pv = prev["leads_detail"][str(lead)]["with_weather"]
        _show("incumbent", pv)
        _show("xgb-solo", sc_x)
        _show("blend", sc)
        dw = pv["block_month"]["model"]["wape"] - sc["block_month"]["model"]["wape"]
        dr = sc["block_month"]["model"]["r2"] - pv["block_month"]["model"]["r2"]
        da = sc["warning"]["avg_precision"] - pv["warning"]["avg_precision"]
        du = sc["warning"]["roc_auc"] - pv["warning"]["roc_auc"]
        verdicts.append((lead, dw, dr, da, du))
        print(f"  blend vs incumbent: WAPE {dw:+.1f}  R2 {dr:+.3f}  AP {da:+.3f}  "
              f"AUC {du:+.3f}   (positive = better)")

        # ---- final XGBoost heads on every year, to sit beside the incumbent's ----
        f_full = frame_for_lead(full, lead)
        last = int(all_years.max())
        gbm, iso = fit_head("reg", pr, f_full, FEATURES, last, device)
        clf, ciso = fit_head("clf", pc, f_full, FEATURES, last, device)
        bundle[f"reg_h{lead}_gbm_x"], bundle[f"reg_h{lead}_iso_x"] = gbm, iso
        bundle[f"clf_h{lead}_x"], bundle[f"clf_h{lead}_iso_x"] = clf, ciso

        metrics["leads_detail"][str(lead)] = {
            "hyperparams": {"regression": pr, "classification": pc},
            "with_weather": sc,            # the blend: what the API will serve
            "xgb_solo": sc_x,
            "incumbent": pv,
            "history_only": {"block_month": sc["block_month"]["model"]},
        }
        bl["lead"] = lead
        hindcasts.append(bl)

    # ---------- verdict ----------
    # Gated on the warning head's average precision and on block R2. AP is the metric that
    # was too weak to be worth showing, so it has to improve on every lead; R2 is the proper
    # score for a conditional-mean predictor, so it must not regress. WAPE is reported but
    # not gated: on a zero-inflated count panel WAPE rewards systematic under-prediction,
    # which is what the incumbent's -12% bias is, so gating on it would penalise a
    # better-calibrated model for being better calibrated.
    won = bool(verdicts) and all(da > 0 for *_, da, _ in verdicts) and all(
        dr >= -0.005 for _, _, dr, _, _ in verdicts)
    m = lambda i: float(np.mean([v[i] for v in verdicts])) if verdicts else 0.0  # noqa: E731
    metrics["versus_incumbent"] = {
        "gate": "warning AP must improve on every lead and block R2 must not regress by more "
                "than 0.005; WAPE is reported but not gated, because on zero-inflated counts "
                "it rewards under-prediction",
        "blend_weight_xgb": BLEND_W,
        "mean_wape_gain": round(m(1), 2), "mean_r2_gain": round(m(2), 4),
        "mean_ap_gain": round(m(3), 4), "mean_auc_gain": round(m(4), 4),
        "per_lead": [{"lead": l, "wape_gain": round(dw, 2), "r2_gain": round(dr, 4),
                      "ap_gain": round(da, 4), "auc_gain": round(du, 4)}
                     for l, dw, dr, da, du in verdicts],
        "installed": bool(won or args.force),
    }

    hc_all = pd.concat(hindcasts, ignore_index=True)
    side = PROCESSED / "forecast_gpu_hindcast.parquet"
    duckdb.sql(f"COPY hc_all TO '{side}' (FORMAT parquet, COMPRESSION zstd)")
    print(f"\nblended hindcast kept at {side} ({len(hc_all):,} rows) whatever the verdict")
    print(f"blend vs incumbent, mean over leads: WAPE {m(1):+.2f}  R2 {m(2):+.3f}  "
          f"AP {m(3):+.3f}  AUC {m(4):+.3f}")
    if not won and not args.force:
        out = PROCESSED / "forecast_gpu_rejected.json"
        out.write_text(json.dumps(metrics, indent=1))
        raise SystemExit(
            "the blend did not clear the gate (AP up on every lead, R2 not down by >0.005). "
            f"Nothing was installed; full numbers in {out}.\n"
            "Re-run with --force to install it anyway.")

    # ---------- artefacts (same names and shapes forecast.py writes) ----------
    # The shipped bundle carries BOTH members: the incumbent's scikit-learn heads under
    # their original keys, so an old consumer still works, and the XGBoost heads under a
    # _x suffix. `blend` tells a consumer how to combine them.
    bundle["blend"] = {"weight_xgb": BLEND_W, "counts": "geometric mean in log1p space",
                       "probs": "arithmetic mean"}
    bundle["features_x"] = FEATURES
    joblib.dump(bundle, MODELS / "earlywarn.joblib", compress=3)

    feat_tbl = frame_for_lead(full, LEADS[0])
    keep = [*KEYS, "month", "year", "moy", "y", *FEATURES,
            *[f"y_clim_h{h}" for h in LEADS],
            *[f"{c}_clim_target_h{h}" for h in LEADS for c in ("t2m", "precip", "vpd")]]
    feat_tbl = feat_tbl[list(dict.fromkeys(keep))].copy()
    for c in feat_tbl.columns:
        if feat_tbl[c].dtype == np.float64:
            feat_tbl[c] = feat_tbl[c].astype(np.float32)
    duckdb.sql(f"COPY feat_tbl TO '{PROCESSED / 'forecast_features.parquet'}' "
               f"(FORMAT parquet, COMPRESSION zstd)")

    hc = hc_all[[*KEYS, "lead", "month", "target_month", "target", "pred", "pred_hist_only",
                 "y_clim", "y_lag1", "y_lag12", "warn", "warn_prob"]].copy()
    for c in ("target", "pred", "pred_hist_only", "y_clim", "y_lag1", "y_lag12", "warn_prob"):
        hc[c] = hc[c].astype(np.float32)
    duckdb.sql(f"COPY hc TO '{PROCESSED / 'forecast_backtest.parquet'}' "
               f"(FORMAT parquet, COMPRESSION zstd)")

    metrics["artefacts"] = {"model": "earlywarn.joblib",
                            "features_table": "forecast_features.parquet",
                            "backtest": "forecast_backtest.parquet"}
    (MODELS / "earlywarn.json").write_text(json.dumps(metrics, indent=1))
    (PROCESSED / "forecast_metrics.json").write_text(json.dumps(metrics, indent=1))
    print(f"\n-> {MODELS / 'earlywarn.joblib'} "
          f"({(MODELS / 'earlywarn.joblib').stat().st_size / 1e6:.1f} MB)")
    package()
    print(f"done in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
