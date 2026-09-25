"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { collection, limit, onSnapshot, orderBy, query } from "firebase/firestore";
import GoogleHotspotMap, { type FireMarker } from "@/components/map/GoogleHotspotMap";
import IncidentDrawer, { type DrawerTarget } from "@/components/dashboard/IncidentDrawer";
import ModelQualityCard from "@/components/dashboard/ModelQualityCard";
import OperatorAuth from "@/components/dashboard/OperatorAuth";
import OperatorCopilot from "@/components/dashboard/OperatorCopilot";
import Icon from "@/components/shared/Icon";
import LiveIndicator from "@/components/shared/LiveIndicator";
import { db, isFirebaseConfigured } from "@/lib/firebase";
import {
  hasPollutionSignal,
  reportToIncident,
  type FirestoreReport,
} from "@/lib/firestoreReports";
import { isInOperationalRegion } from "@/lib/operationalRegion";
import { parseSensorTimestamp, priorityRank, TIER_LABELS } from "@/lib/supportEvidence";
import { formatStatus, getIncidentAge } from "@/components/command/commandData";
import type { HazardType, Incident, Severity } from "@/lib/types";
import { useT } from "@/lib/languageContext";

/** Every empty metric renders as this — never a zero that could read as a real measurement. */
const EMPTY = "—";

const HAZARDS: HazardType[] = ["fire", "smog", "dust", "industrial", "particulate"];
const SEVERITIES: Severity[] = ["critical", "medium", "low"];

type Integrations = Record<string, boolean>;

type FireFeed = {
  fires: FireMarker[];
  windowStart: string;
  windowEnd: string;
  truncated: boolean;
  error?: string;
};

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

function compareIncidents(a: Incident, b: Incident) {
  const reportsA = a.evidence?.citizenSignal?.reportCount ?? 0;
  const reportsB = b.evidence?.citizenSignal?.reportCount ?? 0;
  const rankDelta = priorityRank(a.evidence?.tier, reportsA) - priorityRank(b.evidence?.tier, reportsB);
  if (rankDelta !== 0) return rankDelta;
  return (b.evidence?.fusion.finalConfidence ?? b.aiConfidence) - (a.evidence?.fusion.finalConfidence ?? a.aiConfidence);
}

