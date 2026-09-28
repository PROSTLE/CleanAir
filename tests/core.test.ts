import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { cellToLatLng, isValidCell } from "h3-js";
import { rankUpwindSources } from "@/lib/attribution";
import { parseExif } from "@/lib/exif";
import {
  backtestHeuristic,
  DELHI_H3_CELLS,
  forecastPM25,
  getIstHour,
  getLocalHour,
  type SensorReading,
} from "@/lib/forecastEngine";
import { computeFusionConfidence } from "@/lib/fusionConfidence";
import { isPollutionClassification, parseClassification } from "@/lib/geminiClassifier";
import { angularDifferenceDeg, bearingDeg, getH3CellId, haversineKm } from "@/lib/geo";
import { CITIES, cityForPoint, isInOperationalRegion, resolveCityForPoint } from "@/lib/cities";
import {
  checkStoredSatelliteSupport,
  checkStoredSensorSupport,
  determineTier,
  parseSensorTimestamp,
} from "@/lib/supportEvidence";
import { PM10_BREAKPOINTS, PM25_BREAKPOINTS, usAqiToConcentration } from "@/lib/usAqi";

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Point `km` away from (lat, lng) along `bearing` degrees (small-distance approximation). */
function offset(lat: number, lng: number, bearing: number, km: number) {
  const rad = (bearing * Math.PI) / 180;
  const dLat = (km * Math.cos(rad)) / 111.32;
  const dLng = (km * Math.sin(rad)) / (111.32 * Math.cos((lat * Math.PI) / 180));
  return { lat: lat + dLat, lng: lng + dLng };
}

function hourlySeries(hours: number, valueAt: (index: number) => number, endMs = Date.parse("2026-09-25T06:00:00Z")) {
  return Array.from({ length: hours }, (_, index): SensorReading => ({
    sampledAt: new Date(endMs - (hours - 1 - index) * 3_600_000).toISOString(),
    h3CellId: "883da1149bfffff",
    location_label: "Test station",
    location_lat: 28.64,
    location_lng: 77.31,
    sensor_pm25: valueAt(index),
    sensor_pm10: null,
    sensor_no2: null,
    sensor_so2: null,
    sensor_co: null,
    sensor_nh3: null,
    sensor_ozone: null,
  }));
}

const ITO = { lat: 28.6292, lng: 77.241 };

// ─── geo ─────────────────────────────────────────────────────────────────────

describe("geo", () => {
  it("computes compass bearings", () => {
    assert.ok(Math.abs(bearingDeg(28, 77, 29, 77) - 0) < 0.5);
    assert.ok(Math.abs(bearingDeg(28, 77, 28, 78) - 90) < 1);
  });

  it("wraps angular differences", () => {
    assert.equal(angularDifferenceDeg(350, 10), 20);
    assert.equal(angularDifferenceDeg(90, 270), 180);
  });

  it("measures distance", () => {
    const point = offset(ITO.lat, ITO.lng, 45, 5);
    assert.ok(Math.abs(haversineKm(ITO.lat, ITO.lng, point.lat, point.lng) - 5) < 0.05);
  });

  it("refuses to invent an H3 cell for missing coordinates", () => {
    assert.throws(() => getH3CellId({ lat: "", lng: "" }));
    assert.equal(getH3CellId({ lat: "28.6292", lng: "77.241" }).length, 15);
  });
});

// ─── attribution ─────────────────────────────────────────────────────────────

describe("upwind attribution", () => {
  const upwind = { name: "Upwind landfill", kind: "landfill" as const, ...offset(ITO.lat, ITO.lng, 315, 4) };
  const downwind = { name: "Downwind plant", kind: "industrial_area" as const, ...offset(ITO.lat, ITO.lng, 135, 4) };
  const farUpwind = { name: "Too far", kind: "industrial_area" as const, ...offset(ITO.lat, ITO.lng, 315, 25) };

  it("ranks only sources lying upwind within range", () => {
    const result = rankUpwindSources({
      ...ITO,
      wind: { fromDeg: 315, speedMs: 3 },
      candidates: [upwind, downwind, farUpwind],
    });
    assert.equal(result.mode, "upwind");
    assert.deepEqual(result.sources.map((source) => source.name), ["Upwind landfill"]);
    assert.ok(result.sources[0].offWindDeg !== null && result.sources[0].offWindDeg <= 2);
  });

  it("falls back to proximity when the wind is calm", () => {
    const near = { name: "Near dump", kind: "landfill" as const, ...offset(ITO.lat, ITO.lng, 135, 1) };
    const result = rankUpwindSources({ ...ITO, wind: { fromDeg: 315, speedMs: 0.4 }, candidates: [near, upwind] });
    assert.equal(result.mode, "calm");
    assert.deepEqual(result.sources.map((source) => source.name), ["Near dump"]);
    assert.equal(result.sources[0].offWindDeg, null);
  });

  it("counts regional fires upwind (stubble-burning case)", () => {
    const punjabFire = offset(ITO.lat, ITO.lng, 310, 250);
    const eastFire = offset(ITO.lat, ITO.lng, 100, 250);
    const result = rankUpwindSources({
      ...ITO,
      wind: { fromDeg: 315, speedMs: 4 },
      candidates: [],
      fires: [punjabFire, eastFire],
    });
    assert.equal(result.regionalUpwindFires, 1);
  });
});

