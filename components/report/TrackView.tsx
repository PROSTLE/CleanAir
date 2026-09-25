"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import LiveIndicator from "@/components/shared/LiveIndicator";
import { db, isFirebaseConfigured } from "@/lib/firebase";
import type { FirestoreReport } from "@/lib/firestoreReports";
import { useT } from "@/lib/languageContext";
import { TIER_LABELS } from "@/lib/supportEvidence";

type StepState = "done" | "current" | "waiting" | "stopped";

type Step = { key: string; state: StepState; detail: string; time?: string };

function formatTime(value?: { toDate?: () => Date } | null) {
  const date = value?.toDate?.();
  return date
    ? date.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })
    : undefined;
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
              time: formatTime(report.classifiedAt),
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
    ? { key: "track_step_dispatched", state: "done", detail: t("track_dispatched"), time: formatTime(report.dispatchedAt) }
    : { key: "track_step_dispatched", state: promoted && !resolved ? "current" : "waiting", detail: t("track_waiting") };

  const closed: Step = resolved
    ? {
        key: "track_step_resolved",
        state: report.outcome === "false_positive" ? "stopped" : "done",
        detail: report.outcome === "false_positive" ? t("track_closed_unconfirmed") : t("track_resolved"),
        time: formatTime(report.resolvedAt),
      }
    : { key: "track_step_resolved", state: "waiting", detail: t("track_waiting") };

  return [
    { key: "track_step_received", state: "done", detail: t("track_received"), time: formatTime(report.createdAt) },
    analysed,
    corroborated,
    dispatch,
    closed,
  ];
}

export default function TrackView({ reportId }: { reportId: string }) {
  const t = useT();
  const [report, setReport] = useState<TrackedReport | null>(null);
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
            <header className="svd-card-head">
              <h2>{report.location?.label ?? t("drawer_unknown_location")}</h2>
              <p>
                {t("track_report_id")}: {reportId}
              </p>
            </header>
            <ol className="svd-timeline">
              {buildSteps(report, t).map((step) => (
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
          </section>

          {report.photoUrl && (
            <section className="svd-card">
              {/* eslint-disable-next-line @next/next/no-img-element -- remote ImgBB evidence photo */}
              <img className="svd-drawer-photo" src={report.photoUrl} alt={t("drawer_photo_alt")} />
              {report.note && <p className="svd-muted-note">“{report.note}”</p>}
            </section>
          )}
        </div>
      )}
    </div>
  );
}
