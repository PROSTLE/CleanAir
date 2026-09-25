"use client";

import { useState, useEffect, useCallback } from "react";
import Navbar from "@/components/shared/Navbar";
import ForecastChart from "@/components/forecast/ForecastChart";
import AQIBadge from "@/components/forecast/AQIBadge";
import DelhiIllustration from "@/components/shared/DelhiIllustration";
import Icon, { type IconName } from "@/components/shared/Icon";
import LiveIndicator, { type LiveState } from "@/components/shared/LiveIndicator";
import {
  DELHI_H3_CELLS,
  getAQIInfo,
  type ForecastResult,
  type HourlyForecastPoint,
  type SensorReading,
} from "@/lib/forecastEngine";
import { useT } from "@/lib/languageContext";

type ForecastApiResponse = ForecastResult & {
  history?: SensorReading[];
  source?: "bigquery";
  dataSource?: "live" | "archive";
  station?: string;
  isLiveHistory?: boolean;
  historyAgeHours?: number | null;
  windApplied?: boolean;
  backtest?: { maeHeuristic: number; maePersistence: number; evaluatedPoints: number; holdoutHours: number } | null;
  arima?: { points: Array<{ time: string; value: number; lower: number; upper: number }> | null; reason?: string };
  error?: string;
};

type ForecastMeta = Pick<
  ForecastApiResponse,
  "station" | "isLiveHistory" | "historyAgeHours" | "windApplied" | "dataSource" | "backtest" | "arima"
>;

type GoogleAq = {
  current: { indiaAqi: number | null; indiaCategory: string | null; pm25: number | null; time: string | null };
  forecast: Array<{ time: string | null; pm25: number | null }>;
};

type Translator = (key: string) => string;

const FORECAST_REFRESH_MS = 60_000;
const TREND_ICON: Record<ForecastResult["trend"], IconName> = {
  rising: "trend-up",
  falling: "trend-down",
  stable: "trend-flat",
};

function shortStation(label?: string) {
  return label?.replace(/, Delhi - (DPCC|CPCB|IMD)$/, "") ?? "";
}

function buildSummary(forecast: ForecastResult, t: Translator) {
  const slope = Math.abs(forecast.trendMagnitude).toFixed(1);
  const trendNote =
    forecast.trend === "rising"
      ? t("forecast_trend_upward").replace("{slope}", slope)
      : forecast.trend === "falling"
        ? t("forecast_trend_downward").replace("{slope}", slope)
        : t("forecast_trend_stable");
  // The peak is the 24-hour maximum, which can sit above the current value
  // even while the short-term trend falls (e.g. the evening build-up). So the
  // sentence states the peak and the current trend separately.
  return t("fc_summary")
    .replace("{peakValue}", Math.round(forecast.peakPm25).toString())
    .replace("{peakHour}", forecast.peakHour)
    .replace("{trendNote}", trendNote)
    .replace("{covNote}", forecast.covariateNudge > 3 ? t("forecast_covariate_amplified") : "")
    .replace("{windNote}", forecast.windDamping ? t("forecast_wind_help") : "");
}

