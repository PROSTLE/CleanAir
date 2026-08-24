"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import Navbar from "@/components/shared/Navbar";
import ForecastChart from "@/components/forecast/ForecastChart";
import AQIBadge from "@/components/forecast/AQIBadge";
import {
  DELHI_H3_CELLS,
  generateMockHistory,
  forecastPM25,
  getAQIInfo,
  type ForecastResult,
  type SensorReading,
} from "@/lib/forecastEngine";
import { useT } from "@/lib/languageContext";

type ForecastApiResponse = ForecastResult & {
  history?: SensorReading[];
  source?: "bigquery" | "mock";
};

const FORECAST_REFRESH_MS = 60_000;

// ─── Refined Cell selector component ─────────────────────────────────────────
function CellSelector({
  selected,
  onChange,
  t,
}: {
  selected: string;
  onChange: (id: string) => void;
  t: (key: string) => string;
}) {
  return (
    <div className="forecast-cell-selector-grid">
      {DELHI_H3_CELLS.map((cell) => {
        const isSelected = selected === cell.h3CellId;
        return (
          <button
            key={cell.h3CellId}
            className={`forecast-cell-chip ${isSelected ? "is-active" : ""}`}
            onClick={() => onChange(cell.h3CellId)}
            aria-pressed={isSelected}
          >
            <span className="chip-dot" />
            <span className="chip-label">{cell.labelKey ? t(cell.labelKey) : cell.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ─── Trend Badge ─────────────────────────────────────────────────────────────
function TrendIndicator({
  trend,
  magnitude,
}: {
  trend: "rising" | "falling" | "stable";
  magnitude: number;
}) {
  const isRising = trend === "rising";
  const isFalling = trend === "falling";

  return (
    <div className={`forecast-trend-tag trend-${trend}`}>
      <span className="trend-icon">
        {isRising ? "↗" : isFalling ? "↘" : "→"}
      </span>
      <span className="trend-text">
        {magnitude > 0 ? `${magnitude.toFixed(1)} µg/m³/hr` : "Steady"}
      </span>
    </div>
  );
}

// ─── Stat Card ────────────────────────────────────────────────────────────────
function MetricCard({
  icon,
  label,
  value,
  unit,
  sub,
  accent,
  badge,
}: {
  icon?: React.ReactNode;
  label: string;
  value: string | number;
  unit?: string;
  sub?: string;
  accent?: string;
  badge?: string;
}) {
  return (
    <div className="forecast-metric-card" style={accent ? { borderTopColor: accent } : {}}>
      <div className="metric-header">
        <span className="forecast-metric-label">{label}</span>
        {badge && <span className="metric-badge">{badge}</span>}
      </div>

      <div className="metric-value-row">
        <p className="forecast-metric-value" style={accent ? { color: accent } : {}}>
          {value}
          {unit && <span className="forecast-metric-unit">{unit}</span>}
        </p>
      </div>

      {sub && <p className="forecast-metric-sub">{sub}</p>}
    </div>
  );
}

// ─── Hourly table row with modern gradient capsule ─────────────────────────
function HourRow({
  hour,
  pm25,
  confidence,
}: {
  hour: string;
  pm25: number;
  confidence: "low" | "medium" | "high";
}) {
  const aqi = getAQIInfo(pm25);
  const confClass =
    confidence === "high"
      ? "conf-high"
      : confidence === "medium"
      ? "conf-medium"
      : "conf-low";

  // Calculate percentage of 350 max scale
  const barWidth = Math.min(100, Math.max(8, (pm25 / 320) * 100));

  return (
    <div className="forecast-hour-card">
      <div className="forecast-hour-time-badge">{hour}</div>

      <div className="forecast-hour-bar-track">
        <div
          className="forecast-hour-bar-fill"
          style={{
            width: `${barWidth}%`,
            background: aqi.color,
            boxShadow: `0 0 10px ${aqi.color}40`,
          }}
        />
      </div>

      <div className="forecast-hour-value" style={{ color: aqi.textColor }}>
        <strong>{pm25}</strong>
        <span className="val-unit">µg/m³</span>
      </div>

      <span className={`forecast-conf-pill ${confClass}`}>
        {confidence.toUpperCase()}
      </span>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function ForecastPage() {
  const t = useT();
  const [selectedCell, setSelectedCell] = useState(DELHI_H3_CELLS[0].h3CellId);
  const [loading, setLoading] = useState(false);
  const [forecast, setForecast] = useState<ForecastResult | null>(null);
  const [history, setHistory] = useState<SensorReading[]>([]);
  const [source, setSource] = useState<"bigquery" | "mock" | null>(null);

  const loadForecast = useCallback(async (h3CellId: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/forecast?h3CellId=${h3CellId}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error("API error");

      const data = (await res.json()) as ForecastApiResponse;
      const { history: apiHistory, source: apiSource, ...forecastResult } = data;

      setForecast(forecastResult);
      setHistory(apiHistory ?? []);
      setSource(apiSource ?? null);
    } catch (err) {
      console.error("Forecast error:", err);
      const cell = DELHI_H3_CELLS.find((c) => c.h3CellId === h3CellId);
      const hist = generateMockHistory(
        h3CellId,
        cell?.label ?? "Delhi",
        cell?.lat ?? 28.6139,
        cell?.lng ?? 77.209,
        72
      );
      setHistory(hist);
      setForecast(forecastPM25(hist));
      setSource("mock");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void loadForecast(selectedCell);
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [selectedCell, loadForecast]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      loadForecast(selectedCell);
    }, FORECAST_REFRESH_MS);

    return () => window.clearInterval(intervalId);
  }, [selectedCell, loadForecast]);

  const currentAQI = forecast ? getAQIInfo(forecast.currentPm25) : null;
  const peakAQI = forecast ? getAQIInfo(forecast.peakPm25) : null;
  const sourceLabel =
    source === "bigquery"
      ? "Live BigQuery Engine"
      : source === "mock"
      ? "Predictive Heuristic"
      : t("forecast_metric_generated_desc");

  return (
    <main className="app-page-shell">
      <div className="sv-navbar-wrap" style={{ zIndex: 200 }}>
        <div className="app-page-container" style={{ paddingTop: 0 }}>
          <Navbar />
        </div>
      </div>

      <div className="app-page-container app-page-content forecast-page-content">
        {/* ── Page Hero Header ──────────────────────────────────────────── */}
        <div className="forecast-header-card">
          <div className="forecast-header-main">
            <div className="forecast-badge-row">
              <span className="forecast-hero-kicker">
                <span className="sv-live-dot" />
                MUNICIPAL TELEMETRY & PREDICTIVE ML
              </span>
              <span className="forecast-model-pill">BigQuery Engine · H3 Res-7</span>
            </div>
            <h1 className="forecast-hero-title">{t("forecast_title")}</h1>
            <p className="forecast-hero-subtitle">
              24-hour predictive PM2.5 forecasting synthesized from ground CPCB sensors, Sentinel-5P satellite NO₂, and wind dampening models.
            </p>
          </div>

          <div className="forecast-header-actions">
            <button
              className="forecast-refresh-btn"
              onClick={() => loadForecast(selectedCell)}
              disabled={loading}
              title="Refresh Forecast"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={loading ? "spin" : ""}
              >
                <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
                <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
                <path d="M16 21h5v-5" />
              </svg>
              <span>{loading ? "Calculating..." : "Sync Telemetry"}</span>
            </button>
          </div>
        </div>

        {/* ── Cell selector ──────────────────────────────────────────────── */}
        <section className="forecast-zone-section">
          <div className="forecast-zone-header">
            <div className="zone-title-wrap">
              <h2 className="forecast-section-title">{t("forecast_select_cell_title")}</h2>
              <p className="forecast-section-sub">{t("forecast_select_cell_desc")}</p>
            </div>
          </div>

          <CellSelector
            selected={selectedCell}
            onChange={(id) => setSelectedCell(id)}
            t={t}
          />
        </section>

        {/* ── Loading Spinner ────────────────────────────────────────────── */}
        {loading && (
          <div className="forecast-loading-card">
            <span className="forecast-spinner" />
            <p>{t("forecast_loading")}</p>
          </div>
        )}

        {/* ── Main content ───────────────────────────────────────────────── */}
        {!loading && forecast && currentAQI && peakAQI && (
          <>
            {/* ── Hero Forecast Telemetry Banner ──────────────────────────── */}
            <section className="forecast-summary-banner">
              <div className="forecast-summary-left">
                <div className="forecast-location-row">
                  <div className="location-name-group">
                    <span className="forecast-location-name">
                      {t(DELHI_H3_CELLS.find(c => c.h3CellId === forecast.h3CellId)?.labelKey || "cell_delhi")}
                    </span>
                    <span className="forecast-cell-id">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5 12 2" />
                      </svg>
                      {forecast.h3CellId}
                    </span>
                  </div>

                  <TrendIndicator trend={forecast.trend} magnitude={forecast.trendMagnitude} />
                </div>

                <p className="forecast-summary-text">
                  {(() => {
                    const trendNote = forecast.trend === "rising"
                      ? t("forecast_trend_upward").replace("{slope}", Math.abs(forecast.trendMagnitude).toFixed(1))
                      : forecast.trend === "falling"
                      ? t("forecast_trend_downward").replace("{slope}", Math.abs(forecast.trendMagnitude).toFixed(1))
                      : t("forecast_trend_stable");
                    
                    const covNote = forecast.covariateNudge > 3 ? t("forecast_covariate_amplified") : "";
                    const windNote = forecast.windDamping ? t("forecast_wind_help") : "";
                    const peakVal = Math.round(forecast.peakPm25).toString();

                    let template = "";
                    if (forecast.trend === "rising") template = t("forecast_summary_rise");
                    else if (forecast.trend === "falling") template = t("forecast_summary_fall");
                    else template = t("forecast_summary_remain");

                    return template
                      .replace("{peakValue}", peakVal)
                      .replace("{peakHour}", forecast.peakHour)
                      .replace("{trendNote}", trendNote)
                      .replace("{covNote}", covNote)
                      .replace("{windNote}", windNote);
                  })()}
                </p>

                <div className="forecast-summary-badges">
                  <AQIBadge
                    pm25={forecast.currentPm25}
                    aqi={currentAQI}
                    size="md"
                  />
                  {forecast.windDamping && (
                    <span className="forecast-wind-badge">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M17.7 7.7a2.5 2.5 0 1 1 1.8 4.3H2" />
                        <path d="M9.6 4.6A2 2 0 1 1 11 8H2" />
                        <path d="M12.6 19.4A2 2 0 1 0 14 16H2" />
                      </svg>
                      {t("forecast_summary_wind_active")}
                    </span>
                  )}
                  <span className="forecast-station-badge">
                    CPCB Active Monitor Online
                  </span>
                </div>
              </div>

              {/* Right Side: High-Impact 24h Peak Box */}
              <div className="forecast-summary-right">
                <div className="forecast-peak-box" style={{ borderColor: `${peakAQI.color}40` }}>
                  <div className="peak-header">
                    <span className="forecast-peak-label">{t("forecast_summary_peak")}</span>
                    <span className="peak-live-tag" style={{ background: `${peakAQI.color}20`, color: peakAQI.color }}>
                      24h Horizon
                    </span>
                  </div>

                  <p className="forecast-peak-value" style={{ color: peakAQI.color }}>
                    {forecast.peakPm25}
                    <span className="unit">µg/m³</span>
                  </p>

                  <div className="peak-footer-row">
                    <span className="forecast-peak-time">
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="12" cy="12" r="10" />
                        <polyline points="12 6 12 12 16 14" />
                      </svg>
                      {t("forecast_at_time").replace("{time}", forecast.peakHour)}
                    </span>
                    <AQIBadge pm25={forecast.peakPm25} aqi={peakAQI} size="sm" showValue={false} />
                  </div>
                </div>
              </div>
            </section>

            {/* ── Key Metrics 4-Grid ────────────────────────────────────── */}
            <div className="forecast-metrics-grid">
              <MetricCard
                label={t("forecast_metric_current")}
                value={forecast.currentPm25}
                unit=" µg/m³"
                sub={t(currentAQI.description) || currentAQI.description}
                accent={currentAQI.color}
                badge={currentAQI.category}
              />
              <MetricCard
                label={t("forecast_metric_trend")}
                value={`${forecast.trendMagnitude > 0 ? "+" : ""}${forecast.trendMagnitude.toFixed(1)}`}
                unit=" µg/m³/hr"
                sub={
                  forecast.trend === "rising"
                    ? t("forecast_metric_trend_rising")
                    : forecast.trend === "falling"
                    ? t("forecast_metric_trend_falling")
                    : t("forecast_metric_trend_stable")
                }
                accent={
                  forecast.trend === "rising"
                    ? "#ef4444"
                    : forecast.trend === "falling"
                    ? "#22c55e"
                    : "#6366f1"
                }
                badge={forecast.trend.toUpperCase()}
              />
              <MetricCard
                label={t("forecast_metric_covariate")}
                value={`${forecast.covariateNudge > 0 ? "+" : ""}${forecast.covariateNudge.toFixed(1)}`}
                unit=" µg/m³"
                sub="Sentinel-5P NO₂ & PM10 Satellite Delta"
                accent={forecast.covariateNudge > 0 ? "#f97316" : "#22c55e"}
                badge="NO₂ + PM10"
              />
              <MetricCard
                label={t("forecast_metric_generated")}
                value={new Date(forecast.generatedAt).toLocaleTimeString("en-IN", {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
                sub={sourceLabel}
                accent="var(--teal)"
                badge="LIVE SYNC"
              />
            </div>

            {/* ── Interactive 24h Chart Section ──────────────────────────── */}
            <section className="forecast-chart-panel">
              <div className="forecast-chart-panel-header">
                <div>
                  <h2 className="forecast-panel-title">
                    {t("forecast_chart_title")}
                  </h2>
                  <p className="forecast-panel-sub">
                    {t("forecast_chart_subtitle")}
                  </p>
                </div>
              </div>

              <ForecastChart forecast={forecast} history={history} />
            </section>

            {/* ── Hourly Table Section with Clean Grid ──────────────────── */}
            <section className="forecast-timeline-section">
              <div className="forecast-timeline-header">
                <h2 className="forecast-panel-title">Hourly Projection Breakdown</h2>
                <p className="forecast-panel-sub">Hourly forecasted PM2.5 readings mapped with confidence thresholds.</p>
              </div>

              <div className="forecast-table-grid">
                {/* Left: next 12h */}
                <div className="forecast-timeline-col">
                  <div className="timeline-col-header">
                    <span className="timeline-col-badge">{t("forecast_table_next_12")}</span>
                    <span className="timeline-col-sub">Immediate Operational Window</span>
                  </div>
                  <div className="forecast-hour-list">
                    {forecast.forecast.slice(0, 12).map((f) => (
                      <HourRow
                        key={f.hour}
                        hour={f.hour}
                        pm25={f.predicted_pm25}
                        confidence={f.confidence}
                      />
                    ))}
                  </div>
                </div>

                {/* Right: hours 13–24 */}
                <div className="forecast-timeline-col">
                  <div className="timeline-col-header">
                    <span className="timeline-col-badge">{t("forecast_table_hours_13_24")}</span>
                    <span className="timeline-col-sub">Extended Dispatch Window</span>
                  </div>
                  <div className="forecast-hour-list">
                    {forecast.forecast.slice(12).map((f) => (
                      <HourRow
                        key={f.hour}
                        hour={f.hour}
                        pm25={f.predicted_pm25}
                        confidence={f.confidence}
                      />
                    ))}
                  </div>
                </div>
              </div>
            </section>

            {/* ── Developer & Municipal API Integration ──────────────────── */}
            <section className="forecast-api-panel">
              <div className="api-panel-header">
                <div>
                  <h3 className="api-panel-title">{t("forecast_api_title")}</h3>
                  <p className="api-panel-desc">{t("forecast_api_desc")}</p>
                </div>
                <Link
                  href={`/api/forecast?h3CellId=${forecast.h3CellId}`}
                  target="_blank"
                  className="btn btn-outline"
                  style={{ fontSize: "0.82rem", padding: "8px 16px" }}
                >
                  {t("forecast_api_try")} ↗
                </Link>
              </div>

              <div className="forecast-api-terminal">
                <div className="terminal-topbar">
                  <span className="term-dot red" />
                  <span className="term-dot yellow" />
                  <span className="term-dot green" />
                  <span className="term-title">cURL API Telemetry Endpoint</span>
                </div>
                <div className="terminal-code">
                  <code>
                    <span className="term-method">GET</span>{" "}
                    <span className="term-path">/api/forecast?h3CellId=</span>
                    <span className="term-param">{forecast.h3CellId}</span>
                  </code>
                </div>
              </div>
            </section>
          </>
        )}
      </div>
    </main>
  );
}
