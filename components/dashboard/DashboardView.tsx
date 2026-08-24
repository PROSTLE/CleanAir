"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
} from "firebase/firestore";
import GoogleHotspotMap from "@/components/map/GoogleHotspotMap";
import { db, isFirebaseConfigured } from "@/lib/firebase";
import {
  hasPollutionSignal,
  reportToIncident,
  type FirestoreReport,
} from "@/lib/firestoreReports";
import { isInOperationalRegion } from "@/lib/operationalRegion";
import {
  formatStatus,
  getIncidentAge,
  getRecommendedAction,
  getRecommendedActionKey,
} from "@/components/command/commandData";
import type { HazardType, Incident, Severity } from "@/lib/types";
import { useT } from "@/lib/languageContext";

/** Every empty metric renders as this — never a zero that could read as a real measurement. */
const EMPTY = "—";

const HAZARDS: HazardType[] = ["fire", "smog", "dust", "industrial", "particulate"];
const SEVERITIES: Severity[] = ["critical", "medium", "low"];

type Integrations = Record<string, boolean>;

function isLive(incident: Incident) {
  return (
    incident.status !== "resolved" &&
    isInOperationalRegion(incident.latitude, incident.longitude)
  );
}

/** Renders a count, or EMPTY when there is nothing connected to count. */
function metric(value: number, connected: boolean): string {
  return connected ? String(value) : EMPTY;
}

