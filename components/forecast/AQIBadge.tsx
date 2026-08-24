"use client";

import type { AQIInfo } from "@/lib/forecastEngine";
import { useT } from "@/lib/languageContext";

interface AQIBadgeProps {
  pm25: number;
  aqi: AQIInfo;
  showValue?: boolean;
  size?: "sm" | "md" | "lg";
}

export default function AQIBadge({
  pm25,
  aqi,
  showValue = true,
  size = "md",
}: AQIBadgeProps) {
  const t = useT();
  const sizeClass =
    size === "sm"
      ? "aqi-badge-sm"
      : size === "lg"
      ? "aqi-badge-lg"
      : "aqi-badge-md";

  return (
    <span
      className={`aqi-badge ${sizeClass}`}
      style={{
        background: aqi.bgColor,
        color: aqi.textColor,
        borderColor: aqi.color + "40",
      }}
      title={t(aqi.description)}
    >
      <span
        className="aqi-badge-dot"
        style={{ background: aqi.color }}
      />
      {t(aqi.category)}
      {showValue && (
        <span className="aqi-badge-value">
          {Math.round(pm25)} µg/m³
        </span>
      )}
    </span>
  );
}
