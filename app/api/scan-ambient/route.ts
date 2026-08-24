import { NextResponse } from "next/server";
import { scanAmbientHotspots } from "@/lib/ambientScan";

export const runtime = "nodejs";

// In-process cooldown — Earth Engine responses are already cached 3h per
// cell, but this avoids kicking off a redundant scan on every Command
// Center mount within the same server instance.
const COOLDOWN_MS = 60 * 1000;
let lastRunAt = 0;
let lastResult: Awaited<ReturnType<typeof scanAmbientHotspots>> | null = null;

export async function GET(request: Request) {
  const now = Date.now();
  const force = new URL(request.url).searchParams.get("force") === "1";
  if (!force && lastResult && lastResult.promoted.length > 0 && now - lastRunAt < COOLDOWN_MS) {
    return NextResponse.json({ ...lastResult, cached: true });
  }

  try {
    const result = await scanAmbientHotspots();
    lastRunAt = now;
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
