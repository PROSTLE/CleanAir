-- BigQuery setup for VayuSetu. Replace `your-project` with BIGQUERY_PROJECT_ID
-- and run once:  bq query --use_legacy_sql=false < scripts/setup-bigquery.sql
--
-- Location: Delhi data is best kept in asia-south1 (Mumbai) or asia-south2
-- (Delhi); the model and tables must share the dataset's location.

CREATE SCHEMA IF NOT EXISTS `your-project.cleanair_analytics`
OPTIONS (location = 'asia-south1');

-- Live CPCB readings appended by /api/cron/tick (lib/server/bigqueryLive.ts).
-- Partitioned by day so forecast reads only scan recent partitions.
CREATE TABLE IF NOT EXISTS `your-project.cleanair_analytics.cpcb_live_readings` (
  sampledAt TIMESTAMP NOT NULL,     -- CPCB "last_update", converted from IST
  ingestedAt TIMESTAMP,
  h3CellId STRING,                  -- H3 resolution 8
  location_label STRING,            -- CPCB station name
  location_lat FLOAT64,
  location_lng FLOAT64,
  sensor_pm25 FLOAT64,
  sensor_pm10 FLOAT64,
  sensor_no2 FLOAT64,
  sensor_so2 FLOAT64,
  sensor_co FLOAT64,
  sensor_nh3 FLOAT64,
  sensor_ozone FLOAT64
)
PARTITION BY DATE(sampledAt)
CLUSTER BY location_label
OPTIONS (partition_expiration_days = 400);

-- Historical archive (optional). Load ml/delhi_historical_snapshots.csv from
-- ml/data-prep.py (Kaggle "Air Quality Data in India", 2015–2020) into
-- `your-project.cleanair_analytics.delhi_historical_pm25`. Its columns already
-- match what the forecast reads:
--   sampledAt, h3CellId, location_label, location_lat, location_lng,
--   sensor_pm25, sensor_pm10, sensor_no2, sensor_so2, sensor_co, sensor_nh3, sensor_ozone
-- The forecast uses it only when a station has no live history, and the UI
-- labels that output as archived data.

-- The ARIMA_PLUS model (`pm25_arima`) is created and retrained by
-- /api/cron/tick once ≥ 7 days of live readings exist; nothing to do here.
