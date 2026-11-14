import type { OutlookBlocks, OutlookLead, RiskLevel, WarnLevel } from "./api";

// The outlook is a probability from a model; the alert layer is a count of what satellites
// saw. They share level names, so they must never share a colour family: observed activity
// stays red/amber, the outlook is violet everywhere it appears.
export const OUTLOOK_STYLE: Record<WarnLevel, { label: string; fill: string; ink: string }> = {
  normal: { label: "Normal", fill: "#eeeaf5", ink: "#4a4458" },
  watch: { label: "Watch", fill: "#d9ccf2", ink: "#3b2470" },
  elevated: { label: "Elevated", fill: "#a58ae0", ink: "#1e0f4a" },
  high: { label: "High", fill: "#5a2ca0", ink: "#ffffff" },
};

const OUTLOOK_RANK: Record<WarnLevel, number> = { high: 0, elevated: 1, watch: 2, normal: 3 };
const NOW_RANK: Record<RiskLevel, number> = { high: 0, elevated: 1, watch: 2 };

/** The model's unit is the 1 degree block; a cell belongs to the block holding its centre. */
export const blockKey = (lon: number, lat: number) => `${Math.floor(lon)}:${Math.floor(lat)}`;

export function outlookIndex(data: OutlookBlocks | null, leadIndex: number): Map<string, OutlookLead> {
  const index = new Map<string, OutlookLead>();
  for (const block of data?.blocks ?? []) {
    const lead = block.leads[leadIndex];
    if (lead) index.set(`${block.bx}:${block.by}`, lead);
  }
  return index;
}

export function outlookFeatures(data: OutlookBlocks | null, leadIndex: number) {
  return {
    type: "FeatureCollection" as const,
    features: (data?.blocks ?? []).filter((block) => block.leads[leadIndex]).map(({ bx, by, leads }) => ({
      type: "Feature" as const,
      properties: { level: leads[leadIndex].level, prob: leads[leadIndex].prob },
      geometry: { type: "Polygon" as const, coordinates: [[[bx, by], [bx + 1, by], [bx + 1, by + 1], [bx, by + 1], [bx, by]]] },
    })),
  };
}

/**
 * Observed activity decides the order; the outlook only breaks ties inside a level, so a
 * cell burning now in a block expected to run hot comes before one burning now in a quiet
 * block. The two are never added into one score.
 */
export function byNowThenOutlook<T extends { level: RiskLevel; lon: number; lat: number }>(
  cells: T[], index: Map<string, OutlookLead>,
): T[] {
  if (!index.size) return cells;
  const rank = (cell: T) => OUTLOOK_RANK[index.get(blockKey(cell.lon, cell.lat))?.level ?? "normal"];
  return cells
    .map((cell, order) => ({ cell, order }))
    .sort((a, b) => NOW_RANK[a.cell.level] - NOW_RANK[b.cell.level] || rank(a.cell) - rank(b.cell) || a.order - b.order)
    .map(({ cell }) => cell);
}

/** True when every month the model forecast is already over: the inputs need refreshing. */
export function outlookExpired(data: OutlookBlocks | null, today: string): boolean {
  const last = data?.leads.at(-1)?.target_month;
  return last !== undefined && last < today.slice(0, 7);
}
