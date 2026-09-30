"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { collection, limit, onSnapshot, orderBy, query } from "firebase/firestore";
import HotspotMap, { type FireMarker } from "@/components/map/HotspotMap";
import IncidentDrawer, { type DrawerTarget } from "@/components/dashboard/IncidentDrawer";
import ModelQualityCard from "@/components/dashboard/ModelQualityCard";
import OperatorAuth, { COMMAND_CENTER_ID } from "@/components/dashboard/OperatorAuth";
import OperatorCopilot from "@/components/dashboard/OperatorCopilot";
import AqiGauge from "@/components/shared/AqiGauge";
import Icon from "@/components/shared/Icon";
import LiveIndicator from "@/components/shared/LiveIndicator";
import { db, isFirebaseConfigured } from "@/lib/firebase";
import {
  hasPollutionSignal,
  reportToIncident,
  type FirestoreReport,
} from "@/lib/firestoreReports";
import { cityTimeZoneLabel, formatCityTime, isInCity, type CityConfig } from "@/lib/cities";
import { useCity } from "@/lib/cityContext";
import { AQI_SCALES, medianStationAqi, type AqiInput } from "@/lib/aqiScales";
import { parseSensorTimestamp, priorityRank, TIER_LABELS } from "@/lib/supportEvidence";
import { formatStatus, getIncidentAge } from "@/components/command/commandData";
import type { HazardType, Incident, Severity } from "@/lib/types";
import { useT } from "@/lib/languageContext";
import { closureDisplayState } from "@/lib/closure";
import { chronicReasonText, type RecurrenceSummary } from "@/lib/recurrence";
import { getSlaStatusNow } from "@/lib/sla";

type RecurrenceByCell = Record<string, RecurrenceSummary | { error: string }>;

function chronicSummary(entry: RecurrenceByCell[string] | undefined) {
  return entry && "chronic" in entry && entry.chronic ? entry : null;
}

/** Repeat-hotspot, overdue and resident-dispute flags for one queue row. */
function QueueChips({ incident, recurrence }: { incident: Incident; recurrence: RecurrenceSummary | null }) {
  const t = useT();
  const sla = getSlaStatusNow({
    priority: incident.workOrder?.priority,
    openedAtMs: Date.parse(incident.timestamp),
    resolved: incident.status === "resolved",
  });
  const disputed = closureDisplayState(incident.closure) === "disputed";
  return (
    <>
      {disputed && <span className="svd-mini-chip is-warn">{t("closure_chip_disputed")}</span>}
      {recurrence && (
        <span className="svd-mini-chip is-alert" title={recurrence.chronicReasons.map((r) => chronicReasonText(r, t)).join(" · ")}>
          {t("dash_chip_chronic")}
        </span>
      )}
      {sla?.overdueHours && (
        <span className="svd-mini-chip is-warn">{t("sla_overdue").replace("{hours}", String(sla.overdueHours))}</span>
      )}
    </>
  );
}

/** Every empty metric renders as this — never a zero that could read as a real measurement. */
const EMPTY = "—";

const HAZARDS: HazardType[] = ["fire", "smog", "dust", "industrial", "particulate"];
const SEVERITIES: Severity[] = ["critical", "medium", "low"];

type Integrations = Record<string, boolean>;

type FireFeed = {
  cityId: string;
  fires: FireMarker[];
  windowStart: string;
  windowEnd: string;
  truncated: boolean;
  error?: string;
};

