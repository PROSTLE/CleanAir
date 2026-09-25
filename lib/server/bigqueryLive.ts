import "server-only";

import { BigQuery } from "@google-cloud/bigquery";
import type { NearbyStationReading } from "@/lib/cpcbSensor";
import type { SensorReading } from "@/lib/forecastEngine";
import { getH3CellId } from "@/lib/geo";
import { parseSensorTimestamp } from "@/lib/supportEvidence";

// Tables live in one dataset; see scripts/setup-bigquery.sql for the DDL.
//   archive  – historical CPCB hourly data (Kaggle 2015–2020, via ml/data-prep.py)
//   live     – CPCB readings appended by /api/cron/tick every run
//   model    – BigQuery ML ARIMA_PLUS model trained on the live table
function projectId() {
  return process.env.BIGQUERY_PROJECT_ID?.trim() || null;
}

export function isBigQueryConfigured() {
  return projectId() !== null;
}

function datasetPrefix() {
  return `${projectId()}.${process.env.BIGQUERY_DATASET ?? "cleanair_analytics"}`;
}

export function archiveTable() {
  return process.env.BIGQUERY_FORECAST_TABLE ?? `${datasetPrefix()}.delhi_historical_pm25`;
}

export function liveTable() {
  return process.env.BIGQUERY_LIVE_TABLE ?? `${datasetPrefix()}.cpcb_live_readings`;
}

export function arimaModel() {
  return process.env.BIGQUERY_ARIMA_MODEL ?? `${datasetPrefix()}.pm25_arima`;
}

let client: BigQuery | null = null;

function getClient() {
  const project = projectId();
  if (!project) throw new Error("BIGQUERY_PROJECT_ID is not set.");
  if (client) return client;

  const clientEmail = process.env.BIGQUERY_CLIENT_EMAIL;
  const privateKey = process.env.BIGQUERY_PRIVATE_KEY?.replace(/\\n/g, "\n");
  client = new BigQuery(
    clientEmail && privateKey
      ? { projectId: project, credentials: { client_email: clientEmail, private_key: privateKey } }
      : // Application Default Credentials (runtime service account).
        { projectId: project },
  );
  return client;
}

function splitTableId(fullyQualified: string) {
  const [project, dataset, table] = fullyQualified.split(".");
  if (!project || !dataset || !table) {
    throw new Error(`Expected project.dataset.table, got "${fullyQualified}".`);
  }
  return { dataset, table };
}

const READING_COLUMNS = `
    location_label,
    location_lat,
    location_lng,
    sensor_pm25,
    sensor_pm10,
    sensor_no2,
    sensor_so2,
    sensor_co,
    sensor_nh3,
    sensor_ozone`;

// ─── Ingestion ────────────────────────────────────────────────────────────────

/**
 * Appends the current CPCB snapshot. insertId (station + source timestamp)
 * lets BigQuery drop retries; reads also de-duplicate per station-hour, so a
 * station that hasn't refreshed since the last tick doesn't skew history.
 */
