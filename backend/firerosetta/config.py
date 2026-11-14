"""Shared paths and constants. Every other module imports from here."""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = Path(os.environ.get("FIREROSETTA_DATA", ROOT / "data"))
RAW = DATA / "raw"            # bytes exactly as FIRMS served them
STAGED = DATA / "staged"      # unified hotspot parquet
PROCESSED = DATA / "processed"  # grid aggregates, model output, metrics
MANIFEST = DATA / "manifest.json"

FIRMS = "https://firms.modaps.eosdis.nasa.gov"

# FIRMS country-archive names (as used in file names) -> bbox (W, S, E, N) for the NRT API.
COUNTRIES: dict[str, tuple[float, float, float, float]] = {
    "Turkey": (25.6, 35.8, 44.9, 42.2),
    "Greece": (19.3, 34.7, 29.7, 41.8),
    "Portugal": (-9.6, 36.9, -6.1, 42.2),
    "Spain": (-9.4, 35.9, 4.4, 43.9),
    "Italy": (6.6, 35.4, 18.6, 47.1),
    "Argentina": (-73.6, -55.1, -53.6, -21.7),
}

# archive folder name, first year, last year (inclusive; None = up to last complete year)
SENSORS = {
    "modis": dict(first=2000, api_sp="MODIS_SP", api_nrt="MODIS_NRT"),
    "viirs-snpp": dict(first=2012, api_sp="VIIRS_SNPP_SP", api_nrt="VIIRS_SNPP_NRT"),
    "viirs-jpss1": dict(first=2018, api_sp="VIIRS_NOAA20_SP", api_nrt="VIIRS_NOAA20_NRT"),
}

# S-NPP stopped delivering to FIRMS on 2026-11-02 13:00 UTC.
SNPP_END = "2026-11-02"

GRID_DEG = 0.1  # harmonization grid
