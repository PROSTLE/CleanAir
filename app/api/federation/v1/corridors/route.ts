import { NextResponse } from "next/server";
import { FEDERATION_CACHE_HEADERS } from "@/lib/server/federation";
import { getCorridorOutlook } from "@/lib/server/corridors";
import { enforceRateLimit, getClientIp, handleRoute } from "@/lib/server/http";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * 48-h PM2.5 outlook along India's economic corridors: every waypoint's
 * calibrated hourly forecast, its worst 24-h window, ventilation and any
 * fire smoke arriving, plus a risk level per segment.
 */
export async function GET(request: Request) {
  return handleRoute(async () => {
    await enforceRateLimit("federation", getClientIp(request), 60, 60 * 1000);
    const result = await getCorridorOutlook();
    return NextResponse.json(
      {
        ...result,
        method:
          "CAMS PM2.5/PM10 forecast (Open-Meteo, ~40 km), scaled to the live-station median in monitored cities (ratio clamped 0.5–2.5); " +
          "risk is the India AQI band of the worst 24-h mean in the next 48 h; ventilation index = 10 m wind × boundary-layer height, " +
          "below 6000 m²/s is unfavourable (IMD); fire smoke = FIRMS clusters whose forward trajectory reaches the waypoint within 36 h.",
      },
      { status: result.error ? 503 : 200, headers: FEDERATION_CACHE_HEADERS },
    );
  });
}
