import "server-only";

import { addDoc, collection, serverTimestamp } from "firebase/firestore";
import type { NearbyStationReading } from "@/lib/cpcbSensor";
import type { SatelliteDataResult } from "@/lib/earthEngineSatellite";
import { db, isFirebaseConfigured } from "@/lib/firebase";
import { getH3CellId } from "@/lib/reportSubmissions";
import type { WindData } from "@/lib/openWeather";

export type PollutionSnapshotInput = {
  lat: number;
  lng: number;
  locationLabel?: string | null;
  sourceContext: "report_classification" | "manual_poll";
  reportId?: string | null;
  sensor: NearbyStationReading | null;
  satellite: SatelliteDataResult | null;
  wind: WindData | null;
};

function serializeSensor(sensor: NearbyStationReading | null) {
  if (!sensor) return null;

  return {
    co: sensor.co,
    distanceKm: sensor.distanceKm,
    lastUpdated: sensor.lastUpdated,
    nh3: sensor.nh3,
    no2: sensor.no2,
    ozone: sensor.ozone,
    pm10: sensor.pm10,
    pm25: sensor.pm25,
    so2: sensor.so2,
    source: sensor.source,
    stationName: sensor.stationName,
  };
}

function serializeSatellite(satellite: SatelliteDataResult | null) {
  if (!satellite) return null;

  return {
    aerosolIndex: {
      anomalyScore: satellite.aerosolIndex.anomalyScore,
      baselineValue: satellite.aerosolIndex.baselineValue,
      chronicScore: satellite.aerosolIndex.chronicScore,
      rawValue: satellite.aerosolIndex.rawValue,
    },
    anomalyScore: satellite.anomalyScore,
    cacheKey: satellite.cacheKey,
    cached: satellite.cached,
    computedAt: satellite.computedAt,
    error: satellite.error ?? null,
    hazardWeights: {
      fireDustSmoke: satellite.hazardWeights.fireDustSmoke,
      industrialTraffic: satellite.hazardWeights.industrialTraffic,
    },
    no2: {
      anomalyScore: satellite.no2.anomalyScore,
      baselineValue: satellite.no2.baselineValue,
      chronicScore: satellite.no2.chronicScore,
      rawValue: satellite.no2.rawValue,
    },
    rawValue: satellite.rawValue,
    source: satellite.source,
    timestamp: satellite.timestamp,
    windowEnd: satellite.windowEnd,
    windowStart: satellite.windowStart,
  };
}

function serializeWind(wind: WindData | null) {
  if (!wind) return null;

  return {
    fetchedAt: wind.fetchedAt,
    humidityPct: wind.humidityPct,
    source: wind.source,
    temperatureC: wind.temperatureC,
    windDegrees: wind.windDegrees,
    windGustMs: wind.windGustMs,
    windSpeedMs: wind.windSpeedMs,
  };
}

export async function recordPollutionSnapshot(input: PollutionSnapshotInput) {
  try {
    if (!isFirebaseConfigured || !db) {
      return { id: null, stored: false, reason: "Firebase is not configured." };
    }
    if (!Number.isFinite(input.lat) || !Number.isFinite(input.lng)) {
      return { id: null, stored: false, reason: "lat and lng must be valid numbers." };
    }

    const h3CellId = getH3CellId({
      label: input.locationLabel ?? "Pollution snapshot",
      lat: String(input.lat),
      lng: String(input.lng),
    });
    const docRef = await addDoc(collection(db, "pollutionSnapshots"), {
      createdAt: serverTimestamp(),
      h3CellId,
      location: {
        label: input.locationLabel ?? null,
        lat: input.lat,
        lng: input.lng,
      },
      reportId: input.reportId ?? null,
      sampledAt: new Date().toISOString(),
      satellite: serializeSatellite(input.satellite),
      sensor: serializeSensor(input.sensor),
      sourceContext: input.sourceContext,
      wind: serializeWind(input.wind),
    });

    return { id: docRef.id, stored: true, reason: null };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Unknown snapshot error.";
    console.warn("Could not record pollution snapshot", reason);
    return { id: null, stored: false, reason };
  }
}
