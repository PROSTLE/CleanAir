import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { advisoryToCap, buildCapAtomFeed, buildCapXml, capDateTime, escapeXml, hotspotToCap } from "@/lib/cap";
import { getCity } from "@/lib/cities";
import {
  MIN_CLUSTER_FIRES,
  advisoryLevel,
  buildAdvisories,
  cityTarget,
  clusterFires,
  sameRegion,
  sourceBounds,
  summarizeBySourceState,
  traceTrajectory,
  windAt,
  type SourcePlace,
  type WindStation,
} from "@/lib/transboundary";

const delhi = getCity("delhi");
const NOW = new Date("2026-10-27T06:00:00Z");
// Sangrur, Punjab: ~230 km north-west of Delhi.
const SANGRUR = { lat: 30.25, lng: 75.84 };

function uniformField(fromDeg: number, speedMs: number, hours = 48): WindStation[] {
  const series = Array.from({ length: hours }, () => ({ fromDeg, speedMs }));
  return [
    { lat: delhi.center.lat, lng: delhi.center.lng, hours: series },
    { lat: SANGRUR.lat, lng: SANGRUR.lng, hours: series },
  ];
}

function firesAround(center: { lat: number; lng: number }, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    lat: center.lat + ((i % 5) - 2) * 0.004,
    lng: center.lng + (Math.floor(i / 5) - 2) * 0.004,
  }));
}

describe("transboundary clustering", () => {
  it("ignores fires inside the city and clusters below the minimum size", () => {
    const fires = [
      ...firesAround(delhi.center, 20),
      ...firesAround({ lat: 29.5, lng: 74.0 }, MIN_CLUSTER_FIRES - 1),
      ...firesAround(SANGRUR, 12),
    ];
    const clusters = clusterFires(fires, delhi);
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].fireCount, 12);
    assert.ok(clusters[0].distanceKm > 200 && clusters[0].distanceKm < 260);
  });

  it("covers about 400 km around the city", () => {
    const [minLng, minLat, maxLng, maxLat] = sourceBounds(delhi);
    assert.ok(minLat < 25.1 && maxLat > 32.1);
    assert.ok(minLng < 73.2 && maxLng > 81.2);
  });
});

describe("transboundary trajectory", () => {
  it("carries smoke from Punjab to Delhi on a north-westerly", () => {
    const trajectory = traceTrajectory(SANGRUR, cityTarget(delhi), uniformField(315, 4));
    assert.ok(trajectory.arrivalHours !== null);
    assert.ok(trajectory.arrivalHours > 8 && trajectory.arrivalHours < 24, `eta ${trajectory.arrivalHours}`);
    assert.deepEqual(trajectory.path[0], [SANGRUR.lng, SANGRUR.lat]);
  });

  it("does not arrive when the wind blows the other way", () => {
    const trajectory = traceTrajectory(SANGRUR, cityTarget(delhi), uniformField(135, 4));
    assert.equal(trajectory.arrivalHours, null);
    assert.ok(trajectory.closestKm > 200);
  });

  it("does not arrive in calm air within the horizon", () => {
    assert.equal(traceTrajectory(SANGRUR, cityTarget(delhi), uniformField(315, 0.3)).arrivalHours, null);
  });

  it("interpolates wind between stations", () => {
    const field: WindStation[] = [
      { lat: 28, lng: 77, hours: [{ fromDeg: 0, speedMs: 4 }] },
      { lat: 30, lng: 77, hours: [{ fromDeg: 0, speedMs: 2 }] },
    ];
    const wind = windAt(field, 29, 77, 0);
    assert.ok(wind);
    // North wind: air moves south (negative v), at the average speed midway.
    assert.ok(Math.abs(wind.v + 3) < 1e-9);
    assert.ok(Math.abs(wind.u) < 1e-9);
  });
});

