"use client";

import type { Incident, Severity } from "@/lib/types";
import { useEffect, useRef, useState } from "react";
import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import { useCity } from "@/lib/cityContext";
import { useT } from "@/lib/languageContext";

const severityColor: Record<Severity, string> = {
  critical: "#ef4444",
  medium: "#f59e0b",
  low: "#10b981",
};

export default function HotspotPreview({ incidents }: { incidents: Incident[] }) {
  const t = useT();
  const { city } = useCity();
  const mapNodeRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);

  useEffect(() => {
    if (!mapNodeRef.current) return;
    let cancelled = false;
    let map: MapLibreMap | null = null;

    // Loaded on demand so the landing page's first paint doesn't wait on the map library.
    Promise.all([import("maplibre-gl"), import("maplibre-gl/dist/maplibre-gl.css")])
      .then(([{ default: maplibregl }]) => {
        if (cancelled || !mapNodeRef.current) return;
        const created = new maplibregl.Map({
          container: mapNodeRef.current,
          // OpenFreeMap: free, keyless OpenStreetMap vector tiles.
          style: "https://tiles.openfreemap.org/styles/positron",
          center: [city.center.lng, city.center.lat],
          zoom: city.zoom,
          interactive: false,
          attributionControl: { compact: true },
        });
        map = created;
        created.on("load", () => {
          created.addSource("hotspots", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
          created.addLayer({
            id: "hotspots",
            type: "circle",
            source: "hotspots",
            paint: {
              "circle-radius": 7,
              "circle-color": ["get", "color"],
              "circle-opacity": 0.9,
              "circle-stroke-color": "#ffffff",
              "circle-stroke-width": 2,
            },
          });
          mapRef.current = created;
          setMapLoaded(true);
        });
      })
      .catch((err) => console.error("Failed to load the hero preview map", err));

    return () => {
      cancelled = true;
      map?.remove();
      mapRef.current = null;
    };
    // The preview is rebuilt for each city (the parent keys it by city).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!mapLoaded || !mapRef.current) return;
    (mapRef.current.getSource("hotspots") as GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: incidents
        .filter((incident) => Number.isFinite(incident.latitude) && Number.isFinite(incident.longitude))
        .map((incident) => ({
          type: "Feature",
          properties: { color: severityColor[incident.severity] || severityColor.medium },
          geometry: { type: "Point", coordinates: [incident.longitude, incident.latitude] },
        })),
    });
  }, [mapLoaded, incidents]);

  return (
    <aside className="hotspot-panel" aria-label="Live hotspot preview" style={{ display: 'flex', flexDirection: 'column', position: 'relative' }}>
      <div className="map-preview" style={{ flex: 1, position: 'relative', overflow: 'hidden', minHeight: '400px', padding: 0 }}>
        {/* Map container */}
        <div
          ref={mapNodeRef}
          style={{ width: '100%', height: '100%', position: 'absolute', inset: 0, backgroundColor: '#f4f5f1' }}
        />

        {/* Clean floating header */}
        <div style={{ position: 'absolute', top: '16px', left: '16px', zIndex: 10, display: 'flex', alignItems: 'center', gap: '8px', background: 'white', padding: '8px 16px', borderRadius: '24px', boxShadow: '0 4px 12px rgba(0,0,0,0.08)', border: '1px solid rgba(0,0,0,0.05)' }}>
          <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: '#10b981', boxShadow: '0 0 8px rgba(16, 185, 129, 0.4)' }} />
          <span style={{ color: 'var(--ink)', fontSize: '0.85rem', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase' }}>{t("hotspot_preview_recent_reports")}</span>
        </div>
      </div>
    </aside>
  );
}