// ─── cities ──────────────────────────────────────────────────────────────────

describe("cities", () => {
  it("places each capital's centre inside its own boundary", () => {
    for (const city of CITIES) {
      assert.equal(cityForPoint(city.center.lat, city.center.lng)?.id, city.id, city.name);
    }
  });

  it("keeps boundaries apart and excludes the sea and neighbours", () => {
    // Noida (Uttar Pradesh) is outside Delhi NCT but still uses Delhi's data.
    assert.equal(cityForPoint(28.5355, 77.391), null);
    assert.equal(resolveCityForPoint(28.5355, 77.391)?.id, "delhi");
    // Open sea north of Jakarta (Kepulauan Seribu extent was trimmed).
    assert.equal(cityForPoint(-5.8, 106.6), null);
    // Nowhere near any monitored city.
    assert.equal(resolveCityForPoint(0, 0), null);
    assert.equal(isInOperationalRegion(Number.NaN, 77.2), false);
  });

  it("closes every boundary ring for GeoJSON", () => {
    for (const city of CITIES) {
      for (const ring of city.boundary) {
        assert.deepEqual(ring[0], ring[ring.length - 1], city.name);
      }
    }
  });
});

describe("stored sensor support", () => {
  const base = {
    source: "WAQI" as const,
    distanceKm: 0.8,
    primaryDelta: 120,
    pm25Delta: 120,
    trend: "insufficient_data" as const,
  };

  it("accepts a fresh, nearby exceedance from any network", () => {
    assert.equal(checkStoredSensorSupport("smog", { ...base, lastUpdated: new Date().toISOString() }), true);
  });

  it("rejects a stale WAQI reading, like a stale CPCB one", () => {
    const stale = new Date(Date.now() - 3 * 24 * 3_600_000).toISOString();
    assert.equal(checkStoredSensorSupport("smog", { ...base, lastUpdated: stale }), false);
    assert.equal(checkStoredSensorSupport("smog", { ...base, source: "CPCB", lastUpdated: stale }), false);
  });
});

describe("US AQI conversion (WAQI)", () => {
  it("inverts the 2012 EPA PM2.5 breakpoints", () => {
    assert.equal(usAqiToConcentration(50, PM25_BREAKPOINTS), 12);
    assert.equal(usAqiToConcentration(100, PM25_BREAKPOINTS), 35.4);
    assert.equal(usAqiToConcentration(151, PM25_BREAKPOINTS), 55.5);
    assert.equal(usAqiToConcentration(0, PM25_BREAKPOINTS), 0);
  });

  it("inverts PM10 and rejects unusable values", () => {
    assert.equal(usAqiToConcentration(100, PM10_BREAKPOINTS), 154);
    assert.equal(usAqiToConcentration(-3, PM10_BREAKPOINTS), null);
    assert.equal(usAqiToConcentration(undefined, PM10_BREAKPOINTS), null);
  });
});

// ─── forecast ────────────────────────────────────────────────────────────────

describe("forecast engine", () => {
  it("computes hour-of-day in IST regardless of server timezone", () => {
    assert.equal(getIstHour(new Date("2026-09-25T00:00:00Z")), 5);
    assert.equal(getIstHour(new Date("2026-09-25T18:30:00Z")), 0);
  });

  it("computes hour-of-day in each city's time zone", () => {
    const instant = new Date("2026-09-25T00:00:00Z");
    assert.equal(getLocalHour(instant, "Asia/Shanghai"), 8);
    assert.equal(getLocalHour(instant, "Europe/Moscow"), 3);
    assert.equal(getLocalHour(instant, "America/Sao_Paulo"), 21);
    assert.equal(getLocalHour(instant, "Asia/Kolkata"), 5);
  });

  it("uses real Delhi H3 cells", () => {
    const ids = DELHI_H3_CELLS.map((cell) => cell.h3CellId);
    assert.equal(new Set(ids).size, ids.length);
    for (const cell of DELHI_H3_CELLS) {
      assert.ok(isValidCell(cell.h3CellId), cell.h3CellId);
      assert.ok(isInOperationalRegion(cell.lat, cell.lng), `${cell.label} should be inside Delhi NCT`);
      const [lat, lng] = cellToLatLng(cell.h3CellId);
      assert.ok(haversineKm(lat, lng, cell.lat, cell.lng) < 1, `${cell.label} hexagon should contain its zone`);
    }
  });

  it("refuses to forecast without data", () => {
    assert.throws(() => forecastPM25([]));
  });

  it("projects 24 hourly points from the anchor", () => {
    const anchor = new Date("2026-09-25T06:00:00Z");
    const result = forecastPM25(hourlySeries(48, () => 120), { anchor });
    assert.equal(result.forecast.length, 24);
    assert.equal(result.forecast[0].time, "2026-09-25T07:00:00.000Z");
    assert.equal(result.forecast[0].hour, "12:00");
    assert.equal(result.historyEnd, "2026-09-25T06:00:00.000Z");
  });

  it("backtests against held-out readings and a persistence baseline", () => {
    const result = backtestHeuristic(hourlySeries(60, (index) => 100 + 30 * Math.sin(index / 4)));
    assert.ok(result);
    assert.equal(result.evaluatedPoints, 12);
    assert.ok(Number.isFinite(result.maeHeuristic) && result.maeHeuristic >= 0);
    assert.ok(Number.isFinite(result.maePersistence) && result.maePersistence >= 0);
    assert.equal(backtestHeuristic(hourlySeries(20, () => 90)), null);
  });
});

