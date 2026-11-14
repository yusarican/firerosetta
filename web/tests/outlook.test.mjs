import assert from "node:assert/strict";
import test from "node:test";
import { blockKey, byNowThenOutlook, outlookExpired, outlookFeatures, outlookIndex } from "../src/lib/outlook.ts";

const lead = (level, prob = 0.1) => ({ level, prob, expected: 1, normal: 1, ratio: 1 });
const data = {
  basis_month: "2025-12",
  leads: [{ lead: 1, target_month: "2026-01" }, { lead: 2, target_month: "2026-02" }],
  blocks: [
    { bx: 28, by: 38, leads: [lead("normal"), lead("high", 0.6)] },
    { bx: -9, by: 39, leads: [lead("elevated", 0.3), lead("watch")] },
  ],
};

test("a cell joins the 1 degree block holding its centre, west of Greenwich included", () => {
  assert.equal(blockKey(28.99, 38.01), "28:38");
  assert.equal(blockKey(-8.2, 39.5), "-9:39");
  assert.equal(outlookIndex(data, 0).get(blockKey(-8.2, 39.5)).level, "elevated");
  assert.equal(outlookIndex(data, 1).get("28:38").level, "high");
  assert.equal(outlookIndex(null, 0).size, 0);
});

test("block squares follow the selected lead", () => {
  const features = outlookFeatures(data, 1).features;
  assert.deepEqual(features.map((feature) => feature.properties.level), ["high", "watch"]);
  assert.deepEqual(features[1].geometry.coordinates[0][2], [-8, 40]);
});

test("the outlook only breaks ties inside an observed level", () => {
  const cells = [
    { id: "quiet-high", level: "high", lon: 28.5, lat: 38.5 },
    { id: "hot-high", level: "high", lon: -8.5, lat: 39.5 },
    { id: "hot-watch", level: "watch", lon: -8.4, lat: 39.4 },
    { id: "no-block-elevated", level: "elevated", lon: 0.5, lat: 0.5 },
  ];
  assert.deepEqual(byNowThenOutlook(cells, outlookIndex(data, 0)).map((cell) => cell.id),
    ["hot-high", "quiet-high", "no-block-elevated", "hot-watch"]);
  assert.equal(byNowThenOutlook(cells, new Map()), cells);
});

test("the outlook is expired once every forecast month is over", () => {
  assert.equal(outlookExpired(data, "2026-02-28"), false);
  assert.equal(outlookExpired(data, "2026-03-01"), true);
  assert.equal(outlookExpired(null, "2026-03-01"), false);
});
