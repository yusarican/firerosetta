"""Screening priorities from observed fire activity; not an ignition forecast or FWI.

Use one recent sensor (NOAA-20) to avoid adding overlapping satellite counts.
Seasonal context uses complete S-NPP years, including zero-activity years.
"""
from __future__ import annotations

import csv
import datetime as dt
import io
import hashlib
import math
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from functools import lru_cache

import httpx
import numpy as np
from pyproj import Transformer
import shapely
from shapely.geometry import box, mapping, shape

from .config import COUNTRIES, FIRMS, SNPP_END
from .fetch import UA, _availability, _load_key
from .ingest import MASK_DEG, MASK_MIN

GRID_LEVELS_KM = (5, 10, 20)
CACHE_SECONDS = 300
MAX_DATA_AGE_DAYS = 1
HISTORY_FIRST = 2013  # first complete S-NPP calendar year
HISTORY_LAST = int(SNPP_END[:4]) - 1


class MetricGrid:
    """One fixed UTM lattice per selection: 20 -> 10 -> 5 km nests exactly.

    Distances are nominal projected metres; small ground-scale distortion is expected
    away from the central meridian. Never substitute degrees for kilometres.
    """
    def __init__(self, country: str, km: int, bounds=None):
        if km not in GRID_LEVELS_KM:
            raise ValueError("Unsupported grid size")
        self.country, self.km, self.metres = country, km, km * 1000
        self.bounds = tuple(bounds or COUNTRIES[country])
        w, s, e, n = self.bounds
        zone = min(60, max(1, math.floor(((w + e) / 2 + 180) / 6) + 1))
        self.epsg = (32600 if (s + n) / 2 >= 0 else 32700) + zone
        self.forward = Transformer.from_crs(4326, self.epsg, always_xy=True)
        self.inverse = Transformer.from_crs(self.epsg, 4326, always_xy=True)

    def key(self, lon, lat):
        x, y = self.forward.transform(lon, lat)
        return math.floor(x / self.metres), math.floor(y / self.metres)

    def shape(self, x, y):
        size = self.metres
        eastings = [x * size, (x + 1) * size, (x + 1) * size, x * size, x * size]
        northings = [y * size, y * size, (y + 1) * size, (y + 1) * size, y * size]
        lons, lats = self.inverse.transform(eastings, northings)
        geometry = {"type": "Polygon", "coordinates": [[[round(a, 7), round(b, 7)] for a, b in zip(lons, lats)]]}
        bbox = [min(lons), min(lats), max(lons), max(lats)]
        lon, lat = self.inverse.transform((x + 0.5) * size, (y + 0.5) * size)
        return geometry, [round(value, 7) for value in bbox], round(lon, 5), round(lat, 5)

    def lattice(self, bounds):
        """Neutral grid lines also show subcells with no observation; these get no risk label."""
        cw, cs, ce, cn = self.bounds
        w, s, e, n = max(cw, bounds[0]), max(cs, bounds[1]), min(ce, bounds[2]), min(cn, bounds[3])
        empty = {"type": "FeatureCollection", "features": []}
        if w >= e or s >= n:
            return empty
        # Geographic rectangle edges curve in UTM; corners alone can omit a strip
        # of cells inside a wide selection, including cells in the view counter.
        perimeter = shapely.get_coordinates(shapely.segmentize(box(w, s, e, n), 0.05))
        east, north = self.forward.transform(perimeter[:, 0], perimeter[:, 1])
        size = self.metres
        x0, x1 = math.floor(min(east) / size), math.ceil(max(east) / size)
        y0, y1 = math.floor(min(north) / size), math.ceil(max(north) / size)
        lines = []
        def line(xs, ys):
            lon, lat = self.inverse.transform(xs, ys)
            return [[round(a, 7), round(b, 7)] for a, b in zip(lon, lat)]
        for x in range(x0, x1 + 1):
            lines.append(line([x * size] * 13, np.linspace(y0 * size, y1 * size, 13)))
        for y in range(y0, y1 + 1):
            lines.append(line(np.linspace(x0 * size, x1 * size, 13), [y * size] * 13))
        return {"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {},
                 "geometry": {"type": "MultiLineString", "coordinates": lines}}]}