// ─── classifier contract ─────────────────────────────────────────────────────

describe("Gemini classification parsing", () => {
  it("accepts JSON followed by stray prose and clamps values", () => {
    const parsed = parseClassification(
      '{"type":"smoke","severity":7,"confidence":1.4,"authenticity":"camera_photo","description":"Grey plume."} extra words',
    );
    assert.equal(parsed.severity, 5);
    assert.equal(parsed.confidence, 1);
    assert.equal(parsed.authenticity, "camera_photo");
    assert.ok(isPollutionClassification(parsed));
  });

  it("defaults unknown authenticity to unsure and rejects unknown types", () => {
    const parsed = parseClassification('{"type":"clear","severity":0,"confidence":0.9,"description":"Blue sky."}');
    assert.equal(parsed.authenticity, "unsure");
    assert.equal(isPollutionClassification(parsed), false);
    assert.throws(() => parseClassification('{"type":"volcano","severity":3,"confidence":0.5,"description":"x"}'));
  });
});

// ─── evidence rules ──────────────────────────────────────────────────────────

describe("evidence and promotion rules", () => {
  it("parses CPCB IST timestamps (day-first) to the right instant", () => {
    assert.equal(parseSensorTimestamp("25-09-2026 13:00:00"), Date.parse("2026-09-25T07:30:00Z"));
  });

  it("treats a nearby FIRMS fire as satellite support for fire reports only", () => {
    const satellite = {
      source: "Earth Engine" as const,
      signal: "",
      lastPassTime: "",
      freshness: "fresh" as const,
      firmsFireCount: 2,
      firmsNearestKm: 1.2,
    };
    assert.equal(checkStoredSatelliteSupport(satellite, "fire"), true);
    assert.equal(checkStoredSatelliteSupport(satellite, "dust"), false);
    assert.equal(checkStoredSatelliteSupport({ ...satellite, firmsNearestKm: 4 }, "fire"), false);
  });

  it("promotes on independent evidence, never on nothing", () => {
    assert.equal(determineTier({ reportCount: 1, sensorSupported: false, satelliteSupported: false }), null);
    assert.equal(determineTier({ reportCount: 3, sensorSupported: false, satelliteSupported: false }), "crowd_verified");
    assert.equal(determineTier({ reportCount: 1, sensorSupported: false, satelliteSupported: true }), "citizen_satellite_confirmed");
  });

  it("renormalises fusion weights over sources that actually reported", () => {
    const visualOnly = computeFusionConfidence({ visualScore: 80, sensorScore: null, satelliteScore: null, corroborationScore: null });
    assert.equal(visualOnly.finalConfidence, 80);
    assert.equal(visualOnly.visualWeight, 1);
    const withSensor = computeFusionConfidence({ visualScore: 80, sensorScore: 40, satelliteScore: null, corroborationScore: null });
    assert.ok(Math.abs(withSensor.visualWeight + withSensor.sensorWeight - 1) < 1e-9);
    assert.equal(withSensor.satelliteWeight, 0);
  });
});

// ─── EXIF ────────────────────────────────────────────────────────────────────

describe("EXIF integrity metadata", () => {
  const load = (name: string) => {
    const bytes = readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  };

  it("reads capture time and GPS from a camera JPEG", () => {
    const meta = parseExif(load("exif-gps.jpg"));
    assert.ok(meta.takenAt);
    assert.ok(meta.lat !== null && Math.abs(meta.lat - 28.62407) < 1e-4);
    assert.ok(meta.lng !== null && Math.abs(meta.lng - 77.3159) < 1e-4);
  });

  it("returns empty metadata when there is none", () => {
    assert.deepEqual(parseExif(load("no-exif.jpg")), { takenAt: null, lat: null, lng: null });
    assert.deepEqual(parseExif(new Uint8Array([1, 2, 3, 4]).buffer), { takenAt: null, lat: null, lng: null });
  });
});
