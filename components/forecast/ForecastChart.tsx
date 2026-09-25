"use client";

import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";
import type { ForecastResult, SensorReading } from "@/lib/forecastEngine";
import { getAQIInfo, getIstHour } from "@/lib/forecastEngine";
import { useT } from "@/lib/languageContext";

/** An independent series drawn over the forecast horizon, matched by timestamp. */
export type ComparisonPoint = { time: string; value: number | null };

interface ForecastChartProps {
  forecast: ForecastResult;
  history: SensorReading[];
  /** BigQuery ML ARIMA_PLUS forecast (live data only). */
  arima?: ComparisonPoint[] | null;
  /** Google Air Quality API hourly PM2.5 forecast. */
  google?: ComparisonPoint[] | null;
}

interface ChartPoint {
  key: string;
  label: string;
  actual?: number;
  predicted?: number;
  arima?: number;
  google?: number;
}

// Palette: ink for what was measured, brand green for our projection, and
// two muted, clearly different hues for the independent comparisons.
const COLOR = {
  actual: "#1f2d26",
  predicted: "#2c7d40",
  arima: "#b7791f",
  google: "#3b6e8f",
  grid: "rgba(16, 26, 21, 0.07)",
  axis: "#7b877f",
};

function valueAt(series: ComparisonPoint[] | null | undefined, time: string) {
  if (!series?.length) return undefined;
  const targetMs = Date.parse(time);
  const match = series.find((point) => Math.abs(Date.parse(point.time) - targetMs) <= 30 * 60 * 1000);
  return match?.value ?? undefined;
}

function ChartTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: ChartPoint }>;
}) {
  const t = useT();
  if (!active || !payload?.length) return null;
  const point = payload[0].payload;
  const isForecast = point.actual === undefined;
  const value = isForecast ? point.predicted : point.actual;
  const aqi = value !== undefined ? getAQIInfo(value) : null;

  return (
    <div className="fc-tooltip">
      <p className="fc-tooltip-head">
        <span>{point.label} IST</span>
        <span>{isForecast ? t("forecast_chart_legend_forecast") : t("forecast_chart_legend_actual")}</span>
      </p>
      {value !== undefined && (
        <p className="fc-tooltip-value">
          {value}
          <small>µg/m³</small>
        </p>
      )}
      {aqi && (
        <p className="fc-tooltip-aqi">
          <span style={{ background: aqi.color }} aria-hidden="true" />
          {t(aqi.category)}
        </p>
      )}
      {(point.arima !== undefined || point.google !== undefined) && (
        <dl className="fc-tooltip-compare">
          {point.arima !== undefined && (
            <div>
              <dt>{t("forecast_legend_arima")}</dt>
              <dd>{point.arima}</dd>
            </div>
          )}
          {point.google !== undefined && (
            <div>
              <dt>{t("forecast_legend_google")}</dt>
              <dd>{point.google}</dd>
            </div>
          )}
        </dl>
      )}
    </div>
  );
}

