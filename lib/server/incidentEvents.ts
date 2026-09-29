import "server-only";

import { cellToLatLng, isValidCell } from "h3-js";
import { adminDb, adminServerTimestamp } from "@/lib/firebaseAdmin";
import { getCity, resolveCityForPoint } from "@/lib/cities";
import { hasPollutionSignal, type FirestoreReport } from "@/lib/firestoreReports";
import {
  summarizeRecurrence,
  type CellEvent,
  type CellReport,
  type IncidentEventKind,
  type RecurrenceSummary,
} from "@/lib/recurrence";

// Incident docs are keyed by cell (`<cell>-<hazard>`, `ambient-<cell>`) and
// restart their lifecycle when they reopen, so their own fields can't tell a
// cell's history. `incidentEvents` is an append-only log of each lifecycle
// step. Writes are best-effort: a failed log write never blocks promotion,
// the ambient scan or an operator action.

export type IncidentEventInput = {
  incidentId: string;
  h3CellId: string | null | undefined;
  hazardType?: string | null;
  kind: IncidentEventKind;
  tier?: string | null;
  /** Operator UID, "resident", or "system". Never an email: kept server-side, but minimal anyway. */
  by?: string | null;
};

export async function recordIncidentEvents(events: IncidentEventInput[]) {
  const valid = events.filter((event) => event.h3CellId && isValidCell(event.h3CellId));
  if (valid.length === 0) return;
  try {
    const batch = adminDb.batch();
    for (const event of valid) {
      const [lat, lng] = cellToLatLng(event.h3CellId as string);
      batch.set(adminDb.collection("incidentEvents").doc(), {
        incidentId: event.incidentId,
        h3CellId: event.h3CellId,
        cityId: resolveCityForPoint(lat, lng)?.id ?? null,
        hazardType: event.hazardType ?? null,
        kind: event.kind,
        tier: event.tier ?? null,
        by: event.by ?? "system",
        at: adminServerTimestamp(),
      });
    }
    await batch.commit();
  } catch (error) {
    console.warn("[incidentEvents] could not record", error instanceof Error ? error.message : error);
  }
}

export function recordIncidentEvent(event: IncidentEventInput) {
  return recordIncidentEvents([event]);
}

function timestampMs(value: unknown): number {
  const date = (value as { toDate?: () => Date } | null | undefined)?.toDate?.();
  return date ? date.getTime() : NaN;
}

/** 30-day recurrence for one cell, in the time zone of the city it lies in. */
export async function getCellRecurrence(h3CellId: string, nowMs = Date.now()): Promise<RecurrenceSummary> {
  if (!isValidCell(h3CellId)) throw new Error("Invalid H3 cell.");
  const [lat, lng] = cellToLatLng(h3CellId);
  const city = resolveCityForPoint(lat, lng) ?? getCity(null);

  // Single-field equality queries: no composite index needed. Cells hold a
  // handful of docs, so the date window is applied in memory.
  const [eventSnap, reportSnap] = await Promise.all([
    adminDb.collection("incidentEvents").where("h3CellId", "==", h3CellId).limit(500).get(),
    adminDb.collection("reports").where("h3CellId", "==", h3CellId).limit(500).get(),
  ]);

  const events: CellEvent[] = eventSnap.docs.map((doc) => {
    const data = doc.data();
    return { kind: data.kind as IncidentEventKind, atMs: timestampMs(data.at) };
  });
  const reports: CellReport[] = reportSnap.docs.map((doc) => {
    const data = doc.data() as FirestoreReport;
    return {
      atMs: timestampMs(data.createdAt),
      counts: hasPollutionSignal(data) && !data.integrity?.excludeFromPromotion,
    };
  });

  return summarizeRecurrence({ events, reports, nowMs, timeZone: city.timeZone });
}
