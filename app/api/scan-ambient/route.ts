import { NextResponse } from "next/server";
import { scanCityAmbientHotspots, type AmbientScanSummary } from "@/lib/ambientScan";
import { findCity } from "@/lib/cities";

export const runtime = "nodejs";

// A full scan walks every station in one city and queries Earth Engine per
// cell, then writes to Firestore — expensive, and this route is public. The
// cooldown applies to every anonymous caller, per city. Forcing a fresh scan
// requires CRON_SECRET (the same secret /api/cron/tick uses):
// `Authorization: Bearer <secret>`. The scheduler scans every city.
const COOLDOWN_MS = 5 * 60 * 1000;
const lastRun = new Map<string, { at: number; result: AmbientScanSummary }>();
const inFlight = new Map<string, Promise<AmbientScanSummary>>();

function isAuthorizedForce(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const city = findCity(url.searchParams.get("city") ?? "delhi");
  if (!city) return NextResponse.json({ error: "Unknown city." }, { status: 400 });

  const force = url.searchParams.get("force") === "1" && isAuthorizedForce(request);
  const previous = lastRun.get(city.id);
  if (!force && previous && Date.now() - previous.at < COOLDOWN_MS) {
    return NextResponse.json({ ...previous.result, cached: true });
  }

  try {
    // Concurrent dashboard loads share one scan instead of starting several.
    let pending = inFlight.get(city.id);
    if (!pending) {
      pending = scanCityAmbientHotspots(city).finally(() => inFlight.delete(city.id));
      inFlight.set(city.id, pending);
    }
    const result = await pending;
    lastRun.set(city.id, { at: Date.now(), result });
    return NextResponse.json({ ...result, cached: false });
  } catch (error) {
    console.error("[/api/scan-ambient]", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Ambient scan failed" },
      { status: 500 },
    );
  }
}
