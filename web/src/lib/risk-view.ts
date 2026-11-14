import type { RiskCell, RiskGridKm, RiskLevel, RiskView } from "./api";

/** Reserve 20 km cells for broad, multi-country views. Country views stay at 10 km. */
export function riskGridForZoom(zoom: number): RiskGridKm {
  return zoom >= 8 ? 5 : zoom >= 4.5 ? 10 : 20;
}

type Ring = number[][];
type Bounds = RiskView["bounds"];

// Clip to the geographic viewport before measuring area. A bbox test alone counts
// cells that are actually outside the view, especially in clipped custom regions.
function clippedArea(ring: Ring, bounds: Bounds): number {
  let points = ring.slice(0, -1);
  for (const [axis, edge, sign] of [[0, bounds[0], 1], [0, bounds[2], -1], [1, bounds[1], 1], [1, bounds[3], -1]]) {
    const output: Ring = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length];
      const aInside = (a[axis] - edge) * sign >= 0, bInside = (b[axis] - edge) * sign >= 0;
      if (aInside) output.push(a);
      if (aInside !== bInside) {
        const ratio = (edge - a[axis]) / (b[axis] - a[axis]);
        output.push([a[0] + ratio * (b[0] - a[0]), a[1] + ratio * (b[1] - a[1])]);
      }
    }
    points = output;
    if (points.length < 3) return 0;
  }
  return Math.abs(points.reduce((sum, point, i) => {
    const next = points[(i + 1) % points.length];
    return sum + point[0] * next[1] - next[0] * point[1];
  }, 0)) / 2;
}

export function cellInView(cell: RiskCell, bounds: Bounds): boolean {
  const [w, s, e, n] = bounds;
  if (w >= e || s >= n) return false;
  if (cell.bbox[2] <= w || cell.bbox[0] >= e || cell.bbox[3] <= s || cell.bbox[1] >= n) return false;
  const polygons = cell.geometry.type === "Polygon" ? [cell.geometry.coordinates] : cell.geometry.coordinates;
  return polygons.some(([outer, ...holes]) => clippedArea(outer, bounds) - holes.reduce((sum, hole) => sum + clippedArea(hole, bounds), 0) > 1e-12);
}

export function visiblePriorities(cells: RiskCell[], bounds: Bounds, filter: "all" | RiskLevel, selectionBounds: Bounds = bounds) {
  const clipped: Bounds = [Math.max(bounds[0], selectionBounds[0]), Math.max(bounds[1], selectionBounds[1]),
    Math.min(bounds[2], selectionBounds[2]), Math.min(bounds[3], selectionBounds[3])];
  const visible = cells.filter((cell) => (filter === "all" || cell.level === filter) && cellInView(cell, clipped));
  const priorities = visible.filter((cell) => cell.level === "high" || cell.level === "elevated");
  priorities.sort((a, b) =>
    Number(b.level === "high") - Number(a.level === "high") ||
    (a.level === "high" && b.level === "high" ? b.recent_7d - a.recent_7d : 0) ||
    b.active_years - a.active_years || b.seasonal_mean - a.seasonal_mean || a.id.localeCompare(b.id));
  return {
    dataCells: visible.length,
    high: visible.filter((cell) => cell.level === "high").length,
    elevated: visible.filter((cell) => cell.level === "elevated").length,
    priorities,
  };
}
