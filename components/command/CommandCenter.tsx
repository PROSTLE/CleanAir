"use client";

import { useT } from "@/lib/languageContext";

import { useEffect, useMemo, useState } from "react";
import { collection, limit, onSnapshot, orderBy, query, doc, updateDoc, serverTimestamp } from "firebase/firestore";
import type { Incident } from "@/lib/types";
import {
  commandStats,
  formatStatus,
  getIncidentAge,
  getRecommendedAction,
  getRecommendedActionKey,
} from "@/components/command/commandData";
import GoogleHotspotMap from "@/components/map/GoogleHotspotMap";
import { db, isFirebaseConfigured } from "@/lib/firebase";
import {
  hasPollutionSignal,
  reportToIncident,
  type FirestoreReport,
} from "@/lib/firestoreReports";
import { buildIncidentEvidence } from "@/lib/incidentEvidence";
import { isInOperationalRegion } from "@/lib/operationalRegion";
import { TIER_LABELS, priorityRank } from "@/lib/supportEvidence";
import { latLngToCell } from "h3-js";

type CommandTab = "priority" | "citizen_reported" | "auto_detected";
type Translator = (key: string) => string;
const SINGLE_SOURCE_AUTO_DISPLAY_CAP = 78;
const AUTO_DETECTED_DISPLAY_LIMIT = 20;

const commandTabs: Array<{ id: CommandTab; label: string }> = [
  { id: "priority", label: "Priority" },
  { id: "citizen_reported", label: "Citizen Reported" },
  { id: "auto_detected", label: "Automatically Detected" },
];

function getIncidentHazardLabel(incident: Incident, t: Translator) {
  const isAutoDetected = (incident.evidence?.citizenSignal?.reportCount ?? 0) === 0;

  if (isAutoDetected) {
    if (incident.hazardType === "dust") return t("hazard_auto_dust");
    if (incident.hazardType === "industrial") return t("hazard_auto_industrial");
    if (incident.hazardType === "particulate") return t("hazard_auto_particulate");
    if (incident.hazardType === "smog") return t("hazard_auto_smog");
    if (incident.hazardType === "fire") return t("hazard_auto_fire");
  }

  return t("hazard_" + incident.hazardType);
}

function shouldShowInCommandCenter(incident: Incident) {
  return (
    incident.status !== "resolved" &&
    isInOperationalRegion(incident.latitude, incident.longitude)
  );
}

function getCitizenReportCount(incident: Incident) {
  return incident.evidence?.citizenSignal?.reportCount ?? 0;
}

function getAutoAbnormalnessScore(incident: Incident) {
  const maxTriggerDelta = Math.max(
    0,
    ...(incident.triggerPollutants ?? []).map((pollutant) => pollutant.deltaPct),
  );
  return Math.max(incident.aiConfidence, maxTriggerDelta);
}

function compareAutoDetected(a: Incident, b: Incident) {
  const rankA = priorityRank(a.evidence?.tier, 0);
  const rankB = priorityRank(b.evidence?.tier, 0);
  if (rankA !== rankB) return rankA - rankB;

  const abnormalityDelta = getAutoAbnormalnessScore(b) - getAutoAbnormalnessScore(a);
  if (abnormalityDelta !== 0) return abnormalityDelta;

  return b.aiConfidence - a.aiConfidence;
}

function compareCitizenBacked(a: Incident, b: Incident) {
  const reportsA = getCitizenReportCount(a);
  const reportsB = getCitizenReportCount(b);
  if (reportsB !== reportsA) return reportsB - reportsA;

  const rankA = priorityRank(a.evidence?.tier, reportsA);
  const rankB = priorityRank(b.evidence?.tier, reportsB);
  if (rankA !== rankB) return rankA - rankB;

  return b.aiConfidence - a.aiConfidence;
}

function translateFreshness(freshness: string, t: Translator) {
  const normalized = freshness.toLowerCase();
  if (normalized === "fresh") return t("freshness_fresh");
  if (normalized === "stale") return t("freshness_stale");
  return freshness;
}

function getCoverageLabel(
  coverage: { level: string; nearestSensorKm: number; label: string },
  t: Translator,
) {
  if (coverage.nearestSensorKm <= 0.05) {
    return t("coverage_at_nearest_station").replace(
      "{distance}",
      coverage.nearestSensorKm.toFixed(1),
    );
  }
  if (coverage.level === "low") return t("coverage_low_station");
  if (coverage.level === "limited") return t("coverage_limited_station");
  return t("coverage_nearby_sensor");
}