@lru_cache(maxsize=30)
def metric_grid(country, km=10):
    return MetricGrid(country, km)


def risk_region(geometry):
    region = shape(geometry)
    if region.geom_type not in ("Polygon", "MultiPolygon") or region.is_empty or not region.is_valid:
        raise ValueError("Draw a valid area.")
    w, s, e, n = region.bounds
    if not all(math.isfinite(value) for value in region.bounds) or not (-180 <= w < e <= 180 and -85 <= s < n <= 85):
        raise ValueError("Invalid area coordinates.")
    if e - w > 25 or n - s > 40:
        raise ValueError("For 5 km detail, select a smaller area (at most 25 degrees longitude and 40 degrees latitude).")
    countries = [name for name, extent in COUNTRIES.items() if region.intersects(box(*extent))]
    if not countries:
        raise ValueError("The selection is outside the loaded historical coverage. Choose an area in or near Türkiye, Greece, Spain, Portugal, Italy or Argentina.")
    return region, countries


def count_visible_grid(geometry, bounds, grid_km=10):
    """Count all cells, including empty ones, without reading fire data or calling NASA."""
    if len(bounds) != 4 or not all(math.isfinite(value) for value in bounds):
        raise ValueError("Invalid map bounds.")
    w, s, e, n = bounds
    if not (-180 <= w < e <= 180 and -85 <= s < n <= 85):
        raise ValueError("Invalid map bounds.")
    region, _ = risk_region(geometry)
    grid = MetricGrid("view", grid_km, region.bounds)
    visible = region.intersection(box(w, s, e, n))
    if visible.is_empty or visible.area == 0:
        return 0
    # Densify before projection so curved geographic edges cannot hide candidate rows.
    coordinates = shapely.get_coordinates(shapely.segmentize(visible, 0.05))
    east, north = grid.forward.transform(coordinates[:, 0], coordinates[:, 1])
    size = grid.metres
    x0, x1 = math.floor(min(east) / size) - 1, math.ceil(max(east) / size) + 1
    y0, y1 = math.floor(min(north) / size) - 1, math.ceil(max(north) / size) + 1
    width = x1 - x0
    count = 0
    shapely.prepare(visible)
    # Bound temporary memory even when a whole country is visible.
    for start in range(0, width * (y1 - y0), 2048):
        index = np.arange(start, min(start + 2048, width * (y1 - y0)))
        xs, ys = (x0 + index % width) * size, (y0 + index // width) * size
        eastings = np.stack([xs, xs + size, xs + size, xs, xs], axis=-1)
        northings = np.stack([ys, ys, ys + size, ys + size, ys], axis=-1)
        lons, lats = grid.inverse.transform(eastings, northings)
        polygons = shapely.polygons(np.round(np.stack([lons, lats], axis=-1), 7))
        # A shared edge alone has no visible cell area. Holes and clipped selections count correctly.
        count += int(np.count_nonzero(shapely.intersects(visible, polygons) & ~shapely.touches(visible, polygons)))
    return count


@dataclass(frozen=True)
class Observation:
    lon: float
    lat: float
    date: dt.date
    time: str


@dataclass(frozen=True)
class Snapshot:
    observations: list[Observation]
    through: dt.date


@dataclass(frozen=True)
class StaticSites:
    """Persistent non-fire heat sources flagged by static.py, on that detector's own grid.

    `fire` holds the sites it found inside the vegetation-fire stream (FIRMS type 0), which
    the type filter cannot remove; `every` adds the ones FIRMS already tags. NRT records
    carry no type at all, so live data is screened against `every`.
    """
    deg: float
    fire: np.ndarray
    every: np.ndarray


def site_codes(sx, sy):
    """One integer per site cell, so membership is a vectorised np.isin."""
    return np.asarray(sx, dtype=np.int64) * 40_000 + np.asarray(sy, dtype=np.int64) + 20_000


def on_static_site(lon, lat, codes, deg):
    lon, lat = np.asarray(lon, dtype=float), np.asarray(lat, dtype=float)
    if not len(codes) or not len(lon):
        return np.zeros(len(lon), dtype=bool)
    return np.isin(site_codes(np.floor(lon / deg), np.floor(lat / deg)), codes)


def load_live(country: str, today: dt.date) -> Snapshot | None:
    """Fetch the last 30 days without rebuilding the historical model or writing raw files."""
    return load_live_bounds(COUNTRIES[country], today)


def load_live_bounds(bounds, today: dt.date) -> Snapshot | None:
    key = _load_key()
    if not key:
        return None
    first = today - dt.timedelta(days=29)
    with httpx.Client(headers=UA, timeout=20, follow_redirects=True) as client:
        available = _availability(client, key).get("VIIRS_NOAA20_NRT")
        if not available or available[0] > first:
            raise ValueError("Incomplete NRT availability")
        through = min(today, available[1])
        if through < first:
            raise ValueError("NRT coverage is too old")
        bbox = ",".join(map(str, bounds))
        starts = [first + dt.timedelta(days=i) for i in range(0, (through - first).days + 1, 5)]

        def fetch(start):
            response = client.get(f"{FIRMS}/api/area/csv/{key}/VIIRS_NOAA20_NRT/{bbox}/5/{start}")
            response.raise_for_status()
            text = response.text.strip()
            if not text.startswith("latitude,"):
                raise ValueError("Invalid FIRMS response")
            return list(csv.DictReader(io.StringIO(text)))

        with ThreadPoolExecutor(max_workers=3) as pool:
            batches = list(pool.map(fetch, starts))
    w, s, e, n = bounds
    observations = set()
    for rows in batches:
        for row in rows:
            if row["confidence"].lower() not in ("n", "h"):
                continue
            date = dt.date.fromisoformat(row["acq_date"])
            lat, lon = float(row["latitude"]), float(row["longitude"])
            if first <= date <= through and w <= lon <= e and s <= lat <= n:
                observations.add((lon, lat, date, row["acq_time"].zfill(4)))
    return Snapshot([Observation(*record) for record in sorted(observations)], through)


def summarize(observations, today, grid, static_mask=frozenset()):
    """Filter future/old records, exact duplicates and known static heat sources."""
    first = today - dt.timedelta(days=29)
    week = today - dt.timedelta(days=6)
    grouped = {}
    for record in set(observations):
        if not first <= record.date <= today:
            continue
        if (math.floor(record.lon / MASK_DEG), math.floor(record.lat / MASK_DEG)) in static_mask:
            continue
        key = grid.key(record.lon, record.lat)
        cell = grouped.setdefault(key, {"recent_7d": 0, "recent_30d": 0, "days": set(), "last_seen": None})
        cell["recent_30d"] += 1
        if record.date >= week:
            cell["recent_7d"] += 1
            cell["days"].add(record.date)
        cell["last_seen"] = max(cell["last_seen"] or record.date, record.date)
    return grouped


def prioritize(history, recent, *, fresh, grid, bounds):
    """Explicit screening rules. The labels are priorities, never probabilities."""
    means = [value[0] for value in history.values() if value[0] > 0]
    threshold = max(1.0, float(np.quantile(means, 0.75))) if means else 1.0
    cells = []
    for x, y in history.keys() | recent.keys():
        mean, active_years = history.get((x, y), (0.0, 0))
        evidence = recent.get((x, y), {})
        n7, n30 = evidence.get("recent_7d", 0), evidence.get("recent_30d", 0)
        if mean <= 0 and n30 == 0:
            continue
        seasonal = mean >= threshold and active_years >= 3
        level = "high" if fresh and n7 else "elevated" if seasonal or (fresh and n30) else "watch"
        geometry, bbox, lon, lat = grid.shape(x, y)
        if bbox[2] <= bounds[0] or bbox[0] >= bounds[2] or bbox[3] <= bounds[1] or bbox[1] >= bounds[3]:
            continue
        last_seen = evidence.get("last_seen")
        cells.append({
            "id": f"{grid.country}:{grid.km}:{x}:{y}", "lon": lon, "lat": lat,
            "bbox": bbox, "geometry": geometry,
            "level": level, "seasonal": seasonal, "seasonal_mean": round(float(mean), 2),
            "active_years": int(active_years), "recent_7d": int(n7), "recent_30d": int(n30),
            "active_days_7d": len(evidence.get("days", ())),
            "last_seen": last_seen.isoformat() if last_seen else None,
        })
    order = {"high": 0, "elevated": 1, "watch": 2}
    cells.sort(key=lambda c: (order[c["level"]], -c["recent_7d"] if fresh else 0,
                              -c["active_years"], -c["seasonal_mean"], c["id"]))
    return cells, round(threshold, 2)


class RiskMonitor:
    def __init__(self, connection, data_through: str, loader=load_live, area_loader=load_live_bounds,
                 static_sites: StaticSites | None = None):
        self.connection = connection
        self.data_through = dt.date.fromisoformat(data_through)
        self.loader = loader
        self.area_loader = area_loader
        self.cache = {}
        self.snapshots = {}
        self.history_points = {}
        self.lock = threading.Lock()
        self.static_mask = None
        self.static_sites = static_sites

    def _screen(self, observations, live, today):
        """Drop detections sitting on a flagged industrial heat source; report how many."""
        sites = self.static_sites
        if sites is None or not observations:
            return observations, 0
        hit = on_static_site([r.lon for r in observations], [r.lat for r in observations],
                             sites.every if live else sites.fire, sites.deg)
        first = today - dt.timedelta(days=29)
        dropped = len({r for r, bad in zip(observations, hit) if bad and first <= r.date <= today})
        return [r for r, bad in zip(observations, hit) if not bad], dropped

    def _screen_history(self, points):
        """A chimney burns every month of every year, which is exactly what 'seasonal' rewards."""
        sites = self.static_sites
        if sites is None or not len(points["lon"]):
            return points
        keep = ~on_static_site(points["lon"], points["lat"], sites.fire, sites.deg)
        return {name: np.asarray(values)[keep] for name, values in points.items()}

    def get_area(self, geometry, today=None, grid_km=10):
        today = today or dt.date.today()
        region, countries = risk_region(geometry)
        bounds = region.bounds
        area_id = "area-" + hashlib.sha256(region.wkb).hexdigest()[:16]
        key = (area_id, today, grid_km)
        with self.lock:
            cached = self.cache.get(key)
            if cached and time.monotonic() - cached[0] < CACHE_SECONDS:
                return cached[1]
            grid = MetricGrid(area_id, grid_km, bounds)
            cursor = self.connection.cursor()
            try:
                report = self._build_area(cursor, region, countries, today, grid)
            finally:
                cursor.close()
            self.cache = {k: v for k, v in self.cache.items() if k[1] == today}
            while len(self.cache) >= 32:
                self.cache.pop(next(iter(self.cache)))
            self.cache[key] = (time.monotonic(), report)
            return report

    def _build_area(self, cursor, region, countries, today, grid):
        bounds = region.bounds
        w, s, e, n = bounds
        last_year = min(HISTORY_LAST, today.year - 1)
        years = max(0, last_year - HISTORY_FIRST + 1)
        marks = ",".join("?" for _ in countries)
        point_key = (grid.country, today.month, last_year)
        if point_key not in self.history_points:
            points = cursor.execute(f"""
                SELECT lon, lat, year(acq_date)::SMALLINT AS year FROM (
                    SELECT DISTINCT lon, lat, acq_date, acq_time FROM hs
                    WHERE country IN ({marks}) AND platform = 'SNPP' AND type = 0 AND conf IN ('n', 'h')
                    AND acq_date BETWEEN ? AND ? AND month(acq_date) = ?
                    AND lon BETWEEN ? AND ? AND lat BETWEEN ? AND ?)
            """, [*countries, dt.date(HISTORY_FIRST, 1, 1), dt.date(last_year, 12, 31),
                    today.month, w, e, s, n]).fetchnumpy()
            inside = shapely.intersects_xy(region, points["lon"], points["lat"])
            points = self._screen_history({name: np.asarray(values)[inside] for name, values in points.items()})
            self.history_points = {k: v for k, v in self.history_points.items() if k[1:] == point_key[1:]}
            while len(self.history_points) >= 10:
                self.history_points.pop(next(iter(self.history_points)))
            self.history_points[point_key] = points
        history = aggregate_history(self.history_points[point_key], grid, years)
        source_key = ("bbox-" + str(tuple(bounds)), today)
        stored = self.snapshots.get(source_key)
        if stored and time.monotonic() - stored[0] < CACHE_SECONDS:
            _, snapshot, live_error = stored
        else:
            snapshot, live_error = None, None
            try:
                snapshot = self.area_loader(bounds, today)
            except (httpx.HTTPError, ValueError, KeyError, TypeError, csv.Error):
                live_error = "Live NASA data could not be retrieved. Using the latest prepared local data."
            self.snapshots = {k: v for k, v in self.snapshots.items() if k[1] == today}
            while len(self.snapshots) >= 16:
                self.snapshots.pop(next(iter(self.snapshots)))
            self.snapshots[source_key] = (time.monotonic(), snapshot, live_error)
        if snapshot is not None:
            observations = snapshot.observations
            through, source = snapshot.through, "live"
        else:
            local = cursor.execute(f"""
                SELECT DISTINCT lon, lat, acq_date, acq_time FROM hs WHERE country IN ({marks})
                AND platform = 'NOAA20' AND type = 0 AND conf IN ('n', 'h')
                AND acq_date BETWEEN ? AND ? AND lon BETWEEN ? AND ? AND lat BETWEEN ? AND ?
            """, [*countries, today - dt.timedelta(days=29), today, w, e, s, n]).fetchall()
            observations = [Observation(*row) for row in local]
            through, source = min(today, self.data_through), "local"
        if observations:
            inside = shapely.intersects_xy(region, [r.lon for r in observations], [r.lat for r in observations])
            observations = [r for r, keep in zip(observations, inside) if keep]
        observations, static_filtered = self._screen(observations, source == "live", today)
        recent = summarize(observations, today, grid, self._mask(cursor) if source == "live" else frozenset())
        age = max(0, (today - through).days)
        cells, threshold = prioritize(history, recent, fresh=age <= MAX_DATA_AGE_DAYS, grid=grid, bounds=bounds)
        for cell in cells:
            clipped = shape(cell["geometry"]).intersection(region)
            if clipped.is_empty or clipped.geom_type not in ("Polygon", "MultiPolygon"):
                clipped = shape(cell["geometry"])
            cell["geometry"] = mapping(clipped)
            cell["bbox"] = list(clipped.bounds)
            if not region.covers(shapely.Point(cell["lon"], cell["lat"])):
                point = clipped.representative_point()
                cell["lon"], cell["lat"] = round(point.x, 5), round(point.y, 5)
        lattice = grid.lattice(bounds)
        if lattice["features"]:
            clipped = shape(lattice["features"][0]["geometry"]).intersection(region)
            if clipped.geom_type == "LineString":
                clipped = shapely.MultiLineString([clipped])
            elif clipped.geom_type == "GeometryCollection":
                clipped = shapely.MultiLineString([part for part in clipped.geoms if part.geom_type == "LineString"])
            lattice["features"][0]["geometry"] = mapping(clipped)
        coverage = shapely.union_all([box(*COUNTRIES[name]) for name in countries])
        return {
            "country": grid.country, "bbox": bounds, "selection_geometry": mapping(region),
            "coverage_countries": countries, "coverage_partial": region.difference(coverage).area > 1e-8,
            "as_of": today.isoformat(), "checked_at": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
            "data_through": through.isoformat(), "data_age_days": age, "source": source, "live_error": live_error,
            "current_evidence_enabled": age <= MAX_DATA_AGE_DAYS, "grid_km": grid.km,
            "grid_crs": f"EPSG:{grid.epsg}", "view_bbox": bounds, "lattice": lattice,
            "history_first": HISTORY_FIRST, "history_last": last_year, "history_years": years,
            "season_month": today.month, "seasonal_threshold": threshold,
            "recent_sensor": "NOAA-20 VIIRS", "refresh_seconds": CACHE_SECONDS,
            "static_screen": self.static_sites is not None, "static_filtered": static_filtered,
            "summary": report_summary(cells), "cells": cells,
        }

    def _mask(self, cursor):
        if self.static_mask is None:
            spots = cursor.execute(f"""
                SELECT floor(lon / {MASK_DEG})::INT, floor(lat / {MASK_DEG})::INT
                FROM hs WHERE NOT is_nrt AND type <> 0 GROUP BY ALL HAVING count(*) >= {MASK_MIN}
            """).fetchall()
            self.static_mask = {(x + dx, y + dy) for x, y in spots
                                for dx in (-1, 0, 1) for dy in (-1, 0, 1)}
        return self.static_mask

    def get(self, country: str, today: dt.date | None = None, grid_km: int = 10, bounds=None):
        today = today or dt.date.today()
        grid = metric_grid(country, grid_km)
        bounds = tuple(bounds or COUNTRIES[country])
        key = (country, today, grid_km)
        with self.lock:
            cached = self.cache.get(key)
            if cached and time.monotonic() - cached[0] < CACHE_SECONDS:
                result = cached[1]
            else:
                cursor = self.connection.cursor()
                try:
                    # Build each country/scale once, not on every pan or zoom.
                    result = self._build(cursor, country, today, grid, COUNTRIES[country])
                finally:
                    cursor.close()
                self.cache = {k: v for k, v in self.cache.items() if k[1] == today}
                while len(self.cache) >= 32:
                    self.cache.pop(next(iter(self.cache)))
                self.cache[key] = (time.monotonic(), result)
            if bounds == tuple(COUNTRIES[country]):
                return result
            cells = [c for c in result["cells"] if c["bbox"][2] > bounds[0] and c["bbox"][0] < bounds[2]
                     and c["bbox"][3] > bounds[1] and c["bbox"][1] < bounds[3]]
            return result | {"cells": cells, "summary": report_summary(cells), "view_bbox": bounds,
                             "lattice": grid.lattice(bounds)}

    def _history(self, cursor, country, today, grid, last_year, years):
        if not years:
            return {}
        key = (country, today.month, last_year)
        if key not in self.history_points:
            points = cursor.execute("""
                SELECT lon, lat, year(acq_date)::SMALLINT AS year FROM hs
                WHERE country = ? AND platform = 'SNPP' AND type = 0 AND conf IN ('n', 'h')
                  AND acq_date BETWEEN ? AND ? AND month(acq_date) = ?
                  AND isfinite(lon) AND isfinite(lat)
            """, [country, dt.date(HISTORY_FIRST, 1, 1), dt.date(last_year, 12, 31), today.month]).fetchnumpy()
            self.history_points = {k: v for k, v in self.history_points.items() if k[1:] == key[1:]}
            # Native arrays retain much less memory than per-detection Python objects.
            self.history_points[key] = self._screen_history(points)
        points = self.history_points[key]
        if not len(points["lon"]):
            return {}
        east, north = grid.forward.transform(points["lon"], points["lat"])
        coordinates = np.column_stack((np.floor(east / grid.metres).astype(np.int64),
                                       np.floor(north / grid.metres).astype(np.int64), points["year"]))
        keys, counts = np.unique(coordinates, axis=0, return_counts=True)
        totals = {}
        for (x, y, _), count in zip(keys, counts):
            total, active = totals.get((int(x), int(y)), (0, 0))
            totals[int(x), int(y)] = (total + int(count), active + 1)
        return {key: (total / years, active) for key, (total, active) in totals.items()}

    def _build(self, cursor, country, today, grid, bounds):
        last_year = min(HISTORY_LAST, today.year - 1)
        years = max(0, last_year - HISTORY_FIRST + 1)
        history = self._history(cursor, country, today, grid, last_year, years)

        source_key = (country, today)
        stored = self.snapshots.get(source_key)
        if stored and time.monotonic() - stored[0] < CACHE_SECONDS:
            _, snapshot, live_error = stored
        else:
            snapshot, live_error = None, None
            try:
                snapshot = self.loader(country, today)
            except (httpx.HTTPError, ValueError, KeyError, TypeError, csv.Error):
                # FIRMS URLs contain the private MAP_KEY; never disclose exception text.
                live_error = "Live NASA data could not be retrieved. Using the latest prepared local data."
            self.snapshots = {k: v for k, v in self.snapshots.items() if k[1] == today}
            self.snapshots[source_key] = (time.monotonic(), snapshot, live_error)
        if snapshot is not None:
            observations, static_filtered = self._screen(snapshot.observations, True, today)
            recent = summarize(observations, today, grid, self._mask(cursor))
            through, source = snapshot.through, "live"
        else:
            first = today - dt.timedelta(days=29)
            local = cursor.execute("""
                SELECT lon, lat, acq_date, acq_time FROM hs
                WHERE country = ? AND platform = 'NOAA20' AND type = 0 AND conf IN ('n', 'h')
                  AND acq_date BETWEEN ? AND ?
            """, [country, first, today]).fetchall()
            observations, static_filtered = self._screen([Observation(*r) for r in local], False, today)
            recent = summarize(observations, today, grid)
            through, source = min(today, self.data_through), "local"
        age = max(0, (today - through).days)
        fresh = age <= MAX_DATA_AGE_DAYS
        cells, threshold = prioritize(history, recent, fresh=fresh, grid=grid, bounds=bounds)
        return {
            "country": country, "bbox": COUNTRIES[country], "as_of": today.isoformat(),
            "checked_at": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
            "data_through": through.isoformat(), "data_age_days": age,
            "source": source, "live_error": live_error, "current_evidence_enabled": fresh,
            "grid_km": grid.km, "grid_crs": f"EPSG:{grid.epsg}", "view_bbox": bounds,
            "lattice": grid.lattice(bounds),
            "history_first": HISTORY_FIRST, "history_last": last_year,
            "history_years": years, "season_month": today.month, "seasonal_threshold": threshold,
            "recent_sensor": "NOAA-20 VIIRS", "refresh_seconds": CACHE_SECONDS,
            "static_screen": self.static_sites is not None, "static_filtered": static_filtered,
            "summary": report_summary(cells),
            "cells": cells,
        }


def report_summary(cells):
    return {level: sum(c["level"] == level for c in cells) for level in ("high", "elevated", "watch")} | {
        "recent_7d": sum(c["recent_7d"] for c in cells), "total_cells": len(cells)}


def aggregate_history(points, grid, years):
    if not years or not len(points["lon"]):
        return {}
    east, north = grid.forward.transform(points["lon"], points["lat"])
    coordinates = np.column_stack((np.floor(east / grid.metres).astype(np.int64),
                                   np.floor(north / grid.metres).astype(np.int64), points["year"]))
    keys, counts = np.unique(coordinates, axis=0, return_counts=True)
    totals = {}
    for (x, y, _), count in zip(keys, counts):
        total, active = totals.get((int(x), int(y)), (0, 0))
        totals[int(x), int(y)] = (total + int(count), active + 1)
    return {key: (total / years, active) for key, (total, active) in totals.items()}
