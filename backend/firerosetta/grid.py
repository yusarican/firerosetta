"""Step 3 - hotspots -> dense cell x month table used for training and for serving.

Quality screen applied to every sensor identically (this is the first half of harmonization):
  * type = 0 only  - drops volcanoes, static industrial sources, offshore flares.
                     VIIRS flags ~25-30 % of Turkish/Italian detections as static, MODIS ~3 %,
                     so leaving them in would inflate the VIIRS era by itself.
  * confidence >= nominal - drops low-confidence pixels (sun glint, hot bare soil).

    uv run python -m firerosetta.grid
"""
from __future__ import annotations

import duckdb

from .config import PROCESSED, STAGED

SQL = """
CREATE TABLE hs AS
  SELECT country, gx, gy, date_trunc('month', acq_date)::DATE AS month, platform, daynight, frp
  FROM '{src}' WHERE type = 0 AND conf <> 'l';

CREATE TABLE sparse AS
  SELECT country, gx, gy, month,
    count(*) FILTER (platform IN ('Terra','Aqua'))                 AS m_n,
    count(*) FILTER (platform = 'Terra')                           AS m_terra,
    count(*) FILTER (platform = 'Aqua')                            AS m_aqua,
    count(*) FILTER (platform IN ('Terra','Aqua') AND daynight='N') AS m_night,
    count(*) FILTER (platform = 'Terra' AND daynight='N')          AS m_terra_night,
    coalesce(sum(frp) FILTER (platform IN ('Terra','Aqua')), 0)    AS m_frp,
    coalesce(sum(frp) FILTER (platform = 'Terra'), 0)              AS m_terra_frp,
    count(*) FILTER (platform = 'SNPP')                            AS v_snpp,
    count(*) FILTER (platform = 'NOAA20')                          AS v_n20,
    coalesce(sum(frp) FILTER (platform = 'SNPP'), 0)               AS v_snpp_frp
  FROM hs GROUP BY ALL;

-- every cell that ever burned x every month of the record (zeros are data too)
CREATE TABLE cells AS SELECT DISTINCT country, gx, gy FROM sparse;
CREATE TABLE months AS
  SELECT unnest(generate_series(DATE '2000-11-01', (SELECT max(month) FROM sparse), INTERVAL 1 MONTH))::DATE AS month;

-- MODIS activity in the surrounding 3x3 and 7x7 cells: tells the model about fires
-- next door that this cell's 1 km MODIS pixels may have missed
CREATE TABLE nb AS
  SELECT c.country, c.gx, c.gy, s.month,
    sum(s.m_n)     FILTER (abs(s.gx-c.gx)<=1 AND abs(s.gy-c.gy)<=1) AS m_nb3,
    sum(s.m_n)                                                     AS m_nb7,
    sum(s.m_terra) FILTER (abs(s.gx-c.gx)<=1 AND abs(s.gy-c.gy)<=1) AS t_nb3,
    sum(s.m_terra)                                                 AS t_nb7
  FROM cells c JOIN sparse s
    ON s.gx BETWEEN c.gx-3 AND c.gx+3 AND s.gy BETWEEN c.gy-3 AND c.gy+3
  WHERE s.m_n > 0 GROUP BY ALL;

-- long-run MODIS climatology of the cell (MODIS-only, so it exists for every era)
CREATE TABLE clim AS
  SELECT country, gx, gy,
         sum(m_n)::DOUBLE / 23 AS m_clim, sum(m_terra)::DOUBLE / 23 AS t_clim
  FROM sparse WHERE month >= DATE '2003-01-01' GROUP BY ALL;

COPY (
  SELECT c.country, c.gx, c.gy, m.month,
    year(m.month)::SMALLINT AS year, month(m.month)::TINYINT AS moy,
    coalesce(s.m_n,0)::INT m_n, coalesce(s.m_terra,0)::INT m_terra, coalesce(s.m_aqua,0)::INT m_aqua,
    coalesce(s.m_night,0)::INT m_night, coalesce(s.m_terra_night,0)::INT m_terra_night,
    coalesce(s.m_frp,0)::FLOAT m_frp, coalesce(s.m_terra_frp,0)::FLOAT m_terra_frp,
    coalesce(nb.m_nb3,0)::INT m_nb3, coalesce(nb.m_nb7,0)::INT m_nb7,
    coalesce(nb.t_nb3,0)::INT t_nb3, coalesce(nb.t_nb7,0)::INT t_nb7,
    coalesce(cl.m_clim,0)::FLOAT m_clim, coalesce(cl.t_clim,0)::FLOAT t_clim,
    coalesce(s.v_snpp,0)::INT v_snpp, coalesce(s.v_n20,0)::INT v_n20,
    coalesce(s.v_snpp_frp,0)::FLOAT v_snpp_frp
  FROM cells c CROSS JOIN months m
  LEFT JOIN sparse s USING (country, gx, gy, month)
  LEFT JOIN nb USING (country, gx, gy, month)
  LEFT JOIN clim cl USING (country, gx, gy)
  ORDER BY country, month, gx, gy
) TO '{out}' (FORMAT parquet, COMPRESSION zstd);
"""


def main() -> None:
    PROCESSED.mkdir(parents=True, exist_ok=True)
    out = PROCESSED / "cell_month.parquet"
    con = duckdb.connect()
    con.execute(SQL.format(src=STAGED / "hotspots.parquet", out=out))
    print(con.sql(f"""
        SELECT country, count(DISTINCT (gx, gy)) cells, count(*) n_rows,
               sum(m_n) modis, sum(v_snpp) snpp, sum(v_n20) noaa20
        FROM '{out}' GROUP BY ALL ORDER BY ALL""").df().to_string())
    print(f"-> {out} ({out.stat().st_size / 1e6:.0f} MB)")


if __name__ == "__main__":
    main()
