import { NextResponse } from "next/server";

/**
 * Reports which server-side integrations are actually wired up.
 *
 * Returns booleans only — never the key values themselves. The dashboard uses
 * this to show a real "not configured" state instead of rendering zeros that
 * would read as genuine measurements.
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
      openWeather: configured("OPENWEATHER_API_KEY"),
      bigQuery: configured("BIGQUERY_PROJECT_ID", "BIGQUERY_CLIENT_EMAIL", "BIGQUERY_PRIVATE_KEY"),
      earthEngine: configuredAny("FIREBASE_SERVICE_ACCOUNT_KEY", "GOOGLE_CLOUD_PROJECT", "GCP_PROJECT", "GCLOUD_PROJECT"),
      speechToText: configured("GOOGLE_SPEECH_API_KEY"),
      imageUpload: configured("IMGBB_API_KEY"),
    },
  });
}
