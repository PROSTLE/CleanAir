"use client";

import { useEffect, useRef, useState } from "react";
import maplibregl, { type Map as MapLibreMap, type Marker, type Popup } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { getAQIInfo } from "@/lib/forecastEngine";
import { useT } from "@/lib/languageContext";
import { CITY_CENTER, MONITORED_CELLS } from "@/lib/mapConstants";
import { DELHI_NCT_BOUNDARY, DELHI_OPERATIONAL_BOUNDS } from "@/lib/operationalRegion";

// OpenFreeMap: free, keyless vector tiles built from OpenStreetMap
// (OpenMapTiles schema). Building footprints and roads are OSM geometry;
// building heights are OSM `height` / `building:levels` where mapped, and an
// OpenMapTiles default where they are not.
const STYLE_URL = "https://tiles.openfreemap.org/styles/positron";

// The ambient-scan areas are ~1 km centroids (see MONITORED_CELLS), so they
// are drawn as a soft ring of that size rather than as a precise pin.
const AREA_RADIUS_M = 800;

const OVERVIEW = {
  center: [CITY_CENTER.lng, CITY_CENTER.lat] as [number, number],
  zoom: 10.6,
  pitch: 45,
  bearing: -12,
};

export type Map3DPoint = {
  id: string;
  lat: number;
  lng: number;
  label: string;
  detail: string;
  color: string;
};

type Station = {
  name: string;
  lat: number;
  lng: number;
  pm25: number | null;
  pm10: number | null;
  lastUpdated: string | null;
};

