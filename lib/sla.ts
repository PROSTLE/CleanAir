import type { WorkOrder } from "@/lib/types";

// Response targets per work-order priority. A target exists only once a work
// order has set a priority (Gemini picks it from the recorded evidence, and
// the operator can redraft it); with no work order there is no target, rather
// than a guessed one. Edit these to match the municipality's own SLA.
export const RESPONSE_TARGET_HOURS: Record<WorkOrder["priority"], number> = {
  immediate: 4,
  within_24h: 24,
  routine: 72,
};

export type SlaStatus = {
  targetHours: number;
  elapsedHours: number;
  dueAtMs: number;
  /** Hours past the target, or null while still within it. */
  overdueHours: number | null;
};

/** getSlaStatus against the current time. */
export function getSlaStatusNow(input: Omit<Parameters<typeof getSlaStatus>[0], "nowMs">) {
  return getSlaStatus({ ...input, nowMs: Date.now() });
}

/** Time since the hotspot was confirmed, against its work-order target. Null when there is no target or it is closed. */
export function getSlaStatus(input: {
  priority: WorkOrder["priority"] | null | undefined;
  openedAtMs: number;
  resolved: boolean;
  nowMs: number;
}): SlaStatus | null {
  if (input.resolved || !input.priority || !Number.isFinite(input.openedAtMs)) return null;
  const targetHours = RESPONSE_TARGET_HOURS[input.priority];
  if (targetHours === undefined) return null;
  const dueAtMs = input.openedAtMs + targetHours * 3_600_000;
  const elapsedHours = Math.max(0, (input.nowMs - input.openedAtMs) / 3_600_000);
  const overdue = input.nowMs - dueAtMs;
  return {
    targetHours,
    elapsedHours: Math.floor(elapsedHours),
    dueAtMs,
    overdueHours: overdue > 0 ? Math.max(1, Math.floor(overdue / 3_600_000)) : null,
  };
}
