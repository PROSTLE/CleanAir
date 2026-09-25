"use client";

import type { AQIInfo } from "@/lib/forecastEngine";
import { useT } from "@/lib/languageContext";

interface AQIBadgeProps {
  pm25: number;
  aqi: AQIInfo;
  showValue?: boolean;
}

/** AQI category as a colour swatch + label: the colour carries the band, the text stays ink. */
export default function AQIBadge({ pm25, aqi, showValue = true }: AQIBadgeProps) {
  const t = useT();
  return (
    <span className="vs-aqi" title={t(aqi.description)}>
      <span className="vs-aqi-swatch" style={{ background: aqi.color }} aria-hidden="true" />
      {t(aqi.category)}
      {showValue && <span className="vs-aqi-value">{Math.round(pm25)} µg/m³</span>}
    </span>
  );
}