export async function insertLiveReadings(stations: NearbyStationReading[]) {
  const { dataset, table } = splitTableId(liveTable());
  const rows = stations
    .map((station) => {
      const sampledAtMs = parseSensorTimestamp(station.lastUpdated);
      if (sampledAtMs === null || station.pm25 === null) return null;
      return {
        insertId: `${station.stationName}|${station.lastUpdated}`,
        json: {
          sampledAt: new Date(sampledAtMs).toISOString(),
          ingestedAt: new Date().toISOString(),
          h3CellId: getH3CellId({ lat: station.lat, lng: station.lng }),
          location_label: station.stationName,
          location_lat: station.lat,
          location_lng: station.lng,
          sensor_pm25: station.pm25,
          sensor_pm10: station.pm10,
          sensor_no2: station.no2,
          sensor_so2: station.so2,
          sensor_co: station.co,
          sensor_nh3: station.nh3,
          sensor_ozone: station.ozone,
        },
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  if (rows.length === 0) return { inserted: 0 };
  await getClient().dataset(dataset).table(table).insert(rows, { raw: true, skipInvalidRows: true });
  return { inserted: rows.length };
}

// ─── History ──────────────────────────────────────────────────────────────────

export async function queryLiveHistory(stationLabel: string, hours = 72): Promise<SensorReading[]> {
  const [rows] = await getClient().query({
    query: `
      SELECT
        FORMAT_TIMESTAMP('%Y-%m-%dT%H:00:00Z', hour_ts) AS sampledAt,
        * EXCEPT (hour_ts)
      FROM (
        SELECT
          TIMESTAMP_TRUNC(sampledAt, HOUR) AS hour_ts,
          ANY_VALUE(h3CellId) AS h3CellId,
          ANY_VALUE(location_label) AS location_label,
          ANY_VALUE(location_lat) AS location_lat,
          ANY_VALUE(location_lng) AS location_lng,
          AVG(sensor_pm25) AS sensor_pm25,
          AVG(sensor_pm10) AS sensor_pm10,
          AVG(sensor_no2) AS sensor_no2,
          AVG(sensor_so2) AS sensor_so2,
          AVG(sensor_co) AS sensor_co,
          AVG(sensor_nh3) AS sensor_nh3,
          AVG(sensor_ozone) AS sensor_ozone
        FROM \`${liveTable()}\`
        WHERE location_label = @stationLabel
          AND sampledAt >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @hours HOUR)
          AND sensor_pm25 IS NOT NULL
        GROUP BY hour_ts
      )
      ORDER BY hour_ts ASC`,
    params: { stationLabel, hours },
  });
  return rows as SensorReading[];
}

export async function queryArchiveHistory(h3CellId: string, locationLabel: string): Promise<SensorReading[]> {
  const [rows] = await getClient().query({
    query: `
      SELECT * FROM (
        SELECT
          FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%E3SZ', sampledAt) AS sampledAt,
          COALESCE(NULLIF(h3CellId, ''), @h3CellId) AS h3CellId,
          ${READING_COLUMNS}
        FROM \`${archiveTable()}\`
        WHERE (
            h3CellId = @h3CellId
            OR LOWER(TRIM(location_label)) = LOWER(TRIM(@locationLabel))
          )
          AND sensor_pm25 IS NOT NULL
        ORDER BY sampledAt DESC
        LIMIT 72
      )
      ORDER BY sampledAt ASC`,
    params: { h3CellId, locationLabel },
  });
  return rows as SensorReading[];
}

// ─── BigQuery ML ──────────────────────────────────────────────────────────────

export const ARIMA_TRAINING_DAYS = 30;
export const ARIMA_MIN_TRAINING_ROWS = 24 * 7;

export async function countLiveTrainingRows() {
  const [rows] = await getClient().query({
    query: `
      SELECT COUNT(DISTINCT CONCAT(location_label, CAST(TIMESTAMP_TRUNC(sampledAt, HOUR) AS STRING))) AS n
      FROM \`${liveTable()}\`
      WHERE sampledAt >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${ARIMA_TRAINING_DAYS} DAY)`,
  });
  return Number((rows as Array<{ n: number }>)[0]?.n ?? 0);
}

/**
 * (Re)trains one ARIMA_PLUS model per station from the live table. Starts a
 * query job and returns immediately; training runs inside BigQuery.
 */
export async function startArimaTraining() {
  const [job] = await getClient().createQueryJob({
    query: `
      CREATE OR REPLACE MODEL \`${arimaModel()}\`
      OPTIONS (
        model_type = 'ARIMA_PLUS',
        time_series_timestamp_col = 'ts',
        time_series_data_col = 'pm25',
        time_series_id_col = 'station',
        data_frequency = 'HOURLY',
        auto_arima = TRUE,
        clean_spikes_and_dips = TRUE
      ) AS
      SELECT
        TIMESTAMP_TRUNC(sampledAt, HOUR) AS ts,
        location_label AS station,
        AVG(sensor_pm25) AS pm25
      FROM \`${liveTable()}\`
      WHERE sampledAt >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${ARIMA_TRAINING_DAYS} DAY)
        AND sensor_pm25 IS NOT NULL
      GROUP BY ts, station`,
  });
  return { jobId: job.id ?? null };
}

export type ArimaPoint = { time: string; value: number; lower: number; upper: number };

export async function arimaForecast(stationLabel: string, horizonHours = 24): Promise<ArimaPoint[]> {
  const [rows] = await getClient().query({
    query: `
      SELECT
        FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', forecast_timestamp) AS time,
        forecast_value AS value,
        prediction_interval_lower_bound AS lower,
        prediction_interval_upper_bound AS upper
      FROM ML.FORECAST(MODEL \`${arimaModel()}\`, STRUCT(@horizon AS horizon, 0.8 AS confidence_level))
      WHERE station = @stationLabel
      ORDER BY forecast_timestamp`,
    params: { horizon: horizonHours, stationLabel },
  });
  return (rows as Array<{ time: string; value: number; lower: number; upper: number }>).map((row) => ({
    time: row.time,
    value: Math.max(0, Math.round(row.value)),
    lower: Math.max(0, Math.round(row.lower)),
    upper: Math.max(0, Math.round(row.upper)),
  }));
}
