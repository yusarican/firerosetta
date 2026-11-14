type StyleEvent = "style.load" | "styledataloading" | "webglcontextlost";
type StyleEvents = {
  on(event: StyleEvent, listener: () => void): unknown;
  off(event: StyleEvent, listener: () => void): unknown;
  isStyleLoaded(): boolean | void;
};

/** Keep only the latest updates and replay them after this map's style is rebuilt.
 * Source/tile loading is deliberately not a style reset: isStyleLoaded() can be
 * false during ordinary GeoJSON uploads, although addSource/addLayer are safe.
 */
export function createMapStyleSync(map: StyleEvents, onReady: (ready: boolean) => void) {
  let ready = map.isStyleLoaded() === true;
  let disposed = false;
  const updates = new Map<string, { apply: () => void; replay: boolean }>();

  const applyUpdate = (key: string) => {
    if (disposed || !ready) return;
    const update = updates.get(key);
    if (!update) return;
    if (!update.replay) updates.delete(key);
    update.apply();
  };
  const loading = () => {
    if (disposed) return;
    ready = false;
    onReady(false);
  };
  const loaded = () => {
    if (disposed) return;
    ready = true;
    // Bootstrap is registered first, before any source/layer updates.
    for (const key of [...updates.keys()]) applyUpdate(key);
    if (!disposed) onReady(ready);
  };
  map.on("styledataloading", loading);
  map.on("webglcontextlost", loading);
  map.on("style.load", loaded);

  return {
    get ready() { return !disposed && ready; },
    update(key: string, apply: () => void, replay = true) {
      if (disposed) return;
      updates.set(key, { apply, replay });
      applyUpdate(key);
    },
    cancel(key: string) { updates.delete(key); },
    dispose() {
      disposed = true;
      ready = false;
      updates.clear();
      map.off("styledataloading", loading);
      map.off("webglcontextlost", loading);
      map.off("style.load", loaded);
    },
  };
}
