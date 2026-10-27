"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl, { type GeoJSONSource, type Map as MapLibreMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { CITIES } from "@/lib/cities";
import { useT } from "@/lib/languageContext";
import { LEVEL_COLOR, type AdvisoryFeed } from "@/components/federation/federationData";

const STYLE_URL = "https://tiles.openfreemap.org/styles/positron";
const INDIA_BOUNDS: [[number, number], [number, number]] = [
  [68, 7],
  [92, 34],
];

function toGeoJson(feed: AdvisoryFeed | null, cityIds: Set<string>) {
  const features = (feed?.features ?? []).filter((feature) => cityIds.has(feature.properties.cityId));
  return {
    trajectories: {
      type: "FeatureCollection" as const,
      features: features.map((feature) => ({
        type: "Feature" as const,
        geometry: feature.geometry,
        properties: { color: LEVEL_COLOR[feature.properties.level], fires: feature.properties.fireCount },
      })),
    },
    sources: {
      type: "FeatureCollection" as const,
      features: features.map((feature) => ({
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: [feature.properties.source.lng, feature.properties.source.lat] },
        properties: {
          color: LEVEL_COLOR[feature.properties.level],
          fires: feature.properties.fireCount,
          label: feature.properties.source.label,
        },
      })),
    },
  };
}

/** Fire clusters and their estimated smoke trajectories into each receiving city. */
export default function FederationMap({ feed, group }: { feed: AdvisoryFeed | null; group: "india" | "brics" }) {
  const nodeRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const t = useT();
  const cities = useMemo(() => CITIES.filter((city) => city.group === group), [group]);

  useEffect(() => {
    if (!nodeRef.current) return;
    let map: MapLibreMap;
    try {
      map = new maplibregl.Map({
        container: nodeRef.current,
        style: STYLE_URL,
        bounds: INDIA_BOUNDS,
        fitBoundsOptions: { padding: 24 },
        pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
        attributionControl: { compact: true },
      });
    } catch {
      // No WebGL on this device.
      queueMicrotask(() => setFailed(true));
      return;
    }
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
    map.on("load", () => {
      const empty = { type: "FeatureCollection" as const, features: [] };
      map.addSource("trajectories", { type: "geojson", data: empty });
      map.addSource("fire-sources", { type: "geojson", data: empty });
      map.addLayer({
        id: "trajectories",
        type: "line",
        source: "trajectories",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ["get", "color"],
          "line-width": ["interpolate", ["linear"], ["get", "fires"], 3, 1.5, 100, 4],
          "line-opacity": 0.75,
          "line-dasharray": [2, 1.5],
        },
      });
      map.addLayer({
        id: "fire-sources",
        type: "circle",
        source: "fire-sources",
        paint: {
          "circle-color": ["get", "color"],
          "circle-radius": ["interpolate", ["linear"], ["get", "fires"], 3, 5, 100, 14, 400, 22],
          "circle-opacity": 0.35,
          "circle-stroke-color": ["get", "color"],
          "circle-stroke-width": 1.5,
        },
      });
      setReady(true);
    });
    map.on("error", (event) => console.warn("Federation map", event.error?.message));
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const data = toGeoJson(feed, new Set(cities.map((city) => city.id)));
    (map.getSource("trajectories") as GeoJSONSource | undefined)?.setData(data.trajectories);
    (map.getSource("fire-sources") as GeoJSONSource | undefined)?.setData(data.sources);
  }, [feed, ready, cities]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const markers = cities.map((city) => {
      const element = document.createElement("div");
      element.className = "fed-city-marker";
      element.textContent = city.name;
      return new maplibregl.Marker({ element, anchor: "left" }).setLngLat([city.center.lng, city.center.lat]).addTo(map);
    });
    if (group === "india") map.fitBounds(INDIA_BOUNDS, { padding: 24, duration: 0 });
    else {
      const bounds = new maplibregl.LngLatBounds();
      cities.forEach((city) => bounds.extend([city.center.lng, city.center.lat]));
      map.fitBounds(bounds, { padding: 60, duration: 0, maxZoom: 4 });
    }
    return () => markers.forEach((marker) => marker.remove());
  }, [ready, group, cities]);

  if (failed) return <div className="fed-map fed-map-failed">{t("fed_map_unavailable")}</div>;
  return <div className="fed-map" ref={nodeRef} role="img" aria-label={t("fed_map_label")} />;
}
