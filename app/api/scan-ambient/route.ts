import { NextResponse } from "next/server";
import { scanAmbientHotspots } from "@/lib/ambientScan";

export const runtime = "nodejs";

// A full scan walks every Delhi CPCB station and queries Earth Engine per
// cell, then writes to Firestore — expensive, and this route is public. The
// cooldown applies to every anonymous caller (previously it was skipped
// whenever the last scan promoted nothing, and `?force=1` bypassed it for
// anyone). Forcing a fresh scan requires CRON_SECRET (the same secret
// /api/cron/tick uses): `Authorization: Bearer <secret>`.
const COOLDOWN_MS = 5 * 60 * 1000;
let lastRunAt = 0;
let lastResult: Awaited<ReturnType<typeof scanAmbientHotspots>> | null = null;
let inFlight: Promise<Awaited<ReturnType<typeof scanAmbientHotspots>>> | null = null;

function isAuthorizedForce(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(request: Request) {
  const now = Date.now();
  const force =
    new URL(request.url).searchParams.get("force") === "1" && isAuthorizedForce(request);

  if (!force && lastResult && now - lastRunAt < COOLDOWN_MS) {
    return NextResponse.json({ ...lastResult, cached: true });
  }

  try {
    // Concurrent dashboard loads share one scan instead of starting several.
    inFlight ??= scanAmbientHotspots().finally(() => {
      inFlight = null;
    });
    const result = await inFlight;
    lastRunAt = Date.now();
    lastResult = result;
    return NextResponse.json({ ...result, cached: false });
  } catch (error) {
    console.error("[/api/scan-ambient]", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Ambient scan failed" },
      { status: 500 },
    );
  }
}