export default function DashboardView() {
  const t = useT();
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [reports, setReports] = useState<Incident[]>([]);
  const [connected, setConnected] = useState(false);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [integrations, setIntegrations] = useState<Integrations | null>(null);
  const [fireFeed, setFireFeed] = useState<FireFeed | null>(null);
  const [showFires, setShowFires] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

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

  // Sensor/satellite-only (ambient) detection runs when something calls
  // /api/scan-ambient. Cloud Scheduler → /api/cron/tick is the production
  // trigger; this keeps the layer fresh during demos. The route enforces
  // its own cooldown.
  useEffect(() => {
    if (!isFirebaseConfigured) return;
    const controller = new AbortController();
    fetch("/api/scan-ambient", { signal: controller.signal }).catch(() => {
      /* scan failures surface in server logs; the feed still renders */
    });
    return () => controller.abort();
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
    fetch("/api/fires")
      .then(async (r) => (await r.json()) as FireFeed)
      .then((data) => {
        if (!cancelled) setFireFeed(data);
      })
      .catch(() => {
        if (!cancelled) setFireFeed({ fires: [], windowStart: "", windowEnd: "", truncated: false, error: "unavailable" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(id);
  }, [toast]);

  const active = useMemo(() => incidents.filter(isLive).sort(compareIncidents), [incidents]);
  const queue = useMemo(
    () => reports.filter((r) => isLive(r) && !r.evidence?.alertTier),
    [reports],
  );

  const selectedTarget: DrawerTarget | null = useMemo(() => {
    if (!selectedId) return null;
    const fromIncidents = incidents.find((incident) => incident.id === selectedId);
    if (fromIncidents) return { incident: fromIncidents, collection: "incidents" };
    const fromReports = reports.find((report) => report.id === selectedId);
    return fromReports ? { incident: fromReports, collection: "reports" } : null;
  }, [selectedId, incidents, reports]);

  const closeDrawer = useCallback(() => setSelectedId(null), []);

  const critical = active.filter((i) => i.severity === "critical").length;
  const resolvedToday = incidents.filter((i) => {
    if (i.status !== "resolved" || !i.resolvedAt) return false;
    return new Date(i.resolvedAt).toDateString() === new Date().toDateString();
  }).length;

  const avgConfidence = active.length
    ? Math.round(
        active.reduce((sum, i) => sum + (i.evidence?.fusion.finalConfidence ?? i.aiConfidence), 0) / active.length,
      )
    : null;

  const judged = incidents.filter((i) => i.outcome === "confirmed" || i.outcome === "false_positive");
  const verifiedPrecision = judged.length
    ? Math.round((judged.filter((i) => i.outcome === "confirmed").length / judged.length) * 100)
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
  // CPCB stamps are "DD-MM-YYYY HH:MM:SS" in IST, which `new Date()` either
  // rejects ("Invalid Date") or reads month-first. Use the shared parser.
  const sensorUpdatedMs = parseSensorTimestamp(sensor?.lastUpdated);

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
    {
      id: "precision",
      label: t("dash_kpi_precision"),
      value: verifiedPrecision == null ? EMPTY : `${verifiedPrecision}%`,
      detail: t("dash_kpi_precision_detail").replace("{n}", String(judged.length)),
    },
  ];

  const integrationRows = [
    { id: "firestore", label: t("dash_src_firestore"), ok: isFirebaseConfigured },
    { id: "maps", label: t("dash_src_maps"), ok: Boolean(process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY) },
    { id: "gemini", label: t("dash_src_gemini"), ok: integrations?.gemini },
    { id: "cpcb", label: t("dash_src_cpcb"), ok: integrations?.cpcb },
    { id: "earthEngine", label: t("dash_src_earth_engine"), ok: integrations?.earthEngine },
    { id: "bigQuery", label: t("dash_src_bigquery"), ok: integrations?.bigQuery },
    { id: "openWeather", label: t("dash_src_openweather"), ok: integrations?.openWeather },
    { id: "googleAirQuality", label: t("dash_src_air_quality"), ok: integrations?.googleAirQuality },
    { id: "places", label: t("dash_src_places"), ok: integrations?.places },
    { id: "whatsappNotify", label: t("dash_src_whatsapp"), ok: integrations?.whatsappNotify },
    { id: "operatorAuth", label: t("dash_src_operator_auth"), ok: integrations?.operatorAuth },
    { id: "scheduler", label: t("dash_src_scheduler"), ok: integrations?.scheduler },
  ];

  const rows = active.slice(0, 15);
  const mapIncidents = useMemo(() => [...active, ...queue], [active, queue]);

  return (
    <div className="svd">
      <header className="svd-head">
        <div>
          <LiveIndicator
            state={connected ? "live" : isFirebaseConfigured ? "connecting" : "offline"}
            label={connected ? t("dash_feed_live") : t("dash_feed_idle")}
          />
          <h1>{t("dash_title")}</h1>
          <p className="svd-lede">{t("dash_lede")}</p>
        </div>
        <OperatorAuth />
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

      <section className="svd-card svd-queue">
        <header className="svd-card-head svd-card-head-split">
          <div>
            <h2 className="vs-title">
              <Icon name="list" size={17} />
              {t("dash_queue")}
            </h2>
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
                  <th scope="col">{t("dash_col_evidence")}</th>
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
                    <td className="svd-status">
                      {incident.evidence?.tier
                        ? t(`tier_${incident.evidence.tier}`) || TIER_LABELS[incident.evidence.tier]
                        : EMPTY}
                    </td>
                    <td>
                      <span className={`svd-tag svd-sev-${incident.severity}`}>
                        {t(`severity_${incident.severity}`) || incident.severity}
                      </span>
                    </td>
                    <td>
                      {incident.evidence?.fusion.finalConfidence
                        ? `${incident.evidence.fusion.finalConfidence}%`
                        : incident.aiConfidence
                          ? `${incident.aiConfidence}%`
                          : EMPTY}
                    </td>
                    <td>{incident.timestamp ? getIncidentAge(incident.timestamp) : EMPTY}</td>
                    <td className="svd-status">
                      {incident.dispatchStatus === "dispatched" ? t("dash_dispatched") : formatStatus(incident.status)}
                      {incident.workOrder && <span className="svd-mini-chip">{t("dash_work_order_ready")}</span>}
                    </td>
                    <td>
                      <button type="button" className="svd-action" onClick={() => setSelectedId(incident.id)}>
                        {t("dash_review")}
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
        <header className="svd-card-head svd-card-head-split">
          <div>
            <h2 className="vs-title">
              <Icon name="pin" size={17} />
              {t("dash_map")}
            </h2>
            <p>{t("dash_map_detail_ops")}</p>
          </div>
          <label className="svd-toggle">
            <input type="checkbox" checked={showFires} onChange={(event) => setShowFires(event.target.checked)} />
            {t("dash_show_fires")}
          </label>
        </header>
        <div className="svd-map">
          {/* Bare map only — the component's own header/sidebar belong to the
              standalone /map page and carry that page's styling. */}
          <GoogleHotspotMap
            incidents={mapIncidents}
            fires={showFires ? fireFeed?.fires : undefined}
            mode="operations"
            onIncidentSelect={setSelectedId}
            selectedIncidentId={selectedId}
            showHeader={false}
            showSidebar={false}
          />
        </div>
      </section>

      <div className="svd-grid">
        <OperatorCopilot />

        <section className="svd-card svd-card-wide">
          <header className="svd-card-head">
            <h2 className="vs-title">
              <Icon name="layers" size={17} />
              {t("dash_hazard_mix")}
            </h2>
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

        <section className="svd-card svd-card-wide">
          <header className="svd-card-head">
            <h2 className="vs-title">
              <Icon name="flame" size={17} />
              {t("dash_fires_title")}
            </h2>
            <p>{t("dash_fires_detail")}</p>
          </header>
          {!fireFeed ? (
            <p className="svd-empty">{t("drawer_loading")}</p>
          ) : fireFeed.error ? (
            <p className="svd-empty">{t("dash_fires_unavailable")}</p>
          ) : (
            <>
              <p className="svd-big-number">
                {fireFeed.fires.length}
                {fireFeed.truncated ? "+" : ""}
                <span>{t("dash_fires_unit")}</span>
              </p>
              <p className="svd-note">
                {t("dash_fires_window")
                  .replace("{start}", new Date(fireFeed.windowStart).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }))
                  .replace("{end}", new Date(fireFeed.windowEnd).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }))}
              </p>
            </>
          )}
        </section>

        <section className="svd-card">
          <header className="svd-card-head">
            <h2 className="vs-title">
              <Icon name="alert" size={17} />
              {t("dash_severity")}
            </h2>
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
            <h2 className="vs-title">
              <Icon name="station" size={17} />
              {t("dash_sensor")}
            </h2>
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
            {sensorUpdatedMs !== null
              ? `${t("dash_sensor_updated")} ${new Date(sensorUpdatedMs).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`
              : sensor?.lastUpdated
                ? `${t("dash_sensor_updated")} ${sensor.lastUpdated}`
                : t("dash_sensor_none")}
          </p>
        </section>

        <ModelQualityCard incidents={incidents} />

        <section className="svd-card svd-card-full">
          <header className="svd-card-head">
            <h2 className="vs-title">
              <Icon name="database" size={17} />
              {t("dash_sources")}
            </h2>
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

      {selectedTarget && (
        <IncidentDrawer
          key={selectedTarget.incident.id}
          target={selectedTarget}
          onClose={closeDrawer}
          onToast={setToast}
        />
      )}

      {toast && (
        <div className="svd-toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
