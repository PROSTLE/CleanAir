"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { collection, limit, onSnapshot, orderBy, query } from "firebase/firestore";
import { formatStatus } from "@/components/command/commandData";
import { latLngToCell } from "h3-js";
import { CITY_CENTER } from "@/lib/mapConstants";
import { db, isFirebaseConfigured } from "@/lib/firebase";
import {
  hasPollutionSignal,
  reportToIncident,
  type FirestoreReport,
} from "@/lib/firestoreReports";
import {
  loadGoogleMaps,
  type GoogleMapCircle,
  type GoogleMapInfoWindow,
  type GoogleMapInstance,
  type GoogleMapMarker,
  type GoogleMapsApi,
} from "@/lib/googleMaps";
import type { Incident, PromotionTier, Severity } from "@/lib/types";
import { useT } from "@/lib/languageContext";

declare global {
  interface Window {
    google?: GoogleMapsApi;
    cleanAirGoogleMapsPromises?: Partial<Record<string, Promise<void>>>;
  }
}

const severityColor: Record<Severity, string> = {
  critical: "#ef4444",
  medium: "#f59e0b",
  low: "#10b981",
};

const severityRadius: Record<Severity, number> = {
  critical: 600,
  medium: 500,
  low: 450,
};

const COMPACT_MAP_QUERY = "(max-width: 520px)";

function subscribeToCompactMapViewport(onStoreChange: () => void) {
  const mediaQuery = window.matchMedia(COMPACT_MAP_QUERY);
  mediaQuery.addEventListener("change", onStoreChange);
  return () => mediaQuery.removeEventListener("change", onStoreChange);
}

function getCompactMapViewportSnapshot() {
  return window.matchMedia(COMPACT_MAP_QUERY).matches;
}

function getServerCompactMapViewportSnapshot() {
  return false;
}

type GoogleHotspotMapProps = {
  incidents?: Incident[];
  mode?: "public" | "operations";
  onIncidentSelect?: (incidentId: string) => void;
  selectedIncidentId?: string | null;
  showHeader?: boolean;
  showSidebar?: boolean;
};

const mapStyles = [
  {
    featureType: "poi",
    stylers: [{ visibility: "off" }],
  },
  {
    featureType: "transit",
    stylers: [{ visibility: "off" }],
  },
  {
    featureType: "road",
    elementType: "geometry",
    stylers: [{ color: "#d8e1da" }],
  },
  {
    featureType: "water",
    elementType: "geometry",
    stylers: [{ color: "#d9ece7" }],
  },
  {
    featureType: "landscape",
    elementType: "geometry",
    stylers: [{ color: "#eef4f1" }],
  },
];

interface MapCluster {
  id: string;
  h3CellId: string;
  latitude: number;
  longitude: number;
  incidents: Incident[];
  promotedIncident?: Incident;
}

// Maps each promotion tier to the physical source(s) that earned it.
// This mirrors TIER_LABELS in lib/supportEvidence.ts and must stay in sync
// with it — the tier itself is the single source of truth for what
// corroborated an incident, decided at promotion time in
// lib/supportEvidence.ts / lib/reportSubmissions.ts / lib/ambientScan.ts.
const TIER_SOURCES: Record<PromotionTier, string[]> = {
  sensor_satellite_confirmed: ["sensor", "satellite"],
  crowd_verified: ["citizen"],
  citizen_sensor_confirmed: ["citizen", "sensor"],
  citizen_satellite_confirmed: ["citizen", "satellite"],
  sensor_detected: ["sensor"],
  satellite_detected: ["satellite"],
};

function getEvidenceSourceSummary(incident: Incident) {
  const tier = incident.evidence?.tier;
  const sources = tier && TIER_SOURCES[tier] ? [...TIER_SOURCES[tier]] : [incident.source];

  return {
    count: sources.length,
    label: sources.join(" + "),
  };
}

function getEvidenceSourceLabel(incident: Incident, t: (key: string) => string) {
  const tier = incident.evidence?.tier;
  const sources = tier && TIER_SOURCES[tier] ? [...TIER_SOURCES[tier]] : [incident.source];
  return sources.map((source) => t(`evidence_source_${source}`) || source).join(" + ");
}