// ─── Hourly row ───────────────────────────────────────────────────────────────
// Confidence is a fixed horizon schedule (see forecastEngine), so it is shown
// as three quiet dots rather than a loud HIGH/MEDIUM/LOW badge.
function HourRow({ point, t }: { point: HourlyForecastPoint; t: Translator }) {
  const aqi = getAQIInfo(point.predicted_pm25);
  const filled = point.confidence === "high" ? 3 : point.confidence === "medium" ? 2 : 1;
  const width = Math.min(100, Math.max(4, (point.predicted_pm25 / 300) * 100));

  return (
    <li className="fc-hour">
      <span className="fc-hour-time">{point.hour}</span>
      <span className="fc-hour-track" aria-hidden="true">
        <span className="fc-hour-fill" style={{ width: `${width}%`, background: aqi.color }} />
      </span>
      <span className="fc-hour-value">
        {point.predicted_pm25}
        <small>µg/m³</small>
      </span>
      <span className="fc-confidence" title={t(`fc_confidence_${point.confidence}`)}>
        {[0, 1, 2].map((index) => (
          <span key={index} className={index < filled ? "is-on" : ""} />
        ))}
      </span>
    </li>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────
export default function ForecastPage() {
  const t = useT();
  const [selectedCell, setSelectedCell] = useState(DELHI_H3_CELLS[0].h3CellId);
  const [loading, setLoading] = useState(false);
  const [forecast, setForecast] = useState<ForecastResult | null>(null);
  const [history, setHistory] = useState<SensorReading[]>([]);
  const [meta, setMeta] = useState<ForecastMeta | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [googleAq, setGoogleAq] = useState<GoogleAq | null>(null);
  const [googleAqError, setGoogleAqError] = useState<string | null>(null);

  const selected = DELHI_H3_CELLS.find((cell) => cell.h3CellId === selectedCell) ?? DELHI_H3_CELLS[0];

  // Independent cross-check: Google's modelled PM2.5 for the same point.
  useEffect(() => {
    const cell = DELHI_H3_CELLS.find((candidate) => candidate.h3CellId === selectedCell);
    if (!cell) return;
    let cancelled = false;
    fetch(`/api/air-quality?lat=${cell.lat}&lng=${cell.lng}`)
      .then(async (response) => {
        const data = (await response.json().catch(() => null)) as (GoogleAq & { error?: string }) | null;
        if (cancelled) return;
        if (!response.ok || !data || data.error) {
          setGoogleAq(null);
          setGoogleAqError(data?.error ?? `Air Quality API responded ${response.status}`);
        } else {
          setGoogleAq(data);
          setGoogleAqError(null);
        }
      })
      .catch((error) => {
        if (!cancelled) setGoogleAqError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedCell]);

  const loadForecast = useCallback(async (h3CellId: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/forecast?h3CellId=${h3CellId}`, { cache: "no-store" });
      const data = (await res.json().catch(() => null)) as ForecastApiResponse | null;
      if (!res.ok || !data) {
        throw new Error(data?.error ?? `Forecast service responded ${res.status}`);
      }

      const {
        history: apiHistory,
        source: _source,
        station,
        isLiveHistory,
        historyAgeHours,
        windApplied,
        dataSource,
        backtest,
        arima,
        error: _error,
        ...forecastResult
      } = data;
      void _source;
      void _error;

      setForecast(forecastResult);
      setHistory(apiHistory ?? []);
      setMeta({ station, isLiveHistory, historyAgeHours, windApplied, dataSource, backtest, arima });
      setLoadError(null);
    } catch (err) {
      // No client-side synthetic fallback: show why the forecast is missing.
      console.warn("Forecast unavailable:", err);
      setForecast(null);
      setHistory([]);
      setMeta(null);
      setLoadError(err instanceof Error ? err.message : "Forecast unavailable.");
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
      void loadForecast(selectedCell);
    }, FORECAST_REFRESH_MS);
    return () => window.clearInterval(intervalId);
  }, [selectedCell, loadForecast]);

  const currentAQI = forecast ? getAQIInfo(forecast.currentPm25) : null;
  const peakAQI = forecast ? getAQIInfo(forecast.peakPm25) : null;
  const historyEndLabel = forecast?.historyEnd
    ? new Date(forecast.historyEnd).toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        dateStyle: "medium",
        timeStyle: "short",
      })
    : null;

  const liveState: LiveState =
    loading && !forecast ? "connecting" : !forecast ? "offline" : meta?.isLiveHistory ? "live" : "archive";
  const liveLabel = {
    live: t("fc_state_live"),
    archive: t("fc_state_archive"),
    connecting: t("fc_state_connecting"),
    offline: t("fc_state_offline"),
  }[liveState];

  const backtestBeatsBaseline = meta?.backtest ? meta.backtest.maeHeuristic <= meta.backtest.maePersistence : null;
  const arimaPeak = meta?.arima?.points?.length ? Math.max(...meta.arima.points.map((point) => point.value)) : null;

  return (
    <main className="app-page-shell">
      <div className="sv-navbar-wrap" style={{ zIndex: 200 }}>
        <div className="app-page-container" style={{ paddingTop: 0 }}>
          <Navbar />
        </div>
      </div>

      <div className="app-page-container app-page-content">
        <div className="svd fc">
          {/* ── Header ───────────────────────────────────────────────────── */}
          <header className="svd-head fc-head">
            <div>
              <LiveIndicator state={liveState} label={`${t("fc_kicker")} · ${liveLabel}`} />
              <h1>{t("forecast_title")}</h1>
              <p className="svd-lede">{t("fc_lede")}</p>
              <ul className="vs-meta fc-provenance">
                <li>
                  <Icon name="database" size={15} />
                  {t("fc_meta_source")}
                </li>
                <li>
                  <Icon name="hexagon" size={15} />
                  {t("fc_meta_grid")}
                </li>
                <li>
                  <Icon name="wind" size={15} />
                  {meta?.windApplied ? t("fc_meta_wind_on") : t("fc_meta_wind_off")}
                </li>
              </ul>
            </div>
            <button
              type="button"
              className="svd-btn"
              onClick={() => void loadForecast(selectedCell)}
              disabled={loading}
            >
              <Icon name="refresh" size={15} className={loading ? "vs-spin" : ""} />
              {loading ? t("fc_refreshing") : t("fc_refresh")}
            </button>
          </header>

          {/* ── Zones ────────────────────────────────────────────────────── */}
          <nav className="fc-zones" aria-label={t("forecast_select_cell_title")}>
            {DELHI_H3_CELLS.map((cell) => {
              const isSelected = selectedCell === cell.h3CellId;
              return (
                <button
                  key={cell.h3CellId}
                  type="button"
                  className={`fc-zone ${isSelected ? "is-active" : ""}`}
                  onClick={() => setSelectedCell(cell.h3CellId)}
                  aria-pressed={isSelected}
                >
                  <span className="fc-zone-name">{cell.labelKey ? t(cell.labelKey) : cell.label}</span>
                  <span className="fc-zone-station">
                    <Icon name="station" size={12} />
                    {shortStation(cell.bigQueryLabel ?? cell.label)}
                  </span>
                </button>
              );
            })}
          </nav>

          {loading && !forecast && !loadError && (
            <p className="fc-status">
              <Icon name="refresh" size={15} className="vs-spin" />
              {t("forecast_loading")}
            </p>
          )}

          {!loading && loadError && (
            <section className="svd-card fc-card">
              <div className="vs-empty">
                <DelhiIllustration points={[{ lat: selected.lat, lng: selected.lng, tone: "calm" }]} />
                <div>
                  <strong>{t("fc_unavailable_title")}</strong>
                  <p>{loadError}</p>
                  <p>{t("fc_unavailable_help")}</p>
                </div>
              </div>
            </section>
          )}

          {forecast && meta && !meta.isLiveHistory && (
            <p className="fc-notice" role="status">
              <Icon name="clock" size={16} />
              <span>
                <strong>{t("fc_archive_title")}</strong>{" "}
                {t("fc_archive_body")
                  .replace("{station}", meta.station ?? t("forecast_station"))
                  .replace("{date}", historyEndLabel ?? "—")
                  .replace(
                    "{days}",
                    meta.historyAgeHours != null ? String(Math.round(meta.historyAgeHours / 24)) : "—",
                  )}
              </span>
            </p>
          )}

          {forecast && currentAQI && peakAQI && (
            <>
              {/* ── Now vs peak ────────────────────────────────────────── */}
              <section className="fc-hero">
                <div className="fc-hero-block">
                  <p className="fc-label">
                    {t("fc_now")} · {t(selected.labelKey) || selected.label}
                  </p>
                  <p className="fc-reading">
                    {forecast.currentPm25}
                    <small>µg/m³ PM2.5</small>
                  </p>
                  <AQIBadge pm25={forecast.currentPm25} aqi={currentAQI} showValue={false} />
                </div>
                <div className="fc-hero-block">
                  <p className="fc-label">{t("fc_peak")}</p>
                  <p className="fc-reading">
                    {forecast.peakPm25}
                    <small>{t("fc_peak_at").replace("{hour}", forecast.peakHour)}</small>
                  </p>
                  <AQIBadge pm25={forecast.peakPm25} aqi={peakAQI} showValue={false} />
                </div>
                <p className="fc-summary">{buildSummary(forecast, t)}</p>
              </section>

              <ul className="svd-kpis fc-kpis">
                <li className="svd-kpi">
                  <strong className={`fc-trend is-${forecast.trend}`}>
                    <Icon name={TREND_ICON[forecast.trend]} size={22} />
                    {forecast.trendMagnitude > 0 ? "+" : ""}
                    {forecast.trendMagnitude.toFixed(1)}
                  </strong>
                  <span>{t("forecast_metric_trend")}</span>
                  <small>
                    {forecast.trend === "rising"
                      ? t("forecast_metric_trend_rising")
                      : forecast.trend === "falling"
                        ? t("forecast_metric_trend_falling")
                        : t("forecast_metric_trend_stable")}{" "}
                    · µg/m³/h
                  </small>
                </li>
                <li className="svd-kpi">
                  <strong>
                    {forecast.covariateNudge > 0 ? "+" : ""}
                    {forecast.covariateNudge.toFixed(1)}
                  </strong>
                  <span>{t("forecast_metric_covariate")}</span>
                  <small>{t("fc_covariate_detail")}</small>
                </li>
                <li className="svd-kpi">
                  <strong>{history.length}</strong>
                  <span>{t("fc_history_points")}</span>
                  <small>{historyEndLabel ? t("fc_history_until").replace("{date}", historyEndLabel) : "—"}</small>
                </li>
                <li className="svd-kpi">
                  <strong>
                    {new Date(forecast.generatedAt).toLocaleTimeString("en-IN", {
                      timeZone: "Asia/Kolkata",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </strong>
                  <span>{t("forecast_metric_generated")}</span>
                  <small>{t("fc_generated_detail")}</small>
                </li>
              </ul>

              {/* ── Chart ──────────────────────────────────────────────── */}
              <section className="svd-card fc-card">
                <header className="svd-card-head">
                  <h2 className="vs-title">
                    <Icon name="chart" size={18} />
                    {t("forecast_chart_title")}
                  </h2>
                  <p>{t("forecast_chart_subtitle")}</p>
                </header>
                <ForecastChart
                  forecast={forecast}
                  history={history}
                  arima={meta?.arima?.points?.map((point) => ({ time: point.time, value: point.value })) ?? null}
                  google={
                    // Google forecasts from now; only comparable to live history.
                    meta?.isLiveHistory && googleAq
                      ? googleAq.forecast.flatMap((point) =>
                          point.time ? [{ time: point.time, value: point.pm25 }] : [],
                        )
                      : null
                  }
                />
              </section>

              {/* ── Model comparison ───────────────────────────────────── */}
              <section className="svd-card fc-card">
                <header className="svd-card-head">
                  <h2 className="vs-title">
                    <Icon name="gauge" size={18} />
                    {t("forecast_models_title")}
                  </h2>
                  <p>{t("forecast_models_sub")}</p>
                </header>
                <ul className="fc-models">
                  <li>
                    <span className="fc-model-name">{t("forecast_model_backtest")}</span>
                    <strong>
                      {meta?.backtest ? meta.backtest.maeHeuristic.toFixed(1) : "—"}
                      {meta?.backtest && <small>µg/m³ MAE</small>}
                    </strong>
                    <p>
                      {meta?.backtest
                        ? t("forecast_model_backtest_sub")
                            .replace("{persistence}", meta.backtest.maePersistence.toFixed(1))
                            .replace("{n}", String(meta.backtest.evaluatedPoints))
                        : t("forecast_model_backtest_none")}
                    </p>
                    {backtestBeatsBaseline !== null && (
                      <span className={`fc-verdict ${backtestBeatsBaseline ? "is-good" : "is-weak"}`}>
                        {backtestBeatsBaseline ? t("forecast_model_beats_baseline") : t("forecast_model_below_baseline")}
                      </span>
                    )}
                  </li>
                  <li>
                    <span className="fc-model-name">{t("forecast_model_arima")}</span>
                    <strong>
                      {arimaPeak ?? "—"}
                      {arimaPeak !== null && <small>µg/m³ peak</small>}
                    </strong>
                    <p>
                      {arimaPeak !== null
                        ? t("forecast_model_arima_sub")
                        : (meta?.arima?.reason ?? t("forecast_model_arima_none"))}
                    </p>
                  </li>
                  <li>
                    <span className="fc-model-name">{t("forecast_model_google")}</span>
                    <strong>
                      {googleAq?.current.pm25 ?? "—"}
                      {googleAq?.current.pm25 != null && <small>µg/m³ now</small>}
                    </strong>
                    <p>
                      {googleAq
                        ? t("forecast_model_google_sub")
                            .replace("{aqi}", String(googleAq.current.indiaAqi ?? "—"))
                            .replace("{category}", googleAq.current.indiaCategory ?? "")
                        : (googleAqError ?? t("drawer_loading"))}
                    </p>
                  </li>
                  <li>
                    <span className="fc-model-name">{t("forecast_model_source")}</span>
                    <strong>{meta?.dataSource === "live" ? t("forecast_source_live") : t("forecast_source_archive")}</strong>
                    <p>{meta?.station ? `${t("forecast_station")}: ${meta.station}` : "—"}</p>
                  </li>
                </ul>
              </section>

              {/* ── Hourly ─────────────────────────────────────────────── */}
              <section className="svd-card fc-card">
                <header className="svd-card-head svd-card-head-split">
                  <div>
                    <h2 className="vs-title">
                      <Icon name="clock" size={18} />
                      {t("fc_hours_title")}
                    </h2>
                    <p>{t("fc_hours_sub")}</p>
                  </div>
                  <span className="fc-confidence-key">
                    <span className="fc-confidence" aria-hidden="true">
                      <span className="is-on" />
                      <span className="is-on" />
                      <span />
                    </span>
                    {t("fc_confidence_key")}
                  </span>
                </header>
                <div className="fc-hours">
                  <div>
                    <p className="fc-label">{t("forecast_table_next_12")}</p>
                    <ol>
                      {forecast.forecast.slice(0, 12).map((point) => (
                        <HourRow key={point.time} point={point} t={t} />
                      ))}
                    </ol>
                  </div>
                  <div>
                    <p className="fc-label">{t("forecast_table_hours_13_24")}</p>
                    <ol>
                      {forecast.forecast.slice(12).map((point) => (
                        <HourRow key={point.time} point={point} t={t} />
                      ))}
                    </ol>
                  </div>
                </div>
              </section>

              {/* ── Data access ────────────────────────────────────────── */}
              <section className="svd-card fc-card fc-api">
                <div>
                  <h2 className="vs-title">
                    <Icon name="code" size={18} />
                    {t("forecast_api_title")}
                  </h2>
                  <p>{t("forecast_api_desc")}</p>
                </div>
                <code>GET /api/forecast?h3CellId={forecast.h3CellId}</code>
                <a
                  className="sv-underline-link"
                  href={`/api/forecast?h3CellId=${forecast.h3CellId}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t("fc_api_open")}
                </a>
              </section>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