export default function ForecastChart({ forecast, history, arima, google }: ForecastChartProps) {
  const t = useT();
  const points: ChartPoint[] = [];

  // Last 12 measured hours, then the 24-hour projection. Keys are unique so
  // the "Now" marker can sit exactly between the two.
  const recentHistory = [...history]
    .filter((reading) => reading.sensor_pm25 !== null)
    .sort((a, b) => Date.parse(a.sampledAt) - Date.parse(b.sampledAt))
    .slice(-12);

  recentHistory.forEach((reading, index) => {
    const label = `${String(getIstHour(new Date(reading.sampledAt))).padStart(2, "0")}:00`;
    points.push({ key: `h${index}`, label, actual: Math.round(reading.sensor_pm25 as number) });
  });

  const nowKey = points.length ? points[points.length - 1].key : undefined;
  // The projection starts from the last measured value so the lines join.
  if (points.length) points[points.length - 1].predicted = points[points.length - 1].actual;

  forecast.forecast.forEach((point, index) => {
    points.push({
      key: `f${index}`,
      label: point.hour,
      predicted: point.predicted_pm25,
      arima: valueAt(arima, point.time),
      google: valueAt(google, point.time),
    });
  });

  const maxValue = Math.max(
    80,
    ...points.map((point) => Math.max(point.actual ?? 0, point.predicted ?? 0, point.arima ?? 0, point.google ?? 0)),
  );
  const labelByKey = new Map(points.map((point) => [point.key, point.label]));

  return (
    <div className="fc-chart">
      <ResponsiveContainer width="100%" height={320}>
        <ComposedChart data={points} margin={{ top: 16, right: 12, left: -8, bottom: 4 }}>
          <defs>
            <linearGradient id="fcActualFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={COLOR.predicted} stopOpacity={0.16} />
              <stop offset="100%" stopColor={COLOR.predicted} stopOpacity={0} />
            </linearGradient>
          </defs>

          <CartesianGrid stroke={COLOR.grid} vertical={false} />

          <XAxis
            dataKey="key"
            tickFormatter={(key: string) => labelByKey.get(key) ?? ""}
            tick={{ fontSize: 11, fill: COLOR.axis }}
            tickLine={false}
            axisLine={{ stroke: "rgba(16, 26, 21, 0.12)" }}
            interval={2}
            dy={6}
          />
          <YAxis
            domain={[0, Math.ceil((maxValue * 1.12) / 50) * 50]}
            tick={{ fontSize: 11, fill: COLOR.axis }}
            tickLine={false}
            axisLine={false}
            width={44}
          />

          <Tooltip content={<ChartTooltip />} cursor={{ stroke: "rgba(16, 26, 21, 0.18)", strokeWidth: 1 }} />

          <ReferenceLine
            y={60}
            stroke="#c9a45e"
            strokeDasharray="2 4"
            label={{ value: t("forecast_chart_legend_naaqs"), fontSize: 10, fill: "#8a6a2e", position: "insideTopLeft" }}
          />
          <ReferenceLine
            y={15}
            stroke="#9fc5a7"
            strokeDasharray="2 4"
            label={{ value: t("forecast_chart_legend_who"), fontSize: 10, fill: "#4f7a58", position: "insideTopLeft" }}
          />
          {nowKey && (
            <ReferenceLine
              x={nowKey}
              stroke="rgba(16, 26, 21, 0.35)"
              label={{ value: t("fc_chart_now"), fontSize: 10, fill: COLOR.actual, position: "top" }}
            />
          )}

          <Area
            type="monotone"
            dataKey="actual"
            stroke={COLOR.actual}
            strokeWidth={2}
            fill="url(#fcActualFill)"
            dot={false}
            activeDot={{ r: 4, fill: COLOR.actual, stroke: "#fff", strokeWidth: 2 }}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="predicted"
            stroke={COLOR.predicted}
            strokeWidth={2}
            strokeDasharray="6 4"
            dot={false}
            activeDot={{ r: 4, fill: COLOR.predicted, stroke: "#fff", strokeWidth: 2 }}
            connectNulls
            isAnimationActive={false}
          />
          {arima?.length ? (
            <Line
              type="monotone"
              dataKey="arima"
              stroke={COLOR.arima}
              strokeWidth={1.6}
              dot={false}
              connectNulls
              isAnimationActive={false}
            />
          ) : null}
          {google?.length ? (
            <Line
              type="monotone"
              dataKey="google"
              stroke={COLOR.google}
              strokeWidth={1.6}
              strokeDasharray="1 3"
              strokeLinecap="round"
              dot={false}
              connectNulls
              isAnimationActive={false}
            />
          ) : null}
        </ComposedChart>
      </ResponsiveContainer>

      <ul className="fc-legend">
        <li>
          <span className="fc-swatch" style={{ borderTopColor: COLOR.actual }} />
          {t("forecast_chart_legend_actual")}
        </li>
        <li>
          <span className="fc-swatch is-dashed" style={{ borderTopColor: COLOR.predicted }} />
          {t("forecast_chart_legend_forecast")}
        </li>
        {arima?.length ? (
          <li>
            <span className="fc-swatch" style={{ borderTopColor: COLOR.arima }} />
            {t("forecast_legend_arima")}
          </li>
        ) : null}
        {google?.length ? (
          <li>
            <span className="fc-swatch is-dotted" style={{ borderTopColor: COLOR.google }} />
            {t("forecast_legend_google")}
          </li>
        ) : null}
      </ul>
    </div>
  );
}
