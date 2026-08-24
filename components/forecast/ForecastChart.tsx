"use client";

import {
  AreaChart,
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
import { getAQIInfo } from "@/lib/forecastEngine";
import { useT } from "@/lib/languageContext";

interface ForecastChartProps {
  forecast: ForecastResult;
  history: SensorReading[];
}

interface ChartPoint {
  label: string;
  actual?: number;
  predicted?: number;
  confidenceBand?: number;
  confidenceUpper?: number;
  confidenceLower?: number;
}

// ─── Custom glassmorphic tooltip ─────────────────────────────────────────
function CustomTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string; payload: ChartPoint }>;
  label?: string;
}) {
  const t = useT();
  if (!active || !payload?.length) return null;

  const pointData = payload[0]?.payload;
  const isForecast = pointData?.predicted !== undefined;
  const pmValue = isForecast ? pointData.predicted : pointData?.actual;
  const aqi = pmValue !== undefined ? getAQIInfo(pmValue) : null;

  return (
    <div className="forecast-custom-tooltip">
      <div className="tooltip-header">
        <span className="tooltip-time-badge">{label}</span>
        <span className={`tooltip-type-pill ${isForecast ? "forecast-type" : "actual-type"}`}>
          {isForecast ? "24h Forecast" : "Recorded Sensor"}
        </span>
      </div>

      <div className="tooltip-body">
        <div className="tooltip-main-metric">
          <span className="tooltip-metric-val" style={{ color: aqi?.color || "#101a15" }}>
            {pmValue}
          </span>
          <span className="tooltip-metric-unit">µg/m³ PM2.5</span>
        </div>

        {aqi && (
          <div className="tooltip-aqi-tag" style={{ borderColor: aqi.color, color: aqi.color }}>
            <span className="tooltip-aqi-dot" style={{ background: aqi.color }} />
            {aqi.category}
          </div>
        )}
      </div>

      {isForecast && pointData.confidenceBand && (
        <div className="tooltip-footer">
          <span>Confidence Variance:</span>
          <strong>±{pointData.confidenceBand} µg/m³</strong>
        </div>
      )}
    </div>
  );
}

// ─── Glowing confidence dot renderer ─────────────────────────────────────
function ConfidenceDot(props: {
  cx?: number;
  cy?: number;
  payload?: ChartPoint;
}) {
  const { cx, cy, payload } = props;
  if (!payload?.predicted || cx === undefined || cy === undefined) return null;

  const aqi = getAQIInfo(payload.predicted);
  return (
    <g>
      <circle cx={cx} cy={cy} r={6} fill={aqi.color} opacity={0.25} />
      <circle cx={cx} cy={cy} r={3.5} fill={aqi.color} stroke="#ffffff" strokeWidth={1.5} />
    </g>
  );
}

