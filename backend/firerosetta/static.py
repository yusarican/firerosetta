"""Step 7 - find the persistent non-fire heat sources still hiding in the fire stream.

A factory chimney, flare stack, steel mill or refinery is hot every week of the year. FIRMS
already tags some of these with `type` 1/2/3 and `grid.py` drops those, but that tag comes from
a location database: it is incomplete, and it is applied very unevenly between sensors (VIIRS
~25-30 % of Turkish/Italian detections flagged, MODIS ~3 %). Whatever it misses stays in the
"vegetation fire" stream and gets counted as burning - and because 375 m VIIRS sees small point
sources that 1 km MODIS cannot, those leftovers land almost entirely in the VIIRS era. That is
exactly the kind of fake sensor jump this whole project exists to remove.

So this step learns what a persistent point source looks like, with no labels at all:

  1. Pool detections into ~1.1 km sites and describe each by *how it behaves over time* - how
     many of the months it could appear in it actually appears in, whether it recurs every
     year, whether it is nocturnal, how steady its radiative power is, how tightly detections
     stack on one spot, and whether anything ever burns beside it on the same day.
  2. Score each site with three detectors that fail in different ways and average their ranks:
     an isolation forest (is this site unusual?), a Mahalanobis distance (is it far from the
     bulk?), and a staticness index (is it unusual *in the direction* a chimney would be?).
     The third is what makes the score directional - the first two alone would equally flag a
     site that is merely weird.
  3. Cut the score where the data says to: fit a robust normal to the core of the staticness
     index and count how many sites exceed its far tail by more than a normal ever would.
     That excess is the contamination estimate, and no label is involved in computing it.

FIRMS's own `type` tag is used for exactly one thing - *scoring* the result afterwards. Those
sites are removed before fitting, so the model is never shown an example of what it must find.

On the choice of model: a denoising autoencoder, Deep SVDD and exact GPU kNN were all built and
measured first (`--benchmark-deep` reruns them). Every one of them scored worse than the three
cheap detectors above, and adding them to the ensemble made it worse, so none of them ships.
With 21 tidy behaviours and ~110k sites there is no representation left for a deep net to
learn. That measurement is in `static.json` under "deep_benchmark".

    uv run python -m firerosetta.static
    uv run python -m firerosetta.static --package           # + release tarball
    uv run --extra gpu python -m firerosetta.static --benchmark-deep   # reruns the GPU trials
"""
from __future__ import annotations

import argparse
import hashlib
import json
import platform
import tarfile
import time
from datetime import datetime, timezone

import duckdb
import numpy as np
import pandas as pd
import sklearn
from scipy.stats import norm
from sklearn.covariance import EmpiricalCovariance
from sklearn.ensemble import IsolationForest
from sklearn.impute import SimpleImputer
from sklearn.metrics import roc_auc_score
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import QuantileTransformer

from . import gpu
from .config import MODELS, PROCESSED, STAGED

SITE_DEG = 0.01        # ~1.1 km: absorbs the geolocation jitter of a single point source
# A site is only *eligible to be flagged* with enough record to tell persistence from a fire:
# one detection is never a factory, and a year of span is the least that can show something
# coming back outside its region's fire season.
MIN_DAYS, MIN_SPAN_DAYS = 10, 365
TAIL_SIGMA = 4.0       # far tail of the staticness index used for the contamination estimate

MOY = [f"moy_{m}" for m in range(1, 13)]

# Site behaviours the detectors see. `season_align` (cosine similarity between a site's
# month-of-year shape and its 1 deg block's) was built and measured first: AUC 0.499, pure
# noise, so it is not here - local fire seasons are too broad to separate anything.
FEATURES = [
    # persistence: the core of it
    "log_days", "log_span", "months_frac", "years_frac", "days_per_month", "det_per_day",
    # seasonality: fires are peaked in a season, industry is flat
    "n_moy", "moy_R", "moy_entropy",
    # episode shape: a fire is one multi-day burst then silence for months
    "streak_ratio", "gap_long_frac", "gap_short_frac",
    # neighbourhood: a spreading fire lights adjacent cells the same day, a chimney never does
    "ring_ratio", "ring_day_frac",
    # radiometry and geometry of a fixed industrial source
    "night_frac", "high_frac", "viirs_frac", "log_frp", "frp_iqr", "spread_m", "n_platform",
]

