"""Step 2 - raw FIRMS CSVs -> one typed parquet with a shared schema.

MODIS and VIIRS files differ (brightness vs bright_ti4, numeric vs l/n/h confidence);
this is where they become one table. Nothing is filtered here except exact duplicates.

NRT files carry no `type` column, so static sources (gas flares, factories, volcanoes) would
pass as vegetation fires. NRT rows inherit the type of the ~550 m spot they fall in when the
standard record has >= 3 non-vegetation detections in that spot or its 8 neighbours.
Held-out check (mask from 2000-2024, scored on 2025 standard data, 6 countries):
vegetation-count error +12.8% -> -1.5% for VIIRS, +6.5% -> +1.5% for MODIS.

    uv run python -m firerosetta.ingest
"""
from __future__ import annotations

import duckdb

from .config import GRID_DEG, RAW, STAGED

MASK_DEG, MASK_MIN = 0.005, 3

SQL = """
CREATE TEMP TABLE typed AS
  WITH src AS (
    SELECT *, replace(filename, chr(92), '/') AS f
    FROM read_csv('{raw}/*/*/*/*.csv', union_by_name=true, filename=true,
                  types={{'confidence':'VARCHAR','acq_time':'VARCHAR','satellite':'VARCHAR',
                          'version':'VARCHAR','type':'VARCHAR'}})
  ), typed AS (
    SELECT
      regexp_extract(f, '_\\d{{4}}_(.+)\\.csv$', 1)                     AS country,
      CASE WHEN instrument = 'MODIS' THEN 'MODIS' ELSE 'VIIRS' END      AS sensor,
      CASE satellite WHEN 'N' THEN 'SNPP' WHEN 'N20' THEN 'NOAA20' WHEN 'N21' THEN 'NOAA21'
                     WHEN '1' THEN 'NOAA20' WHEN '2' THEN 'NOAA21'
                     ELSE satellite END                                AS platform,
      CAST(latitude AS DOUBLE) AS lat, CAST(longitude AS DOUBLE) AS lon,
      CAST(acq_date AS DATE) AS acq_date,
      lpad(acq_time, 4, '0') AS acq_time,
      daynight,
      -- one confidence scale: low / nominal / high (MODIS thresholds per the MOD14 user guide)
      CASE WHEN instrument = 'MODIS'
           THEN CASE WHEN TRY_CAST(confidence AS INT) < 30 THEN 'l'
                     WHEN TRY_CAST(confidence AS INT) < 80 THEN 'n' ELSE 'h' END
           ELSE lower(confidence) END                                  AS conf,
      CAST(frp AS DOUBLE) AS frp,
      CAST(COALESCE(brightness, bright_ti4) AS DOUBLE) AS bright_mir,
      CAST(scan AS DOUBLE) AS scan, CAST(track AS DOUBLE) AS track,
      -- 0 vegetation fire, 1 volcano, 2 other static land source, 3 offshore; NRT rows have no type
      COALESCE(TRY_CAST(type AS INT), 0) AS type,
      f LIKE '%/nrt/%' AS is_nrt
    FROM src
  )
  SELECT DISTINCT *, floor(lon / {md})::INT AS mx, floor(lat / {md})::INT AS my
  FROM typed
  WHERE platform IN ('Terra','Aqua','SNPP','NOAA20','NOAA21');

CREATE TEMP TABLE static_spot AS
  SELECT mx, my, mode(type) AS t
  FROM typed WHERE NOT is_nrt AND type <> 0 GROUP BY ALL HAVING count(*) >= {mmin};

CREATE TEMP TABLE static_mask AS
  SELECT s.mx + dx AS mx, s.my + dy AS my, min(t) AS t
  FROM static_spot s, range(-1, 2) a(dx), range(-1, 2) b(dy) GROUP BY ALL;

COPY (
  SELECT h.* EXCLUDE (type, mx, my),
         CASE WHEN h.is_nrt AND m.t IS NOT NULL THEN m.t ELSE h.type END AS type,
         h.is_nrt AND m.t IS NOT NULL AS type_inferred,
         CAST(floor(h.lon / {g}) AS INT) AS gx, CAST(floor(h.lat / {g}) AS INT) AS gy
  FROM typed h LEFT JOIN static_mask m USING (mx, my)
  ORDER BY country, acq_date
) TO '{out}' (FORMAT parquet, COMPRESSION zstd);
"""


def _raise_fd_limit(target: int = 10240) -> None:
    # union_by_name opens every CSV at once; macOS shells default to 256 fds.
    try:
        import resource
    except ImportError:  # Windows has no POSIX file-descriptor limit.
        return
    soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
    want = target if hard == resource.RLIM_INFINITY else min(target, hard)
    if soft < want:
        resource.setrlimit(resource.RLIMIT_NOFILE, (want, hard))


def main() -> None:
    _raise_fd_limit()
    STAGED.mkdir(parents=True, exist_ok=True)
    out = STAGED / "hotspots.parquet"
    con = duckdb.connect()
    con.execute(SQL.format(raw=RAW, out=out, g=GRID_DEG, md=MASK_DEG, mmin=MASK_MIN))
    print(con.sql(f"""
        SELECT country, platform, min(acq_date) first, max(acq_date) last, count(*) n,
               round(avg((type=0)::INT)*100,1) pct_veg, round(avg((conf='l')::INT)*100,1) pct_low,
               count(*) FILTER (is_nrt) n_nrt, count(*) FILTER (type_inferred) n_static_inferred
        FROM '{out}' GROUP BY ALL ORDER BY ALL
    """).df().to_string())
    print(f"-> {out} ({out.stat().st_size / 1e6:.0f} MB)")


if __name__ == "__main__":
    main()
