"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import LiveIndicator from "@/components/shared/LiveIndicator";
import ReadAloud from "@/components/shared/ReadAloud";
import { closureDisplayState, type ClosureAnswer } from "@/lib/closure";
import { formatCityTime, getCity, resolveCityForPoint } from "@/lib/cities";
import { db, isFirebaseConfigured } from "@/lib/firebase";
import { toCoordinate } from "@/lib/geo";
import type { FirestoreReport } from "@/lib/firestoreReports";
import { useT } from "@/lib/languageContext";
import { getMyReportToken } from "@/lib/myReports";
import { getSlaStatusNow } from "@/lib/sla";
import { TIER_LABELS } from "@/lib/supportEvidence";

type StepState = "done" | "current" | "waiting" | "stopped";

type Step = { key: string; state: StepState; detail: string; time?: string };

/** Times are shown in the time zone of the city the report was filed in. */
function formatTime(report: TrackedReport, value?: { toDate?: () => Date } | null) {
  const date = value?.toDate?.();
  if (!date) return undefined;
  const city =
    resolveCityForPoint(toCoordinate(report.location?.lat), toCoordinate(report.location?.lng)) ?? getCity("delhi");
  return formatCityTime(city, date);
}

type TrackedReport = FirestoreReport & {
  classifiedAt?: { toDate?: () => Date };
  geminiClassification?: FirestoreReport["geminiClassification"] & { description?: string };
};

function buildSteps(report: TrackedReport, t: (key: string) => string): Step[] {
  const status = report.status ?? "pending";
  const classification = report.geminiClassification;
  const promoted = Boolean(report.validation?.alertTier) || status === "under_review";
  const dispatched = report.dispatchStatus === "dispatched";
  const resolved = status === "resolved";

  const analysed: Step =
    status === "pending"
      ? { key: "track_step_analysed", state: "current", detail: t("track_analysing") }
      : status === "classification_failed"
        ? { key: "track_step_analysed", state: "stopped", detail: t("track_analysis_failed") }
        : status === "no_signal"
          ? { key: "track_step_analysed", state: "stopped", detail: t("track_no_signal") }
          : {
              key: "track_step_analysed",
              state: "done",
              detail: classification?.description ?? t("track_signal_found"),
              time: formatTime(report, report.classifiedAt),
            };

  const analysisDone = analysed.state === "done";
  const corroborated: Step = !analysisDone
    ? { key: "track_step_corroborated", state: "waiting", detail: t("track_waiting") }
    : promoted
      ? {
          key: "track_step_corroborated",
          state: "done",
          detail: report.validation?.tier
            ? t(`tier_${report.validation.tier}`) || TIER_LABELS[report.validation.tier]
            : t("track_promoted"),
        }
      : report.integrity?.excludeFromPromotion
        ? { key: "track_step_corroborated", state: "stopped", detail: t("track_integrity_review") }
        : { key: "track_step_corroborated", state: resolved ? "stopped" : "current", detail: t("track_awaiting_corroboration") };

  const dispatch: Step = dispatched
    ? { key: "track_step_dispatched", state: "done", detail: t("track_dispatched"), time: formatTime(report, report.dispatchedAt) }
    : { key: "track_step_dispatched", state: promoted && !resolved ? "current" : "waiting", detail: t("track_waiting") };

  const closed: Step = resolved
    ? {
        key: "track_step_resolved",
        state: report.outcome === "false_positive" ? "stopped" : "done",
        detail: report.outcome === "false_positive" ? t("track_closed_unconfirmed") : t("track_resolved"),
        time: formatTime(report, report.resolvedAt),
      }
    : { key: "track_step_resolved", state: "waiting", detail: t("track_waiting") };

  return [
    { key: "track_step_received", state: "done", detail: t("track_received"), time: formatTime(report, report.createdAt) },
    analysed,
    corroborated,
    dispatch,
    closed,
  ];
}

type LinkedIncident = Pick<FirestoreReport, "workOrder" | "status" | "createdAt" | "closure">;

/** "Is it fixed?" — shown once an operator resolves the hotspot (lib/closure.ts). */
function ClosureCard({ reportId, report }: { reportId: string; report: TrackedReport }) {
  const t = useT();
  const [token] = useState(() => (typeof window === "undefined" ? null : getMyReportToken(reportId)));
  const [sending, setSending] = useState<ClosureAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const state = closureDisplayState(report.closure);
  if (!state) return null;

  const answer = async (value: ClosureAnswer) => {
    setSending(value);
    setError(null);
    try {
      const response = await fetch(`/api/reports/${reportId}/closure`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, answer: value }),
      });
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(payload?.error ?? `Request failed (${response.status}).`);
      // The report listener picks up the new state.
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(null);
    }
  };

  return (
    <section className="svd-closure svd-closure-inline" aria-live="polite">
      <h2>{t("closure_title")}</h2>
      {state === "awaiting" && (
        <>
          <p>{t("closure_question")}</p>
          {token ? (
            <div className="svd-closure-buttons">
              <button
                type="button"
                className="svd-btn svd-btn-primary"
                disabled={sending !== null}
                onClick={() => void answer("fixed")}
              >
                {sending === "fixed" ? t("drawer_working") : t("closure_answer_fixed")}
              </button>
              <button
                type="button"
                className="svd-btn"
                disabled={sending !== null}
                onClick={() => void answer("not_fixed")}
              >
                {sending === "not_fixed" ? t("drawer_working") : t("closure_answer_not_fixed")}
              </button>
            </div>
          ) : (
            <p className="svd-muted-note">{t("closure_other_device")}</p>
          )}
          {report.closure?.deadline && (
            <p className="svd-muted-note">
              {t("closure_deadline").replace("{time}", formatTime(report, { toDate: () => new Date(report.closure!.deadline) }) ?? "")}
            </p>
          )}
        </>
      )}
      {state === "confirmed" && <p>{t("closure_state_confirmed")}</p>}
      {state === "disputed" && <p>{t("closure_state_disputed")}</p>}
      {state === "superseded" && <p>{t("closure_state_superseded")}</p>}
      {state === "unanswered" && <p>{t("closure_state_unanswered")}</p>}
      {error && <p className="svd-form-error">{error}</p>}
    </section>
  );
}