# Which way each behaviour points for a static source. This is physics and the published
# flare-detection literature, not labels: persistent, aseasonal, nocturnal, point-like,
# radiometrically steady, and none of the burst-and-spread structure of a real fire.
STATIC_SIGNS = {
    "months_frac": +1, "years_frac": +1, "days_per_month": +1, "moy_entropy": +1,
    "night_frac": +1, "gap_short_frac": +1,
    "moy_R": -1, "gap_long_frac": -1, "streak_ratio": -1, "ring_ratio": -1,
    "ring_day_frac": -1, "spread_m": -1, "frp_iqr": -1, "high_frac": -1,
}
DETECTORS = ("iforest", "staticness", "mahalanobis")
NQ = 1001              # resolution of the stored score quantiles used to rank new sites

BUNDLE_FILES = ("static.joblib", "static.json", "static_sites.parquet")

SQL = """
CREATE TEMP TABLE det AS
  SELECT country, sensor, platform, lat, lon, acq_date, daynight, conf, frp, bright_mir,
         (type = 0) AS veg, floor(lon/{d})::INT AS sx, floor(lat/{d})::INT AS sy,
         floor(lon)::INT AS bx, floor(lat)::INT AS byy, month(acq_date) AS moy
  FROM '{src}'
  WHERE conf <> 'l';          -- the same quality screen grid.py applies before harmonizing

-- one row per site per day: the unit a point source repeats on and a fire does not
CREATE TEMP TABLE sd AS
  SELECT veg, sx, sy, acq_date, count(*) AS n FROM det GROUP BY ALL;

CREATE TEMP TABLE gaps AS
  SELECT veg, sx, sy,
         acq_date - lag(acq_date) OVER w            AS gap,
         acq_date - (row_number() OVER w)::INT      AS run_key  -- constant within a run of days
  FROM sd WINDOW w AS (PARTITION BY veg, sx, sy ORDER BY acq_date);

CREATE TEMP TABLE runs AS
  SELECT veg, sx, sy, max(len) AS max_streak
  FROM (SELECT veg, sx, sy, run_key, count(*) AS len FROM gaps GROUP BY ALL) GROUP BY ALL;

CREATE TEMP TABLE gapstat AS
  SELECT veg, sx, sy, avg((gap > 90)::INT) AS gap_long_frac, avg((gap <= 2)::INT) AS gap_short_frac
  FROM gaps WHERE gap IS NOT NULL GROUP BY ALL;

-- same-day detections in the 8 touching cells
CREATE TEMP TABLE ringstat AS
  SELECT veg, sx, sy, sum(ring_n) AS ring_tot, count(*) AS ring_days FROM (
    SELECT s.veg, s.sx, s.sy, s.acq_date, sum(o.n) AS ring_n
    FROM sd s JOIN sd o
      ON o.veg = s.veg AND o.acq_date = s.acq_date
     AND o.sx BETWEEN s.sx-1 AND s.sx+1 AND o.sy BETWEEN s.sy-1 AND s.sy+1
     AND NOT (o.sx = s.sx AND o.sy = s.sy)
    GROUP BY ALL
  ) GROUP BY ALL;

CREATE TEMP TABLE base AS
  SELECT
    veg, any_value(country) AS country, sx, sy,
    avg(lon) AS lon, avg(lat) AS lat, any_value(bx) AS bx, any_value(byy) AS byy,
    count(*) AS n_det,
    count(DISTINCT acq_date) AS n_days,
    count(DISTINCT date_trunc('month', acq_date)) AS n_months,
    count(DISTINCT year(acq_date)) AS n_years,
    count(DISTINCT moy) AS n_moy,
    count(DISTINCT platform) AS n_platform,
    1 + (max(acq_date) - min(acq_date)) AS span_days,
    min(acq_date) AS first_seen, max(acq_date) AS last_seen,
    avg((daynight = 'N')::INT) AS night_frac,
    avg((conf = 'h')::INT) AS high_frac,
    avg((sensor = 'VIIRS')::INT) AS viirs_frac,
    count(*) FILTER (sensor = 'MODIS') AS n_modis,
    count(*) FILTER (sensor = 'VIIRS') AS n_viirs,
    median(frp) AS frp_med,
    median(bright_mir) AS bright_med,
    quantile_cont(ln(1+frp), 0.75) - quantile_cont(ln(1+frp), 0.25) AS frp_iqr,
    -- sub-cell scatter in metres: a fixed source keeps landing on the same spot
    sqrt(pow(stddev_samp(lat) * 111320, 2)
       + pow(stddev_samp(lon) * 111320 * cos(radians(avg(lat))), 2)) AS spread_m,
    -- resultant length of the month-of-year angles: 1 = one month only, 0 = spread over the year
    sqrt(pow(avg(cos(2*pi()*moy/12)), 2) + pow(avg(sin(2*pi()*moy/12)), 2)) AS moy_R,
    {moy_cols}
  FROM det GROUP BY veg, sx, sy;

SELECT b.*, r.max_streak,
       coalesce(g.gap_long_frac, 0) AS gap_long_frac,
       coalesce(g.gap_short_frac, 0) AS gap_short_frac,
       coalesce(rs.ring_tot, 0) AS ring_tot, coalesce(rs.ring_days, 0) AS ring_days
FROM base b
LEFT JOIN runs r USING (veg, sx, sy)
LEFT JOIN gapstat g USING (veg, sx, sy)
LEFT JOIN ringstat rs USING (veg, sx, sy);
"""


