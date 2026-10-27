import type { AdvisoryLevel, SourceRegionSummary, TransboundaryAdvisory } from "@/lib/transboundary";

/** Response of GET /api/federation/v1/advisories. */
export type AdvisoryFeed = {
  type: "FeatureCollection";
  generatedAt: string;
  method: string;
  cities: Array<{
    cityId: string;
    cityName: string;
    computedAt: string;
    advisories: number;
    clustersConsidered: number;
    firesConsidered: number;
    firesTruncated: boolean;
    fireWindow: { start: string; end: string } | null;
    windLevel: string | null;
    error: string | null;
  }>;
  bySourceState: SourceRegionSummary[];
  features: Array<{
    type: "Feature";
    id: string;
    geometry: { type: "LineString"; coordinates: Array<[number, number]> };
    properties: Omit<TransboundaryAdvisory, "path"> & { cap: string };
  }>;
};

export const LEVEL_COLOR: Record<AdvisoryLevel, string> = {
  severe: "#b42318",
  high: "#c2410c",
  moderate: "#a15c07",
  watch: "#6d7b73",
};

export const LEVEL_LABEL_KEY: Record<AdvisoryLevel, string> = {
  severe: "fed_level_severe",
  high: "fed_level_high",
  moderate: "fed_level_moderate",
  watch: "fed_level_watch",
};

export function formatEta(hours: number) {
  if (hours < 1) return "<1 h";
  return `~${Math.round(hours)} h`;
}
