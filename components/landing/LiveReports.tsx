"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { collection, limit, onSnapshot, orderBy, query } from "firebase/firestore";
import HotspotPreview from "@/components/landing/HotspotPreview";
import LiveIndicator from "@/components/shared/LiveIndicator";
import { db, isFirebaseConfigured } from "@/lib/firebase";
import { hasPollutionSignal, reportToIncident, type FirestoreReport } from "@/lib/firestoreReports";
import type { Incident } from "@/lib/types";
import { useT } from "@/lib/languageContext";

const HAS_MAPS_KEY = Boolean(process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY);

/**
 * Live citizen reporting — lifted out of the hero so the fold stays editorial.
 * Everything degrades to an explicit "standing by" state when Firebase isn't
 * configured, rather than rendering zeroes that look like real readings.
 */
export default function LiveReports() {
  const t = useT();
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [reports, setReports] = useState<Incident[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!isFirebaseConfigured || !db) return;
    const incidentsQuery = query(collection(db, "incidents"), orderBy("updatedAt", "desc"));
    return onSnapshot(incidentsQuery, (snapshot) => {
      setConnected(true);
      setIncidents(snapshot.docs.map((doc) => reportToIncident(doc.id, doc.data() as FirestoreReport)));
    });
  }, []);

  useEffect(() => {
    if (!isFirebaseConfigured || !db) return;
    const reportsQuery = query(collection(db, "reports"), orderBy("createdAt", "desc"), limit(20));
    return onSnapshot(reportsQuery, (snapshot) => {
      setReports(
        snapshot.docs
          .map((doc) => ({ id: doc.id, data: doc.data() as FirestoreReport }))
          .filter((entry) => hasPollutionSignal(entry.data))
          .map((entry) => reportToIncident(entry.id, entry.data))
          .filter((incident) => incident.status !== "resolved"),
      );
    });
  }, []);

  const active = incidents.filter((incident) => incident.status !== "resolved");
  const critical = active.filter((incident) => incident.severity === "critical").length;
  const resolvedToday = incidents.filter((incident) => {
    if (incident.status !== "resolved" || !incident.resolvedAt) return false;
    return new Date(incident.resolvedAt).toDateString() === new Date().toDateString();
  }).length;

  const placeholder = "—";
  const stats = [
    {
      label: t("hero_stat_active"),
      value: connected ? String(active.length) : placeholder,
      detail: connected ? `${critical} ${t("hero_stat_critical")}` : t("reports_awaiting"),
    },
    {
      label: t("hero_stat_resolved"),
      value: connected ? String(resolvedToday) : placeholder,
      detail: connected ? t("hero_stat_cleanup") : t("reports_awaiting"),
    },
    {
      label: t("reports_stat_queue"),
      value: connected ? String(reports.length) : placeholder,
      detail: t("reports_stat_queue_detail"),
    },
    {
      label: t("hero_stat_next_spike"),
      value: placeholder,
      detail: t("hero_stat_awaiting_forecast"),
    },
  ];

  return (
    <section id="reports" className="sv-section sv-reports">
      <header className="sv-section-head sv-section-head-split">
        <div>
          <LiveIndicator
            state={connected ? "live" : isFirebaseConfigured ? "connecting" : "offline"}
            label={connected ? t("reports_kicker_live") : t("reports_kicker_idle")}
          />
          <h2>{t("reports_heading")}</h2>
        </div>
        <Link href="/report" className="sv-pill sv-pill-dark">
          {t("nav_report_button")}
          <svg viewBox="0 0 24 24" aria-hidden="true" className="sv-pill-arrow">
            <path d="M5 12h13M13 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Link>
      </header>

      <div className="sv-reports-body">
        <ul className="sv-stat-grid">
          {stats.map((stat) => (
            <li className="sv-stat" key={stat.label}>
              <strong>{stat.value}</strong>
              <span>{stat.label}</span>
              <small>{stat.detail}</small>
            </li>
          ))}
        </ul>

        <div className="sv-reports-map">
          {HAS_MAPS_KEY ? (
            <HotspotPreview incidents={reports.slice(0, 6)} />
          ) : (
            <div className="sv-map-placeholder">
              <span className="sv-map-placeholder-grid" aria-hidden="true" />
              <p>{t("reports_map_unconfigured")}</p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