def build_sites() -> pd.DataFrame:
    """Detections -> one row per ~1.1 km site, for both streams."""
    con = duckdb.connect()
    con.execute("PRAGMA threads=8")
    moy_cols = ", ".join(f"count(*) FILTER (moy = {m}) AS moy_{m}" for m in range(1, 13))
    t = time.perf_counter()
    df = con.sql(SQL.format(src=STAGED / "hotspots.parquet", d=SITE_DEG, moy_cols=moy_cols)).df()
    print(f"sites: {len(df):,} built in {time.perf_counter() - t:.1f}s "
          f"({(~df.veg).sum():,} at locations FIRMS already tags non-vegetation)")
    return df


def derive(df: pd.DataFrame) -> pd.DataFrame:
    """Turn raw site counts into the scale-free behaviours the detectors see."""
    f = df.copy()
    f["months_frac"] = f.n_months / (f.span_days / 30.44).clip(lower=1)  # of months it could appear in
    f["years_frac"] = f.n_years / (f.span_days / 365.25).clip(lower=1)
    f["det_per_day"] = f.n_det / f.n_days
    f["days_per_month"] = f.n_days / f.n_months
    f["streak_ratio"] = f.max_streak / f.n_days          # one long burst -> close to 1
    f["ring_ratio"] = f.ring_tot / f.n_det
    f["ring_day_frac"] = f.ring_days / f.n_days
    f["log_days"] = np.log1p(f.n_days)
    f["log_span"] = np.log1p(f.span_days)
    f["log_frp"] = np.log1p(f.frp_med)

    h = f[MOY].to_numpy(float)
    p = np.clip(h / h.sum(1, keepdims=True).clip(1e-9), 1e-12, None)
    f["moy_entropy"] = -(p * np.log(p)).sum(1) / np.log(12)   # 1 = detected evenly all year
    return f


def eligible(f: pd.DataFrame) -> pd.Series:
    return (f.n_days >= MIN_DAYS) & (f.span_days >= MIN_SPAN_DAYS)


# --------------------------------------------------------------------------- the detector

def staticness(X: pd.DataFrame, mu: pd.Series, sd: pd.Series) -> np.ndarray:
    """Mean z-score of the behaviours, each signed the way a static source points.

    In standard-deviation units, so its far tail has a meaning the threshold can use.
    """
    z = ((X[FEATURES] - mu) / sd.replace(0, np.nan)).fillna(0.0)
    return (sum(z[c] * s for c, s in STATIC_SIGNS.items()) / len(STATIC_SIGNS)).to_numpy()


