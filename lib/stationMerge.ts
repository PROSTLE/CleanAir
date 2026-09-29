// Merging station feeds, kept free of server-only imports so it can be
// unit-tested (lib/stations.ts does the fetching).
import { haversineKm } from "@/lib/geo";
import type { StationReading } from "@/lib/stations";
import { parseSensorTimestamp } from "@/lib/supportEvidence";

// Two feeds relaying the same monitor publish coordinates a few metres apart.
const SAME_MONITOR_KM = 0.25;
// Some feeds place the same monitor several hundred metres apart (Delhi's DPCC
// stations differ by 260–400 m between OpenAQ and WAQI). An offline pin that
// close to a live station from another feed is dropped: it is almost always
// the same monitor, and a live reading sits right there either way.
const OFFLINE_SHADOW_KM = 0.6;

export function hasUsablePollutantData(station: StationReading) {
  return [station.pm25, station.pm10, station.no2, station.so2, station.co, station.nh3, station.ozone].some(
    (value) => value !== null,
  );
}

function readingMs(station: StationReading) {
  return parseSensorTimestamp(station.lastUpdated) ?? 0;
}

/**
 * Merges feeds given in order of preference. When two feeds carry the same
 * monitor, the live one wins, then the newer reading, then the preferred feed.
 */
export function mergeStationFeeds(feeds: StationReading[][]): StationReading[] {
  const merged: StationReading[] = [];
  for (const feed of feeds) {
    for (const raw of feed) {
      const station = raw.stale ? { ...raw, pm25: null, pm10: null, no2: null, so2: null, co: null, nh3: null, ozone: null } : raw;
      if (!station.stale && !hasUsablePollutantData(station)) continue;
      const twin = merged.findIndex(
        (other) => haversineKm(other.lat, other.lng, station.lat, station.lng) <= SAME_MONITOR_KM,
      );
      if (twin === -1) {
        merged.push(station);
        continue;
      }
      const current = merged[twin];
      const better =
        current.stale !== station.stale ? !station.stale : readingMs(station) > readingMs(current);
      if (better) merged[twin] = station;
    }
  }
  return merged.filter(
    (station) =>
      !station.stale ||
      !merged.some(
        (other) =>
          !other.stale &&
          other.source !== station.source &&
          haversineKm(other.lat, other.lng, station.lat, station.lng) <= OFFLINE_SHADOW_KM,
      ),
  );
}
