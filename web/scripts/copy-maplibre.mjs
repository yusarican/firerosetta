import { copyFileSync, mkdirSync } from "node:fs";

const destination = new URL("../public/maplibre/", import.meta.url);
mkdirSync(destination, { recursive: true });
for (const name of ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"]) {
  copyFileSync(
    new URL(`../node_modules/maplibre-gl/dist/${name}`, import.meta.url),
    new URL(name, destination),
  );
}
