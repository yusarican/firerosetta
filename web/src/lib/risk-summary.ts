import type { RiskReport } from "./api";

/** Totals always cover the entire selection, independently of the map camera. */
export function selectionReport(base: RiskReport, today: string): RiskReport {
  const age = Math.max(base.data_age_days, Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${base.data_through}T00:00:00Z`)) / 86_400_000));
  const fresh = base.current_evidence_enabled && age <= 1;
  const cells = fresh ? base.cells : base.cells.map((cell) => ({
    ...cell, level: cell.seasonal ? "elevated" as const : "watch" as const,
  }));
  return { ...base, cells, data_age_days: age, current_evidence_enabled: fresh, summary: {
    high: cells.filter((cell) => cell.level === "high").length,
    elevated: cells.filter((cell) => cell.level === "elevated").length,
    watch: cells.filter((cell) => cell.level === "watch").length,
    recent_7d: cells.reduce((sum, cell) => sum + cell.recent_7d, 0),
    total_cells: cells.length,
  } };
}
