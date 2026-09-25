"use client";

import { useEffect, useState } from "react";
import GoogleHotspotMap, { type FireMarker } from "@/components/map/GoogleHotspotMap";
import { useT } from "@/lib/languageContext";

/** Public hotspot map plus the NASA FIRMS regional fire layer. */
export default function PublicMapView() {
  const t = useT();
  const [fires, setFires] = useState<FireMarker[] | null>(null);
  const [firesError, setFiresError] = useState(false);
  const [showFires, setShowFires] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/fires")
      .then(async (response) => {
        const data = (await response.json()) as { fires?: FireMarker[]; error?: string };
        if (cancelled) return;
        if (!response.ok || data.error) setFiresError(true);
        else setFires(data.fires ?? []);
      })
      .catch(() => {
        if (!cancelled) setFiresError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <GoogleHotspotMap
      fires={showFires && fires ? fires : undefined}
      headerControls={
        <div className="map-layer-bar">
          <label className="svd-toggle">
            <input
              type="checkbox"
              checked={showFires}
              disabled={firesError}
              onChange={(event) => setShowFires(event.target.checked)}
            />
            {t("dash_show_fires")}
          </label>
          <small>
            {firesError
              ? t("map_fires_unavailable_short")
              : fires
                ? t("map_fires_count").replace("{count}", String(fires.length))
                : t("drawer_loading")}
          </small>
        </div>
      }
    />
  );
}
