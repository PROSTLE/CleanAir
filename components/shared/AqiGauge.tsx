"use client";

import type { AqiReading, AqiScale } from "@/lib/aqiScales";
import { AQI_MAX } from "@/lib/indiaAqi";
import { useT } from "@/lib/languageContext";

type AqiGaugeProps = {
  /** India's National AQI or the US EPA AQI, depending on the city. */
  scale: AqiScale;
  /** Null shows the empty dial with `emptyText`; never a made-up value. */
  value: AqiReading | null;
  title: string;
  caption?: string;
  emptyText?: string;
  compact?: boolean;
};

const CX = 100;
const CY = 100;
const R = 78;
const GAP = 1.4; // index units left blank between bands

/** Point on the dial for an index value: 0 at the left end, 500 at the right. */
function point(value: number, radius = R) {
  const angle = Math.PI * (1 - Math.min(Math.max(value, 0), AQI_MAX) / AQI_MAX);
  return { x: CX + radius * Math.cos(angle), y: CY - radius * Math.sin(angle) };
}

function arc(from: number, to: number) {
  const start = point(from);
  const end = point(to);
  return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${R} ${R} 0 0 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
}

/** An AQI on a 0–500 dial, coloured by its scale's six bands. */
export default function AqiGauge({ scale, value, title, caption, emptyText, compact = false }: AqiGaugeProps) {
  const t = useT();
  const category = value ? t(value.info.category) : null;
  const needleDeg = value ? (180 * Math.min(value.aqi, AQI_MAX)) / AQI_MAX : 0;

  return (
    <figure className={`aqi-gauge${compact ? " is-compact" : ""}`}>
      <figcaption className="aqi-gauge-title">{title}</figcaption>
      <div
        className="aqi-gauge-dial"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={AQI_MAX}
        aria-valuenow={value?.aqi}
        aria-valuetext={value ? `${t(scale.labelKey)} ${value.aqi}, ${category}` : emptyText}
      >
        <svg viewBox="0 0 200 112" aria-hidden="true">
          {scale.bands.map((band) => (
            <path
              key={band.from}
              d={arc(band.from + (band.from === 0 ? 0 : GAP / 2), band.to - (band.to === AQI_MAX ? 0 : GAP / 2))}
              stroke={band.info.color}
              strokeWidth={14}
              fill="none"
              opacity={value && value.info.category !== band.info.category ? 0.45 : 1}
            />
          ))}
          {[0, 100, 200, 300, 400, 500].map((tick) => {
            const at = point(tick, R + 14);
            return (
              <text key={tick} x={at.x} y={at.y + 3} className="aqi-gauge-tick" textAnchor="middle">
                {tick}
              </text>
            );
          })}
          {value && (
            <g className="aqi-gauge-needle" style={{ transform: `rotate(${needleDeg}deg)` }}>
              <line x1={CX} y1={CY} x2={CX - R + 12} y2={CY} />
            </g>
          )}
          <circle cx={CX} cy={CY} r={value ? 5 : 3} className="aqi-gauge-pivot" />
        </svg>
      </div>
      {value ? (
        <div className="aqi-gauge-reading">
          <strong style={{ color: value.info.textColor }}>{value.aqi}</strong>
          <span className="aqi-gauge-category">
            <i style={{ background: value.info.color }} aria-hidden="true" />
            {category}
          </span>
          <small>
            {t(scale.labelKey)} · {t("aqi_gauge_led_by").replace("{pollutant}", value.dominant)}
          </small>
        </div>
      ) : (
        <p className="aqi-gauge-empty">{emptyText ?? t("aqi_gauge_no_live")}</p>
      )}
      {caption && <p className="aqi-gauge-caption">{caption}</p>}
    </figure>
  );
}