describe("transboundary advisories", () => {
  const places = new Map<string, SourcePlace>();

  it("levels by fire count and arrival time", () => {
    assert.equal(advisoryLevel(150, 12), "severe");
    assert.equal(advisoryLevel(150, 30), "high");
    assert.equal(advisoryLevel(40, 20), "high");
    assert.equal(advisoryLevel(12, 40), "moderate");
    assert.equal(advisoryLevel(4, 10), "watch");
  });

  it("builds an inter-state advisory and a source-state summary", () => {
    const clusters = clusterFires(firesAround(SANGRUR, 25), delhi);
    places.set(clusters[0].key, { district: "Sangrur", state: "Punjab", country: "India" });
    const advisories = buildAdvisories({
      city: delhi,
      clusters,
      field: uniformField(315, 4),
      places,
      cityState: delhi.region,
      now: NOW,
    });
    assert.equal(advisories.length, 1);
    const [advisory] = advisories;
    assert.equal(advisory.source.label, "Sangrur, Punjab");
    assert.equal(advisory.interState, true);
    assert.equal(advisory.level, "moderate");
    assert.match(advisory.id, /^tb-delhi-30p0_75p5-2026102706$/);
    assert.ok(Date.parse(advisory.arrivesAt) > NOW.getTime());

    const summary = summarizeBySourceState(advisories);
    assert.equal(summary.length, 1);
    assert.equal(summary[0].state, "Punjab");
    assert.equal(summary[0].fireCount, 25);
    assert.deepEqual(summary[0].affectedCities.map((entry) => entry.cityId), ["delhi"]);
  });

  it("treats Delhi and Delhi NCT as the same region", () => {
    assert.ok(sameRegion("Delhi", "Delhi NCT"));
    assert.ok(!sameRegion("Punjab", "Delhi NCT"));
    assert.ok(!sameRegion("Haryana", "Delhi NCT"));
  });
});

describe("CAP 1.2", () => {
  it("writes UTC as -00:00 without fractional seconds", () => {
    assert.equal(capDateTime(new Date("2026-10-27T06:30:15.123Z")), "2026-10-27T06:30:15-00:00");
  });

  it("escapes XML special characters", () => {
    assert.equal(escapeXml(`A & B <"c">'`), "A &amp; B &lt;&quot;c&quot;&gt;&apos;");
  });

  it("produces an alert with elements in schema order", () => {
    const clusters = clusterFires(firesAround(SANGRUR, 120), delhi);
    const places = new Map([[clusters[0].key, { district: "Sangrur", state: "Punjab", country: "India" }]]);
    const [advisory] = buildAdvisories({ city: delhi, clusters, field: uniformField(315, 4), places, cityState: delhi.region, now: NOW });
    const xml = buildCapXml(
      advisoryToCap(advisory, { sender: "vayusetu@example.org", web: "https://example.org/federation", cityCenter: delhi.center }),
    );
    assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">/);
    const order = ["<identifier>", "<sender>", "<sent>", "<status>", "<msgType>", "<scope>", "<info>"].map((tag) => xml.indexOf(tag));
    assert.deepEqual([...order].sort((a, b) => a - b), order);
    assert.ok(order.every((index) => index >= 0));
    const infoOrder = ["<language>", "<category>", "<event>", "<responseType>", "<urgency>", "<severity>", "<certainty>", "<onset>", "<expires>", "<senderName>", "<headline>", "<description>", "<instruction>", "<web>", "<parameter>", "<area>"].map((tag) => xml.indexOf(tag));
    assert.deepEqual([...infoOrder].sort((a, b) => a - b), infoOrder);
    assert.match(xml, /<severity>Severe<\/severity>/);
    assert.match(xml, /<certainty>Possible<\/certainty>/);
    assert.match(xml, /<circle>30\.2\d+,75\.8\d+ 30<\/circle>/);
    assert.doesNotMatch(xml, /Z<\//);
  });

  it("marks an operator-verified hotspot as observed", () => {
    const xml = buildCapXml(
      hotspotToCap(
        {
          id: "8828308281fffff-fire",
          cityName: "New Delhi",
          lat: 28.7,
          lng: 77.05,
          hazardType: "fire",
          tier: "crowd_verified",
          severity: "critical",
          status: "verified",
          confidencePct: 84,
          updatedAt: NOW,
        },
        { sender: "vayusetu@example.org", web: "https://example.org/zone/x" },
      ),
    );
    assert.match(xml, /<identifier>vayusetu-inc-8828308281fffff-fire<\/identifier>/);
    assert.match(xml, /<certainty>Observed<\/certainty>/);
    assert.match(xml, /<event>Open burning<\/event>/);
  });

  it("builds an Atom index linking to CAP documents", () => {
    const feed = buildCapAtomFeed({
      id: "urn:vayusetu:cap:delhi",
      title: "VayuSetu alerts — New Delhi",
      selfUrl: "https://example.org/api/federation/v1/cap?city=delhi",
      updated: NOW,
      entries: [{ id: "tb-1", title: "Smoke & haze", updated: NOW, summary: "s", capUrl: "https://example.org/cap/tb-1" }],
    });
    assert.match(feed, /<feed xmlns="http:\/\/www.w3.org\/2005\/Atom">/);
    assert.match(feed, /<title>Smoke &amp; haze<\/title>/);
    assert.match(feed, /type="application\/cap\+xml" href="https:\/\/example.org\/cap\/tb-1"/);
  });
});