export default function TrackView({ reportId }: { reportId: string }) {
  const t = useT();
  const [report, setReport] = useState<TrackedReport | null>(null);
  const [incident, setIncident] = useState<{ id: string; data: LinkedIncident } | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing" | "error" | "unconfigured">(
    isFirebaseConfigured && db ? "loading" : "unconfigured",
  );

  useEffect(() => {
    if (!isFirebaseConfigured || !db) return;
    return onSnapshot(
      doc(db, "reports", reportId),
      (snapshot) => {
        if (!snapshot.exists()) {
          setState("missing");
          return;
        }
        setReport(snapshot.data() as TrackedReport);
        setState("ready");
      },
      () => setState("error"),
    );
  }, [reportId]);

  // The incident this report was promoted into carries the work-order
  // priority behind the "city target" line.
  const incidentId = report?.incidentId ?? null;
  useEffect(() => {
    if (!isFirebaseConfigured || !db || !incidentId) return;
    return onSnapshot(
      doc(db, "incidents", incidentId),
      (snapshot) => setIncident(snapshot.exists() ? { id: incidentId, data: snapshot.data() as LinkedIncident } : null),
      () => setIncident(null),
    );
  }, [incidentId]);

  const linkedIncident = incident && incident.id === incidentId ? incident.data : null;
  const sla = linkedIncident
    ? getSlaStatusNow({
        priority: linkedIncident.workOrder?.priority,
        openedAtMs: linkedIncident.createdAt?.toDate?.().getTime() ?? NaN,
        resolved: linkedIncident.status === "resolved",
      })
    : null;
  const steps = report ? buildSteps(report, t) : [];
  const spokenSteps = steps.map((step) => `${t(step.key)}. ${step.detail}.`).join(" ");

  return (
    <div className="svd svd-track">
      <header className="svd-head">
        <div>
          <LiveIndicator
            state={state === "ready" ? "live" : state === "loading" ? "connecting" : "offline"}
            label={t("track_kicker")}
          />
          <h1>{t("track_title")}</h1>
          <p className="svd-lede">{t("track_lede")}</p>
        </div>
        <Link href="/report" className="svd-btn svd-btn-primary">
          {t("nav_report_button")}
        </Link>
      </header>

      {state === "loading" && <p className="svd-empty">{t("drawer_loading")}</p>}
      {state === "missing" && <p className="svd-alert">{t("track_missing")}</p>}
      {state === "error" && <p className="svd-alert">{t("track_error")}</p>}
      {state === "unconfigured" && <p className="svd-alert">{t("track_unconfigured")}</p>}

      {state === "ready" && report && (
        <div className="svd-track-grid">
          <section className="svd-card">
            <header className="svd-card-head svd-card-head-split">
              <div>
                <h2>{report.location?.label ?? t("drawer_unknown_location")}</h2>
                <p>
                  {t("track_report_id")}: {reportId}
                </p>
              </div>
              <ReadAloud text={spokenSteps} />
            </header>
            <ol className="svd-timeline">
              {steps.map((step) => (
                <li key={step.key} className={`svd-timeline-step is-${step.state}`}>
                  <span className="svd-timeline-dot" aria-hidden="true" />
                  <div>
                    <strong>{t(step.key)}</strong>
                    <p>{step.detail}</p>
                    {step.time && <small>{step.time}</small>}
                  </div>
                </li>
              ))}
            </ol>
            {sla && (
              <p className={sla.overdueHours ? "svd-callout" : "svd-muted-note"}>
                {t("track_city_target").replace("{hours}", String(sla.targetHours))}
                {sla.overdueHours ? ` · ${t("sla_overdue").replace("{hours}", String(sla.overdueHours))}` : ""}
              </p>
            )}
            <ClosureCard reportId={reportId} report={report} />
          </section>

          <div>
            {report.photoUrl && (
              <section className="svd-card">
                {/* eslint-disable-next-line @next/next/no-img-element -- remote ImgBB evidence photo */}
                <img className="svd-drawer-photo" src={report.photoUrl} alt={t("drawer_photo_alt")} />
                {report.note && <p className="svd-muted-note">“{report.note}”</p>}
              </section>
            )}
            {report.h3CellId && (
              <section className="svd-card svd-closure">
                <h2>{t("zone_link_about_area")}</h2>
                <p>{t("track_area_detail")}</p>
                <Link href={`/zone/${report.h3CellId}`} className="sv-underline-link">
                  {t("zone_link_open")} →
                </Link>
              </section>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
