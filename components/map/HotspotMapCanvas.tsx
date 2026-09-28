"use client";

import { useEffect, useRef, useState } from "react";
import maplibregl, { type GeoJSONSource, type Map as MapLibreMap, type Marker, type Popup } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { getAQIInfo } from "@/lib/forecastEngine";
import { useT } from "@/lib/languageContext";
import type { CityConfig } from "@/lib/cities";

// OpenFreeMap: free, keyless vector tiles built from OpenStreetMap
// (OpenMapTiles schema). Building footprints and roads are OSM geometry;
// building heights are OSM `height` / `building:levels` where mapped, and an
// OpenMapTiles default where they are not.
const STYLE_URL = "https://tiles.openfreemap.org/styles/positron";

// The ambient-scan areas are ~1 km centroids (see city.monitoredAreas), so
// they are drawn as a soft ring of that size rather than as a precise pin.
const AREA_RADIUS_M = 800;

function homeView(city: CityConfig) {
  return { center: [city.center.lng, city.center.lat] as [number, number], zoom: city.zoom };
}
const PITCH_3D = 55;
const BEARING_3D = -12;

/** NASA FIRMS active-fire pixel (from /api/fires). */
export type FireMarker = { lat: number; lng: number; brightnessK: number | null };

export type MapPoint = {
  id: string;
  lat: number;
  lng: number;
  title: string;
  /** Marker markup (an inline SVG built by the caller from trusted values). */
  html: string;
  anchor: "bottom" | "center";
  /** Pixels above the coordinate where the pop-up tip sits. */
  popupOffset: number;
  zIndex: number;
  circle: { radiusM: number; color: string; fillOpacity: number; strokeOpacity: number };
};

export type MapSelection = {
  id: string;
  lat: number;
  lng: number;
  /** Pop-up markup; the caller escapes any user-supplied text. */
  html: string;
  popupOffset: number;
};

type Station = {
  name: string;
  lat: number;
  lng: number;
  pm25: number | null;
  pm10: number | null;
  lastUpdated: string | null;
  source: "CPCB" | "WAQI";
  attribution: string | null;
};

type HotspotMapCanvasProps = {
  /** The map is built once per city; the parent remounts it (key) on a city change. */
  city: CityConfig;
  points: MapPoint[];
  fires?: FireMarker[];
  selection: MapSelection | null;
  onSelect: (id: string) => void;
  view: "2d" | "3d";
  /** Public map extras: ground stations, monitored areas, legend and area shortcuts. */
  showContext: boolean;
  popupMaxWidth: number;
  onStatusChange: (status: "ready" | "error") => void;
};