function isLive(incident: Incident, city: CityConfig) {
  return incident.status !== "resolved" && isInCity(city, incident.latitude, incident.longitude);
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
  const { city, ready: cityReady } = useCity();
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [reports, setReports] = useState<Incident[]>([]);
  const [connected, setConnected] = useState(false);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [integrations, setIntegrations] = useState<Integrations | null>(null);
  const [fireFeedState, setFireFeed] = useState<FireFeed | null>(null);
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
    if (!isFirebaseConfigured || !cityReady) return;
    const controller = new AbortController();
    fetch(`/api/scan-ambient?city=${city.id}`, { signal: controller.signal }).catch(() => {
      /* scan failures surface in server logs; the feed still renders */
    });
    return () => controller.abort();
  }, [city.id, cityReady]);

  // City-wide AQI for the header gauge, from the same stations the map shows.
  const [cityStations, setCityStations] = useState<{
    cityId: string;
    stations: AqiInput[];
  } | null>(null);
  useEffect(() => {
    if (!cityReady) return;
    let cancelled = false;
    fetch(`/api/stations?city=${city.id}`)
      .then((response) => response.json().catch(() => null))
      .then((data) => {
        if (!cancelled) setCityStations({ cityId: city.id, stations: Array.isArray(data?.stations) ? data.stations : [] });
      })
      .catch(() => {
        if (!cancelled) setCityStations({ cityId: city.id, stations: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [city.id, cityReady]);
  const aqiScale = AQI_SCALES[city.aqiScale];
  const cityAqi = cityStations?.cityId === city.id ? medianStationAqi(cityStations.stations, aqiScale) : null;

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

  useEffect(() => {
    if (!cityReady) return;
    let cancelled = false;
    fetch(`/api/fires?city=${city.id}`)
      .then(async (r) => (await r.json()) as Omit<FireFeed, "cityId">)
      .then((data) => {
        if (!cancelled) setFireFeed({ ...data, cityId: city.id });
      })
      .catch(() => {
        if (!cancelled) {
          setFireFeed({ cityId: city.id, fires: [], windowStart: "", windowEnd: "", truncated: false, error: "unavailable" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [city.id, cityReady]);

  // Only show fires fetched for the city currently selected.
  const fireFeed = fireFeedState?.cityId === city.id ? fireFeedState : null;

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(id);
  }, [toast]);

  const active = useMemo(
    () => incidents.filter((incident) => isLive(incident, city)).sort(compareIncidents),
    [city, incidents],
  );
  const queue = useMemo(
    () => reports.filter((r) => isLive(r, city) && !r.evidence?.alertTier),
    [city, reports],
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
  // rejects ("Invalid Date") or reads month-first. Use the shared parser
  // (it also reads WAQI's ISO timestamps).
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
    { id: "maps", label: t("dash_src_maps"), ok: true },
    { id: "gemini", label: t("dash_src_gemini"), ok: integrations?.gemini },
    // One row per station feed; a city has stations when any of them answers.
    ...city.stations.sources.map((source) => ({
      id: `stations-${source}`,
      label: t("dash_src_stations").replace(
        "{network}",
        source === "openaq" ? "OpenAQ" : source === "waqi" ? "WAQI" : "CPCB (data.gov.in)",
      ),
      ok: integrations?.[source],
    })),
    { id: "earthEngine", label: t("dash_src_earth_engine"), ok: integrations?.earthEngine },
    { id: "bigQuery", label: t("dash_src_bigquery"), ok: integrations?.bigQuery },
    { id: "weather", label: t("dash_src_weather"), ok: integrations?.weather },
    { id: "googleAirQuality", label: t("dash_src_air_quality"), ok: integrations?.googleAirQuality },
    { id: "places", label: t("dash_src_places"), ok: integrations?.places },
    { id: "whatsappNotify", label: t("dash_src_whatsapp"), ok: integrations?.whatsappNotify },
    { id: "operatorAuth", label: t("dash_src_operator_auth"), ok: integrations?.operatorAuth },
    { id: "scheduler", label: t("dash_src_scheduler"), ok: integrations?.scheduler },
  ];

  const rows = active.slice(0, 15);
  const mapIncidents = useMemo(() => [...active, ...queue], [active, queue]);

  // 30-day repeat-hotspot history for the cells in the queue (one request).
  const rowCells = [...new Set(rows.map((incident) => incident.h3CellId).filter((cell): cell is string => !!cell))]
    .sort()
    .slice(0, 20)
    .join(",");
  const [recurrenceFeed, setRecurrenceFeed] = useState<{ key: string; cells: RecurrenceByCell } | null>(null);
  useEffect(() => {
    if (!rowCells) return;
    let cancelled = false;
    fetch(`/api/zones/recurrence?cells=${rowCells}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { cells?: RecurrenceByCell } | null) => {
        if (!cancelled && data?.cells) setRecurrenceFeed({ key: rowCells, cells: data.cells });
      })
      .catch(() => {
        /* chips simply don't show */
      });
    return () => {
      cancelled = true;
    };
  }, [rowCells]);
  const recurrenceByCell = recurrenceFeed?.key === rowCells ? recurrenceFeed.cells : {};

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
          <p className="svd-note">
            {t("dash_city_scope")
              .replace("{city}", `${city.name}, ${city.country}`)
              .replace("{standard}", city.standards.source)}
          </p>
        </div>
        <div className="svd-head-gauge">
          <AqiGauge
            compact
            scale={aqiScale}
            value={cityAqi?.aqi ?? null}
            title={t("aqi_gauge_title_city").replace("{city}", city.name)}
            caption={cityAqi ? t("aqi_gauge_city_median").replace("{count}", String(cityAqi.stations)) : undefined}
            emptyText={cityStations?.cityId === city.id ? t("aqi_gauge_no_live") : t("drawer_loading")}
          />
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

      <section className="svd-card svd-queue" id={COMMAND_CENTER_ID} tabIndex={-1}>
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
                      <QueueChips incident={incident} recurrence={chronicSummary(recurrenceByCell[incident.h3CellId ?? ""])} />
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

      {/* Citizen reports Gemini has classified but no independent evidence has
          backed yet. They join the response queue once promoted. */}
      <section className="svd-card svd-queue" aria-labelledby="svd-reports-title">
        <header className="svd-card-head svd-card-head-split">
          <div>
            <h2 className="vs-title" id="svd-reports-title">
              <Icon name="citizens" size={17} />
              {t("dash_reports_title")} ({queue.length})
            </h2>
            <p>{t("dash_reports_detail")}</p>
          </div>
        </header>
        {queue.length === 0 ? (
          <p className="svd-empty">{t("dash_reports_empty").replace("{city}", city.name)}</p>
        ) : (
          <div className="svd-table-scroll">
            <table className="svd-table">
              <thead>
                <tr>
                  <th scope="col">{t("dash_col_location")}</th>
                  <th scope="col">{t("dash_col_hazard")}</th>
                  <th scope="col">{t("dash_col_confidence")}</th>
                  <th scope="col">{t("dash_col_age")}</th>
                  <th scope="col">{t("dash_col_status")}</th>
                  <th scope="col">{t("dash_col_action")}</th>
                </tr>
              </thead>
              <tbody>
                {[...queue]
                  .sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""))
                  .slice(0, 20)
                  .map((report) => (
                    <tr key={report.id}>
                      <td>
                        {report.neighborhood || EMPTY}
                        {/* The report's own id, as the reporter sees it on their tracking page. */}
                        <small className="svd-report-id">{report.id.replace(/^firestore-/, "")}</small>
                      </td>
                      <td>{t(`hazard_${report.hazardType}`)}</td>
                      <td>{report.aiConfidence ? `${report.aiConfidence}%` : EMPTY}</td>
                      <td>{report.timestamp ? getIncidentAge(report.timestamp) : EMPTY}</td>
                      <td className="svd-status">{formatStatus(report.status)}</td>
                      <td>
                        <button type="button" className="svd-action" onClick={() => setSelectedId(report.id)}>
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
          <HotspotMap
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
            <p>{t("dash_fires_detail_city").replace("{region}", city.fireRegion.label)}</p>
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
                {t("dash_fires_window_tz")
                  .replace("{start}", formatCityTime(city, fireFeed.windowStart))
                  .replace("{end}", formatCityTime(city, fireFeed.windowEnd))
                  .replace("{tz}", cityTimeZoneLabel(city))}
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
            <p>{sensor?.stationName ? sensor.stationName : t("dash_sensor_detail_generic")}</p>
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
              ? `${t("dash_sensor_updated")} ${formatCityTime(city, sensorUpdatedMs)} ${cityTimeZoneLabel(city)}`
              : sensor?.lastUpdated
                ? `${t("dash_sensor_updated")} ${sensor.lastUpdated}`
                : t("dash_sensor_none")}
          </p>
        </section>

        <ModelQualityCard incidents={incidents} />

        {/* Integration status is for the team, not for operators on a phone. */}
        <section className="svd-card svd-card-full vs-hide-mobile">
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
