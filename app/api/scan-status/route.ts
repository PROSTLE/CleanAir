import { NextResponse } from "next/server";
import { findCity } from "@/lib/cities";
import { adminDb } from "@/lib/firebaseAdmin";

export const runtime = "nodejs";

/**
 * When the automatic station + satellite scan last ran for a city and what it
 * checked, as recorded by the scan itself (lib/ambientScan.ts). Null when the
 * city has never been scanned.
 */
export async function GET(request: Request) {
  const city = findCity(new URL(request.url).searchParams.get("city"));
  if (!city) return NextResponse.json({ error: "Unknown city." }, { status: 400 });
  try {
    const doc = await adminDb.collection("system").doc(`ambientScan-${city.id}`).get();
    const data = doc.data();
    const at = data?.at?.toDate?.() as Date | undefined;
    return NextResponse.json(
      {
        cityId: city.id,
        lastScan: at
          ? {
              at: at.toISOString(),
              scanned: Number(data?.scanned ?? 0),
              stations: Number(data?.stations ?? 0),
              promoted: Number(data?.promoted ?? 0),
              watching: Number(data?.watching ?? 0),
            }
          : null,
      },
      { headers: { "Cache-Control": "public, max-age=60" } },
    );
  } catch (error) {
    return NextResponse.json(
      { cityId: city.id, lastScan: null, error: error instanceof Error ? error.message : String(error) },
      { status: 503 },
    );
  }
}