function circlePolygon(lng: number, lat: number, radiusM: number, steps = 48) {
  const dLat = radiusM / 111_320;
  const dLng = radiusM / (111_320 * Math.cos((lat * Math.PI) / 180));
  return Array.from({ length: steps + 1 }, (_, i) => {
    const angle = (i / steps) * Math.PI * 2;
    return [lng + dLng * Math.cos(angle), lat + dLat * Math.sin(angle)];
  });
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

/** MapLibre map shared by the 2D and 3D views: 3D just tilts the camera and raises OSM buildings. */
export default function HotspotMapCanvas({
  city,
  points,
  fires,
  selection,
  onSelect,
  view,
  showContext,
  popupMaxWidth,
  onStatusChange,
}: HotspotMapCanvasProps) {
  const t = useT();
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const popupRef = useRef<Popup | null>(null);
  const markerElements = useRef<Record<string, HTMLElement>>({});
  const pannedIdRef = useRef<string | null>(null);
  const onStatusChangeRef = useRef(onStatusChange);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [stations, setStations] = useState<Station[] | null>(null);
  const [stationsError, setStationsError] = useState(false);

  useEffect(() => {
    onStatusChangeRef.current = onStatusChange;
  }, [onStatusChange]);

  useEffect(() => {
    if (!showContext) return;
    let cancelled = false;
    fetch(`/api/stations?city=${city.id}`)
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
  }, [city.id, showContext]);

  useEffect(() => {
    if (!nodeRef.current) return;
    const pad = 0.15;
    let loaded = false;
    let map: MapLibreMap;
    const fail = () => {
      setFailed(true);
      onStatusChangeRef.current("error");
    };
    try {
      map = new maplibregl.Map({
        container: nodeRef.current,
        style: STYLE_URL,
        ...homeView(city),
        maxPitch: 70,
        minZoom: city.zoom - 2,
        maxBounds: [
          [city.bounds.minLng - pad, city.bounds.minLat - pad],
          [city.bounds.maxLng + pad, city.bounds.maxLat + pad],
        ],
        pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
        canvasContextAttributes: { antialias: true },
        attributionControl: { compact: true },
      });
    } catch {
      // No WebGL on this device.
      queueMicrotask(fail);
      return;
    }
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");
    popupRef.current = new maplibregl.Popup({ maxWidth: `${popupMaxWidth}px` });

    map.on("load", () => {
      const firstLabel = map.getStyle().layers.find((layer) => layer.type === "symbol")?.id;

      // Extruded OSM buildings; only visible in the 3D view.
      map.addLayer(
        {
          id: "buildings-3d",
          type: "fill-extrusion",
          source: "openmaptiles",
          "source-layer": "building",
          minzoom: 13,
          filter: ["!=", ["get", "hide_3d"], true],
          layout: { visibility: "none" },
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

      if (showContext) {
        map.addSource("city-boundary", {
          type: "geojson",
          data: {
            type: "Feature",
            properties: {},
            geometry: {
              type: "MultiPolygon",
              coordinates: city.boundary.map((ring) => [ring.map(([lng, lat]) => [lng, lat])]),
            },
          },
        });
        map.addLayer(
          {
            id: "city-boundary",
            type: "line",
            source: "city-boundary",
            paint: { "line-color": "#2c7d40", "line-width": 1.4, "line-opacity": 0.55, "line-dasharray": [3, 2] },
          },
          firstLabel,
        );

        map.addSource("monitored-areas", {
          type: "geojson",
          data: {
            type: "FeatureCollection",
            features: city.monitoredAreas.map((area) => ({
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
      }

      // Hotspot radius circles, same sizes and colours as the old Google map.
      map.addSource("hotspot-circles", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer(
        {
          id: "hotspot-circles-fill",
          type: "fill",
          source: "hotspot-circles",
          paint: { "fill-color": ["get", "color"], "fill-opacity": ["get", "fillOpacity"] },
        },
        "buildings-3d",
      );
      map.addLayer(
        {
          id: "hotspot-circles-line",
          type: "line",
          source: "hotspot-circles",
          paint: { "line-color": ["get", "color"], "line-opacity": ["get", "strokeOpacity"], "line-width": 1 },
        },
        "buildings-3d",
      );

      // NASA FIRMS fires: non-interactive dots, drawn as a layer so hundreds stay cheap.
      map.addSource("fires", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({
        id: "fires",
        type: "circle",
        source: "fires",
        paint: {
          "circle-radius": 4.5,
          "circle-color": "#e4572e",
          "circle-opacity": 0.85,
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1.5,
        },
      });

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
      onStatusChangeRef.current("ready");
    });
    map.on("error", (event: { error?: Error; sourceId?: string }) => {
      // A single tile failing is recoverable; the style never loading is not.
      if (!loaded && !event.sourceId) fail();
    });

    return () => {
      popupRef.current?.remove();
      map.remove();
      mapRef.current = null;
    };
    // The map is created once; view, popup width and extras are applied by later effects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    popupRef.current?.setMaxWidth(`${popupMaxWidth}px`);
  }, [popupMaxWidth]);

  // 2D and 3D are the same map: tilt the camera and raise the buildings.
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const is3d = view === "3d";
    map.setLayoutProperty("buildings-3d", "visibility", is3d ? "visible" : "none");
    if (map.getLayer("building")) map.setLayoutProperty("building", "visibility", is3d ? "none" : "visible");
    if (is3d) {
      map.dragRotate.enable();
      map.touchZoomRotate.enableRotation();
      map.touchPitch.enable();
    } else {
      map.dragRotate.disable();
      map.touchZoomRotate.disableRotation();
      map.touchPitch.disable();
    }
    map.easeTo({ pitch: is3d ? PITCH_3D : 0, bearing: is3d ? BEARING_3D : 0, duration: 700 });
  }, [ready, view]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    (map.getSource("hotspot-circles") as GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: points.map((point) => ({
        type: "Feature",
        properties: {
          color: point.circle.color,
          fillOpacity: point.circle.fillOpacity,
          strokeOpacity: point.circle.strokeOpacity,
        },
        geometry: { type: "Polygon", coordinates: [circlePolygon(point.lng, point.lat, point.circle.radiusM)] },
      })),
    });
  }, [points, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    (map.getSource("fires") as GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: (fires ?? []).map((fire) => ({
        type: "Feature",
        properties: {},
        geometry: { type: "Point", coordinates: [fire.lng, fire.lat] },
      })),
    });
  }, [fires, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    markerElements.current = {};
    const markers: Marker[] = points.map((point) => {
      const element = document.createElement("button");
      element.type = "button";
      element.className = "hotspot-marker";
      element.title = point.title;
      element.setAttribute("aria-label", point.title);
      element.innerHTML = point.html;
      element.style.zIndex = String(point.zIndex);
      element.addEventListener("click", (event) => {
        event.stopPropagation();
        onSelect(point.id);
      });
      markerElements.current[point.id] = element;
      return new maplibregl.Marker({ element, anchor: point.anchor }).setLngLat([point.lng, point.lat]).addTo(map);
    });
    return () => markers.forEach((marker) => marker.remove());
  }, [onSelect, points, ready]);

  // Open the selected hotspot's pop-up; pan only when the selection itself changes.
  useEffect(() => {
    const map = mapRef.current;
    const popup = popupRef.current;
    if (!ready || !map || !popup) return;
    if (!selection) {
      popup.remove();
      pannedIdRef.current = null;
      return;
    }
    popup
      .setOffset(selection.popupOffset)
      .setLngLat([selection.lng, selection.lat])
      .setHTML(selection.html)
      .addTo(map);
    if (pannedIdRef.current === selection.id) return;
    pannedIdRef.current = selection.id;
    const center: [number, number] = [selection.lng, selection.lat];
    if (map.getPitch() > 0) map.flyTo({ center, zoom: Math.max(map.getZoom(), 15) });
    else map.easeTo({ center });
    const element = markerElements.current[selection.id];
    if (element) {
      element.classList.add("is-bouncing");
      window.setTimeout(() => element.classList.remove("is-bouncing"), 700);
    }
  }, [ready, selection]);

  // Ground stations: a pole rising from the exact published coordinate.
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
          `${station.source === "WAQI" ? `${station.attribution ?? t("map3d_station_source_unknown")} · WAQI` : t("map3d_station_source")}${station.lastUpdated ? ` · ${station.lastUpdated}` : ""}`,
        ];
        pannedIdRef.current = null;
        popupRef.current
          ?.setOffset(48)
          .setLngLat([station.lng, station.lat])
          .setDOMContent(popupContent(station.name, lines))
          .addTo(map);
      });
      // Offset by half the ground dot so its centre sits on the coordinate.
      return new maplibregl.Marker({ element, anchor: "bottom", offset: [0, 3.5] })
        .setLngLat([station.lng, station.lat])
        .addTo(map);
    });
    return () => markers.forEach((marker) => marker.remove());
  }, [ready, stations, t]);

  function flyToArea(lng: number, lat: number) {
    popupRef.current?.remove();
    mapRef.current?.flyTo({
      center: [lng, lat],
      zoom: 15.4,
      ...(view === "3d" ? { pitch: 60, bearing: -20 } : {}),
    });
  }

  function showAllCity() {
    popupRef.current?.remove();
    mapRef.current?.flyTo({
      ...homeView(city),
      ...(view === "3d" ? { pitch: PITCH_3D, bearing: BEARING_3D } : {}),
    });
  }

  const stationStatus = stationsError
    ? t("map3d_stations_unavailable_city").replace("{city}", city.name)
    : stations
      ? t("map3d_stations_count_city").replace("{count}", String(stations.length)).replace("{city}", city.name)
      : t("drawer_loading");

  return (
    <>
      <div className="hotspot-map-root" ref={nodeRef} />
      {showContext && ready && !failed && (
        <>
          <div className="map3d-legend">
            <span><i className="map3d-key is-station" />{t("map3d_legend_ground_station")}</span>
            <span><i className="map3d-key is-signal" />{t("map3d_legend_signal")}</span>
            {city.monitoredAreas.length > 0 && (
              <span><i className="map3d-key is-area" />{t("map3d_legend_area")}</span>
            )}
            <small>{stationStatus}</small>
          </div>
          <div className="map3d-areas" role="group" aria-label={t("map3d_areas_label")}>
            <button type="button" onClick={showAllCity}>{t("map3d_all_city").replace("{city}", city.name)}</button>
            {city.monitoredAreas.map((area) => (
              <button key={area.label} type="button" onClick={() => flyToArea(area.lng, area.lat)}>
                {area.label}
              </button>
            ))}
          </div>
        </>
      )}
    </>
  );
}