def rank_against(quantiles: np.ndarray, raw: np.ndarray) -> np.ndarray:
    """Position of each raw score within the training distribution, in [0, 1].

    Stored as quantiles rather than the raw training scores so a consumer can rank a brand new
    site exactly the way training did, without shipping the training set.
    """
    return np.searchsorted(quantiles, raw) / (len(quantiles) - 1)


def contamination(idx_train: np.ndarray, ksigma: float = TAIL_SIGMA) -> tuple[float, dict]:
    """Share of sites that are static, estimated from the staticness index alone.

    Robust median/MAD describe the fire bulk. A normal distribution puts a known, tiny mass
    beyond `ksigma`; anything above that is excess, and the excess is the contamination. No
    label is read here, which matters, because a site this model flags that FIRMS does not tag
    is the discovery we are after - calibrating on that tag would count discoveries as errors.
    """
    med = float(np.median(idx_train))
    mad = float(np.median(np.abs(idx_train - med)) * 1.4826)
    thr = med + ksigma * mad
    expected = len(idx_train) * float(norm.sf(ksigma))
    observed = int((idx_train > thr).sum())
    rate = max(observed - expected, 0.0) / len(idx_train)
    return rate, {"median": round(med, 4), "robust_sd": round(mad, 4), "ksigma": ksigma,
                  "threshold": round(thr, 4), "expected_above": round(expected, 1),
                  "observed_above": observed, "rate": round(rate, 6)}


# --------------------------------------------------------------------------- evaluation

def _auc(y, s):
    return float(roc_auc_score(y, s)) if 0 < y.sum() < len(y) else float("nan")


def stratified_auc(elig: pd.DataFrame, y: np.ndarray, score: np.ndarray) -> tuple[float, list]:
    """AUC inside bins of detection-day count.

    The plain AUC is flattered: FIRMS tags whole known-static *locations*, which therefore
    carry more detections, so any score that likes well-observed sites looks good. Repeating
    the test within day-count bins takes that advantage away. This is the honest number.
    """
    bins = pd.cut(elig.n_days, [MIN_DAYS - 1, 15, 25, 50, 100, 10 ** 9])
    per, aucs, wts = [], [], []
    for b, idx in elig.groupby(bins, observed=True).groups.items():
        loc = elig.index.get_indexer(idx)
        yb = y[loc]
        if 0 < yb.sum() < len(yb):
            a = _auc(yb, score[loc])
            per.append({"days": str(b), "n": int(len(yb)), "known_static": int(yb.sum()),
                        "auc": round(a, 4)})
            aucs.append(a)
            wts.append(yb.sum())
    return (float(np.average(aucs, weights=wts)) if aucs else float("nan")), per


def impact(f: pd.DataFrame, flagged: set[tuple[int, int]]) -> dict:
    """How many 'fire' detections the flags remove, and from which sensor.

    This is the number that matters for the harmonization: leftovers only VIIRS can see inflate
    the VIIRS era and masquerade as a real step change in burning.
    """
    fire = f[f.veg].copy()
    fire["flag"] = [(a, b) in flagged for a, b in zip(fire.sx, fire.sy)]
    fl = fire[fire.flag]
    tot_m, tot_v = int(fire.n_modis.sum()), int(fire.n_viirs.sum())
    out = {"modis_detections": tot_m, "viirs_detections": tot_v,
           "modis_flagged": int(fl.n_modis.sum()), "viirs_flagged": int(fl.n_viirs.sum()),
           "modis_pct": round(float(fl.n_modis.sum() / max(tot_m, 1) * 100), 3),
           "viirs_pct": round(float(fl.n_viirs.sum() / max(tot_v, 1) * 100), 3)}
    by = (fl.groupby("country")[["n_modis", "n_viirs"]].sum()
          / fire.groupby("country")[["n_modis", "n_viirs"]].sum() * 100)
    out["by_country_pct"] = by.round(3).rename(
        columns={"n_modis": "modis", "n_viirs": "viirs"}).to_dict("index")
    return out