function getAmbientSourceLabel(source: string, t: (key: string) => string) {
  const keyBySource: Record<string, string> = {
    dust: "hazard_auto_dust",
    industrial: "hazard_auto_industrial",
    particulate: "hazard_auto_particulate",
    smog: "hazard_auto_smog",
    fire: "hazard_auto_fire",
  };
  const key = keyBySource[source];
  return key ? t(key) : source;
}

const hazardColor: Record<string, string> = {
  fire: "#ef4444", // Red
  smog: "#3b82f6", // Blue
  dust: "#f59e0b", // Orange
  industrial: "#a855f7", // Purple
  particulate: "#eab308", // Amber — visually distinct from all 4 confirmed types
};

function markerIcon(cluster: MapCluster, mode: "public" | "operations") {
  const isPromoted = !!cluster.promotedIncident;
  const primaryIncident = cluster.promotedIncident ?? cluster.incidents[0];
  const isPending = primaryIncident.status === "pending" || primaryIncident.status === "classification_failed";
  const evidenceSummary = getEvidenceSourceSummary(primaryIncident);
  
  if ((!isPromoted || isPending) && mode === "operations") {
    const hasMultiple = cluster.incidents.length > 1;
    const r = hasMultiple ? 14 : 8;
    const size = hasMultiple ? 28 : 16;
    return {
      url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(`
        <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="${size/2}" cy="${size/2}" r="${r - 1}" fill="#94a3b8" stroke="#475569" stroke-width="1.5" stroke-dasharray="2 2" fill-opacity="0.3"/>
          ${hasMultiple ? `<text x="${size/2}" y="${size/2 + 3.5}" text-anchor="middle" font-family="Arial, sans-serif" font-size="10" font-weight="800" fill="#334155">${cluster.incidents.length}</text>` : `<circle cx="${size/2}" cy="${size/2}" r="3" fill="#64748b"/>`}
        </svg>
      `)}`,
      scaledSize: new window.google!.maps.Size(size, size),
      anchor: new window.google!.maps.Point(size/2, size/2),
    };
  }

  const color = mode === "public" ? (hazardColor[primaryIncident.hazardType] || severityColor[primaryIncident.severity]) : severityColor[primaryIncident.severity];

  let label = "";
  if (primaryIncident.linkedReportIds) {
    label = String(primaryIncident.linkedReportIds.length);
  } else if (!isPromoted && mode === "public") {
    label = String(cluster.incidents.length);
  } else if (mode === "operations") {
    label = String(evidenceSummary.count);
  } else if (primaryIncident.severity === "critical") {
    label = "!";
  } else if (primaryIncident.severity === "medium") {
    label = "•";
  }

  return {
    url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(`
      <svg width="38" height="46" viewBox="0 0 38 46" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M19 45C19 45 35 29.8 35 17.8C35 8.5 27.8 1 19 1C10.2 1 3 8.5 3 17.8C3 29.8 19 45 19 45Z" fill="${color}" stroke="white" stroke-width="3" />
        <circle cx="19" cy="18" r="8" fill="white" fill-opacity="0.96"/>
        <text x="19" y="22" text-anchor="middle" font-family="Arial, sans-serif" font-size="14" font-weight="800" fill="${color}">${label}</text>
      </svg>
    `)}`,
    scaledSize: new window.google!.maps.Size(38, 46),
    anchor: new window.google!.maps.Point(19, 45),
  };
}

