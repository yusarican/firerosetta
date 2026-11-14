import assert from "node:assert/strict";
import test from "node:test";
import { selectionReport } from "../src/lib/risk-summary.ts";
import { getRisk } from "../src/lib/api.ts";
import { highPriorityColor, RISK_FILL_COLOR } from "../src/lib/risk-colors.ts";
import { expression } from "@maplibre/maplibre-gl-style-spec";

const report = () => ({
  data_age_days: 0, data_through: "2026-11-14", current_evidence_enabled: true,
  cells: [
    { id: "west", bbox: [27, 36, 28, 37], level: "high", seasonal: false, recent_7d: 4 },
    { id: "east", bbox: [40, 40, 41, 41], level: "high", seasonal: true, recent_7d: 20 },
    { id: "history", bbox: [35, 38, 36, 39], level: "watch", seasonal: false, recent_7d: 0 },
  ],
});

test("selection totals retain distant off-screen cells", () => {
  const base = report();
  const result = selectionReport(base, "2026-11-14");
  assert.deepEqual(result.cells.map((cell) => cell.id), ["west", "east", "history"]);
  assert.deepEqual(result.summary, { high: 2, elevated: 0, watch: 1, recent_7d: 24, total_cells: 3 });
  assert.equal(base.summary, undefined);
});

test("a day rollover downgrades stale alerts and recomputes full-selection totals", () => {
  const base = report();
  const result = selectionReport(base, "2026-11-16");
  assert.equal(result.current_evidence_enabled, false);
  assert.equal(result.data_age_days, 2);
  assert.deepEqual(result.summary, { high: 0, elevated: 1, watch: 2, recent_7d: 24, total_cells: 3 });
  assert.deepEqual(base.cells.map((cell) => cell.level), ["high", "high", "watch"]);
});

test("country requests fetch full coverage without a viewport filter", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify(report()), { status: 200 });
  });
  for (const gridKm of [10, 5]) await getRisk("Turkey", undefined, { gridKm });
  await getRisk("Turkey");
  assert.deepEqual(requests.map((request) => request.url), [
    "/api/risk?country=Turkey&grid_km=10", "/api/risk?country=Turkey&grid_km=5",
    "/api/risk?country=Turkey&grid_km=10",
  ]);
  assert.ok(requests.every((request) => request.options.method === "GET"));
});

test("map rendering and legend use the same shades, with darker red for more detections", () => {
  const compiled = expression.createExpression(RISK_FILL_COLOR, { type: "color" });
  assert.equal(compiled.result, "success", JSON.stringify(compiled.value));
  const luminance = (hex) => {
    const channels = hex.slice(1).match(/../g).map((channel) => parseInt(channel, 16));
    return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
  };
  let previous = Infinity;
  for (const count of [1, 5, 15, 40]) {
    const color = highPriorityColor(count);
    const rendered = compiled.value.evaluate({}, { properties: { level: "high", recent_7d: count } });
    assert.equal(rendered, color);
    assert.ok(luminance(color) < previous);
    previous = luminance(color);
  }
  assert.equal(highPriorityColor(1000), highPriorityColor(40));
  assert.equal(highPriorityColor(4), highPriorityColor(1));
});
