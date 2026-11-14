import datetime as dt
import unittest
from unittest.mock import Mock, patch

import duckdb
import httpx
from shapely.geometry import shape

from firerosetta.risk import Observation, RiskMonitor, Snapshot, load_live, metric_grid, prioritize, summarize


TODAY = dt.date(2026, 11, 14)


class RiskTests(unittest.TestCase):
    def setUp(self):
        self.con = duckdb.connect()
        self.con.execute("""CREATE TABLE hs (country VARCHAR, platform VARCHAR, type INT, conf VARCHAR,
                         lon DOUBLE, lat DOUBLE, acq_date DATE, acq_time VARCHAR, is_nrt BOOLEAN)""")
        self.con.execute("""INSERT INTO hs VALUES
            ('Turkey','SNPP',0,'n',28.05,38.05,DATE '2023-11-20','1100',false),
            ('Turkey','SNPP',0,'n',28.05,38.05,DATE '2023-11-20','1101',false),
            ('Turkey','SNPP',0,'n',28.05,38.05,DATE '2023-11-20','1102',false),
            ('Turkey','SNPP',0,'n',28.05,38.05,DATE '2025-11-20','1100',false),
            ('Turkey','SNPP',0,'n',28.05,38.05,DATE '2025-11-20','1101',false),
            ('Turkey','SNPP',0,'n',28.05,38.05,DATE '2026-11-20','1100',false),
            ('Turkey','SNPP',0,'n',28.05,38.05,DATE '2024-08-20','1100',false),
            ('Turkey','SNPP',0,'n',28.05,38.05,DATE '2012-11-20','1100',false)""")

    def tearDown(self):
        self.con.close()

    def insert(self, platform="NOAA20", confidence="n", kind=0, date="2026-11-13"):
        self.con.execute("INSERT INTO hs VALUES ('Turkey', ?, ?, ?, 28.05, 38.05, ?::DATE, '1234', true)",
                         [platform, kind, confidence, date])

    def test_zero_years_and_no_future_or_other_seasons_in_baseline(self):
        report = RiskMonitor(self.con, "2026-11-14", loader=lambda *_: None).get("Turkey", TODAY)
        cell = report["cells"][0]
        self.assertEqual(report["history_years"], 13)
        self.assertEqual(cell["seasonal_mean"], round(5 / 13, 2))
        self.assertEqual(cell["active_years"], 2)

    def test_local_counts_use_one_sensor_and_quality_screen(self):
        self.insert()
        self.insert(platform="SNPP")
        self.insert(confidence="l")
        self.insert(kind=2)
        self.insert(date="2026-11-15")
        report = RiskMonitor(self.con, "2026-11-14", loader=lambda *_: None).get("Turkey", TODAY)
        self.assertEqual(report["summary"]["recent_7d"], 1)
        self.assertEqual(report["summary"]["high"], 1)

    def test_stale_data_does_not_raise_current_alerts(self):
        self.insert()
        report = RiskMonitor(self.con, "2026-11-10", loader=lambda *_: None).get("Turkey", TODAY)
        self.assertFalse(report["current_evidence_enabled"])
        self.assertEqual(report["summary"]["high"], 0)
        self.assertEqual(report["cells"][0]["level"], "watch")

    def test_empty_live_result_replaces_old_local_detections(self):
        self.insert()
        report = RiskMonitor(self.con, "2026-11-14", loader=lambda *_: Snapshot([], TODAY)).get("Turkey", TODAY)
        self.assertEqual(report["source"], "live")
        self.assertEqual(report["summary"]["recent_7d"], 0)

    def test_live_static_sources_are_masked_with_their_neighbours(self):
        self.con.execute("""INSERT INTO hs SELECT 'Turkey','NOAA20',2,'n',28.05,38.05,
                            DATE '2025-11-13','1234',false FROM range(3)""")
        records = [Observation(28.0501, 38.0501, TODAY, "1234"), Observation(29.05, 38.05, TODAY, "1234")]
        report = RiskMonitor(self.con, "2026-11-14", loader=lambda *_: Snapshot(records, TODAY)).get("Turkey", TODAY)
        self.assertEqual(report["summary"]["recent_7d"], 1)
        self.assertEqual(report["summary"]["high"], 1)

    def test_network_failure_falls_back_without_disclosing_key(self):
        loader = Mock(side_effect=httpx.ConnectError("https://example.test/PRIVATE_KEY"))
        report = RiskMonitor(self.con, "2026-11-14", loader=loader).get("Turkey", TODAY)
        self.assertEqual(report["source"], "local")
        self.assertNotIn("PRIVATE_KEY", str(report))
        self.assertTrue(report["live_error"])

    def test_cache_refreshes_on_day_change(self):
        loader = Mock(return_value=Snapshot([], TODAY))
        monitor = RiskMonitor(self.con, "2026-11-14", loader=loader)
        monitor.get("Turkey", TODAY)
        monitor.get("Turkey", TODAY)
        self.assertEqual(loader.call_count, 1)
        report = monitor.get("Turkey", TODAY + dt.timedelta(days=2))
        self.assertEqual(loader.call_count, 2)
        self.assertFalse(report["current_evidence_enabled"])

    def test_windows_are_inclusive_and_exact_duplicates_are_removed(self):
        record = Observation(28.05, 38.05, TODAY - dt.timedelta(days=6), "1234")
        rows = [record, record, Observation(28.05, 38.05, TODAY - dt.timedelta(days=7), "1234"),
                Observation(28.05, 38.05, TODAY - dt.timedelta(days=30), "1234"),
                Observation(28.05, 38.05, TODAY + dt.timedelta(days=1), "1234")]
        cell = next(iter(summarize(rows, TODAY, metric_grid("Turkey")).values()))
        self.assertEqual(cell["recent_7d"], 1)
        self.assertEqual(cell["recent_30d"], 2)

    def test_negative_coordinates_and_seasonal_only_priority(self):
        grid = metric_grid("Portugal")
        cells, _ = prioritize({grid.key(-6.5, 38.1): (3.0, 5)}, {}, fresh=False, grid=grid,
                              bounds=(-9.6, 36.9, -6.1, 42.2))
        self.assertEqual(cells[0]["level"], "elevated")
        self.assertLess(cells[0]["bbox"][0], cells[0]["bbox"][2])
        self.assertLess(cells[0]["bbox"][0], -6.5)
        self.assertGreater(cells[0]["bbox"][2], -6.5)

    def test_finest_cells_are_5000_metres_and_nested_in_parent(self):
        parent, child = metric_grid("Turkey", 20), metric_grid("Turkey", 5)
        px, py = parent.key(28.05, 38.05)
        a = parent.inverse.transform(px * 20000 + 1000, py * 20000 + 1000)
        b = parent.inverse.transform(px * 20000 + 9000, py * 20000 + 1000)
        ka, kb = child.key(*a), child.key(*b)
        self.assertNotEqual(ka, kb)
        self.assertEqual((ka[0] // 4, ka[1] // 4), (px, py))
        self.assertEqual((kb[0] // 4, kb[1] // 4), (px, py))
        geometry, _, _, _ = child.shape(*ka)
        ring = geometry["coordinates"][0]
        x0, y0 = child.forward.transform(*ring[0])
        x1, y1 = child.forward.transform(*ring[1])
        x2, y2 = child.forward.transform(*ring[2])
        self.assertAlmostEqual(x1 - x0, 5000, delta=0.03)
        self.assertAlmostEqual(y2 - y1, 5000, delta=0.03)

    def test_grid_never_exceeds_twenty_kilometres(self):
        for size in (40, 80):
            with self.assertRaises(ValueError):
                metric_grid("Turkey", size)

    def test_refinement_uses_point_coordinates_and_reuses_live_snapshot(self):
        parent, child = metric_grid("Turkey", 20), metric_grid("Turkey", 5)
        x, y = parent.key(28.05, 38.05)
        points = [parent.inverse.transform(x * 20000 + offset, y * 20000 + 1000) for offset in (1000, 9000)]
        loader = Mock(return_value=Snapshot([Observation(lon, lat, TODAY, '1200') for lon, lat in points], TODAY))
        monitor = RiskMonitor(self.con, "2026-11-14", loader=loader)
        coarse = monitor.get("Turkey", TODAY, grid_km=20)
        fine = monitor.get("Turkey", TODAY, grid_km=5)
        self.assertEqual(coarse["summary"]["high"], 1)
        self.assertEqual(fine["summary"]["high"], 2)
        self.assertEqual(fine["summary"]["recent_7d"], coarse["summary"]["recent_7d"])
        self.assertEqual(loader.call_count, 1)

    def test_viewport_excludes_cells_outside_view(self):
        report = RiskMonitor(self.con, "2026-11-14", loader=lambda *_: None).get(
            "Turkey", TODAY, grid_km=5, bounds=(40.0, 40.0, 41.0, 41.0))
        self.assertEqual(report["cells"], [])
        self.assertTrue(report["lattice"]["features"])

    def test_panning_reuses_precomputed_country_layer(self):
        monitor = RiskMonitor(self.con, "2026-11-14", loader=lambda *_: None)
        with patch.object(monitor, "_history", wraps=monitor._history) as history:
            monitor.get("Turkey", TODAY)
            monitor.get("Turkey", TODAY, bounds=(27, 37, 29, 39))
            monitor.get("Turkey", TODAY, bounds=(40, 40, 41, 41))
            self.assertEqual(history.call_count, 1)

    def test_custom_polygon_excludes_detections_inside_bbox_but_outside_shape(self):
        polygon = {"type": "Polygon", "coordinates": [[[28,38],[28.2,38],[28,38.2],[28,38]]]}
        loader = Mock(return_value=Snapshot([
            Observation(28.05, 38.05, TODAY, '1200'), Observation(28.18, 38.18, TODAY, '1200')], TODAY))
        monitor = RiskMonitor(self.con, "2026-11-14", area_loader=loader)
        coarse = monitor.get_area(polygon, TODAY, grid_km=20)
        fine = monitor.get_area(polygon, TODAY, grid_km=5)
        self.assertEqual(fine["summary"]["recent_7d"], 1)
        self.assertEqual(coarse["summary"]["recent_7d"], 1)
        self.assertEqual(loader.call_count, 1)
        for cell in fine["cells"]:
            self.assertLess(shape(cell["geometry"]).difference(shape(polygon)).area, 1e-10)

    def test_custom_area_deduplicates_overlapping_country_records(self):
        self.con.execute("""INSERT INTO hs VALUES ('Greece','SNPP',0,'n',28.05,38.05,
                            DATE '2023-11-20','1100',false)""")
        polygon = {"type": "Polygon", "coordinates": [[[28,38],[28.2,38],[28.2,38.2],[28,38.2],[28,38]]]}
        report = RiskMonitor(self.con, "2026-11-14", area_loader=lambda *_: None).get_area(polygon, TODAY)
        self.assertEqual(report["cells"][0]["seasonal_mean"], round(5 / 13, 2))

    def test_custom_area_outside_history_coverage_is_rejected(self):
        polygon = {"type": "Polygon", "coordinates": [[[0,0],[1,0],[1,1],[0,1],[0,0]]]}
        with self.assertRaises(ValueError):
            RiskMonitor(self.con, "2026-11-14", area_loader=lambda *_: None).get_area(polygon, TODAY)

    def test_live_parser_filters_confidence_country_dates_and_duplicates(self):
        body = "latitude,longitude,acq_date,acq_time,confidence\n38.05,28.05,2026-11-14,1234,n\n38.05,28.05,2026-11-14,1234,n\n38.05,28.05,2026-11-14,1235,l\n0,0,2026-11-14,1234,h\n38.05,28.05,2026-11-15,1234,h\n"
        response = httpx.Response(200, text=body, request=httpx.Request("GET", "https://example.test"))
        with patch("firerosetta.risk._load_key", return_value="PRIVATE_KEY"), \
             patch("firerosetta.risk._availability", return_value={"VIIRS_NOAA20_NRT": (dt.date(2026, 8, 1), TODAY)}), \
             patch("firerosetta.risk.httpx.Client") as client:
            client.return_value.__enter__.return_value.get.return_value = response
            snapshot = load_live("Turkey", TODAY)
        self.assertEqual(len(snapshot.observations), 1)
        self.assertEqual(snapshot.through, TODAY)


if __name__ == "__main__":
    unittest.main()
