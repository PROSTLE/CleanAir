import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { closureDisplayState, isClosureOpen, openClosure, CLOSURE_WINDOW_HOURS } from "@/lib/closure";
import {
  CHRONIC_MIN_EPISODES,
  FIX_HELD_DAYS,
  localDateKey,
  recentDateKeys,
  summarizeRecurrence,
  type CellEvent,
} from "@/lib/recurrence";
import { getSlaStatus, RESPONSE_TARGET_HOURS } from "@/lib/sla";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-09-29T06:30:00Z");
const TZ = "Asia/Kolkata";

describe("recurrence", () => {
  it("has no history for a cell with no events or reports", () => {
    const summary = summarizeRecurrence({ events: [], reports: [], nowMs: NOW, timeZone: TZ });
    assert.equal(summary.episodes, 0);
    assert.equal(summary.reportDays, 0);
    assert.equal(summary.chronic, false);
    assert.equal(summary.trackingSinceMs, null);
    assert.deepEqual(summary.activeDates, []);
  });

  it(`flags a cell chronic at ${CHRONIC_MIN_EPISODES} confirmed episodes in the window`, () => {
    const events: CellEvent[] = [
      { kind: "promoted", atMs: NOW - 20 * DAY },
      { kind: "reopened", atMs: NOW - 12 * DAY },
      { kind: "reopened", atMs: NOW - 2 * DAY },
    ];
    const summary = summarizeRecurrence({ events, reports: [], nowMs: NOW, timeZone: TZ });
    assert.equal(summary.episodes, 3);
    assert.ok(summary.chronic);
    assert.deepEqual(summary.chronicReasons, ["episodes"]);
  });

  it("ignores episodes older than the window", () => {
    const events: CellEvent[] = [
      { kind: "promoted", atMs: NOW - 45 * DAY },
      { kind: "reopened", atMs: NOW - 40 * DAY },
      { kind: "reopened", atMs: NOW - 1 * DAY },
    ];
    const summary = summarizeRecurrence({ events, reports: [], nowMs: NOW, timeZone: TZ });
    assert.equal(summary.episodes, 1);
    assert.equal(summary.chronic, false);
    assert.equal(summary.trackingSinceMs, NOW - 45 * DAY);
  });

  it("counts report days by the city's local date and skips flagged reports", () => {
    // 18:40 UTC and 19:00 UTC on the same UTC day fall on different IST dates.
    const reports = [
      { atMs: Date.parse("2026-09-20T18:00:00Z"), counts: true },
      { atMs: Date.parse("2026-09-20T19:00:00Z"), counts: true },
      { atMs: Date.parse("2026-09-25T08:00:00Z"), counts: false },
    ];
    const summary = summarizeRecurrence({ events: [], reports, nowMs: NOW, timeZone: TZ });
    assert.equal(summary.reportDays, 2);
    assert.deepEqual(summary.activeDates, ["2026-09-20", "2026-09-21"]);
  });

  it(`says a fix did not hold when the hotspot returns within ${FIX_HELD_DAYS} days`, () => {
    const events: CellEvent[] = [
      { kind: "promoted", atMs: NOW - 10 * DAY },
      { kind: "resolved", atMs: NOW - 6 * DAY },
      { kind: "reopened", atMs: NOW - 3 * DAY },
    ];
    const summary = summarizeRecurrence({ events, reports: [], nowMs: NOW, timeZone: TZ });
    assert.ok(summary.fixDidNotHold);
    assert.ok(summary.chronicReasons.includes("fix_did_not_hold"));
  });

  it("treats a resident dispute as a fix that did not hold", () => {
    const events: CellEvent[] = [
      { kind: "promoted", atMs: NOW - 5 * DAY },
      { kind: "resolved", atMs: NOW - 3 * DAY },
      { kind: "disputed", atMs: NOW - 2 * DAY },
    ];
    assert.ok(summarizeRecurrence({ events, reports: [], nowMs: NOW, timeZone: TZ }).fixDidNotHold);
  });

  it("counts an event stamped slightly ahead by the database clock", () => {
    const events: CellEvent[] = [
      { kind: "resolved", atMs: NOW - DAY },
      { kind: "disputed", atMs: NOW + 3_000 },
    ];
    assert.ok(summarizeRecurrence({ events, reports: [], nowMs: NOW, timeZone: TZ }).fixDidNotHold);
  });

  it("lists the last N local dates oldest first", () => {
    const keys = recentDateKeys(NOW, 30, TZ);
    assert.equal(keys.length, 30);
    assert.equal(keys.at(-1), localDateKey(NOW, TZ));
    assert.equal(keys[0], localDateKey(NOW - 29 * DAY, TZ));
  });
});

describe("response targets", () => {
  it("has no target without a work-order priority", () => {
    assert.equal(getSlaStatus({ priority: null, openedAtMs: NOW - DAY, resolved: false, nowMs: NOW }), null);
  });

  it("has no target once resolved", () => {
    assert.equal(getSlaStatus({ priority: "immediate", openedAtMs: NOW - DAY, resolved: true, nowMs: NOW }), null);
  });

  it("reports hours overdue past the target", () => {
    const status = getSlaStatus({ priority: "within_24h", openedAtMs: NOW - 30 * HOUR, resolved: false, nowMs: NOW });
    assert.equal(status?.targetHours, RESPONSE_TARGET_HOURS.within_24h);
    assert.equal(status?.overdueHours, 6);
  });

  it("is not overdue inside the target", () => {
    const status = getSlaStatus({ priority: "routine", openedAtMs: NOW - 10 * HOUR, resolved: false, nowMs: NOW });
    assert.equal(status?.overdueHours, null);
    assert.equal(status?.elapsedHours, 10);
  });
});

describe("resident fix-check", () => {
  it(`opens for ${CLOSURE_WINDOW_HOURS} hours`, () => {
    const closure = openClosure(new Date(NOW), true);
    assert.equal(closure.state, "awaiting");
    assert.equal(Date.parse(closure.deadline) - NOW, CLOSURE_WINDOW_HOURS * HOUR);
    assert.equal(closure.confirmed, 0);
    assert.ok(isClosureOpen(closure, NOW + HOUR));
  });

  it("shows an unanswered check once the window has passed", () => {
    const closure = openClosure(new Date(NOW), false);
    assert.equal(closureDisplayState(closure, NOW + (CLOSURE_WINDOW_HOURS + 1) * HOUR), "unanswered");
    assert.equal(isClosureOpen(closure, NOW + (CLOSURE_WINDOW_HOURS + 1) * HOUR), false);
  });

  it("keeps answered states as stored", () => {
    const closure = { ...openClosure(new Date(NOW), false), state: "disputed" as const };
    assert.equal(closureDisplayState(closure, NOW + 200 * HOUR), "disputed");
    assert.equal(closureDisplayState(null, NOW), null);
  });
});