def benchmark_deep(Xtr: np.ndarray, Xe: np.ndarray, elig: pd.DataFrame, y: np.ndarray,
                   ranks: dict) -> dict:
    """Re-run the GPU models that lost, so the claim stays checkable instead of anecdotal."""
    torch = gpu.torch_or_none()
    if torch is None:
        print("  skipped: torch is not installed (uv sync --extra gpu)")
        return {"skipped": "torch not installed"}
    device = gpu.require("deep benchmark")
    gpu.seed_all(0)
    Xtr, Xe = Xtr.astype(np.float32), Xe.astype(np.float32)   # torch Linear layers are float32

    def mlp(sizes, bias=True):
        L = []
        for i in range(len(sizes) - 1):
            L.append(torch.nn.Linear(sizes[i], sizes[i + 1], bias=bias))
            if i < len(sizes) - 2:
                L.append(torch.nn.ReLU())
        return torch.nn.Sequential(*L).to(device)

    def train(nets, step, epochs=150, lr=2e-3):
        params = [p for n in nets for p in n.parameters()]
        opt = torch.optim.AdamW(params, lr=lr, weight_decay=1e-4)
        sch = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=epochs)
        x = torch.as_tensor(Xtr, device=device)
        for _ in range(epochs):
            perm = torch.randperm(len(x), device=device)
            for i in range(0, len(x), 1024):
                loss = step(x[perm[i:i + 1024]])
                opt.zero_grad(set_to_none=True)
                loss.backward()
                opt.step()
            sch.step()

    out: dict = {"device": gpu.describe()}
    nf = Xtr.shape[1]

    enc, dec = mlp([nf, 64, 32, 6]), mlp([6, 32, 64, nf])
    t = time.perf_counter()
    train([enc, dec], lambda xb: torch.nn.functional.mse_loss(
        dec(enc(xb + 0.15 * torch.randn_like(xb))), xb))
    with torch.no_grad():
        xe = torch.as_tensor(Xe, device=device)
        ae_score = ((dec(enc(xe)) - xe) ** 2).mean(1).cpu().numpy()
    out["autoencoder"] = {"sec": round(time.perf_counter() - t, 1)}

    net = mlp([nf, 64, 32, 8], bias=False)   # no biases: otherwise it collapses to a constant
    with torch.no_grad():
        c = net(torch.as_tensor(Xtr, device=device)).mean(0)
        c[c.abs() < 0.1] = 0.1
    t = time.perf_counter()
    train([net], lambda xb: ((net(xb) - c) ** 2).sum(1).mean(), lr=1e-3)
    with torch.no_grad():
        svdd_score = ((net(torch.as_tensor(Xe, device=device)) - c) ** 2).sum(1).cpu().numpy()
    out["deep_svdd"] = {"sec": round(time.perf_counter() - t, 1)}

    # exact k-th nearest neighbour distance: 1.2e10 pairs, the one place the GPU is the enabler
    t = time.perf_counter()
    R = torch.as_tensor(Xtr, device=device)
    rn = (R ** 2).sum(1)
    knn_score = np.empty(len(Xe), np.float32)
    for i in range(0, len(Xe), 2048):
        Q = torch.as_tensor(Xe[i:i + 2048], device=device)
        d2 = ((Q ** 2).sum(1, keepdim=True) + rn[None, :] - 2.0 * (Q @ R.T)).clamp_(min=0)
        knn_score[i:i + 2048] = torch.topk(d2, 101, dim=1, largest=False)[0][:, 100].sqrt().cpu()
    out["knn100"] = {"sec": round(time.perf_counter() - t, 1),
                     "pairs": int(len(Xe)) * int(len(Xtr))}

    from scipy.stats import rankdata
    base = np.mean([ranks[d] for d in DETECTORS], axis=0)
    rank = lambda v: rankdata(v) / len(v)
    for name, s in (("autoencoder", ae_score), ("deep_svdd", svdd_score), ("knn100", knn_score)):
        strat, _ = stratified_auc(elig, y, s)
        with_it = np.mean([rank(base)] + [rank(s)], axis=0)
        strat_ens, _ = stratified_auc(elig, y, with_it)
        out[name] |= {"auc": round(_auc(y, s), 4), "auc_stratified": round(strat, 4),
                      "ensemble_with_it_stratified": round(strat_ens, 4)}
        print(f"  {name:12s} stratified {strat:.3f}  |  added to the shipped ensemble: "
              f"{strat_ens:.3f}")
    out["shipped_ensemble_stratified"] = round(stratified_auc(elig, y, base)[0], 4)
    print(f"  shipped ensemble on its own: {out['shipped_ensemble_stratified']:.3f}")
    return out


