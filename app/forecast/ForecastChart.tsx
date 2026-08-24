"use client";

import {
  AreaChart,
  Area,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

import { hourlyForecast } from "./forecastData";

export default function ForecastChart() {
  return (
    <section className="forecast-chart-card">
      <div className="forecast-chart-header">
        <div>
          <p>24-Hour Prediction</p>
          <h2>AI AQI Forecast</h2>
        </div>

        <span>Powered by Gemini + BigQuery</span>
      </div>

      <ResponsiveContainer width="100%" height={340}>
        <AreaChart data={hourlyForecast}>
          <defs>
            <linearGradient id="forecastGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#14b8a6" stopOpacity={0.6} />
              <stop offset="100%" stopColor="#14b8a6" stopOpacity={0} />
            </linearGradient>
          </defs>

          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />

          <XAxis dataKey="time" />

          <YAxis />

          <Tooltip />

          <Area
            type="monotone"
            dataKey="aqi"
            stroke="#14b8a6"
            strokeWidth={3}
            fill="url(#forecastGradient)"
          />
        </AreaChart>
      </ResponsiveContainer>
    </section>
  );
} 