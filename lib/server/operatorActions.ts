import "server-only";

import { adminDb, adminServerTimestamp } from "@/lib/firebaseAdmin";
import { getRecommendedAction } from "@/components/command/commandData";
import { resolveIncidentHazardType } from "@/lib/firestoreReports";
import type { Target } from "@/lib/server/incidentContext";
import { HttpError, type Operator } from "@/lib/server/http";
import { notifyReporters } from "@/lib/server/notify";

export type OperatorAction = "dispatch" | "resolve" | "false_positive";

export function parseOperatorAction(value: unknown): OperatorAction {
  if (value === "dispatch" || value === "resolve" || value === "false_positive") return value;
  throw new HttpError(400, "action must be dispatch, resolve, or false_positive.");
}

/**
 * Applies an operator decision to the incident AND every linked report, so
 * the public tracking page and the promotion engine see the same state
 * (previously only the incident changed, and the untouched reports
 * re-promoted it on the next classification).
 */
export async function applyOperatorAction(target: Target, action: OperatorAction, operator: Operator) {
  const linkedReportIds: string[] =
    target.collection === "incidents"
      ? Array.isArray(target.data.linkedReportIds)
        ? target.data.linkedReportIds.filter((id: unknown): id is string => typeof id === "string")
        : []
      : [target.id];

  // UID, not email: incident docs are publicly readable.
  const audit = { by: operator.uid, action, at: new Date().toISOString() };
  let update: Record<string, unknown>;
  let reportUpdate: Record<string, unknown>;
  const hazardType = resolveIncidentHazardType(target.data);
  const actionLabel = getRecommendedAction({ hazardType } as Parameters<typeof getRecommendedAction>[0]);

  if (action === "dispatch") {
    if (target.data.status === "resolved") throw new HttpError(409, "This incident is already resolved.");
    update = {
      dispatchStatus: "dispatched",
      dispatchedAction: actionLabel,
      dispatchedAt: adminServerTimestamp(),
      dispatchedBy: audit.by,
      updatedAt: adminServerTimestamp(),
    };
    reportUpdate = { dispatchStatus: "dispatched", dispatchedAt: adminServerTimestamp() };
  } else {
    const outcome = action === "resolve" ? "confirmed" : "false_positive";
    update = {
      status: "resolved",
      outcome,
      resolvedAt: adminServerTimestamp(),
      resolvedBy: audit.by,
      updatedAt: adminServerTimestamp(),
    };
    reportUpdate = { status: "resolved", outcome, resolvedAt: adminServerTimestamp() };
  }

  const batch = adminDb.batch();
  batch.update(target.ref, { ...update, auditLog: [...(target.data.auditLog ?? []), audit].slice(-50) });
  if (target.collection === "incidents") {
    for (const reportId of linkedReportIds) {
      batch.set(adminDb.collection("reports").doc(reportId), reportUpdate, { merge: true });
    }
  }
  await batch.commit();

  // A false positive isn't something to announce to the reporter.
  const notification =
    action === "false_positive"
      ? null
      : await notifyReporters(linkedReportIds, action === "dispatch" ? "dispatched" : "resolved", {
          area: target.area,
          action: action === "dispatch" ? actionLabel : undefined,
        }).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));

  return { action, linkedReports: linkedReportIds.length, notification };
}