export default function DashboardView() {
  const t = useT();
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [reports, setReports] = useState<Incident[]>([]);
  const [connected, setConnected] = useState(false);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [integrations, setIntegrations] = useState<Integrations | null>(null);
  const [dispatching, setDispatching] = useState<string | null>(null);

  useEffect(() => {
    if (!isFirebaseConfigured || !db) return;
    const q = query(collection(db, "incidents"), orderBy("updatedAt", "desc"), limit(200));
    return onSnapshot(
      q,
      (snapshot) => {
        setConnected(true);
        setFeedError(null);
        setIncidents(
          snapshot.docs.map((d) => reportToIncident(d.id, d.data() as FirestoreReport)),
        );
      },
      (error) => setFeedError(error.message),
    );
  }, []);

  useEffect(() => {
    if (!isFirebaseConfigured || !db) return;
    const q = query(collection(db, "reports"), orderBy("createdAt", "desc"), limit(50));
    return onSnapshot(
      q,
      (snapshot) => {
        setConnected(true);
        setReports(
          snapshot.docs
            .map((d) => ({ id: d.id, data: d.data() as FirestoreReport }))
            .filter((r) => hasPollutionSignal(r.data))
            .map((r) => reportToIncident(r.id, r.data)),
        );
      },
      (error) => setFeedError(error.message),
    );
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/system-status")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data?.integrations) setIntegrations(data.integrations);
      })
      .catch(() => {
        /* status panel just stays unknown */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const active = useMemo(() => incidents.filter(isLive), [incidents]);
  const queue = useMemo(
    () => reports.filter((r) => isLive(r) && !r.evidence?.alertTier),
    [reports],
  );

  const critical = active.filter((i) => i.severity === "critical").length;
  const resolvedToday = incidents.filter((i) => {
    if (i.status !== "resolved" || !i.resolvedAt) return false;
    return new Date(i.resolvedAt).toDateString() === new Date().toDateString();
  }).length;

  const avgConfidence = active.length
    ? Math.round(active.reduce((sum, i) => sum + i.aiConfidence, 0) / active.length)
    : null;

  const hazardMix = HAZARDS.map((hazard) => ({
    id: hazard,
    label: t(`hazard_${hazard}`),
    count: active.filter((i) => i.hazardType === hazard).length,
  })).sort((a, b) => b.count - a.count);

  const severityMix = SEVERITIES.map((severity) => ({
    id: severity,
    label: t(`severity_${severity}`) || severity,
    count: active.filter((i) => i.severity === severity).length,
  }));

  const sourceMix = (["citizen", "sensor", "satellite"] as const).map((source) => ({
    id: source,
    label: t(`source_filter_${source}`) || source,
    count: active.filter((i) => i.source === source).length,
  }));

  // Most recent incident that actually carries a calibrated sensor reading.
  const sensor = useMemo(
    () => active.find((i) => i.evidence?.sensor?.pm25 != null)?.evidence?.sensor ?? null,
    [active],
  );

  const maxHazard = Math.max(1, ...hazardMix.map((h) => h.count));

  const kpis = [
    {
      id: "active",
      label: t("dash_kpi_active"),
      value: metric(active.length, connected),
      detail: connected ? `${critical} ${t("hero_stat_critical")}` : t("dash_awaiting"),
    },
    {
      id: "critical",
      label: t("dash_kpi_critical"),
      value: metric(critical, connected),
      detail: t("dash_kpi_critical_detail"),
    },
    {
      id: "queue",
      label: t("dash_kpi_queue"),
      value: metric(queue.length, connected),
      detail: t("dash_kpi_queue_detail"),
    },
    {
      id: "resolved",
      label: t("dash_kpi_resolved"),
      value: metric(resolvedToday, connected),
      detail: t("dash_kpi_resolved_detail"),
    },
    {
      id: "confidence",
      label: t("dash_kpi_confidence"),
      value: avgConfidence == null ? EMPTY : `${avgConfidence}%`,
      detail: t("dash_kpi_confidence_detail"),
    },
  ];

  const handleDispatch = async (incident: Incident) => {
    if (!db || incident.dispatchStatus === "dispatched") return;
    setDispatching(incident.id);
    try {
      const collectionName = incident.evidence?.alertTier ? "incidents" : "reports";
      const docId = incident.id.replace("firestore-", "");
      await updateDoc(doc(db, collectionName, docId), {
        dispatchStatus: "dispatched",
        dispatchedAction: t(getRecommendedActionKey(incident)) || getRecommendedAction(incident),
        dispatchedAt: serverTimestamp(),
      });
    } catch (error) {
      console.error("Failed to dispatch:", error);
    } finally {
      setDispatching(null);
    }
  };

  const integrationRows = [
    { id: "firestore", label: t("dash_src_firestore"), ok: isFirebaseConfigured },
    { id: "maps", label: t("dash_src_maps"), ok: Boolean(process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY) },
    { id: "gemini", label: t("dash_src_gemini"), ok: integrations?.gemini },
    { id: "cpcb", label: t("dash_src_cpcb"), ok: integrations?.cpcb },
    { id: "earthEngine", label: t("dash_src_earth_engine"), ok: integrations?.earthEngine },
    { id: "bigQuery", label: t("dash_src_bigquery"), ok: integrations?.bigQuery },
    { id: "openWeather", label: t("dash_src_openweather"), ok: integrations?.openWeather },
  ];

  const rows = [...active].sort((a, b) => b.aiConfidence - a.aiConfidence).slice(0, 12);

  return (
    <div className="svd">
      <header className="svd-head">
        <div>
          <p className="sv-eyebrow">
            <span className={`sv-live-dot ${connected ? "is-live" : ""}`} aria-hidden="true" />
            {connected ? t("dash_feed_live") : t("dash_feed_idle")}
          </p>
          <h1>{t("dash_title")}</h1>
          <p className="svd-lede">{t("dash_lede")}</p>
        </div>
      </header>

      {feedError && (
        <p className="svd-alert" role="status">
          {t("live_data_error_suffix")}: {feedError}
        </p>
      )}

      <ul className="svd-kpis">
        {kpis.map((kpi) => (
          <li className="svd-kpi" key={kpi.id}>
            <strong>{kpi.value}</strong>
            <span>{kpi.label}</span>
            <small>{kpi.detail}</small>
          </li>
        ))}
      </ul>

      <div className="svd-grid">
        <section className="svd-card svd-card-wide">
          <header className="svd-card-head">
            <h2>{t("dash_hazard_mix")}</h2>
            <p>{t("dash_hazard_mix_detail")}</p>
          </header>
          {active.length === 0 ? (
            <p className="svd-empty">{t("dash_no_signal")}</p>
          ) : (
            <ul className="svd-bars">
              {hazardMix.map((hazard) => (
                <li key={hazard.id}>
                  <span className="svd-bar-label">{hazard.label}</span>
                  <span className="svd-bar-track">
                    <span
                      className={`svd-bar-fill svd-hazard-${hazard.id}`}
                      style={{ width: `${(hazard.count / maxHazard) * 100}%` }}
                    />
                  </span>
                  <span className="svd-bar-value">{hazard.count}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="svd-card">
          <header className="svd-card-head">
            <h2>{t("dash_severity")}</h2>
            <p>{t("dash_severity_detail")}</p>
          </header>
          <ul className="svd-split">
            {severityMix.map((item) => (
              <li key={item.id}>
                <span className={`svd-dot svd-sev-${item.id}`} aria-hidden="true" />
                <span className="svd-split-label">{item.label}</span>
                <strong>{metric(item.count, connected)}</strong>
              </li>
            ))}
          </ul>
          <hr className="svd-rule" />
          <ul className="svd-split">
            {sourceMix.map((item) => (
              <li key={item.id}>
                <span className="svd-split-label">{item.label}</span>
                <strong>{metric(item.count, connected)}</strong>
              </li>
            ))}
          </ul>
        </section>

        <section className="svd-card">
          <header className="svd-card-head">
            <h2>{t("dash_sensor")}</h2>
            <p>{sensor?.stationName ? sensor.stationName : t("dash_sensor_detail")}</p>
          </header>
          <ul className="svd-readings">
            {[
              { key: "PM2.5", value: sensor?.pm25, unit: "µg/m³" },
              { key: "PM10", value: sensor?.pm10, unit: "µg/m³" },
              { key: "NO₂", value: sensor?.no2, unit: "µg/m³" },
              { key: "SO₂", value: sensor?.so2, unit: "µg/m³" },
            ].map((reading) => (
              <li key={reading.key}>
                <span>{reading.key}</span>
                <strong>
                  {reading.value == null ? EMPTY : reading.value}
                  {reading.value == null ? "" : <em>{reading.unit}</em>}
                </strong>
              </li>
            ))}
          </ul>
          <p className="svd-note">
            {sensor?.lastUpdated
              ? `${t("dash_sensor_updated")} ${new Date(sensor.lastUpdated).toLocaleString()}`
              : t("dash_sensor_none")}
          </p>
        </section>

        <section className="svd-card svd-card-full">
          <header className="svd-card-head">
            <h2>{t("dash_sources")}</h2>
            <p>{t("dash_sources_detail")}</p>
          </header>
          <ul className="svd-sources">
            {integrationRows.map((row) => (
              <li key={row.id}>
                <span className="svd-split-label">{row.label}</span>
                <span className={`svd-chip ${row.ok === true ? "is-ok" : row.ok === false ? "is-off" : ""}`}>
                  {row.ok === undefined ? EMPTY : row.ok ? t("dash_connected") : t("dash_not_configured")}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section className="svd-card svd-queue">
        <header className="svd-card-head svd-card-head-split">
          <div>
            <h2>{t("dash_queue")}</h2>
            <p>{t("dash_queue_detail")}</p>
          </div>
          <Link href="/report" className="sv-underline-link">
            {t("nav_report_button")}
          </Link>
        </header>

        {rows.length === 0 ? (
          <p className="svd-empty">{connected ? t("dash_queue_empty") : t("dash_no_signal")}</p>
        ) : (
          <div className="svd-table-scroll">
            <table className="svd-table">
              <thead>
                <tr>
                  <th scope="col">{t("dash_col_location")}</th>
                  <th scope="col">{t("dash_col_hazard")}</th>
                  <th scope="col">{t("dash_col_severity")}</th>
                  <th scope="col">{t("dash_col_confidence")}</th>
                  <th scope="col">{t("dash_col_age")}</th>
                  <th scope="col">{t("dash_col_status")}</th>
                  <th scope="col">{t("dash_col_action")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((incident) => (
                  <tr key={incident.id}>
                    <td>{incident.neighborhood || EMPTY}</td>
                    <td>{t(`hazard_${incident.hazardType}`)}</td>
                    <td>
                      <span className={`svd-tag svd-sev-${incident.severity}`}>
                        {t(`severity_${incident.severity}`) || incident.severity}
                      </span>
                    </td>
                    <td>{incident.aiConfidence ? `${incident.aiConfidence}%` : EMPTY}</td>
                    <td>{incident.timestamp ? getIncidentAge(incident.timestamp) : EMPTY}</td>
                    <td className="svd-status">{formatStatus(incident.status)}</td>
                    <td>
                      <button
                        type="button"
                        className="svd-action"
                        onClick={() => handleDispatch(incident)}
                        disabled={
                          !db ||
                          incident.dispatchStatus === "dispatched" ||
                          dispatching === incident.id
                        }
                      >
                        {incident.dispatchStatus === "dispatched"
                          ? t("dash_dispatched")
                          : dispatching === incident.id
                            ? t("dispatch_dispatching")
                            : t(getRecommendedActionKey(incident)) || getRecommendedAction(incident)}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="svd-card svd-map-card">
        <header className="svd-card-head">
          <h2>{t("dash_map")}</h2>
          <p>{t("dash_map_detail")}</p>
        </header>
        <div className="svd-map">
          {/* Bare map only — the component's own header/sidebar belong to the
              standalone /map page and carry that page's styling. */}
          <GoogleHotspotMap mode="operations" showHeader={false} showSidebar={false} />
        </div>
      </section>
    </div>
  );
}
