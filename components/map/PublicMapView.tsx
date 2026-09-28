"use client";

import { useEffect, useState } from "react";
import HotspotMap, { type FireMarker } from "@/components/map/HotspotMap";
import { useCity } from "@/lib/cityContext";
import { useT } from "@/lib/languageContext";

/** Public hotspot map plus the NASA FIRMS regional fire layer. */
export default function PublicMapView() {
  const t = useT();
  const { city, ready } = useCity();
  // Tagged with the city it was fetched for, so switching cities never shows stale fires.
  const [feed, setFeed] = useState<{ cityId: string; fires: FireMarker[] | null; error: boolean } | null>(null);
  const [showFires, setShowFires] = useState(true);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    fetch(`/api/fires?city=${city.id}`)
      .then(async (response) => {
        const data = (await response.json()) as { fires?: FireMarker[]; error?: string };
        if (cancelled) return;
        const failed = !response.ok || Boolean(data.error);
        setFeed({ cityId: city.id, fires: failed ? null : (data.fires ?? []), error: failed });
      })
      .catch(() => {
        if (!cancelled) setFeed({ cityId: city.id, fires: null, error: true });
      });
    return () => {
      cancelled = true;
    };
  }, [city.id, ready]);

  const current = feed?.cityId === city.id ? feed : null;
  const fires = current?.fires ?? null;
  const firesError = current?.error ?? false;

  return (
    <HotspotMap
      enable3d
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
