import { NextResponse } from "next/server";
import {
  forecastPM25,
  generateMockHistory,
  DELHI_H3_CELLS,
  type SensorReading,
} from "@/lib/forecastEngine";

export const runtime = "nodejs";

const BIGQUERY_TABLE =
  process.env.BIGQUERY_FORECAST_TABLE ??
  "cleanair-clear-streets.cleanair_analytics.delhi_historical_pm25";

function getBigQueryClientOptions(projectId: string) {
  const clientEmail = process.env.BIGQUERY_CLIENT_EMAIL;
  const privateKey = process.env.BIGQUERY_PRIVATE_KEY?.replace(/\\n/g, "\n");

  if (clientEmail && privateKey) {
    return {
      projectId,
      credentials: {
        client_email: clientEmail,
        private_key: privateKey,
      },
    };
  }

  return { projectId };
}

// ─── Optional BigQuery fetch ────────────────────────────────────────────────
// If GOOGLE_APPLICATION_CREDENTIALS or BIGQUERY_PROJECT_ID is set in env,
// we attempt to pull real historical data. Otherwise we fall back to the
// deterministic mock generator so the demo is always fast.

async function fetchFromBigQuery(
  h3CellId: string,
  locationLabel: string
): Promise<SensorReading[] | null> {
  const projectId = process.env.BIGQUERY_PROJECT_ID;
  if (!projectId) return null;

  try {
    // Use Function() to hide the import from Turbopack/webpack static analysis.
    // This means no build-time warning when @google-cloud/bigquery is not installed.
    // At runtime, if the package doesn't exist, the catch below handles it gracefully.
    // eslint-disable-next-line no-new-func
    const dynamicImport = new Function("pkg", "return import(pkg)");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bqModule = (await dynamicImport("@google-cloud/bigquery")) as any;
    const bq = new bqModule.BigQuery(getBigQueryClientOptions(projectId));

    const query = `
  SELECT
    FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%E3SZ', sampledAt) AS sampledAt,
    COALESCE(NULLIF(h3CellId, ''), @h3CellId) AS h3CellId,
    location_label,
    location_lat,
    location_lng,
    sensor_pm25,
    sensor_pm10,
    sensor_no2,
    sensor_so2,
    sensor_co,
    sensor_nh3,
    sensor_ozone
  FROM (
    SELECT
      sampledAt,
      h3CellId,
      location_label,
      location_lat,
      location_lng,
      sensor_pm25,
      sensor_pm10,
      sensor_no2,
      sensor_so2,
      sensor_co,
      sensor_nh3,
      sensor_ozone
    FROM \`${BIGQUERY_TABLE}\`
    WHERE (
        h3CellId = @h3CellId
        OR LOWER(TRIM(location_label)) = LOWER(TRIM(@locationLabel))
      )
      AND sensor_pm25 IS NOT NULL
    ORDER BY sampledAt DESC
    LIMIT 72
  )
  ORDER BY sampledAt ASC
`;

    const [rows] = await bq.query({
      query,
      params: { h3CellId, locationLabel },
    });
    return rows as SensorReading[];
  } catch (err) {
    console.error("[forecast] BigQuery error detail:", (err as { message?: string }).message, (err as { code?: string }).code);
    console.error("[forecast] BigQuery fetch failed, falling back to mock:", err);
    return null;
  }
}

// ─── Route handler ─────────────────────────────────────────────────────────

export async function GET(request: Request) {
  const url = new URL(request.url);
  const h3CellId = url.searchParams.get("h3CellId")?.trim();

  console.log("[forecast] BigQuery project:", process.env.BIGQUERY_PROJECT_ID ?? "(not set)");
  console.log("[forecast] BigQuery table:", BIGQUERY_TABLE);

  if (!h3CellId) {
    return NextResponse.json(
      {
        error:
          "Missing required query parameter: h3CellId. Example: /api/forecast?h3CellId=872a100edffffff",
      },
      { status: 400 }
    );
  }

  // Find known cell metadata (or build a default)
  const knownCell = DELHI_H3_CELLS.find((c) => c.h3CellId === h3CellId);
  const cellLabel = knownCell?.label ?? `Cell ${h3CellId}`;
  const bigQueryLabel = knownCell?.bigQueryLabel ?? cellLabel;
  const cellLat = knownCell?.lat ?? 28.6139;
  const cellLng = knownCell?.lng ?? 77.209;

  // Attempt BigQuery, fall back to mock
  let history: SensorReading[];
  let source: "bigquery" | "mock";

  const bqData = await fetchFromBigQuery(h3CellId, bigQueryLabel);

  if (bqData && bqData.length >= 3) {
    console.log(`[forecast] BigQuery fetch succeeded — ${bqData.length} rows for ${h3CellId}`);
    history = bqData;
    source = "bigquery";
  } else {
    console.log(`[forecast] Using mock data for ${h3CellId} (BigQuery unavailable or returned no rows)`);
    history = generateMockHistory(h3CellId, cellLabel, cellLat, cellLng, 72);
    source = "mock";
  }

  const result = forecastPM25(history);

  return NextResponse.json(
    { ...result, history, source },
    {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
      },
    }
  );
}