type Delhi3DMapProps = {
  points: Map3DPoint[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  visible: boolean;
};

function circlePolygon(lng: number, lat: number, radiusM: number, steps = 48) {
  const dLat = radiusM / 111_320;
  const dLng = radiusM / (111_320 * Math.cos((lat * Math.PI) / 180));
  const ring = Array.from({ length: steps + 1 }, (_, i) => {
    const angle = (i / steps) * Math.PI * 2;
    return [lng + dLng * Math.cos(angle), lat + dLat * Math.sin(angle)];
  });
  return ring;
}

function popupContent(title: string, lines: string[]) {
  const root = document.createElement("div");
  root.className = "map3d-popup";
  const heading = document.createElement("strong");
  heading.textContent = title;
  root.appendChild(heading);
  lines.forEach((line) => {
    const row = document.createElement("span");
    row.textContent = line;
    root.appendChild(row);
  });
  return root;
}

/** 3D Delhi view: OSM buildings and roads, CPCB stations, live signals and the monitored areas. */
export default function Delhi3DMap({ points, selectedId, onSelect, visible }: Delhi3DMapProps) {
  const t = useT();
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const popupRef = useRef<Popup | null>(null);
  const flownIdRef = useRef<string | null>(selectedId);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [stations, setStations] = useState<Station[] | null>(null);
  const [stationsError, setStationsError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/stations")
      .then(async (response) => {
        const data = (await response.json()) as { stations?: Station[]; error?: string };
        if (cancelled) return;
        if (!response.ok || data.error) setStationsError(true);
        else setStations(data.stations ?? []);
      })
      .catch(() => {
        if (!cancelled) setStationsError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!nodeRef.current) return;
    const pad = 0.15;
    let loaded = false;
    let map: MapLibreMap;
    try {
      map = new maplibregl.Map({
        container: nodeRef.current,
        style: STYLE_URL,
        ...OVERVIEW,
        maxPitch: 70,
        minZoom: 9,
        maxBounds: [
          [DELHI_OPERATIONAL_BOUNDS.minLng - pad, DELHI_OPERATIONAL_BOUNDS.minLat - pad],
          [DELHI_OPERATIONAL_BOUNDS.maxLng + pad, DELHI_OPERATIONAL_BOUNDS.maxLat + pad],
        ],
        pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
        canvasContextAttributes: { antialias: true },
        attributionControl: { compact: true },
      });
    } catch {
      // No WebGL on this device.
      queueMicrotask(() => setFailed(true));
      return;
    }
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");
    popupRef.current = new maplibregl.Popup({ closeButton: false, maxWidth: "260px" });

    map.on("load", () => {
      const firstLabel = map.getStyle().layers.find((layer) => layer.type === "symbol")?.id;

      // Swap positron's flat footprints for extruded ones.
      if (map.getLayer("building")) map.setLayoutProperty("building", "visibility", "none");
      map.addLayer(
        {
          id: "buildings-3d",
          type: "fill-extrusion",
          source: "openmaptiles",
          "source-layer": "building",
          minzoom: 13,
          filter: ["!=", ["get", "hide_3d"], true],
          paint: {
            "fill-extrusion-color": [
              "interpolate", ["linear"], ["coalesce", ["get", "render_height"], 0],
              0, "#ebe9e1",
              25, "#dedbd0",
              80, "#cdd5cb",
            ],
            "fill-extrusion-height": [
              "interpolate", ["linear"], ["zoom"],
              13, 0,
              14, ["coalesce", ["get", "render_height"], 0],
            ],
            "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
            "fill-extrusion-opacity": 0.92,
          },
        },
        firstLabel,
      );

      map.addSource("delhi-boundary", {
        type: "geojson",
        data: {
          type: "Feature",
          properties: {},
          geometry: { type: "Polygon", coordinates: [DELHI_NCT_BOUNDARY.map(([lng, lat]) => [lng, lat])] },
        },
      });
      map.addLayer(
        {
          id: "delhi-boundary",
          type: "line",
          source: "delhi-boundary",
          paint: { "line-color": "#2c7d40", "line-width": 1.4, "line-opacity": 0.55, "line-dasharray": [3, 2] },
        },
        firstLabel,
      );

      map.addSource("monitored-areas", {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: MONITORED_CELLS.map((area) => ({
            type: "Feature" as const,
            properties: { label: area.label },
            geometry: { type: "Polygon" as const, coordinates: [circlePolygon(area.lng, area.lat, AREA_RADIUS_M)] },
          })),
        },
      });
      map.addLayer(
        {
          id: "monitored-areas-fill",
          type: "fill",
          source: "monitored-areas",
          paint: { "fill-color": "#3fa856", "fill-opacity": 0.07 },
        },
        "buildings-3d",
      );
      map.addLayer(
        {
          id: "monitored-areas-line",
          type: "line",
          source: "monitored-areas",
          paint: { "line-color": "#2c7d40", "line-width": 1.2, "line-opacity": 0.6, "line-dasharray": [2, 2] },
        },
        "buildings-3d",
      );

      map.setSky({
        "sky-color": "#e8efe9",
        "horizon-color": "#f7f8f3",
        "fog-color": "#f7f8f3",
        "sky-horizon-blend": 0.6,
        "horizon-fog-blend": 0.7,
        "fog-ground-blend": 0.75,
      });
      loaded = true;
      setReady(true);
    });
    map.on("error", (event: { error?: Error; sourceId?: string }) => {
      // A single tile failing is recoverable; the style never loading is not.
      if (!loaded && !event.sourceId) setFailed(true);
    });

    return () => {
      popupRef.current?.remove();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // The container is display:none while the 2D map is showing.
  useEffect(() => {
    if (visible) mapRef.current?.resize();
  }, [visible]);

  // CPCB stations: a pole rising from the exact published coordinate.
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !stations) return;
    const markers: Marker[] = stations.map((station) => {
      const element = document.createElement("button");
      element.type = "button";
      element.className = "map3d-station";
      const color = station.pm25 != null ? getAQIInfo(station.pm25).color : "#9aa598";
      element.style.setProperty("--station-color", color);
      element.setAttribute("aria-label", station.name);
      const head = document.createElement("span");
      head.className = "map3d-station-head";
      head.textContent = station.pm25 != null ? String(Math.round(station.pm25)) : "–";
      const stem = document.createElement("span");
      stem.className = "map3d-station-stem";
      element.append(head, stem);
      element.addEventListener("click", (event) => {
        event.stopPropagation();
        const lines = [
          `PM2.5 ${station.pm25 != null ? `${Math.round(station.pm25)} µg/m³` : t("map3d_no_reading")}`,
          `PM10 ${station.pm10 != null ? `${Math.round(station.pm10)} µg/m³` : t("map3d_no_reading")}`,
          `${t("map3d_station_source")}${station.lastUpdated ? ` · ${station.lastUpdated}` : ""}`,
        ];
        popupRef.current?.setOffset(48).setLngLat([station.lng, station.lat]).setDOMContent(popupContent(station.name, lines)).addTo(map);
      });
      // Offset by half the ground dot so its centre sits on the coordinate.
      return new maplibregl.Marker({ element, anchor: "bottom", offset: [0, 3.5] }).setLngLat([station.lng, station.lat]).addTo(map);
    });
    return () => markers.forEach((marker) => marker.remove());
  }, [ready, stations, t]);

  // Live citizen / ambient signals, same colours and positions as the 2D map.
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const markers: Marker[] = points.map((point) => {
      const element = document.createElement("button");
      element.type = "button";
      element.className = "map3d-signal";
      element.style.setProperty("--signal-color", point.color);
      element.setAttribute("aria-label", point.label);
      element.addEventListener("click", (event) => {
        event.stopPropagation();
        onSelect(point.id);
        popupRef.current?.setOffset(14).setLngLat([point.lng, point.lat]).setDOMContent(popupContent(point.label, [point.detail])).addTo(map);
      });
      return new maplibregl.Marker({ element }).setLngLat([point.lng, point.lat]).addTo(map);
    });
    return () => markers.forEach((marker) => marker.remove());
  }, [onSelect, points, ready]);

  // Follow selections made after the 3D view opened (e.g. from the feed list).
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !selectedId || selectedId === flownIdRef.current) return;
    flownIdRef.current = selectedId;
    const point = points.find((candidate) => candidate.id === selectedId);
    if (point) map.flyTo({ center: [point.lng, point.lat], zoom: 16, pitch: 60 });
  }, [points, ready, selectedId]);

  function flyToArea(lng: number, lat: number) {
    popupRef.current?.remove();
    mapRef.current?.flyTo({ center: [lng, lat], zoom: 15.4, pitch: 60, bearing: -20 });
  }

  function showOverview() {
    popupRef.current?.remove();
    mapRef.current?.flyTo(OVERVIEW);
  }

  const stationStatus = stationsError
    ? t("map3d_stations_unavailable")
    : stations
      ? t("map3d_stations_count").replace("{count}", String(stations.length))
      : t("drawer_loading");

  return (
    <div className="map3d" hidden={!visible}>
      <div className="map3d-canvas" ref={nodeRef} />
      {failed ? (
        <div className="google-map-state">
          <strong>{t("map3d_unavailable_title")}</strong>
          <span>{t("map3d_unavailable_desc")}</span>
        </div>
      ) : (
        <>
          <div className="map3d-legend">
            <span><i className="map3d-key is-station" />{t("map3d_legend_station")}</span>
            <span><i className="map3d-key is-signal" />{t("map3d_legend_signal")}</span>
            <span><i className="map3d-key is-area" />{t("map3d_legend_area")}</span>
            <small>{stationStatus}</small>
          </div>
          <div className="map3d-areas" role="group" aria-label={t("map3d_areas_label")}>
            <button type="button" onClick={showOverview}>{t("map3d_all_delhi")}</button>
            {MONITORED_CELLS.map((area) => (
              <button key={area.label} type="button" onClick={() => flyToArea(area.lng, area.lat)}>
                {area.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
