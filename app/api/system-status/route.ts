import { NextResponse } from "next/server";

/**
 * Reports which server-side integrations are actually wired up.
 *
 * Returns booleans only — never the key values themselves. The dashboard uses
 * this to show a real "not configured" state instead of rendering zeros that
 * would read as genuine measurements. Each check mirrors what the integration
 * actually reads; a green chip on an unrelated env var hides a broken pipeline.
 */
export const dynamic = "force-dynamic";

function configured(...vars: string[]): boolean {
  return vars.every((name) => Boolean(process.env[name]?.trim()));
}

function configuredAny(...vars: string[]): boolean {
  return vars.some((name) => Boolean(process.env[name]?.trim()));
}

export async function GET() {
  return NextResponse.json({
    checkedAt: new Date().toISOString(),
    integrations: {
      gemini: configured("GEMINI_API_KEY"),
      cpcb: configured("CPCB_API_KEY"),
      // Station feed for every capital except Delhi.
      waqi: configured("WAQI_API_TOKEN"),
      // Open-Meteo needs no key.
      weather: true,
      // BigQuery authenticates as the app's service account (or explicit
      // BIGQUERY_* credentials); the project ID is required.
      bigQuery: configured("BIGQUERY_PROJECT_ID"),
      // Earth Engine uses the app's service account unless a dedicated key is set.
      earthEngine: configuredAny("EARTH_ENGINE_SERVICE_ACCOUNT_KEY", "FIREBASE_SERVICE_ACCOUNT_KEY"),
      googleAirQuality: configured("GOOGLE_AIR_QUALITY_API_KEY"),
      places: configured("GOOGLE_PLACES_API_KEY"),
      speechToText: configured("GOOGLE_SPEECH_API_KEY"),
      imageUpload: configured("IMGBB_API_KEY"),
      whatsappNotify: configured("TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_WHATSAPP_FROM"),
      operatorAuth: configured("OPERATOR_EMAILS"),
      scheduler: configured("CRON_SECRET"),
      appCheck: process.env.APP_CHECK_ENFORCE === "true",
      firebaseAdmin: configuredAny(
        "FIREBASE_SERVICE_ACCOUNT_KEY",
        "GOOGLE_CLOUD_PROJECT",
        "GCP_PROJECT",
        "GCLOUD_PROJECT",
      ),
    },
  });
}