function getAlertReasonLabel(isAutoDetected: boolean, t: Translator) {
  return isAutoDetected
    ? t("alert_reason_auto_no_citizen")
    : t("alert_reason_citizen_promoted");
}

function getQueueIncidentMeta(incident: Incident, t: Translator) {
  const tierLabel = incident.evidence?.tier
    ? t("tier_" + incident.evidence.tier) || TIER_LABELS[incident.evidence.tier]
    : incident.source === "citizen"
      ? t("source_filter_citizen")
      : incident.source === "sensor"
        ? t("source_filter_sensor")
        : t("source_filter_satellite");
  const isAutoDetected = getCitizenReportCount(incident) === 0;
  const metaParts = [getIncidentHazardLabel(incident, t), tierLabel];

  if (!isAutoDetected) {
    metaParts.push(`${incident.aiConfidence}% ${t("map_confidence")}`);
  }

  return metaParts.join(" · ");
}

function getIncidentNotes(incident: Incident) {
  return [
    incident.note,
    ...(incident.citizenNotes ?? []),
  ]
    .map((note) => note?.trim())
    .filter((note): note is string => !!note)
    .filter((note, index, notes) => notes.indexOf(note) === index);
}

function enrichIncidentWithClusterNotes(incident: Incident, reports: Incident[]) {
  const linkedReportIds = new Set(incident.linkedReportIds ?? []);
  const clusterNotes = reports.flatMap((report) => {
    const rawReportId = report.id.replace("firestore-", "");
    const linkedMatch = linkedReportIds.has(rawReportId);
    const clusterMatch =
      !linkedReportIds.size &&
      report.h3CellId &&
      incident.h3CellId &&
      report.h3CellId === incident.h3CellId &&
      report.hazardType === incident.hazardType;

    return linkedMatch || clusterMatch ? getIncidentNotes(report) : [];
  });
  const citizenNotes = [...getIncidentNotes(incident), ...clusterNotes]
    .filter((note, index, notes) => notes.indexOf(note) === index);

  return citizenNotes.length ? { ...incident, citizenNotes, note: incident.note ?? citizenNotes[0] } : incident;
}

