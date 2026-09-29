import "server-only";

import { adminDb, adminServerTimestamp } from "@/lib/firebaseAdmin";
import { isClosureOpen, type Closure, type ClosureAnswer } from "@/lib/closure";
import { resolveIncidentHazardType } from "@/lib/firestoreReports";
import { HttpError } from "@/lib/server/http";
import { recordIncidentEvent } from "@/lib/server/incidentEvents";

/**
 * A reporter answers the fix-check opened when an operator resolved their
 * hotspot (lib/server/operatorActions.ts).
 *
 * - "fixed": recorded on the report and tallied on the incident.
 * - "not_fixed": the incident and its reports go back to review with the
 *   previous dispatch and resolution cleared, so it returns to the operator
 *   queue flagged as disputed. Other reporters' open checks are closed as
 *   superseded. The work order stays: the operator can reuse or redraft it.
 */
export async function applyResidentClosure(reportId: string, answer: ClosureAnswer, via: "web" | "whatsapp") {
  const reportRef = adminDb.collection("reports").doc(reportId);
  const nowIso = new Date().toISOString();

  const outcome = await adminDb.runTransaction(async (transaction) => {
    const reportSnap = await transaction.get(reportRef);
    if (!reportSnap.exists) throw new HttpError(404, "Report not found.");
    const report = reportSnap.data() ?? {};
    const closure = report.closure as Closure | undefined;
    if (!isClosureOpen(closure)) {
      throw new HttpError(409, "This report is not waiting for a fix confirmation.");
    }

    const incidentId = typeof report.incidentId === "string" ? report.incidentId : null;
    const incidentRef = incidentId ? adminDb.collection("incidents").doc(incidentId) : null;
    const incidentSnap = incidentRef ? await transaction.get(incidentRef) : null;
    const incident = incidentSnap?.exists ? (incidentSnap.data() ?? {}) : null;
    const linkedIds: string[] =
      incident && Array.isArray(incident.linkedReportIds)
        ? incident.linkedReportIds.filter((id: unknown): id is string => typeof id === "string")
        : [];
    // Reads first (transaction rule): the other reporters' docs.
    const otherRefs = answer === "not_fixed"
      ? linkedIds.filter((id) => id !== reportId).map((id) => adminDb.collection("reports").doc(id))
      : [];
    const otherSnaps = otherRefs.length ? await transaction.getAll(...otherRefs) : [];

    const answered: Closure = {
      ...(closure as Closure),
      state: answer === "fixed" ? "confirmed" : "disputed",
      answeredAt: nowIso,
      via,
    };
    const reopenFields = {
      status: "under_review",
      outcome: null,
      resolvedAt: null,
      dispatchStatus: null,
      dispatchedAt: null,
    };

    if (answer === "fixed") {
      transaction.update(reportRef, { closure: answered });
    } else if (incidentRef && incident) {
      transaction.update(reportRef, { closure: answered, ...reopenFields });
    } else {
      // A lone report resolved straight from the queue: back to classified,
      // which is where the operator queue picks up unpromoted reports.
      transaction.update(reportRef, { closure: answered, status: "classified", outcome: null, resolvedAt: null, dispatchStatus: null, dispatchedAt: null });
    }

    if (incidentRef && incident) {
      const current = (incident.closure ?? null) as Closure | null;
      const confirmed = (current?.confirmed ?? 0) + (answer === "fixed" ? 1 : 0);
      const disputed = (current?.disputed ?? 0) + (answer === "not_fixed" ? 1 : 0);
      const incidentClosure: Closure = {
        ...(current ?? { askedAt: closure!.askedAt, deadline: closure!.deadline }),
        state: disputed > 0 ? "disputed" : "confirmed",
        answeredAt: nowIso,
        via,
        confirmed,
        disputed,
      };
      if (answer === "fixed") {
        transaction.update(incidentRef, { closure: incidentClosure });
      } else {
        transaction.update(incidentRef, {
          closure: incidentClosure,
          ...reopenFields,
          dispatchedAction: null,
          reopenedBy: "resident",
          updatedAt: adminServerTimestamp(),
          auditLog: [...(incident.auditLog ?? []), { by: "resident", action: "disputed", at: nowIso }].slice(-50),
        });
        otherSnaps.forEach((snap) => {
          if (!snap.exists) return;
          const other = snap.data() ?? {};
          const otherClosure = other.closure as Closure | undefined;
          transaction.update(snap.ref, {
            ...reopenFields,
            ...(isClosureOpen(otherClosure) ? { closure: { ...otherClosure, state: "superseded" } } : {}),
          });
        });
      }
    }

    return {
      incidentId,
      h3CellId: (incident?.h3CellId ?? report.h3CellId ?? null) as string | null,
      hazardType: resolveIncidentHazardType(incident ?? report),
      tier: (incident?.validation?.tier ?? null) as string | null,
    };
  });

  await recordIncidentEvent({
    incidentId: outcome.incidentId ?? reportId,
    h3CellId: outcome.h3CellId,
    hazardType: outcome.hazardType,
    kind: answer === "fixed" ? "fix_confirmed" : "disputed",
    tier: outcome.tier,
    by: "resident",
  });

  return { answer, reopened: answer === "not_fixed", incidentId: outcome.incidentId };
}

/**
 * WhatsApp reporters answer by replying FIXED or STILL to the resolve
 * message. The bot passes the sender's number; every report from that number
 * with an open check gets the answer.
 */
export async function applyWhatsAppClosure(phone: string, answer: ClosureAnswer) {
  const contacts = await adminDb.collection("reportContacts").where("phone", "==", phone).limit(50).get();
  const reportIds = contacts.docs.map((doc) => doc.id);
  if (reportIds.length === 0) return { updated: 0 };
  const reports = await adminDb.getAll(...reportIds.map((id) => adminDb.collection("reports").doc(id)));
  const open = reports.filter((snap) => snap.exists && isClosureOpen(snap.data()?.closure as Closure | undefined));

  let updated = 0;
  for (const snap of open) {
    try {
      await applyResidentClosure(snap.id, answer, "whatsapp");
      updated += 1;
    } catch (error) {
      // An earlier "still there" in this loop may already have superseded it.
      if (!(error instanceof HttpError && error.status === 409)) throw error;
    }
  }
  return { updated };
}
