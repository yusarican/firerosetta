import assert from "node:assert/strict";
import test from "node:test";
import { cellInView, riskGridForZoom, visiblePriorities } from "../src/lib/risk-view.ts";
import { getRiskGridCount } from "../src/lib/api.ts";

const square = (w, s, e, n) => [[w, s], [e, s], [e, n], [w, n], [w, s]];
const cell = (id, level, w, s, e, n) => ({id, level, bbox:[w,s,e,n], geometry:{type:"Polygon",coordinates:[square(w,s,e,n)]}});

test("20 km is reserved for distant views; country-scale views stay detailed", () => {
  assert.deepEqual([0, 3, 4.49, 4.5, 5.5, 7.99, 8, 10, 18].map(riskGridForZoom),
    [20, 20, 20, 10, 10, 10, 5, 5, 5]);
});

test("visible priorities include partial cells, exclude edge-only contact and retain selection totals", () => {
  const cells = [cell("partial", "high", 0,0,2,2), cell("inside", "elevated", 2,0,3,2),
    cell("watch", "watch", 2,2,3,3), cell("outside", "high", 8,8,9,9), cell("edge", "high", 3,0,4,2)];
  const original = JSON.stringify(cells);
  const visible = visiblePriorities(cells, [1,0,3,3], "all");
  assert.deepEqual(visible, {dataCells:3, high:1, elevated:1, priorities:cells.slice(0,2)});
  assert.equal(JSON.stringify(cells), original);
  assert.deepEqual(visiblePriorities(cells, [7,7,10,10], "all").priorities.map(c => c.id), ["outside"]);
});

test("visible list follows the map priority filter", () => {
  const cells = [cell("high", "high", 0,0,1,1), cell("elevated", "elevated", 0,0,1,1), cell("watch", "watch", 0,0,1,1)];
  assert.deepEqual(visiblePriorities(cells, [0,0,2,2], "high"), {dataCells:1, high:1, elevated:0, priorities:[cells[0]]});
  assert.deepEqual(visiblePriorities(cells, [0,0,2,2], "watch").priorities, []);
});

test("visible cards rank high priority first, then detection count and seasonal history", () => {
  const cells = [
    {...cell("season-weak", "elevated", 0,0,1,1), recent_7d:99, active_years:2, seasonal_mean:3},
    {...cell("high-fewer", "high", 0,0,1,1), recent_7d:2, active_years:10, seasonal_mean:30},
    {...cell("season-strong", "elevated", 0,0,1,1), recent_7d:0, active_years:8, seasonal_mean:4},
    {...cell("high-more", "high", 0,0,1,1), recent_7d:12, active_years:1, seasonal_mean:1},
  ];
  const original = JSON.stringify(cells);
  assert.deepEqual(visiblePriorities(cells, [0,0,2,2], "all").priorities.map(c=>c.id),
    ["high-more", "high-fewer", "season-strong", "season-weak"]);
  assert.equal(JSON.stringify(cells), original);
});

test("edge cells outside the selection do not exceed the visible grid count", () => {
  const cells = [cell("edge", "high", 0,0,2,2)];
  assert.equal(visiblePriorities(cells, [1,0,3,3], "all", [0,0,1,1]).high, 0);
  assert.equal(visiblePriorities(cells, [.5,0,3,3], "all", [0,0,1,1]).high, 1);
});

test("actual polygon geometry excludes false bbox hits and holes", () => {
  const triangle = {...cell("triangle", "high", 0,0,4,4), geometry:{type:"Polygon",coordinates:[[[0,0],[4,0],[0,4],[0,0]]]}};
  assert.equal(cellInView(triangle, [3,3,4,4]), false);
  assert.equal(cellInView(triangle, [0,0,1,1]), true);
  const holed = {...cell("hole", "high", 0,0,5,5), geometry:{type:"Polygon",coordinates:[square(0,0,5,5),square(1,1,4,4)]}};
  assert.equal(cellInView(holed, [2,2,3,3]), false);
  assert.equal(cellInView(holed, [.5,.5,2,2]), true);
});

test("multipart cells are counted once when more than one part is visible", () => {
  const multipart = {...cell("multi", "high", 0,0,5,5), geometry:{type:"MultiPolygon",coordinates:[[square(0,0,1,1)],[square(4,4,5,5)]]}};
  assert.equal(visiblePriorities([multipart], [0,0,6,6], "all").high, 1);
  assert.equal(cellInView(multipart, [2,2,3,3]), false);
  assert.equal(cellInView(multipart, [4,4,6,6]), true);
});

test("neutral grid counts use a local geometry-only request", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({url, ...options});
    return new Response(JSON.stringify({total_cells:42}), {status:200});
  });
  const geometry = {type:"Polygon",coordinates:[square(33,38,34,39)]};
  const view = {gridKm:5,bounds:[33.1,38.1,33.2,38.2]};
  const controller = new AbortController();
  assert.deepEqual(await getRiskGridCount(geometry, view, controller.signal), {total_cells:42});
  assert.equal(calls[0].url, "/api/risk/grid-count");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].signal, controller.signal);
  assert.deepEqual(JSON.parse(calls[0].body), {geometry,grid_km:5,bounds:view.bounds});
});