export default function CommandCenter() {
  const t = useT();
  const [liveReports, setLiveReports] = useState<Incident[]>([]);
  const [liveAlertIncidents, setLiveAlertIncidents] = useState<Incident[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<CommandTab>("priority");
  const [ambientScanState, setAmbientScanState] = useState<"idle" | "scanning">("idle");
  const [toastMessage, setToastMessage] = useState("");
  const [liveDataError, setLiveDataError] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(""), 3000);
  };

  const runAmbientScan = async (force = false, notify = force) => {
    if (!isFirebaseConfigured || ambientScanState === "scanning") return;
    setAmbientScanState("scanning");
    try {
      const response = await fetch(`/api/scan-ambient${force ? "?force=1" : ""}`);
      if (!response.ok) {
        const errorPayload = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(errorPayload?.error ?? `scan-ambient responded ${response.status}`);
      }
      const result = await response.json() as {
        promoted?: unknown[];
        scanned?: number;
        watching?: unknown[];
      };
      if (notify) {
        const completedMessage = t("ambient_scan_complete")
          .replace("{active}", String(result.promoted?.length ?? 0))
          .replace("{scanned}", String(result.scanned ?? 0));
        const watchingCount = result.watching?.length ?? 0;
        showToast(
          watchingCount > 0
            ? `${completedMessage} · ${watchingCount} awaiting confirmation`
            : completedMessage,
        );
      }
    } catch (error) {
      console.error("Ambient scan failed:", error);
      if (notify) showToast(t("ambient_scan_failed"));
    } finally {
      setAmbientScanState("idle");
    }
  };

  useEffect(() => {
    if (!isFirebaseConfigured || !db) return;

    const reportsQuery = query(
      collection(db, "reports"),
      orderBy("createdAt", "desc"),
      limit(50),
    );

    return onSnapshot(
      reportsQuery,
      (snapshot) => {
        setLiveDataError(null);
        setLiveReports(
          snapshot.docs
            .map((reportDoc) => ({
              data: reportDoc.data() as FirestoreReport,
              id: reportDoc.id,
            }))
            .filter((report) => hasPollutionSignal(report.data))
            .map((report) => reportToIncident(report.id, report.data))
            .filter(shouldShowInCommandCenter),
        );
      },
      (error) => {
        // Without this handler, a permission/index/network error silently
        // kills the listener and liveReports just stays empty forever —
        // looks like incidents "never appear" with zero indication why.
        console.error("reports onSnapshot failed:", error);
        setLiveDataError(`${t("live_reports_feed_error")}: ${error.message}`);
      },
    );
  }, []);

  useEffect(() => {
    if (!isFirebaseConfigured || !db) return;

    const incidentsQuery = query(
      collection(db, "incidents"),
      orderBy("updatedAt", "desc"),
      limit(200),
    );

    return onSnapshot(
      incidentsQuery,
      (snapshot) => {
        setLiveDataError(null);
        setLiveAlertIncidents(
          snapshot.docs
            .map((doc) => reportToIncident(doc.id, doc.data() as FirestoreReport))
            .filter(shouldShowInCommandCenter),
        );
      },
      (error) => {
        console.error("incidents onSnapshot failed:", error);
        setLiveDataError(`${t("live_incidents_feed_error")}: ${error.message}`);
      },
    );
  }, []);

  const enrichedAlertIncidents = useMemo(
    () =>
      liveAlertIncidents.map((incident) =>
        enrichIncidentWithClusterNotes(incident, liveReports),
      ),
    [liveAlertIncidents, liveReports],
  );

  // Kick off the sensor/satellite-only ambient scan (no citizen report
  // needed). Writes land in the "incidents" collection and flow back through
  // the onSnapshot listener above like any other promoted incident. The route
  // itself has a 5-min in-process cooldown, so this is safe to call on mount.
  useEffect(() => {
    if (!isFirebaseConfigured) return;
    const timeoutId = window.setTimeout(() => {
      void runAmbientScan(false);
    }, 1000);
    return () => window.clearTimeout(timeoutId);
  }, []);

  const incomingSignals = useMemo(
    () => liveReports.filter((incident) => !incident.evidence?.alertTier),
    [liveReports],
  );

  // "incidents" collection = anything that has cleared a promotion tier.
  // Priority order (see priorityRank in lib/supportEvidence for the full
  // rationale):
  //   1. sensor + satellite confirmed
  //   2. crowd-verified with overwhelming report count (5+)
  //   3. citizen + sensor confirmed
  //   4. citizen + satellite confirmed
  //   5. crowd-verified, baseline (3-4 reports)
  //   6. satellite-detected only
  //   7. sensor-detected only
  // Ties within the same rank fall back to report count (more first), then
  // most-recently-updated first.
  const priorityIncidents = useMemo(
    () => {
      const citizenBacked = enrichedAlertIncidents
        .filter((incident) => getCitizenReportCount(incident) > 0)
        .sort(compareCitizenBacked);
      const autoDetected = enrichedAlertIncidents
        .filter((incident) => getCitizenReportCount(incident) === 0)
        .sort(compareAutoDetected)
        .slice(0, AUTO_DETECTED_DISPLAY_LIMIT);
      return [...citizenBacked, ...autoDetected];
    },
    [enrichedAlertIncidents],
  );

  // Citizen Reported: any promoted incident that had at least one citizen
  // report behind it — including sensor+satellite-confirmed incidents that
  // also happened to have citizen reports. Citizen involvement always wins
  // this bucket, since a human-corroborated signal deserves its own
  // priority channel regardless of what else confirmed it.
  const citizenReportedIncidents = useMemo(
    () =>
      enrichedAlertIncidents.filter(
        (incident) => (incident.evidence?.citizenSignal?.reportCount ?? 0) > 0,
      ),
    [enrichedAlertIncidents],
  );

  // Automatically Detected: promoted incidents with zero citizen reports —
  // purely sensor/satellite driven, since automatic detection can be wrong
  // and shouldn't be mixed into the citizen-corroborated channel.
  const autoDetectedIncidents = useMemo(
    () =>
      enrichedAlertIncidents
        .filter((incident) => getCitizenReportCount(incident) === 0)
        .sort(compareAutoDetected)
        .slice(0, AUTO_DETECTED_DISPLAY_LIMIT),
    [enrichedAlertIncidents],
  );

  const incidents = enrichedAlertIncidents;

  // Keep the automatic-detection view operationally focused: citizen signals
  // belong to the other two tabs and should not inflate this map's marker count.
  const mapOverlaySignals = activeTab === "auto_detected" ? [] : incomingSignals;

  const filteredIncidents = useMemo(() => {
    switch (activeTab) {
      case "priority":
        return priorityIncidents;
      case "citizen_reported":
        return citizenReportedIncidents;
      case "auto_detected":
        return autoDetectedIncidents;
      default:
        return priorityIncidents;
    }
  }, [activeTab, priorityIncidents, citizenReportedIncidents, autoDetectedIncidents]);


  const selectedIncident =
    (() => {
      const allIncidents = [...incidents, ...incomingSignals];
      const selected = allIncidents.find((incident) => incident.id === selectedId);
      const newestLiveIncident = enrichedAlertIncidents[0];
      return selected ?? newestLiveIncident ?? null;
    })();
  const selectedIncidentId = selectedIncident?.id ?? null;
  const isSelectedUnpromoted = selectedIncident && !selectedIncident.evidence?.alertTier;

  const stats = useMemo(
    () =>
      commandStats.map((stat) => {
        if (stat.label === "Active incidents") {
          return {
            ...stat,
            label: t("command_stat_active"),
            detail: t("command_stat_active_detail"),
            value: incidents.filter((incident) => incident.status !== "resolved").length,
          };
        }
        if (stat.label === "Critical") {
          return {
            ...stat,
            label: t("command_stat_critical"),
            detail: t("command_stat_critical_detail"),
            value: incidents.filter((incident) => incident.severity === "critical")
              .length,
          };
        }
        if (stat.label === "Avg response") {
          return { ...stat, label: t("command_stat_avg_response"), detail: t("command_stat_avg_response_detail"), value: "—" };
        }
        if (stat.label === "Peak risk") {
          return { ...stat, label: t("command_stat_peak_risk"), value: "—", detail: t("hero_stat_awaiting_forecast") };
        }
        return stat;
      }),
    [incidents, t],
  );

  return (
    <section className="command-center-grid">
      {liveDataError && (
        <div
          style={{
            gridColumn: "1 / -1",
            background: "#7a1f1f",
            color: "white",
            padding: "10px 16px",
            borderRadius: "8px",
            fontWeight: 600,
            fontSize: "0.85rem",
          }}
        >
          {liveDataError} — {t("live_data_error_suffix")}
        </div>
      )}
      <div className="command-stat-grid" aria-label="Command Center metrics">
        {stats.map((stat) => (
          <article className="command-stat-card" key={stat.label}>
            <strong>{stat.value}</strong>
            <span>{stat.label}</span>
            <small>{stat.detail}</small>
          </article>
        ))}
      </div>

      <aside className="incident-queue-panel">
        <div className="command-panel-header">
          <div>
            <p>{t("command_feed_title")}</p>
            <h2>{t("command_detail_priority")}</h2>
          </div>
          <span>{t("command_count_active").replace("{count}", filteredIncidents.length.toString())}</span>
        </div>

        <div className="source-filter-row" aria-label="Command Center tabs">
          {commandTabs.map((tab) => (
            <button
              className={activeTab === tab.id ? "source-filter active" : "source-filter"}
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              type="button"
            >
              {tab.id === "priority" ? (t("source_filter_priority") || tab.label) :
               tab.id === "citizen_reported" ? (t("source_filter_citizen_reported") || tab.label) :
               (t("source_filter_auto_detected") || tab.label)}
            </button>
          ))}
          {activeTab === "auto_detected" && (
            <button
              className="ambient-refresh-button"
              disabled={ambientScanState === "scanning"}
              onClick={() => void runAmbientScan(true)}
              title={t("ambient_scan_refresh_title")}
              type="button"
            >
              {ambientScanState === "scanning" ? t("ambient_scan_scanning") : t("ambient_scan_reload")}
            </button>
          )}
        </div>

        <div className="incident-queue-list">
          {filteredIncidents.length === 0 ? (
            <div className="incident-empty-state">
              <strong>{t("command_feed_empty_title")}</strong>
              <span>
                {t("command_signals_empty_desc")}
              </span>
            </div>
          ) : filteredIncidents.map((incident) => (
            <button
              className={
                incident.id === selectedIncidentId
                  ? `queue-item selected`
                  : `queue-item`
              }
              key={incident.id}
              onClick={() => setSelectedId(incident.id)}
              type="button"
            >
              <span className={`severity-dot ${incident.severity}`} />
              <span className="queue-copy">
                <strong>
                  {incident.neighborhood}
                </strong>
                <small>{getQueueIncidentMeta(incident, t)}</small>
              </span>
              <span className={`queue-status ${incident.status}`}>
                {t("status_" + incident.status) || formatStatus(incident.status)}
              </span>
            </button>
          ))}
        </div>

        {activeTab !== "auto_detected" && <IncomingSignals signals={incomingSignals} t={t} />}
      </aside>

      <div className="command-map-panel">
        <div className="command-panel-header">
          <div>
            <p>{t("command_detail_map_title")}</p>
            <h2>{t("command_detail_map_layer")}</h2>
          </div>
          <span>{t("command_count_mapped").replace("{count}", (filteredIncidents.length + mapOverlaySignals.length).toString())}</span>
        </div>

        <GoogleHotspotMap
          incidents={[...filteredIncidents, ...mapOverlaySignals]}
          mode="operations"
          onIncidentSelect={setSelectedId}
          selectedIncidentId={selectedIncidentId}
          showHeader={false}
          showSidebar={false}
        />
      </div>


        {selectedIncident ? (
          isSelectedUnpromoted ? (
            <UnverifiedSignalDetail incident={selectedIncident} t={t} />
          ) : (
            <IncidentDetail 
              incident={selectedIncident} 
              t={t}
              onResolved={() => {
                setSelectedId(null);
                showToast(t("incident_marked_resolved"));
              }} 
            />
          )
        ) : (
          <EmptyIncidentDetail t={t} />
        )}
      {toastMessage && (
        <div className="command-toast">
          {toastMessage}
        </div>
      )}
    </section>
  );
}

