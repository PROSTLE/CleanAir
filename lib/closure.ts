// Resident fix-check: when an operator marks a hotspot resolved, the people
// who reported it are asked whether it is actually gone. Shared by the server
// (lib/server/closure.ts) and the track page / dashboard.

/** How long reporters can answer after the operator resolves. */
export const CLOSURE_WINDOW_HOURS = 72;

export type ClosureAnswer = "fixed" | "not_fixed";

export type ClosureState =
  /** Asked, no answer yet. */
  | "awaiting"
  /** At least one reporter said it is fixed and none said otherwise. */
  | "confirmed"
  /** A reporter said it is still there; the hotspot was reopened. */
  | "disputed"
  /** Another reporter's "still there" already reopened it. */
  | "superseded";

export type Closure = {
  state: ClosureState;
  askedAt: string;
  deadline: string;
  answeredAt?: string | null;
  via?: "web" | "whatsapp" | null;
  /** Incident-level tallies across its linked reports. */
  confirmed?: number;
  disputed?: number;
};

export function openClosure(now: Date, perIncident: boolean): Closure {
  return {
    state: "awaiting",
    askedAt: now.toISOString(),
    deadline: new Date(now.getTime() + CLOSURE_WINDOW_HOURS * 3_600_000).toISOString(),
    answeredAt: null,
    via: null,
    ...(perIncident ? { confirmed: 0, disputed: 0 } : {}),
  };
}

/** "unanswered" once the window passed with no reply; derived, never stored. */
export function closureDisplayState(closure: Closure | null | undefined, nowMs = Date.now()) {
  if (!closure) return null;
  if (closure.state === "awaiting" && Date.parse(closure.deadline) < nowMs) return "unanswered" as const;
  return closure.state;
}

export function isClosureOpen(closure: Closure | null | undefined, nowMs = Date.now()) {
  return closureDisplayState(closure, nowMs) === "awaiting";
}
