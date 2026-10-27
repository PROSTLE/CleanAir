import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CITIES } from "@/lib/cities";
import {
  CORRIDORS,
  POOR_VENTILATION_M2S,
  buildCorridorOutlook,
  computeOutlook,
  corridorBounds,
  levelForPm25,
  uniqueWaypoints,
  type WaypointInputs,
} from "@/lib/corridors";

const flat = (value: number, hours = 48) => Array.from({ length: hours }, () => value);

function inputs(overrides: Partial<WaypointInputs> = {}): WaypointInputs {
  return {
    pm25: flat(40),
    pm10: flat(80),
    windSpeedMs: flat(3),
    boundaryLayerM: flat(2500),
    stationPm25: null,
    stationCount: 0,
    smoke: null,
    ...overrides,
  };
}

describe("corridor config", () => {
  it("points every calibrating waypoint at a real monitored city", () => {
    const ids = new Set(CITIES.map((city) => city.id));
    for (const waypoint of uniqueWaypoints()) {
      if (waypoint.cityId) assert.ok(ids.has(waypoint.cityId), waypoint.id);
    }
  });

  it("shares Delhi and Bengaluru between corridors", () => {
    const all = CORRIDORS.flatMap((corridor) => corridor.waypoints).length;
    assert.equal(uniqueWaypoints().length, all - 2);
  });

  it("pads the corridor box for upwind fires", () => {
    const [minLng, minLat, maxLng, maxLat] = corridorBounds(CORRIDORS.find((corridor) => corridor.id === "akic")!);
    assert.ok(minLng < 73 && maxLng > 90 && minLat < 21 && maxLat > 33);
  });
});

describe("waypoint outlook", () => {
  it("returns null with no forecast at all", () => {
    assert.equal(computeOutlook(inputs({ pm25: flat(NaN).map(() => null) })), null);
  });

  it("scales the model to the live stations, within limits", () => {
    const calibrated = computeOutlook(inputs({ stationPm25: 80, stationCount: 6 }))!;
    assert.deepEqual(calibrated.calibration, { factor: 2, stations: 6 });
    assert.equal(calibrated.pm25[10], 80);
    const clamped = computeOutlook(inputs({ stationPm25: 400, stationCount: 1 }))!;
    assert.equal(clamped.calibration?.factor, 2.5);
    assert.equal(computeOutlook(inputs())!.calibration, null);
  });

  it("finds the worst 24-h window and flags a spike", () => {
    const rising = [...flat(40, 24), ...flat(130, 24)];
    const outlook = computeOutlook(inputs({ pm25: rising }))!;
    assert.equal(outlook.now24hMean, 40);
    assert.equal(outlook.peak24hMean, 130);
    assert.equal(outlook.peakWindowStartHours, 24);
    assert.equal(outlook.level, "very_poor");
    assert.ok(outlook.spike);
    assert.ok(outlook.drivers.includes("rising"));
  });

  it("does not call a steady clean day a spike", () => {
    const outlook = computeOutlook(inputs({ pm25: [...flat(10, 24), ...flat(20, 24)] }))!;
    assert.equal(outlook.spike, false);
    assert.equal(outlook.level, "good");
  });

  it("flags poor ventilation below the IMD threshold", () => {
    const stagnant = computeOutlook(inputs({ windSpeedMs: flat(1), boundaryLayerM: flat(300) }))!;
    assert.ok(stagnant.ventilation.peak24hM2s! < POOR_VENTILATION_M2S);
    assert.ok(stagnant.ventilation.poor);
    assert.equal(stagnant.ventilation.poorHours24h, 24);
    assert.ok(stagnant.drivers.includes("stagnation"));
    assert.equal(computeOutlook(inputs())!.ventilation.poor, false);
    // Calm nights don't count: one well-mixed afternoon is enough.
    const night = Array.from({ length: 48 }, (_, h) => (h % 24 >= 8 && h % 24 <= 11 ? 2500 : 80));
    assert.equal(computeOutlook(inputs({ boundaryLayerM: night }))!.ventilation.poor, false);
  });

  it("carries fire smoke through as a driver", () => {
    const outlook = computeOutlook(inputs({ smoke: { firePixels: 60, etaHours: 12, sources: 3 } }))!;
    assert.ok(outlook.drivers.includes("smoke"));
  });

  it("bands PM2.5 like India's AQI", () => {
    assert.equal(levelForPm25(30), "good");
    assert.equal(levelForPm25(61), "moderate");
    assert.equal(levelForPm25(121), "very_poor");
    assert.equal(levelForPm25(251), "severe");
  });
});

describe("corridor outlook", () => {
  it("colours each segment by its worse end and counts hotspots", () => {
    const corridor = CORRIDORS.find((entry) => entry.id === "cbic")!;
    const outlooks = new Map(
      corridor.waypoints.map((waypoint, index) => [
        waypoint.id,
        computeOutlook(inputs({ pm25: flat(index === 2 ? 110 : 25) })),
      ]),
    );
    const outlook = buildCorridorOutlook(corridor, outlooks);
    assert.equal(outlook.segments.length, corridor.waypoints.length - 1);
    assert.equal(outlook.segments[1].level, "poor");
    assert.equal(outlook.segments[2].level, "poor");
    assert.equal(outlook.segments[0].level, "good");
    assert.equal(outlook.hotspots, 1);
    assert.equal(outlook.worst?.waypointId, corridor.waypoints[2].id);
  });
});