function IncomingSignals({ signals, t }: { signals: Incident[], t: Translator }) {
  const groupedSignals = useMemo(() => {
    const groupMap = new Map<string, { primary: Incident; count: number }>();
    signals.forEach((signal) => {
      const h3CellId = signal.h3CellId ?? latLngToCell(signal.latitude, signal.longitude, 8);
      const groupId = `${h3CellId}-${signal.hazardType}`;
      
      const cluster = groupMap.get(groupId);
      if (!cluster) {
        groupMap.set(groupId, { primary: signal, count: 1 });
      } else {
        cluster.count++;
      }
    });
    return Array.from(groupMap.values());
  }, [signals]);

  return (
    <div className="incoming-signals-panel">
      <div>
        <p>{t("command_signals_title")}</p>
        <span>{t("command_count_unverified").replace("{count}", groupedSignals.length.toString())}</span>
      </div>

      {groupedSignals.length === 0 ? (
        <small>{t("command_signals_empty_title")}</small>
      ) : (
        <ul>
          {groupedSignals.slice(0, 3).map((group) => {
            const signal = group.primary;
            return (
              <li key={signal.id}>
                <strong>{signal.neighborhood}</strong>
                <span>
                  {group.count > 1 
                    ? t("incoming_signal_cluster_waiting").replace("{count}", group.count.toString())
                    : t("incoming_signal_awaiting_fusion")}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function IncidentDetail({ incident, onResolved, t }: { incident: Incident; onResolved: () => void, t: Translator }) {
  const [showResolveModal, setShowResolveModal] = useState(false);
  const [showNotesModal, setShowNotesModal] = useState(false);
  const [isResolving, setIsResolving] = useState(false);
  const [resolveError, setResolveError] = useState("");
  const [isDispatching, setIsDispatching] = useState(false);

  const handleDispatch = async () => {
    if (!db || incident.dispatchStatus === "dispatched") return;
    setIsDispatching(true);
    try {
      const collectionName = incident.evidence?.alertTier ? "incidents" : "reports";
      const docId = incident.id.replace("firestore-", "");
      const actionLabel = t(getRecommendedActionKey(incident)) || getRecommendedAction(incident);
      await updateDoc(doc(db, collectionName, docId), {
        dispatchStatus: "dispatched",
        dispatchedAction: actionLabel,
        dispatchedAt: serverTimestamp(),
      });
    } catch (err) {
      console.error("Failed to dispatch:", err);
    } finally {
      setIsDispatching(false);
    }
  };

  const handleResolve = async () => {
    if (!db) return;
    setIsResolving(true);
    setResolveError("");
    try {
      const collectionName = incident.evidence?.alertTier ? "incidents" : "reports";
      const docId = incident.id.replace("firestore-", "");
      await updateDoc(doc(db, collectionName, docId), {
        status: "resolved",
        resolvedAt: serverTimestamp(),
      });
      setShowResolveModal(false);
      onResolved();
    } catch (err) {
      setResolveError(err instanceof Error ? err.message : t("resolve_incident_failed"));
    } finally {
      setIsResolving(false);
    }
  };

  const evidence = incident.evidence ?? null;
  const isAwaitingClassification = !evidence;
  const fallbackEvidence = evidence ?? buildIncidentEvidence(incident);
  const isAutoDetected = fallbackEvidence.citizenSignal.reportCount === 0;
  const physicalSourceCount =
    (fallbackEvidence.fusion.sensorWeight > 0 ? 1 : 0) +
    (fallbackEvidence.fusion.satelliteWeight > 0 ? 1 : 0);
  const hasOnlyOneAutoSource =
    isAutoDetected &&
    physicalSourceCount === 1 &&
    fallbackEvidence.fusion.visualWeight === 0 &&
    (fallbackEvidence.fusion.corroborationWeight ?? 0) === 0;
  const displayedFusionConfidence = hasOnlyOneAutoSource
    ? Math.min(fallbackEvidence.fusion.finalConfidence, SINGLE_SOURCE_AUTO_DISPLAY_CAP)
    : fallbackEvidence.fusion.finalConfidence;
  const sensorLabel =
    fallbackEvidence.sensor.source === "CPCB" && fallbackEvidence.sensor.stationName
      ? t("sensor_label_with_distance")
          .replace("{station}", fallbackEvidence.sensor.stationName)
          .replace("{distance}", fallbackEvidence.sensor.distanceKm?.toFixed(1) ?? "0.0")
      : t("sensor_context_estimated");
  const pollutantName = fallbackEvidence.sensor.primaryName ?? "PM2.5";
  const pollutantValue = fallbackEvidence.sensor.primaryValue ?? fallbackEvidence.sensor.pm25;
  const pollutantDelta = fallbackEvidence.sensor.primaryDelta ?? fallbackEvidence.sensor.pm25Delta;

  const sensorReading =
    pollutantValue !== undefined && pollutantValue !== null
      ? `${pollutantName} ${pollutantValue} µg/m³`
      : `${pollutantName} ${pollutantDelta >= 0 ? "+" : ""}${pollutantDelta}%`;
  const sensorMeta =
    fallbackEvidence.sensor.source === "CPCB" && fallbackEvidence.sensor.lastUpdated
      ? t("sensor_updated_at").replace("{time}", fallbackEvidence.sensor.lastUpdated)
      : fallbackEvidence.sensor.trend;
  const satelliteFreshness = translateFreshness(fallbackEvidence.satellite.freshness, t);
  const satelliteMeta = fallbackEvidence.satellite.windowStart && fallbackEvidence.satellite.windowEnd
    ? t("satellite_window_meta")
        .replace("{freshness}", satelliteFreshness)
        .replace("{start}", fallbackEvidence.satellite.windowStart)
        .replace("{end}", fallbackEvidence.satellite.windowEnd)
    : `${satelliteFreshness} · ${fallbackEvidence.satellite.lastPassTime}`;
  const recommendedAction = t(getRecommendedActionKey(incident)) || getRecommendedAction(incident);
  const coverageLabel = getCoverageLabel(fallbackEvidence.coverage, t);
  const citizenNotes = getIncidentNotes(incident);

  return (
    <aside className="incident-detail-panel">
      <div className="command-panel-header">
        <div>
          <p>{t("command_detail_title")}</p>
          <h2>{incident.neighborhood}</h2>
        </div>
        <span className={`detail-severity ${incident.severity}`}>
          {t("severity_" + incident.severity) || incident.severity}
        </span>
      </div>

      <div className="evidence-preview">
        <div 
          className={`evidence-visual ${incident.hazardType}`}
          style={incident.photoUrl ? { backgroundImage: `url(${incident.photoUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' } : undefined}
        >
          {!incident.photoUrl && <span>{t("hazard_" + incident.hazardType)}</span>}
        </div>
        <div className="evidence-meta">
          <span>{t("incident_age").replace("{age}", getIncidentAge(incident.timestamp))}</span>
          <span>{t("incident_nearby_reports").replace("{count}", String(incident.corroboratingReports ?? 0))}</span>
          <span>{t("incident_health_risk").replace("{risk}", t("severity_" + incident.healthRisk.toLowerCase()) || incident.healthRisk)}</span>
        </div>
        {citizenNotes.length > 0 && (
          <div className="evidence-note-action">
            <button onClick={() => setShowNotesModal(true)} type="button">
              {t("command_detail_view_notes").replace("{count}", citizenNotes.length.toString())}
            </button>
          </div>
        )}
      </div>

      <div className="ai-analysis-card">
        <p>{isAutoDetected ? t("command_evidence_fusion") : t("command_detail_evidence_ai")}</p>
        {isAwaitingClassification ? (
          <>
            <h3>{t("command_detail_status_awaiting_class")}</h3>
            <div className="analysis-meter pending">
              <span style={{ width: "18%" }} />
            </div>
            <small>{t("command_detail_unverified_desc2")}</small>
          </>
        ) : (
          <>
            <h3>
              {t("fusion_confidence_label").replace("{confidence}", displayedFusionConfidence.toString())}
            </h3>
            <div className="analysis-meter">
              <span style={{ width: `${displayedFusionConfidence}%` }} />
            </div>
            <small>
              {[
                fallbackEvidence.fusion.visualWeight > 0
                  ? t("fusion_visual_confidence").replace("{confidence}", incident.aiConfidence.toString())
                  : null,
                fallbackEvidence.fusion.sensorWeight > 0
                  ? t("fusion_sensor_weight").replace("{weight}", Math.round(fallbackEvidence.fusion.sensorWeight * 100).toString())
                  : null,
                fallbackEvidence.fusion.satelliteWeight > 0
                  ? t("fusion_satellite_weight").replace("{weight}", Math.round(fallbackEvidence.fusion.satelliteWeight * 100).toString())
                  : null,
                (fallbackEvidence.fusion.corroborationWeight ?? 0) > 0
                  ? t("fusion_citizen_corroboration").replace("{weight}", Math.round((fallbackEvidence.fusion.corroborationWeight ?? 0) * 100).toString())
                  : null,
              ]
                .filter(Boolean)
                .join(" · ") || t("fusion_no_evidence")}
            </small>
          </>
        )}
      </div>

      <div className="evidence-trail-card">
        <p>{t("command_detail_evidence_title")}</p>
        {isAwaitingClassification ? (
          <div className="evidence-awaiting-state">
            <strong>{t("command_detail_status_awaiting_class")}</strong>
            <span>{t("command_detail_unverified_desc1")}</span>
          </div>
        ) : (
          <>
            <div className="evidence-score-row">
              <strong>{coverageLabel}</strong>
              <span>H3 {fallbackEvidence.fusion.h3CellId}</span>
            </div>
            <ul>
              <li>
                <span>{t("command_detail_evidence_citizen")}</span>
                <strong>
                  {t("citizen_window_summary")
                    .replace("{reports}", fallbackEvidence.citizenSignal.reportCount.toString())
                    .replace("{minutes}", fallbackEvidence.citizenSignal.windowMinutes.toString())}
                </strong>
              </li>
              <li>
                <span>{t("command_detail_nearest_station")}</span>
                <strong>{fallbackEvidence.coverage.nearestSensorKm.toFixed(1)} km</strong>
              </li>
              <li>
                <span>{sensorLabel}</span>
                <strong>
                  {sensorReading} · {sensorMeta}
                </strong>
              </li>
              <li>
                <span>{t("command_detail_evidence_satellite")}</span>
                <strong>
                  {satelliteMeta}
                </strong>
              </li>
            </ul>
            <small>{getAlertReasonLabel(isAutoDetected, t)}</small>
          </>
        )}
      </div>

      <div className="recommended-action-card">
        <p>{t("command_detail_recommended_action")}</p>
        <h3>{recommendedAction}</h3>
        <span>
          {t("command_feed_description")}
        </span>
      </div>

      <div className="dispatch-actions">
        <button 
          type="button" 
          className="primary-action" 
          onClick={handleDispatch}
          disabled={isDispatching || incident.dispatchStatus === "dispatched"}
          style={incident.dispatchStatus === "dispatched" ? { background: '#117c72', opacity: 1 } : {}}
        >
          {incident.dispatchStatus === "dispatched" && incident.dispatchedAt 
            ? t("dispatch_dispatched_at").replace("{time}", new Date(incident.dispatchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) 
            : isDispatching ? t("dispatch_dispatching") : recommendedAction}
        </button>
        <button type="button" onClick={() => setShowResolveModal(true)}>{t("command_detail_resolve_button")}</button>
      </div>

      {showResolveModal && (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, backdropFilter: 'blur(4px)' }}>
          <div style={{ background: 'white', padding: '24px', borderRadius: '12px', width: '90%', maxWidth: '400px', boxShadow: '0 24px 60px rgba(16,24,40,0.16)', color: '#172033' }}>
            <h3 style={{ margin: '0 0 8px', fontSize: '1.1rem', fontWeight: 850 }}>{t("command_detail_resolve_confirm_title")}</h3>
            <p style={{ margin: 0, color: '#667085', fontSize: '0.9rem', lineHeight: 1.5 }}>{t("command_detail_resolve_confirm_desc")}</p>
            {resolveError && <p style={{ color: 'red', marginTop: '12px' }}>{resolveError}</p>}
            <div style={{ display: 'flex', gap: '8px', marginTop: '20px' }}>
              <button disabled={isResolving} onClick={() => setShowResolveModal(false)} style={{ flex: 1, padding: '10px', borderRadius: '8px', border: '1px solid #d8e1da', background: 'white', fontWeight: 700, cursor: 'pointer' }}>{t("common_cancel")}</button>
              <button disabled={isResolving} onClick={handleResolve} style={{ flex: 1, padding: '10px', borderRadius: '8px', border: '1px solid #0f172a', background: '#0f172a', color: 'white', fontWeight: 700, cursor: 'pointer' }}>
                {isResolving ? t("resolve_resolving") : t("resolve_confirm")}
              </button>
            </div>
          </div>
        </div>
      )}
      {showNotesModal && (
        <CitizenNotesModal
          incident={incident}
          notes={citizenNotes}
          onClose={() => setShowNotesModal(false)}
          t={t}
        />
      )}
    </aside>
  );
}

function CitizenNotesModal({
  incident,
  notes,
  onClose,
  t,
}: {
  incident: Incident;
  notes: string[];
  onClose: () => void;
  t: Translator;
}) {
  return (
    <div className="citizen-notes-modal-backdrop" role="presentation">
      <div className="citizen-notes-modal" role="dialog" aria-modal="true" aria-labelledby="citizen-notes-title">
        <div className="citizen-notes-header">
          <div>
            <p>{t("command_detail_citizen_notes")}</p>
            <h3 id="citizen-notes-title">{incident.neighborhood}</h3>
          </div>
          <button aria-label={t("common_close")} onClick={onClose} type="button">{"\u00d7"}</button>
        </div>
        <div className="citizen-notes-list">
          {notes.map((note, index) => (
            <article className="citizen-note" key={`${note}-${index}`}>
              <span>{t("command_detail_note_number").replace("{number}", String(index + 1))}</span>
              <p>{note}</p>
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}

function EmptyIncidentDetail({ t }: { t: Translator }) {
  return (
    <aside className="incident-detail-panel">
      <div className="command-panel-header">
        <div>
          <p>{t("command_detail_title")}</p>
          <h2>{t("command_detail_empty")}</h2>
        </div>
      </div>
      <div className="evidence-awaiting-state">
        <strong>{t("command_feed_empty_title")}</strong>
        <span>{t("command_feed_empty_desc")}</span>
      </div>
    </aside>
  );
}

function UnverifiedSignalDetail({ incident, t }: { incident: Incident, t: Translator }) {
  const reports = incident.corroboratingReports ?? 1;
  const [showNotesModal, setShowNotesModal] = useState(false);
  const citizenNotes = getIncidentNotes(incident);
  return (
    <aside className="incident-detail-panel">
      <div className="command-panel-header">
        <div>
          <p>{t("command_detail_unverified_title")}</p>
          <h2>{incident.neighborhood}</h2>
        </div>
        <span className="detail-severity low">{t("status_pending")}</span>
      </div>
      <div className="evidence-awaiting-state">
        <strong>{t("command_detail_status_awaiting_corrob")}</strong>
        <span>
          {(reports === 1 ? t("unverified_signal_detail_single") : t("unverified_signal_detail_plural"))
            .replace("{count}", reports.toString())}
        </span>
      </div>
      {citizenNotes.length > 0 && (
        <div className="evidence-note-action unverified">
          <button onClick={() => setShowNotesModal(true)} type="button">
            {t("command_detail_view_notes").replace("{count}", citizenNotes.length.toString())}
          </button>
        </div>
      )}
      {showNotesModal && (
        <CitizenNotesModal
          incident={incident}
          notes={citizenNotes}
          onClose={() => setShowNotesModal(false)}
          t={t}
        />
      )}
    </aside>
  );
}