export default function ForecastChart({ forecast, history }: ForecastChartProps) {
  const t = useT();
  const points: ChartPoint[] = [];

  // Historical actuals — last 12 readings (1 per hour)
  const recentHistory = [...history]
    .sort((a, b) => new Date(a.sampledAt).getTime() - new Date(b.sampledAt).getTime())
    .slice(-12);

  for (const r of recentHistory) {
    if (r.sensor_pm25 === null) continue;
    const d = new Date(r.sampledAt);
    const label = `${String(d.getHours()).padStart(2, "0")}:00`;
    points.push({ label, actual: Math.round(r.sensor_pm25) });
  }

  // Bridge point between actual and forecast for seamless graph continuity
  if (points.length > 0 && forecast.forecast.length > 0) {
    const lastActual = points[points.length - 1];
    // Attach starting prediction value to last historical hour so line connects smoothly
    lastActual.predicted = lastActual.actual;
  }

  // Forecast points
  for (const f of forecast.forecast) {
    const band =
      f.confidence === "high"
        ? Math.round(f.predicted_pm25 * 0.1)
        : f.confidence === "medium"
        ? Math.round(f.predicted_pm25 * 0.2)
        : Math.round(f.predicted_pm25 * 0.35);

    points.push({
      label: f.hour,
      predicted: f.predicted_pm25,
      confidenceBand: band,
      confidenceUpper: f.predicted_pm25 + band,
      confidenceLower: Math.max(0, f.predicted_pm25 - band),
    });
  }

  const maxVal = Math.max(
    ...points.map((p) => p.actual ?? 0),
    ...points.map((p) => (p.predicted ?? 0) + (p.confidenceBand ?? 0)),
    80
  );

  return (
    <div className="forecast-chart-card">
      <div className="forecast-chart-canvas-wrap">
        <ResponsiveContainer width="100%" height={320}>
          <AreaChart data={points} margin={{ top: 20, right: 24, left: 0, bottom: 8 }}>
            <defs>
              <linearGradient id="actualGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#117c72" stopOpacity={0.28} />
                <stop offset="95%" stopColor="#117c72" stopOpacity={0.0} />
              </linearGradient>
              <linearGradient id="forecastGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#6366f1" stopOpacity={0.22} />
                <stop offset="95%" stopColor="#6366f1" stopOpacity={0.0} />
              </linearGradient>
            </defs>

            <CartesianGrid
              strokeDasharray="3 3"
              stroke="rgba(16, 26, 21, 0.07)"
              vertical={false}
            />

            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: "#6d7b73", fontWeight: 600 }}
              tickLine={false}
              axisLine={{ stroke: "rgba(16, 26, 21, 0.1)" }}
              interval={2}
              dy={6}
            />

            <YAxis
              domain={[0, Math.ceil(maxVal * 1.15 / 50) * 50]}
              tick={{ fontSize: 11, fill: "#6d7b73", fontWeight: 600 }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v) => `${v}`}
              width={42}
            />

            <Tooltip content={<CustomTooltip />} />

            {/* WHO Guideline Standard (15 µg/m³) */}
            <ReferenceLine
              y={15}
              stroke="#22c55e"
              strokeDasharray="4 4"
              strokeWidth={1.5}
              label={{
                value: "WHO Guideline (15 µg/m³)",
                fontSize: 10,
                fill: "#15803d",
                fontWeight: 700,
                position: "insideBottomRight",
                dy: -4,
              }}
            />

            {/* National Ambient Air Quality Standard (60 µg/m³) */}
            <ReferenceLine
              y={60}
              stroke="#eab308"
              strokeDasharray="4 4"
              strokeWidth={1.5}
              label={{
                value: "India NAAQS Standard (60 µg/m³)",
                fontSize: 10,
                fill: "#a16207",
                fontWeight: 700,
                position: "insideBottomRight",
                dy: -4,
              }}
            />

            {/* Historical Actuals Area & Line */}
            <Area
              type="monotone"
              dataKey="actual"
              name="actual"
              stroke="#117c72"
              strokeWidth={3}
              fill="url(#actualGradient)"
              activeDot={{ r: 6, fill: "#117c72", stroke: "#ffffff", strokeWidth: 2 }}
              connectNulls={false}
            />

            {/* Forecast Area & Dotted Line */}
            <Area
              type="monotone"
              dataKey="predicted"
              name="predicted"
              stroke="#6366f1"
              strokeWidth={2.5}
              strokeDasharray="5 4"
              fill="url(#forecastGradient)"
              dot={<ConfidenceDot />}
              activeDot={{ r: 6, fill: "#6366f1", stroke: "#ffffff", strokeWidth: 2 }}
              connectNulls
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Enhanced Chart Legend */}
      <div className="forecast-chart-legend-bar">
        <div className="legend-group">
          <div className="legend-chip">
            <span className="legend-bullet" style={{ background: "#117c72" }} />
            <span className="legend-text">{t("forecast_chart_legend_actual")}</span>
          </div>

          <div className="legend-chip">
            <span className="legend-dashed-bullet" />
            <span className="legend-text">{t("forecast_chart_legend_forecast")}</span>
          </div>
        </div>

        <div className="legend-group">
          <div className="legend-chip threshold-who">
            <span className="legend-bullet" style={{ background: "#22c55e" }} />
            <span className="legend-text">{t("forecast_chart_legend_who")}</span>
          </div>

          <div className="legend-chip threshold-naaqs">
            <span className="legend-bullet" style={{ background: "#eab308" }} />
            <span className="legend-text">{t("forecast_chart_legend_naaqs")}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
