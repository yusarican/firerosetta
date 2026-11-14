import type { ExpressionSpecification } from "maplibre-gl";

// Fixed thresholds keep the same detection count the same shade in every area.
export const HIGH_PRIORITY_SHADES = [
  { min: 1, label: "1–4", color: "#e56d5b" },
  { min: 5, label: "5–14", color: "#ca3f34" },
  { min: 15, label: "15–39", color: "#9f2229" },
  { min: 40, label: "40+", color: "#681224" },
] as const;

export function highPriorityColor(detections: number): string {
  return [...HIGH_PRIORITY_SHADES].reverse().find((shade) => detections >= shade.min)?.color ?? HIGH_PRIORITY_SHADES[0].color;
}

export const RISK_FILL_COLOR: ExpressionSpecification = [
  "case", ["==", ["get", "level"], "high"],
  ["step", ["coalesce", ["get", "recent_7d"], 0], HIGH_PRIORITY_SHADES[0].color,
    HIGH_PRIORITY_SHADES[1].min, HIGH_PRIORITY_SHADES[1].color,
    HIGH_PRIORITY_SHADES[2].min, HIGH_PRIORITY_SHADES[2].color,
    HIGH_PRIORITY_SHADES[3].min, HIGH_PRIORITY_SHADES[3].color],
  ["match", ["get", "level"], "elevated", "#dd911d", "#83948b"],
];
