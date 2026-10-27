"use client";

import Icon from "@/components/shared/Icon";
import { useT } from "@/lib/languageContext";
import type { CorridorsResult } from "@/lib/server/corridors";

/** Response of GET /api/federation/v1/corridors. */
export type CorridorFeed = CorridorsResult & { method: string };

const NAAQS_PM25 = 60;
const LEVEL_KEY: Record<string, string> = {
  good: "corr_level_good",
  satisfactory: "corr_level_satisfactory",
  moderate: "corr_level_moderate",
  poor: "corr_level_poor",
  very_poor: "corr_level_very_poor",
  severe: "corr_level_severe",
};

function formatHour(computedAt: string, offsetHours: number) {
  const start = Math.floor(Date.parse(computedAt) / 3_600_000) * 3_600_000;
  return new Intl.DateTimeFormat("en-IN", {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Kolkata",
  }).format(new Date(start + offsetHours * 3_600_000));
}

/** 48-h PM2.5 curve with the national 24-h limit as a dashed line. */
function Sparkline({ values, color }: { values: number[]; color: string }) {
  const width = 120;
  const height = 30;
  const max = Math.max(NAAQS_PM25 * 1.4, ...values);
  const x = (i: number) => (i / Math.max(values.length - 1, 1)) * width;
  const y = (value: number) => height - (value / max) * (height - 2) - 1;
  const points = values.map((value, i) => `${x(i).toFixed(1)},${y(value).toFixed(1)}`).join(" ");
  return (
    <svg className="corr-spark" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <line x1="0" x2={width} y1={y(NAAQS_PM25)} y2={y(NAAQS_PM25)} className="corr-spark-limit" />
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export default function CorridorSection({ feed, error }: { feed: CorridorFeed | null; error: string }) {
  const t = useT();
  return (
    <section className="svd-card svd-card-full corr">
      <header className="svd-card-head">
        <h2 className="vs-title">
          <Icon name="chart" size={17} />
          {t("corr_title")}
        </h2>
        <p>{t("corr_detail")}</p>
      </header>
      {!feed ? (
        <p className="svd-empty">{error ? t("corr_unavailable") : t("corr_loading")}</p>
      ) : feed.error ? (
        <p className="svd-empty">{t("corr_unavailable")}</p>
      ) : (
        <div className="corr-list">
          {feed.corridors.map((corridor) => (
            <article className="corr-corridor" key={corridor.id}>
              <header className="corr-head">
                <div>
                  <h3>{corridor.name}</h3>
                  <p>{corridor.description}</p>
                </div>
                {corridor.worst && (
                  <p className="corr-summary">
                    {t("corr_worst")
                      .replace("{name}", corridor.worst.name)
                      .replace("{value}", String(corridor.worst.peak24hMean))}
                    <span>
                      {t("corr_counts")
                        .replace("{hotspots}", String(corridor.hotspots))
                        .replace("{spikes}", String(corridor.spikes))}
                    </span>
                  </p>
                )}
              </header>
              <ol className="corr-strip">
                {corridor.waypoints.map((waypoint) => {
                  const outlook = waypoint.outlook;
                  return (
                    <li className="corr-node" key={waypoint.id} style={{ borderTopColor: outlook?.color ?? "var(--sv-line)" }}>
                      <div className="corr-node-name">
                        <strong>{waypoint.name}</strong>
                        <span>{waypoint.state}</span>
                      </div>
                      {!outlook ? (
                        <p className="corr-node-empty">{t("corr_no_forecast")}</p>
                      ) : (
                        <>
                          <p className="corr-node-value">
                            <strong style={{ color: outlook.color }}>{outlook.peak24hMean}</strong>
                            <span>µg/m³</span>
                          </p>
                          <p className="corr-node-level">{t(LEVEL_KEY[outlook.level])}</p>
                          <Sparkline values={outlook.pm25} color={outlook.color} />
                          <p className="corr-node-peak">
                            {t("corr_peak_at").replace("{time}", formatHour(feed.computedAt, outlook.peakHour))}
                          </p>
                          {outlook.drivers.length > 0 && (
                            <ul className="corr-drivers">
                              {outlook.drivers.includes("rising") && <li className="is-rising">{t("corr_driver_rising")}</li>}
                              {outlook.drivers.includes("stagnation") && (
                                <li className="is-stagnant" title={`${outlook.ventilation.peak24hM2s} m²/s`}>
                                  {t("corr_driver_stagnation")}
                                </li>
                              )}
                              {outlook.drivers.includes("smoke") && outlook.smoke && (
                                <li className="is-smoke">
                                  {t("corr_driver_smoke").replace("{hours}", String(Math.round(outlook.smoke.etaHours)))}
                                </li>
                              )}
                            </ul>
                          )}
                          <p className="corr-node-basis">
                            {outlook.calibration
                              ? t("corr_calibrated").replace("{count}", String(outlook.calibration.stations))
                              : t("corr_model_only")}
                          </p>
                        </>
                      )}
                    </li>
                  );
                })}
              </ol>
            </article>
          ))}
        </div>
      )}
      <p className="svd-note">{t("corr_method_note")}</p>
    </section>
  );
}
