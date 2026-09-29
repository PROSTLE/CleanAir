// Repeat-hotspot history for one H3 cell. Pure functions over two real
// records: the append-only `incidentEvents` log (written whenever an incident
// is promoted, reopened, dispatched, resolved or disputed) and the cell's
// citizen reports. Nothing here estimates or fills gaps: a cell with no
// recorded events has no episode history, and the summary says so.

export type IncidentEventKind =
  | "promoted"
  | "reopened"
  | "dispatched"
  | "resolved"
  | "false_positive"
  | "fix_confirmed"
  | "disputed";

export type CellEvent = { kind: IncidentEventKind; atMs: number };

/** A citizen report in the cell; `counts` = a pollution signal that isn't integrity-flagged. */
export type CellReport = { atMs: number; counts: boolean };

export const RECURRENCE_WINDOW_DAYS = 30;
/** Separate confirmed episodes in the window that make a cell "chronic". */
export const CHRONIC_MIN_EPISODES = 3;
/** Separate days with valid citizen reports in the window that make a cell "chronic". */
export const CHRONIC_MIN_REPORT_DAYS = 3;
/** A hotspot back within this many days of being marked fixed means the fix did not hold. */
export const FIX_HELD_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;
// Events carry Firestore server timestamps, which can run slightly ahead of
// the app server's clock; a just-written event must still count.
const CLOCK_SKEW_MS = 10 * 60 * 1000;

export type ChronicReason = "episodes" | "report_days" | "fix_did_not_hold";

export type RecurrenceSummary = {
  windowDays: number;
  /** Promotions + reopenings recorded in the window. */
  episodes: number;
  /** Distinct local days in the window with at least one valid citizen report. */
  reportDays: number;
  /** Local dates (YYYY-MM-DD, city time zone) with an episode or a valid report. */
  activeDates: string[];
  /** Residents said "still there" after a fix, or it came back within FIX_HELD_DAYS. */
  fixDidNotHold: boolean;
  chronic: boolean;
  chronicReasons: ChronicReason[];
  /** Oldest incident event on record for the cell; null = no episode history yet. */
  trackingSinceMs: number | null;
  lastEpisodeMs: number | null;
};

/** Localised reason text; thresholds come from the constants above, not the locale file. */
export function chronicReasonText(reason: ChronicReason, t: (key: string) => string) {
  const threshold =
    reason === "episodes" ? CHRONIC_MIN_EPISODES : reason === "report_days" ? CHRONIC_MIN_REPORT_DAYS : FIX_HELD_DAYS;
  return t(`chronic_reason_${reason}`).replace("{n}", String(threshold));
}

/** Calendar date of an instant in a city's time zone, as YYYY-MM-DD. */
export function localDateKey(ms: number, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(ms),
  );
}

/** The last `days` local dates ending today, oldest first. */
export function recentDateKeys(nowMs: number, days: number, timeZone: string) {
  const keys: string[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const key = localDateKey(nowMs - offset * DAY_MS, timeZone);
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

const EPISODE_KINDS = new Set<IncidentEventKind>(["promoted", "reopened"]);

export function summarizeRecurrence(input: {
  events: CellEvent[];
  reports: CellReport[];
  nowMs: number;
  timeZone: string;
  windowDays?: number;
}): RecurrenceSummary {
  const windowDays = input.windowDays ?? RECURRENCE_WINDOW_DAYS;
  const windowStart = input.nowMs - windowDays * DAY_MS;
  const events = input.events
    .filter((event) => Number.isFinite(event.atMs) && event.atMs <= input.nowMs + CLOCK_SKEW_MS)
    .sort((a, b) => a.atMs - b.atMs);
  const inWindow = events.filter((event) => event.atMs >= windowStart);

  const episodeEvents = inWindow.filter((event) => EPISODE_KINDS.has(event.kind));
  const validReports = input.reports.filter(
    (report) =>
      report.counts &&
      Number.isFinite(report.atMs) &&
      report.atMs >= windowStart &&
      report.atMs <= input.nowMs + CLOCK_SKEW_MS,
  );

  const reportDates = new Set(validReports.map((report) => localDateKey(report.atMs, input.timeZone)));
  const activeDates = new Set([
    ...reportDates,
    ...episodeEvents.map((event) => localDateKey(event.atMs, input.timeZone)),
  ]);

  const fixes = events.filter((event) => event.kind === "resolved" || event.kind === "fix_confirmed");
  const cameBackAfterFix = episodeEvents.some((episode) =>
    fixes.some((fix) => fix.atMs < episode.atMs && episode.atMs - fix.atMs <= FIX_HELD_DAYS * DAY_MS),
  );
  const disputed = inWindow.some((event) => event.kind === "disputed");
  const fixDidNotHold = cameBackAfterFix || disputed;

  const chronicReasons: ChronicReason[] = [];
  if (episodeEvents.length >= CHRONIC_MIN_EPISODES) chronicReasons.push("episodes");
  if (reportDates.size >= CHRONIC_MIN_REPORT_DAYS) chronicReasons.push("report_days");
  if (fixDidNotHold) chronicReasons.push("fix_did_not_hold");

  return {
    windowDays,
    episodes: episodeEvents.length,
    reportDays: reportDates.size,
    activeDates: [...activeDates].sort(),
    fixDidNotHold,
    chronic: chronicReasons.length > 0,
    chronicReasons,
    trackingSinceMs: events[0]?.atMs ?? null,
    lastEpisodeMs: episodeEvents.at(-1)?.atMs ?? null,
  };
}