# --------------------------------------------------------------------------- packaging

def package(meta: dict | None = None) -> None:
    # Called with the metrics straight from a training run, or without them to re-tar what is
    # already on disk (./scripts/release.sh build static), in which case read the sidecar.
    if meta is None:
        if not (MODELS / "static.json").exists():
            raise SystemExit("no trained model to package; run: python -m firerosetta.static")
        meta = json.loads((MODELS / "static.json").read_text())
    srcs = {}
    for name in BUNDLE_FILES:
        p = MODELS / name if (MODELS / name).exists() else PROCESSED / name
        if not p.exists():
            raise SystemExit(f"nothing to package, missing: {name}")
        srcs[name] = p
    tar = MODELS / "firerosetta-static.tar.gz"
    with tarfile.open(tar, "w:gz") as t:
        for name, p in srcs.items():
            # Same layout rule as the other bundles: every release extracts with
            # tar -xzf <bundle> -C data and each file lands where the code expects it.
            t.add(p, arcname=f"{'models' if p.parent == MODELS else 'processed'}/{name}")
    digest = hashlib.sha256(tar.read_bytes()).hexdigest()
    (MODELS / "firerosetta-static.sha256").write_text(f"{digest}  {tar.name}\n")
    print(f"\n-> {tar} ({tar.stat().st_size / 1e6:.1f} MB)\n   sha256 {digest}")
    print(f"   {meta['flag']['n_flagged']:,} sites flagged, stratified AUC "
          f"{meta['eval']['auc_stratified']}")
    print("\nPublish it (not run automatically - this creates a public tag and release):\n"
          "  ./scripts/release.sh publish static")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--package", action="store_true",
                    help="only re-tar the existing model for release, without retraining")
    ap.add_argument("--benchmark-deep", action="store_true",
                    help="rerun the GPU models that lost, and record the numbers")
    args = ap.parse_args()
    if args.package:
        package()
        return

    # The shipped detector is scikit-learn and runs on CPU; this line says so out loud rather
    # than leaving anyone to wonder whether the GPU was quietly skipped.
    gpu.require("static-source detector (sklearn: CPU by design)")
    MODELS.mkdir(parents=True, exist_ok=True)
    PROCESSED.mkdir(parents=True, exist_ok=True)

    f = derive(build_sites())
    f["is_elig"] = eligible(f)
    # Fit on the fire stream only. Everything FIRMS already tags is held back for scoring, so
    # the model is never shown an example of what it is meant to find.
    train = f[f.is_elig & f.veg].reset_index(drop=True)
    elig = f[f.is_elig].reset_index(drop=True)
    y = (~elig.veg.to_numpy()).astype(int)
    print(f"eligible (>={MIN_DAYS} detection days, >={MIN_SPAN_DAYS} d span): {len(elig):,} sites; "
          f"fitting on {len(train):,} from the fire stream, {y.sum():,} tagged sites held out")

    prep = make_pipeline(SimpleImputer(strategy="median"),
                         QuantileTransformer(output_distribution="normal", n_quantiles=1000,
                                             subsample=200_000, random_state=0))
    # float64 throughout on purpose. Casting to float32 here moved an isolation-forest score
    # by one stored quantile step, so a consumer following the recipe in float64 got a
    # slightly different number than the one shipped. Not worth a dtype footnote in the recipe.
    Xtr = prep.fit_transform(train[FEATURES])
    Xe = prep.transform(elig[FEATURES])

    print("\nfitting the three detectors")
    mu, sd = train[FEATURES].mean(), train[FEATURES].std(ddof=0)
    iso = IsolationForest(n_estimators=300, random_state=0, n_jobs=-1).fit(Xtr)
    cov = EmpiricalCovariance().fit(Xtr)
    raw_tr = {"iforest": -iso.score_samples(Xtr), "staticness": staticness(train, mu, sd),
              "mahalanobis": cov.mahalanobis(Xtr)}
    raw_e = {"iforest": -iso.score_samples(Xe), "staticness": staticness(elig, mu, sd),
             "mahalanobis": cov.mahalanobis(Xe)}
    qs = np.linspace(0, 1, NQ)
    quant = {k: np.quantile(v, qs) for k, v in raw_tr.items()}
    ranks = {k: rank_against(quant[k], raw_e[k]) for k in raw_e}
    score = np.mean([ranks[d] for d in DETECTORS], axis=0)
    score_tr = np.mean([rank_against(quant[d], raw_tr[d]) for d in DETECTORS], axis=0)

    rate, tail = contamination(raw_tr["staticness"])
    cut = float(np.quantile(score_tr, 1 - rate))
    flag = score >= cut
    print(f"  staticness index: median {tail['median']}, robust sd {tail['robust_sd']}; "
          f"{tail['observed_above']} sites past {TAIL_SIGMA} sd where a normal predicts "
          f"{tail['expected_above']}")
    print(f"  -> contamination {rate:.3%}, score cut {cut:.4f}, {int(flag.sum()):,} sites flagged")

    # -------- scoring against the tag the model never saw
    strat, per_bin = stratified_auc(elig, y, score)
    baselines = {
        "iforest_only": rank_against(quant["iforest"], raw_e["iforest"]),
        "staticness_only": raw_e["staticness"],
        "mahalanobis_only": raw_e["mahalanobis"],
        "rule_24months_10moy": ((elig.n_months >= 24) & (elig.n_moy >= 10)).to_numpy(float),
        "persistence_only_months_frac": elig.months_frac.to_numpy(),
    }
    ev = {"n_eligible": int(len(elig)), "n_known_static": int(y.sum()),
          "auc": round(_auc(y, score), 4), "auc_stratified": round(strat, 4),
          "by_days": per_bin,
          "baselines": {k: {"auc": round(_auc(y, v), 4),
                            "auc_stratified": round(stratified_auc(elig, y, v)[0], 4)}
                        for k, v in baselines.items()}}
    print(f"\n  AUC vs the held-out FIRMS tag: {ev['auc']:.3f}  |  "
          f"stratified by detection days: {strat:.3f}")
    for k, v in ev["baselines"].items():
        print(f"    {k:30s} {v['auc']:.3f} / {v['auc_stratified']:.3f}")

    tagged = int((flag & (y == 1)).sum())
    fl = {"n_flagged": int(flag.sum()), "cut": round(cut, 6),
          "contamination_estimate": round(rate, 6),
          "known_static_recovered": tagged,
          "recall_known_static": round(tagged / max(int(y.sum()), 1), 4),
          # not "false positives": a flagged site FIRMS does not tag is the thing we are after
          "candidates_not_tagged_by_firms": int((flag & (y == 0)).sum()),
          "share_of_fire_sites": round(float((flag & (y == 0)).sum() / max((y == 0).sum(), 1)), 5)}
    imp = impact(f, {(a, b) for a, b in zip(elig.sx[flag], elig.sy[flag])})
    print(f"  recovers {fl['recall_known_static']:.1%} of the tagged sites and puts forward "
          f"{fl['candidates_not_tagged_by_firms']:,} FIRMS does not tag")
    print(f"  flags remove {imp['viirs_pct']:.2f}% of VIIRS vs {imp['modis_pct']:.2f}% of MODIS "
          f"'fire' detections")

    deep = {}
    if args.benchmark_deep:
        print("\nrerunning the deep/GPU models that lost")
        deep = benchmark_deep(Xtr, Xe, elig, y, ranks)

    # -------- outputs
    elig = elig.assign(static_score=score, staticness=raw_e["staticness"], flag=flag,
                       r_iforest=ranks["iforest"], r_mahalanobis=ranks["mahalanobis"],
                       r_staticness=ranks["staticness"])
    # Every model input ships with the table, not just the scores: without them a consumer of
    # the release can neither re-derive a score nor check one, which would make the published
    # recipe unverifiable.
    ident = ["country", "sx", "sy", "lon", "lat", "bx", "byy", "veg", "n_det", "n_days",
             "n_months", "n_years", "span_days", "first_seen", "last_seen", "n_modis", "n_viirs",
             "frp_med", "bright_med"]
    scores = ["r_iforest", "r_staticness", "r_mahalanobis", "staticness", "static_score", "flag"]
    out_cols = ident + [c for c in FEATURES if c not in ident] + scores
    sites_out = PROCESSED / "static_sites.parquet"
    elig[out_cols].sort_values("static_score", ascending=False).to_parquet(sites_out, index=False)

    import joblib

    # Plain numpy and scikit-learn only. A bundle holding a firerosetta class could only be
    # opened inside this project, which is the opposite of releasable.
    bundle = {
        "features": FEATURES, "detectors": list(DETECTORS),
        "site_deg": SITE_DEG, "min_days": MIN_DAYS, "min_span_days": MIN_SPAN_DAYS,
        "prep": prep, "iforest": iso, "cov": cov,
        "staticness_mu": mu[FEATURES].to_numpy(), "staticness_sd": sd[FEATURES].to_numpy(),
        "staticness_signs": np.array([STATIC_SIGNS.get(c, 0) for c in FEATURES], float),
        "n_signed": len(STATIC_SIGNS),
        "score_quantiles": {k: v for k, v in quant.items()}, "quantile_levels": qs,
        "cut": cut, "contamination": rate,
        "predict_recipe": (
            "Eligible sites only: n_days >= min_days and span_days >= min_span_days. "
            "X = prep.transform(sites[features]); "
            "z = (sites[features] - staticness_mu) / staticness_sd  (0 where sd == 0); "
            "raw = {iforest: -iforest.score_samples(X), "
            "staticness: (z * staticness_signs).sum(1) / n_signed, "
            "mahalanobis: cov.mahalanobis(X)}; "
            "rank_d = searchsorted(score_quantiles[d], raw[d]) / (len(quantile_levels) - 1); "
            "static_score = mean(rank_d for d in detectors); flag = static_score >= cut."),
    }
    joblib.dump(bundle, MODELS / "static.joblib", compress=3)

    meta = {
        "trained_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "device": gpu.describe(),
        "env": {"python": platform.python_version(), "sklearn": sklearn.__version__,
                "numpy": np.__version__},
        "site_deg": SITE_DEG, "min_days": MIN_DAYS, "min_span_days": MIN_SPAN_DAYS,
        "features": FEATURES, "detectors": list(DETECTORS),
        "n_sites_total": int(len(f)), "n_eligible": int(len(elig)),
        "threshold": tail, "eval": ev, "flag": fl, "impact": imp,
        "deep_benchmark": deep,
    }
    (MODELS / "static.json").write_text(json.dumps(meta, indent=2, default=str))
    (PROCESSED / "static_metrics.json").write_text(json.dumps(meta, indent=2, default=str))
    print(f"\n-> {sites_out}\n-> {MODELS / 'static.joblib'}\n-> {MODELS / 'static.json'}")

    print("\ntop 20 flagged sites FIRMS does not tag (the ones worth checking against a map):")
    top = elig[elig.flag & elig.veg].nlargest(20, "n_months")
    print(top[["country", "lat", "lon", "n_det", "n_days", "n_months", "n_years", "n_moy",
               "night_frac", "frp_med", "spread_m", "static_score"]].round(3).to_string(index=False))

    package(meta)


if __name__ == "__main__":
    main()
