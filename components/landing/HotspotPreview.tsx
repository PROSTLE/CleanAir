"use client";

import type { Incident, Severity } from "@/lib/types";
import { useEffect, useRef, useState } from "react";
import { loadGoogleMaps, type GoogleMapInstance, type GoogleMapMarker } from "@/lib/googleMaps";
import { CITY_CENTER } from "@/lib/mapConstants";
import { useT } from "@/lib/languageContext";

const severityColor: Record<Severity, string> = {
  critical: "#ef4444",
  medium: "#f59e0b",
  low: "#10b981",
};

export default function HotspotPreview({ incidents }: { incidents: Incident[] }) {
  const t = useT();
  const mapNodeRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<GoogleMapInstance | null>(null);
  const markerRefs = useRef<GoogleMapMarker[]>([]);
  const [mapLoaded, setMapLoaded] = useState(false);

  useEffect(() => {
    const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
    if (!apiKey || !mapNodeRef.current) return;

    loadGoogleMaps(apiKey)
      .then(() => {
        if (!mapNodeRef.current) return;
        const maps = window.google!.maps;
        
        const map = new maps.Map(mapNodeRef.current, {
          center: CITY_CENTER,
          zoom: 11,
          disableDefaultUI: true,
          gestureHandling: "none",
          clickableIcons: false,
          styles: [
            { featureType: "poi", stylers: [{ visibility: "off" }] },
            { featureType: "transit", stylers: [{ visibility: "off" }] },
            { featureType: "water", elementType: "geometry", stylers: [{ color: "#e9e9e9" }] },
            { featureType: "landscape", elementType: "geometry", stylers: [{ color: "#f5f5f5" }] },
            { featureType: "road", elementType: "geometry", stylers: [{ color: "#ffffff" }] },
            { featureType: "road", elementType: "labels.text.fill", stylers: [{ color: "#9ca3af" }] },
            { featureType: "road", elementType: "labels.text.stroke", stylers: [{ color: "#ffffff" }] },
            { elementType: "labels.text.fill", stylers: [{ color: "#6b7280" }] },
            { elementType: "labels.text.stroke", stylers: [{ color: "#ffffff", weight: 2 }] },
          ],
        });

        mapRef.current = map;
        setMapLoaded(true);
      })
      .catch((err) => console.error("Failed to load Google Maps for hero preview", err));
  }, []);

  useEffect(() => {
    if (!mapLoaded || !mapRef.current || !window.google?.maps) return;
    const maps = window.google.maps;

    // Clear old markers
    markerRefs.current.forEach(m => m.setMap(null));
    markerRefs.current = [];

    incidents.forEach((incident) => {
      const color = severityColor[incident.severity] || severityColor.medium;
      const marker = new maps.Marker({
        map: mapRef.current,
        position: { lat: incident.latitude, lng: incident.longitude },
        title: incident.neighborhood,
        icon: {
          url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(`
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="9" cy="9" r="7" fill="${color}" fill-opacity="0.9" stroke="white" stroke-width="2"/>
            </svg>
          `)}`,
          scaledSize: new maps.Size(18, 18),
          anchor: new maps.Point(9, 9),
        },
      });
      markerRefs.current.push(marker);
    });
  }, [mapLoaded, incidents]);

  return (
    <aside className="hotspot-panel" aria-label="Live hotspot preview" style={{ display: 'flex', flexDirection: 'column', position: 'relative' }}>
      <div className="map-preview" style={{ flex: 1, position: 'relative', overflow: 'hidden', minHeight: '400px', padding: 0 }}>
        {/* Google Map Container */}
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