export default function GoogleHotspotMap({
  incidents: controlledIncidents,
  mode = "public",
  onIncidentSelect,
  selectedIncidentId: controlledSelectedIncidentId,
  showHeader = true,
  showSidebar = true,
}: GoogleHotspotMapProps = {}) {
  const t = useT();
  const isCompactMapViewport = useSyncExternalStore(
    subscribeToCompactMapViewport,
    getCompactMapViewportSnapshot,
    getServerCompactMapViewportSnapshot,
  );
  const mapNodeRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<GoogleMapInstance | null>(null);
  const markerRefs = useRef<Record<string, GoogleMapMarker>>({});
  const circleRefs = useRef<GoogleMapCircle[]>([]);
  const infoWindowRef = useRef<GoogleMapInfoWindow | null>(null);
  const [liveReports, setLiveReports] = useState<Incident[]>([]);
  const [selectedIdInternal, setSelectedIdInternal] = useState<string | null>(null);
  const hasApiKey = Boolean(process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">(
    hasApiKey ? "loading" : "error",
  );
  const isControlled = controlledIncidents !== undefined;

  useEffect(() => {
    if (isControlled) return;
    if (!isFirebaseConfigured || !db) return;

    const reportsQuery = query(
      collection(db, "reports"),
      orderBy("createdAt", "desc"),
      limit(20),
    );

    return onSnapshot(reportsQuery, (snapshot) => {
      setLiveReports(
        snapshot.docs
          .map((reportDoc) => ({
            data: reportDoc.data() as FirestoreReport,
            id: reportDoc.id,
          }))
          .filter((report) => hasPollutionSignal(report.data))
          .map((report) => reportToIncident(report.id, report.data)),
      );
    });
  }, [isControlled]);

  const incidents = useMemo(
    () => {
      if (controlledIncidents) return controlledIncidents;
      return liveReports;
    },
    [controlledIncidents, liveReports],
  );

  const clusters = useMemo(() => {
    // Pass 1 — group incidents by h3CellId + hazardType, record base coords
    const groupMap = new Map<string, MapCluster & { baseLat: number; baseLng: number }>();
    const cellGroups = new Map<string, string[]>(); // h3CellId → [groupId, ...]

    incidents.forEach((incident) => {
      const h3CellId = incident.h3CellId ?? latLngToCell(incident.latitude, incident.longitude, 8);
      // Ambient incidents (sensor/satellite-only, no citizen reports) are now
      // written as one doc per cell with ID "ambient-{h3}" — group them by
      // h3CellId alone so they never split into multiple markers. Citizen
      // incidents still group by h3+hazardType to keep fire/smog/dust/industrial
      // visually distinct when they co-exist in the same cell.
      const isAmbient = incident.id.startsWith("firestore-ambient-") && !incident.possibleSources?.length
        ? false // old-style ambient-h3-hazardType docs: still dedupe by hazard until they age out
        : (incident.source !== "citizen" && (incident.evidence?.citizenSignal?.reportCount ?? 0) === 0);
      const groupId = isAmbient ? h3CellId : `${h3CellId}-${incident.hazardType}`;

      if (!groupMap.has(groupId)) {
        groupMap.set(groupId, {
          id: groupId,
          h3CellId,
          baseLat: incident.latitude,
          baseLng: incident.longitude,
          latitude: incident.latitude,
          longitude: incident.longitude,
          incidents: [],
        });
        const cell = cellGroups.get(h3CellId) ?? [];
        cell.push(groupId);
        cellGroups.set(h3CellId, cell);
      }

      const cluster = groupMap.get(groupId)!;
      cluster.incidents.push(incident);
      if (incident.linkedReportIds || incident.evidence?.alertTier) {
        cluster.promotedIncident = incident;
      }
    });

    // Pass 2 — spread clusters that share the same cell symmetrically around the base point
    const SPREAD_RADIUS = 0.0003; // ~33 m — subtle shift visible only when zoomed in
    cellGroups.forEach((groupIds) => {
      const total = groupIds.length;
      if (total <= 1) return; // single cluster: no jitter needed
      groupIds.forEach((groupId, i) => {
        const cluster = groupMap.get(groupId)!;
        const angle = (i * Math.PI * 2) / total - Math.PI / 2; // start from top
        cluster.latitude = cluster.baseLat + Math.cos(angle) * SPREAD_RADIUS;
        cluster.longitude = cluster.baseLng + Math.sin(angle) * SPREAD_RADIUS;
      });
    });

    return Array.from(groupMap.values());
  }, [incidents]);

  const selectedId = controlledSelectedIncidentId ?? selectedIdInternal;

  const selectedIncident = useMemo(
    () => {
      const selected = incidents.find((incident) => incident.id === selectedId);
      if (isControlled) return selected ?? null;
      const newestLiveIncident = isCompactMapViewport ? null : liveReports[0];
      return selected ?? newestLiveIncident ?? null;
    },
    [incidents, isCompactMapViewport, isControlled, liveReports, selectedId],
  );
  const selectedIncidentId = selectedIncident?.id ?? null;

  const selectIncident = useCallback((incidentId: string) => {
    onIncidentSelect?.(incidentId);
    if (!isControlled) setSelectedIdInternal(incidentId);
  }, [isControlled, onIncidentSelect]);

  useEffect(() => {
    const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
      return;
    }

    let cancelled = false;

    loadGoogleMaps(apiKey)
      .then(() => {
        if (cancelled || !mapNodeRef.current) return;

        const maps = window.google!.maps;
        const map = new maps.Map(mapNodeRef.current, {
          center: CITY_CENTER,
          clickableIcons: false,
          controlSize: 28,
          disableDefaultUI: true,
          fullscreenControl: mode === "public",
          mapTypeControl: mode === "public" && !isCompactMapViewport,
          mapTypeControlOptions: {
            position: maps.ControlPosition.TOP_RIGHT,
          },
          streetViewControl: false,
          styles: mapStyles,
          zoom: 10,
          zoomControl: true,
          zoomControlOptions: {
            position: maps.ControlPosition.RIGHT_BOTTOM,
          },
        });

        mapRef.current = map;
        infoWindowRef.current = new maps.InfoWindow({
          maxWidth: isCompactMapViewport ? 248 : 360,
        });
        window.setTimeout(() => {
          if (!cancelled) {
            maps.event.trigger(map, "resize");
            map.setCenter?.(CITY_CENTER);
          }
        }, 0);

        setStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });

    return () => {
      cancelled = true;
    };
  }, [isCompactMapViewport, mode]);

  useEffect(() => {
    if (status !== "ready" || !mapNodeRef.current || !mapRef.current || !window.google?.maps) {
      return;
    }

    const mapNode = mapNodeRef.current;
    const map = mapRef.current;
    const resizeMap = () => {
      window.google?.maps.event.trigger(map, "resize");
      if (selectedIncident) {
        map.setCenter?.({
          lat: selectedIncident.latitude,
          lng: selectedIncident.longitude,
        });
      } else {
        map.setCenter?.(CITY_CENTER);
      }
    };

    resizeMap();
    const observer = new ResizeObserver(resizeMap);
    observer.observe(mapNode);
    window.addEventListener("resize", resizeMap);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", resizeMap);
    };
  }, [selectedIncident, status]);

  useEffect(() => {
    if (status !== "ready" || !mapRef.current || !window.google?.maps) return;

    Object.values(markerRefs.current).forEach((marker) => marker.setMap(null));
    circleRefs.current.forEach((circle) => circle.setMap(null));
    markerRefs.current = {};
    circleRefs.current = [];

    const maps = window.google.maps;
    clusters.forEach((cluster) => {
      const primaryIncident = cluster.promotedIncident ?? cluster.incidents[0];
      const position = { lat: cluster.latitude, lng: cluster.longitude };
      
      // Calculate display status for circles
      const isPending = primaryIncident.status === "pending" || primaryIncident.status === "classification_failed";
      const isPromoted = !!cluster.promotedIncident;
      
      const clusterIndex = clusters.indexOf(cluster);
      const marker = new maps.Marker({
        map: mapRef.current,
        position,
        title: `${primaryIncident.neighborhood} — ${primaryIncident.hazardType}`,
        icon: markerIcon(cluster, mode),
        zIndex: 10 + clusterIndex,
      });

      const circleColor = mode === "public"
        ? (hazardColor[primaryIncident.hazardType] ?? severityColor[primaryIncident.severity])
        : (!isPromoted || isPending ? "#667085" : severityColor[primaryIncident.severity]);

      const circle = new maps.Circle({
        center: position,
        fillColor: circleColor,
        fillOpacity: primaryIncident.evidence?.alertTier ? 0.16 : 0.06,
        map: mapRef.current,
        radius: primaryIncident.evidence?.alertTier ? severityRadius[primaryIncident.severity] : 450,
        strokeColor: circleColor,
        strokeOpacity: primaryIncident.evidence?.alertTier ? 0.42 : 0.22,
        strokeWeight: 1,
      });

      marker.addListener("click", () => {
        // If there's a promoted incident, select that. Otherwise just select the first one in the cluster.
        selectIncident(primaryIncident.id);
      });
      
      // Map all incidents in this cluster to the same marker so we can focus them when selected
      cluster.incidents.forEach((incident) => {
        markerRefs.current[incident.id] = marker;
      });
      circleRefs.current.push(circle);
    });
  }, [clusters, mode, selectIncident, status]);

  useEffect(() => {
    if (!selectedIncident || !mapRef.current || !window.google?.maps) return;

    const marker = markerRefs.current[selectedIncident.id];
    const position = {
      lat: selectedIncident.latitude,
      lng: selectedIncident.longitude,
    };

    mapRef.current.panTo(position);
    marker?.setAnimation(window.google.maps.Animation.BOUNCE);
    window.setTimeout(() => marker?.setAnimation(null), 700);

    // Find which cluster this incident belongs to so we can display cluster counts in the info window
    const h3CellId = selectedIncident.h3CellId ?? latLngToCell(selectedIncident.latitude, selectedIncident.longitude, 8);
    const isAmbient = selectedIncident.source !== "citizen" && (selectedIncident.evidence?.citizenSignal?.reportCount ?? 0) === 0;
    const groupId = isAmbient ? h3CellId : `${h3CellId}-${selectedIncident.hazardType}`;
    const cluster = clusters.find((c) => c.id === groupId);
    
    const reportCount = cluster?.promotedIncident?.linkedReportIds?.length ?? cluster?.incidents.length ?? 1;
    const isPromoted = !!cluster?.promotedIncident;
    const evidenceSummary = getEvidenceSourceSummary(selectedIncident);
    const evidenceSourceLabel = getEvidenceSourceLabel(selectedIncident, t);

    // Build the sensor trigger line for ambient/sensor-only incidents.
    // New docs use triggerPollutants; elevatedPollutants is raw legacy context.
    function buildAmbientInfoWindow(incident: Incident): string {
      const headline = incident.neighborhood;
      const pollutantLine = (() => {
        if (incident.triggerPollutants) {
          const parts = incident.triggerPollutants.map((pollutant) => {
            const value =
              pollutant.value !== null ? ` ${Math.round(pollutant.value)} µg/m³` : "";
            const delta =
              pollutant.deltaPct > 0 ? ` (+${Math.round(pollutant.deltaPct)}%)` : "";
            return `${pollutant.name}${value}${delta}`;
          });
          return parts.length > 0 ? `${t("map_trigger")}: ${parts.join(" &middot; ")}` : "";
        }

        const ep = incident.elevatedPollutants;
        const parts: string[] = [];
        if (ep?.pm25 != null && ep.pm25 > 0) parts.push(`PM2.5 ${Math.round(ep.pm25)} µg/m³`);
        if (ep?.pm10 != null && ep.pm10 > 0) parts.push(`PM10 ${Math.round(ep.pm10)} µg/m³`);
        if (ep?.no2 != null && ep.no2 > 0) parts.push(`NO2 ${Math.round(ep.no2)} µg/m³`);
        if (ep?.so2 != null && ep.so2 > 0) parts.push(`SO2 ${Math.round(ep.so2)} µg/m³`);
        return parts.length > 0 ? `${t("map_observed")}: ${parts.join(" &middot; ")}` : "";
      })();

      const sourceLine = (() => {
        const src = incident.possibleSources ?? [];
        if (src.length === 0) return "";
        return `${t("map_possible_sources")}: ${src.map((s) => getAmbientSourceLabel(s, t)).join(" &middot; ")}`;
      })();

      const tierLine = evidenceSummary.count === 1
        ? t("map_evidence_source_single")
        : t("map_evidence_sources").replace("{count}", evidenceSummary.count.toString());

      return `
        <div class="google-map-infowindow ambient-infowindow">
          <strong>${headline}</strong>
          ${pollutantLine ? `<span class="infowindow-pollutants">${pollutantLine}</span>` : ""}
          ${sourceLine ? `<span class="infowindow-sources">${sourceLine}</span>` : ""}
          ${mode === "operations" ? `<span class="infowindow-tier">${tierLine} &middot; ${evidenceSourceLabel}</span>` : ""}
        </div>
      `;
    }
    
    let content = "";
    if (!isPromoted && mode === "operations") {
      content = `
        <div class="google-map-infowindow unverified-tooltip" style="padding: 4px; text-align: center;">
          <strong style="display: block; margin-bottom: 4px;">${selectedIncident.neighborhood}</strong>
          <span style="color: #64748b; font-size: 13px;">${reportCount === 1 ? t("map_citizen_report_single") : t("map_citizen_reports").replace("{count}", reportCount.toString())} · ${t("map_awaiting_corroboration")}</span>
        </div>
      `;
    } else if (!isPromoted && mode !== "operations") {
      content = `
        <div class="google-map-infowindow" style="padding: 4px;">
          <strong style="display: block; margin-bottom: 4px;">${selectedIncident.neighborhood}</strong>
          <span style="color: #64748b; font-size: 13px;">${t("hazard_" + selectedIncident.hazardType) || selectedIncident.hazardType} · ${reportCount} ${t("map_reported")}</span>
        </div>
      `;
    } else if (isAmbient && selectedIncident.possibleSources) {
      // Ambient sensor/satellite-only incidents get the rich pollutant+source breakdown.
      content = buildAmbientInfoWindow(selectedIncident);
    } else {
      content = `
        <div class="google-map-infowindow">
          <strong>${selectedIncident.neighborhood}</strong>
          <span>${t("hazard_" + selectedIncident.hazardType) || selectedIncident.hazardType} · ${selectedIncident.aiConfidence}% ${t("map_confidence")}</span>
          ${reportCount > 1 ? `<span>${t("map_citizen_reports").replace("{count}", reportCount.toString())}</span>` : ""}
          ${mode === "operations" ? `<span>${evidenceSummary.count === 1 ? t("map_evidence_source_single") : t("map_evidence_sources").replace("{count}", evidenceSummary.count.toString())} · ${evidenceSourceLabel}</span>` : ""}
        </div>
      `;
    }
    
    infoWindowRef.current?.setContent(content);
    infoWindowRef.current?.open({
      anchor: marker,
      map: mapRef.current,
    });
  }, [clusters, mode, selectedIncident, t]);

  return (
    <section className={mode === "operations" ? "operations-map-layout" : "public-map-layout"}>
      {showHeader && (
        <div className="public-map-header">
          <div>
            <p className="eyebrow">{t("map_eyebrow")}</p>
            <h1>{t("map_title")}</h1>
            <p>
              {t("map_description")}
            </p>
          </div>
          <div className="map-status-card">
            <span>{incidents.length} {t("map_layer_visible")}</span>
            <strong>{t("map_layer_label")}</strong>
          </div>
        </div>
      )}

      <div
        className={
          showSidebar
            ? "public-map-shell"
            : "public-map-shell operations-map-shell"
        }
      >
        <div className="google-map-panel">
          <div className="google-map-canvas" ref={mapNodeRef} />
          {status !== "ready" && (
            <div className="google-map-state">
              <strong>
                {status === "error" ? "Map unavailable" : "Loading Google Maps"}
              </strong>
              <span>
                {status === "error"
                  ? "Check the Maps JavaScript API key and browser restrictions."
                  : "Plotting Delhi hotspot markers."}
              </span>
            </div>
          )}
        </div>

        {showSidebar && (
          <aside className="public-map-sidebar">
            <div className="map-sidebar-header">
              <p>{t("map_feed_title")}</p>
              <span>{t("map_feed_live")}</span>
            </div>
            <div className="map-incident-list">
              {clusters.length === 0 ? (
                <div className="incident-empty-state compact">
                  <strong>{t("map_feed_empty_title")}</strong>
                  <span>{t("map_feed_empty_desc")}</span>
                </div>
              ) : clusters.map((cluster) => {
                const primaryIncident = cluster.promotedIncident ?? cluster.incidents[0];
                const reportCount = cluster.promotedIncident?.linkedReportIds?.length ?? cluster.incidents.length ?? 1;
                const isSelected = cluster.incidents.some((incident) => incident.id === selectedIncidentId);
                
                return (
                  <button
                    className={
                      isSelected
                        ? `map-incident-card selected`
                        : `map-incident-card`
                    }
                    key={cluster.id}
                    onClick={() => selectIncident(primaryIncident.id)}
                    type="button"
                  >
                    <span className={`severity-dot ${primaryIncident.severity}`} />
                    <span>
                      <strong>
                        {primaryIncident.neighborhood}
                      </strong>
                      <small>
                        {reportCount > 1 ? `${reportCount === 1 ? t("map_report_count_single").replace("{count}", "1") : t("map_reports_count").replace("{count}", reportCount.toString())} · ` : ""}
                        {t("hazard_" + primaryIncident.hazardType) || primaryIncident.hazardType} · {t("status_" + primaryIncident.status) || formatStatus(primaryIncident.status)} ·{" "}
                        {primaryIncident.evidence?.alertTier ? t("map_alert_tier") : t("map_public_signal")}
                      </small>
                    </span>
                  </button>
                );
              })}
            </div>
          </aside>
        )}
      </div>
    </section>
  );
}
