"""Step 1 - download FIRMS hotspot archives and record provenance.

Yearly country CSVs are public (no key). The current year is not in the archive yet;
it is pulled from the FIRMS area API when FIRMS_MAP_KEY is set (env or repo-root .env).

    uv run python -m firerosetta.fetch [--countries Turkey Greece] [--force]
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor

import httpx

from .config import COUNTRIES, FIRMS, MANIFEST, RAW, ROOT, SENSORS

UA = {"User-Agent": "hotspot-harmonization-research/0.1"}


def _load_manifest() -> dict:
    text = MANIFEST.read_text().strip() if MANIFEST.exists() else ""
    return json.loads(text) if text else {"files": {}}


def _get(client: httpx.Client, url: str) -> bytes | None:
    for attempt in range(4):
        try:
            r = client.get(url)
            if r.status_code == 404:
                return None
            r.raise_for_status()
            return r.content
        except (httpx.TransportError, httpx.HTTPStatusError):
            if attempt == 3:
                raise
    return None


def fetch_archive(client, sensor: str, year: int, country: str, force: bool) -> dict | None:
    rel = f"{sensor}/{year}/{sensor}_{year}_{country}.csv"
    dest = RAW / "archive" / rel
    if dest.exists() and not force:
        return None
    url = f"{FIRMS}/data/country/{rel}"
    body = _get(client, url)
    if body is None or not body.startswith(b"latitude"):
        return None  # year not published for this sensor/country
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(body)
    return {
        "path": f"archive/{rel}", "url": url, "bytes": len(body),
        "sha256": hashlib.sha256(body).hexdigest(),
        "fetched_at": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
        "product": "standard/archive", "license": "NASA EOSDIS open data (CC0)",
    }


def _load_key() -> str | None:
    """FIRMS_MAP_KEY from the environment, else from the repo-root .env (git-ignored)."""
    if key := os.environ.get("FIRMS_MAP_KEY"):
        return key
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            name, _, value = line.partition("=")
            if name.strip() == "FIRMS_MAP_KEY" and value.strip():
                return value.strip()
    return None


class _Budget:
    """FIRMS counts 10 transactions per area request, 5000 per rolling 10 minutes."""

    LIMIT, WINDOW, COST = 4500, 600.0, 10

    def __init__(self) -> None:
        self.stamps: deque[float] = deque()

    def spend(self) -> None:
        now = time.monotonic()
        while self.stamps and now - self.stamps[0] > self.WINDOW:
            self.stamps.popleft()
        if (len(self.stamps) + 1) * self.COST > self.LIMIT:
            wait = self.WINDOW - (now - self.stamps[0]) + 1
            print(f"  FIRMS transaction budget reached, waiting {wait:.0f} s")
            time.sleep(wait)
            self.stamps.popleft()
        self.stamps.append(time.monotonic())


def _availability(client, key: str) -> dict[str, tuple[dt.date, dt.date]]:
    body = _get(client, f"{FIRMS}/api/data_availability/csv/{key}/ALL") or b""
    out = {}
    for line in body.decode().splitlines()[1:]:
        name, lo, hi = line.split(",")
        out[name] = (dt.date.fromisoformat(lo), dt.date.fromisoformat(hi))
    return out


def _regions(countries: list[str]) -> list[list[str]]:
    """Group nearby countries so one bbox query serves several (the API bills per request, not per area)."""
    def union(names):
        bs = [COUNTRIES[c] for c in names]
        return min(b[0] for b in bs), min(b[1] for b in bs), max(b[2] for b in bs), max(b[3] for b in bs)

    def area(b):
        return (b[2] - b[0]) * (b[3] - b[1])

    groups: list[list[str]] = []
    for c in countries:
        for g in groups:
            if area(union(g + [c])) <= 2 * sum(area(COUNTRIES[x]) for x in g + [c]):
                g.append(c)
                break
        else:
            groups.append([c])
    return groups


def fetch_current_year(client, key: str, year: int, countries: list[str]) -> list[dict]:
    """Current year via the area API in 5-day windows: standard product up to its last
    published day (-> raw/current), NRT after it (-> raw/nrt). Country = bbox, not clipped."""
    avail = _availability(client, key)
    budget, entries = _Budget(), []
    jan1 = dt.date(year, 1, 1)
    for sensor, meta in SENSORS.items():
        sp_end = avail.get(meta["api_sp"], (None, jan1 - dt.timedelta(days=1)))[1]
        nrt_end = avail.get(meta["api_nrt"], (None, sp_end))[1]
        plan = [("current", meta["api_sp"], jan1, sp_end),
                ("nrt", meta["api_nrt"], max(sp_end + dt.timedelta(days=1), jan1), nrt_end)]
        for kind, product, first, last in plan:
            if last < first:
                continue
            for group in _regions(countries):
                bs = [COUNTRIES[c] for c in group]
                bbox = (min(b[0] for b in bs), min(b[1] for b in bs), max(b[2] for b in bs), max(b[3] for b in bs))
                bbox_s = ",".join(map(str, bbox))
                header, rows, day = None, [], first
                while day <= last:
                    budget.spend()
                    body = _get(client, f"{FIRMS}/api/area/csv/{key}/{product}/{bbox_s}/5/{day}")
                    lines = (body or b"").decode().strip().splitlines()
                    if lines and not lines[0].startswith("latitude"):
                        raise RuntimeError(f"FIRMS refused {product} {day}: {lines[0][:200]}")
                    day += dt.timedelta(days=5)
                    if lines:
                        header = header or lines[0]
                        rows += [ln for ln in lines[1:] if ln.split(",")[5] <= last.isoformat()]
                if not header:
                    continue
                cols = header.split(",")
                ilat, ilon = cols.index("latitude"), cols.index("longitude")
                for c in group:
                    w, s, e, n = COUNTRIES[c]
                    mine = [r for r in rows if s <= float(r.split(",")[ilat]) <= n
                            and w <= float(r.split(",")[ilon]) <= e]
                    rel = f"{kind}/{sensor}/{year}/{sensor}_{year}_{c}.csv"
                    dest = RAW / rel
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    body = ("\n".join([header, *mine]) + "\n").encode()
                    dest.write_bytes(body)
                    entries.append({
                        "path": rel, "url": f"{FIRMS}/api/area/csv/<MAP_KEY>/{product}/{bbox_s}/5/<date>",
                        "bytes": len(body), "sha256": hashlib.sha256(body).hexdigest(),
                        "fetched_at": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
                        "product": f"{product} via area API (country bbox, not country-clipped)",
                        "coverage": f"{first}..{last}",
                        "license": "NASA EOSDIS open data (CC0)",
                    })
                    print(f"  {product:18} {c:10} {first}..{last}: {len(mine):,} rows")
    return entries


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--countries", nargs="*", default=list(COUNTRIES))
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    this_year = dt.date.today().year
    manifest = _load_manifest()
    jobs = [
        (sensor, year, c)
        for c in args.countries
        for sensor, meta in SENSORS.items()
        for year in range(meta["first"], this_year)
    ]
    with httpx.Client(headers=UA, timeout=120, follow_redirects=True) as client:
        with ThreadPoolExecutor(8) as pool:
            for entry in pool.map(lambda j: fetch_archive(client, *j, args.force), jobs):
                if entry:
                    manifest["files"][entry["path"]] = entry
        key = _load_key()
        if key:
            for entry in fetch_current_year(client, key, this_year, args.countries):
                manifest["files"][entry["path"]] = entry
        else:
            print(f"FIRMS_MAP_KEY not set - skipping {this_year} (archive ends {this_year - 1}).")

    manifest["updated_at"] = dt.datetime.now(dt.UTC).isoformat(timespec="seconds")
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    tmp = MANIFEST.with_suffix(".tmp")
    tmp.write_text(json.dumps(manifest, indent=1, sort_keys=True))
    tmp.replace(MANIFEST)  # atomic: an interrupted run can't leave an empty manifest
    total = sum(f["bytes"] for f in manifest["files"].values())
    print(f"{len(manifest['files'])} files, {total / 1e6:.0f} MB in {RAW}")


if __name__ == "__main__":
    main()
