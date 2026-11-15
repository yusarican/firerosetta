import assert from "node:assert/strict";
import test from "node:test";
import { createMapStyleSync } from "../src/components/fire/map-style-sync.ts";

class MapEvents {
  listeners = new Map();
  styleLoaded = false;
  sourcesLoading = false;
  on(event, listener) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(listener);
  }
  off(event, listener) { this.listeners.get(event)?.delete(listener); }
  emit(event) { for (const listener of this.listeners.get(event) ?? []) listener(); }
  isStyleLoaded() { return this.styleLoaded && !this.sourcesLoading; }
  loadStyle() { this.styleLoaded = true; this.emit("style.load"); }
  loseContext() { this.styleLoaded = false; this.emit("webglcontextlost"); }
  addSource(name, output) {
    if (!this.styleLoaded) throw new Error("Style is not done loading.");
    output.push(name);
  }
}

test("delayed style waits and applies only the newest pending area/layers", () => {
  const map = new MapEvents(), output = [];
  const sync = createMapStyleSync(map, () => {});
  sync.update("bootstrap", () => map.addSource("selection", output));
  sync.update("risk-layers", () => map.addSource("old-area", output));
  sync.update("risk-layers", () => map.addSource("latest-area", output));
  assert.deepEqual(output, []);
  map.loadStyle();
  assert.deepEqual(output, ["selection", "latest-area"]);
});

test("a new map never inherits an old map's ready state (Strict Mode/Fast Refresh)", () => {
  const oldMap = new MapEvents(), newMap = new MapEvents(), output = [];
  oldMap.loadStyle();
  const oldSync = createMapStyleSync(oldMap, () => {});
  assert.equal(oldSync.ready, true);
  oldSync.dispose();
  const newSync = createMapStyleSync(newMap, () => {});
  newSync.update("risk-layers", () => newMap.addSource("new-map", output));
  oldMap.loadStyle();
  assert.deepEqual(output, []);
  assert.equal(newSync.ready, false);
  newMap.loadStyle();
  assert.deepEqual(output, ["new-map"]);
});

test("context restoration waits for style.load and rebuilds the latest overlays", () => {
  const map = new MapEvents(), output = [], states = [];
  const sync = createMapStyleSync(map, (ready) => states.push(ready));
  sync.update("bootstrap", () => map.addSource("selection", output));
  sync.update("risk-layers", () => map.addSource("10km", output));
  map.loadStyle();
  map.loseContext();
  sync.update("risk-layers", () => map.addSource("5km", output));
  map.emit("webglcontextrestored");
  assert.equal(sync.ready, false);
  assert.deepEqual(output, ["selection", "10km"]);
  map.loadStyle();
  assert.deepEqual(output, ["selection", "10km", "selection", "5km"]);
  assert.deepEqual(states, [true, false, true]);
});

test("ordinary GeoJSON/tile loading does not stall updates waiting for another style.load", () => {
  const map = new MapEvents(), output = [];
  const sync = createMapStyleSync(map, () => {});
  map.loadStyle();
  map.sourcesLoading = true;
  assert.equal(map.isStyleLoaded(), false);
  sync.update("risk-layers", () => map.addSource("new-data", output));
  assert.deepEqual(output, ["new-data"]);
});

test("a genuine style reload queues updates again", () => {
  const map = new MapEvents(), output = [];
  const sync = createMapStyleSync(map, () => {});
  map.loadStyle();
  map.styleLoaded = false;
  map.emit("styledataloading");
  sync.update("selection", () => map.addSource("new-selection", output));
  assert.deepEqual(output, []);
  map.loadStyle();
  assert.deepEqual(output, ["new-selection"]);
});

test("rebuilding overlays does not reset the user's camera", () => {
  const map = new MapEvents(), output = [];
  const sync = createMapStyleSync(map, () => {});
  sync.update("bounds", () => output.push("fit-bounds"), false);
  sync.update("risk-layers", () => map.addSource("overlays", output));
  map.loadStyle();
  map.loseContext();
  map.loadStyle();
  assert.deepEqual(output, ["fit-bounds", "overlays", "overlays"]);
});

test("unmount disposes pending updates and all event listeners", () => {
  const map = new MapEvents(), output = [];
  const sync = createMapStyleSync(map, () => output.push("ready"));
  sync.update("risk-layers", () => map.addSource("removed-map", output));
  sync.dispose();
  map.loadStyle();
  sync.update("risk-layers", () => output.push("late-response"));
  assert.deepEqual(output, []);
  assert.equal(sync.ready, false);
  assert.equal([...map.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0), 0);
});

test("unmount during initialization cannot notify readiness or run remaining updates", () => {
  const map = new MapEvents(), output = [];
  const sync = createMapStyleSync(map, () => output.push("ready"));
  sync.update("bootstrap", () => sync.dispose());
  sync.update("risk-layers", () => map.addSource("removed-map", output));
  map.loadStyle();
  assert.deepEqual(output, []);
  assert.equal(sync.ready, false);
});
