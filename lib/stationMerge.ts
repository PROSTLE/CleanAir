// Merging station feeds, kept free of server-only imports so it can be
// unit-tested (lib/stations.ts does the fetching).
import { haversineKm } from "@/lib/geo";
import type { HeldBackReading, StationReading } from "@/lib/stations";
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
      const station = raw.stale
        ? { ...raw, pm25: null, pm10: null, no2: null, so2: null, co: null, nh3: null, ozone: null, aqi: null, dominantPollutant: null }
        : raw;
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

// A reading far above every monitor around it is a sensor fault, not air: on
// 27 Oct 2026 Mumbai's AirNow monitor jumped from 83 to 575 µg/m³ PM2.5 while
// the four MPCB stations 1.6–4.3 km away read 41–60. The thresholds sit well
// above the widest real disagreement in the Sep–Oct 2026 station history
// (R.K. Puram, a recurring local source: 4.1× and +157 µg/m³), and hold back
// none of its 7,089 station-hours.
const SCREEN_RADIUS_KM = 5;
const SCREEN_MIN_NEIGHBOURS = 3;
const SCREEN_MIN_RATIO = 5;
const SCREEN_MIN_EXCESS = 150;
const SCREENED: Array<HeldBackReading["pollutant"]> = ["pm25", "pm10"];

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Holds back PM values that sit far above the median of the live monitors
 * around them. The value moves to `heldBack` and the field becomes null, so
 * nothing downstream uses it; the station stays listed with the reason.
 */
export function screenAgainstNeighbours(stations: StationReading[]): StationReading[] {
  return stations.map((station) => {
    if (station.stale) return station;
    const heldBack: HeldBackReading[] = [];
    for (const pollutant of SCREENED) {
      const value = station[pollutant];
      if (value === null) continue;
      const nearby = stations
        .filter(
          (other) =>
            other !== station &&
            !other.stale &&
            other[pollutant] !== null &&
            haversineKm(other.lat, other.lng, station.lat, station.lng) <= SCREEN_RADIUS_KM,
        )
        .map((other) => other[pollutant] as number);
      if (nearby.length < SCREEN_MIN_NEIGHBOURS) continue;
      const neighbourMedian = median(nearby);
      if (value >= SCREEN_MIN_RATIO * neighbourMedian && value - neighbourMedian >= SCREEN_MIN_EXCESS) {
        heldBack.push({ pollutant, value, neighbourMedian: Number(neighbourMedian.toFixed(1)), neighbours: nearby.length });
      }
    }
    if (heldBack.length === 0) return station;
    const withheld = new Set<string>(heldBack.map((entry) => entry.pollutant));
    // A feed's own AQI is built from the same values; drop it when it rests on one withheld.
    const dominant = station.dominantPollutant?.toLowerCase().replace(/[^a-z0-9]/g, "") ?? null;
    const aqiTainted = dominant === null || withheld.has(dominant);
    return {
      ...station,
      pm25: withheld.has("pm25") ? null : station.pm25,
      pm10: withheld.has("pm10") ? null : station.pm10,
      aqi: aqiTainted ? null : station.aqi,
      dominantPollutant: aqiTainted ? null : station.dominantPollutant,
      heldBack,
    };
  });
}
