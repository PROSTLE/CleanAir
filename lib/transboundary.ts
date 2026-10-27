// Transboundary smoke advisories: NASA FIRMS fires outside a city's own
// boundary, grouped into clusters, and a forward trajectory from each cluster
// on the forecast wind to see whether (and when) the smoke reaches the city.
//
// This is a screening estimate, not a dispersion model: one level of wind,
// interpolated between a handful of forecast points, with no plume rise,
// deposition or chemistry. The UI and the CAP feed label it that way.
//
// Pure functions only (no fetches), so the logic is unit-tested in
// tests/transboundary.test.ts and shared by the API routes and the dashboard.
import { isInCity, type CityConfig } from "@/lib/cities";
import { haversineKm } from "@/lib/geo";

/** Fires up to this far from the city centre are considered. */
export const SOURCE_RADIUS_KM = 400;
/** Fires closer than this are local, already covered by upwind attribution. */
export const MIN_SOURCE_DISTANCE_KM = 30;
/** Grid used to group fires into clusters (~55 km, about one district). */
export const CLUSTER_GRID_DEG = 0.5;
/** Clusters with fewer fire pixels are ignored as noise. */
export const MIN_CLUSTER_FIRES = 3;
/** Forecast horizon for the trajectory. */
export const MAX_TRANSPORT_HOURS = 48;
/** Smoke within this distance of the city centre counts as arrived... */
export const ARRIVAL_RADIUS_KM = 20;
/**
 * ...widened as the plume travels: a smoke plume spreads sideways, and the
 * forecast wind direction is only good to several degrees, so a centreline
 * passing 30 km off a city 200 km downwind still reaches it.
 */
export const PLUME_SPREAD_DEG = 8;
const STEPS_PER_HOUR = 4;

export type FirePoint = { lat: number; lng: number; confidence?: number | null };

export type FireCluster = {
  /** Stable key for the grid cell, e.g. "30.0_75.5". */
  key: string;
  lat: number;
  lng: number;
  fireCount: number;
  distanceKm: number;
};

export type WindHour = { speedMs: number; fromDeg: number };

/** Hourly forecast wind at one point; hours[0] is the current hour. */
export type WindStation = { lat: number; lng: number; hours: WindHour[] };

export type Trajectory = {
  /** Hours from now until the smoke is within the arrival radius, or null. */
  arrivalHours: number | null;
  closestKm: number;
  /** [lng, lat] positions, one per hour (GeoJSON order). */
  path: Array<[number, number]>;
};

export type AdvisoryLevel = "severe" | "high" | "moderate" | "watch";

export type SourcePlace = { district: string | null; state: string | null; country: string | null };

export type TransboundaryAdvisory = {
  id: string;
  cityId: string;
  cityName: string;
  level: AdvisoryLevel;
  etaHours: number;
  arrivesAt: string;
  fireCount: number;
  distanceKm: number;
  source: FireCluster & SourcePlace & { label: string };
  /** True when the source lies in a different state/region than the city. */
  interState: boolean;
  path: Array<[number, number]>;
  issuedAt: string;
};

export function clusterKey(lat: number, lng: number) {
  const snap = (value: number) => (Math.floor(value / CLUSTER_GRID_DEG) * CLUSTER_GRID_DEG).toFixed(1);
  return `${snap(lat)}_${snap(lng)}`;
}

/** Bounding box [minLng, minLat, maxLng, maxLat] covering SOURCE_RADIUS_KM around the city. */
export function sourceBounds(city: CityConfig): [number, number, number, number] {
  const { lat, lng } = city.center;
  const dLat = SOURCE_RADIUS_KM / 111;
  const dLng = SOURCE_RADIUS_KM / (111 * Math.cos((lat * Math.PI) / 180));
  const round = (value: number) => Number(value.toFixed(2));
  return [round(lng - dLng), round(lat - dLat), round(lng + dLng), round(lat + dLat)];
}

/**
 * Groups fires outside the city into grid clusters. Fires inside the city
 * boundary or within MIN_SOURCE_DISTANCE_KM of its centre are left to the
 * local upwind attribution (lib/attribution.ts).
 */
export function clusterFires(fires: FirePoint[], city: CityConfig): FireCluster[] {
  const groups = new Map<string, { latSum: number; lngSum: number; count: number }>();
  for (const fire of fires) {
    if (!Number.isFinite(fire.lat) || !Number.isFinite(fire.lng)) continue;
    const distance = haversineKm(city.center.lat, city.center.lng, fire.lat, fire.lng);
    if (distance < MIN_SOURCE_DISTANCE_KM || distance > SOURCE_RADIUS_KM) continue;
    if (isInCity(city, fire.lat, fire.lng)) continue;
    const key = clusterKey(fire.lat, fire.lng);
    const group = groups.get(key) ?? { latSum: 0, lngSum: 0, count: 0 };
    group.latSum += fire.lat;
    group.lngSum += fire.lng;
    group.count += 1;
    groups.set(key, group);
  }
  return [...groups.entries()]
    .filter(([, group]) => group.count >= MIN_CLUSTER_FIRES)
    .map(([key, group]) => {
      const lat = Number((group.latSum / group.count).toFixed(4));
      const lng = Number((group.lngSum / group.count).toFixed(4));
      return {
        key,
        lat,
        lng,
        fireCount: group.count,
        distanceKm: Math.round(haversineKm(city.center.lat, city.center.lng, lat, lng)),
      };
    })
    .sort((a, b) => b.fireCount - a.fireCount);
}

/** Wind vector (m/s) the air moves TOWARDS: u east, v north. */
function toVector(wind: WindHour) {
  const rad = (wind.fromDeg * Math.PI) / 180;
  return { u: -wind.speedMs * Math.sin(rad), v: -wind.speedMs * Math.cos(rad) };
}

/** Inverse-distance-weighted wind at a point for one forecast hour. */
export function windAt(field: WindStation[], lat: number, lng: number, hour: number) {
  let u = 0;
  let v = 0;
  let weightSum = 0;
  for (const station of field) {
    const wind = station.hours[Math.min(hour, station.hours.length - 1)];
    if (!wind || !Number.isFinite(wind.speedMs) || !Number.isFinite(wind.fromDeg)) continue;
    const distance = Math.max(haversineKm(lat, lng, station.lat, station.lng), 1);
    const weight = 1 / distance ** 2;
    const vector = toVector(wind);
    u += vector.u * weight;
    v += vector.v * weight;
    weightSum += weight;
  }
  return weightSum > 0 ? { u: u / weightSum, v: v / weightSum } : null;
}

/** Forward trajectory from a source on the forecast wind field. */
export function traceTrajectory(
  start: { lat: number; lng: number },
  target: CityConfig,
  field: WindStation[],
  maxHours = MAX_TRANSPORT_HOURS,
): Trajectory {
  let { lat, lng } = start;
  let travelledKm = 0;
  const spread = Math.tan((PLUME_SPREAD_DEG * Math.PI) / 180);
  const path: Array<[number, number]> = [[lng, lat]];
  let closestKm = haversineKm(lat, lng, target.center.lat, target.center.lng);
  const stepSeconds = 3600 / STEPS_PER_HOUR;

  for (let hour = 0; hour < maxHours; hour += 1) {
    for (let step = 0; step < STEPS_PER_HOUR; step += 1) {
      const wind = windAt(field, lat, lng, hour);
      if (!wind) return { arrivalHours: null, closestKm: Math.round(closestKm), path };
      lat += (wind.v * stepSeconds) / 1000 / 111;
      lng += (wind.u * stepSeconds) / 1000 / (111 * Math.cos((lat * Math.PI) / 180));
      travelledKm += (Math.hypot(wind.u, wind.v) * stepSeconds) / 1000;
      const distance = haversineKm(lat, lng, target.center.lat, target.center.lng);
      closestKm = Math.min(closestKm, distance);
      if (distance <= ARRIVAL_RADIUS_KM + travelledKm * spread || isInCity(target, lat, lng)) {
        path.push([Number(lng.toFixed(4)), Number(lat.toFixed(4))]);
        const hours = hour + (step + 1) / STEPS_PER_HOUR;
        return { arrivalHours: Number(hours.toFixed(2)), closestKm: Math.round(closestKm), path };
      }
    }
    path.push([Number(lng.toFixed(4)), Number(lat.toFixed(4))]);
  }
  return { arrivalHours: null, closestKm: Math.round(closestKm), path };
}

/**
 * Screening levels from the number of 1 km fire pixels in the cluster and
 * how soon the smoke arrives. Thresholds are a judgement call, not a
 * health standard; the receiving city's own AQI decides the health message.
 */
export function advisoryLevel(fireCount: number, etaHours: number): AdvisoryLevel {
  if (fireCount >= 100 && etaHours <= 24) return "severe";
  if (fireCount >= 30 && etaHours <= 36) return "high";
  if (fireCount >= 10) return "moderate";
  return "watch";
}

const LEVEL_RANK: Record<AdvisoryLevel, number> = { severe: 3, high: 2, moderate: 1, watch: 0 };

export function compareAdvisories(a: TransboundaryAdvisory, b: TransboundaryAdvisory) {
  return LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || a.etaHours - b.etaHours || b.fireCount - a.fireCount;
}

export function placeLabel(place: SourcePlace, cluster: FireCluster) {
  const parts = [place.district, place.state].filter(Boolean);
  return parts.length ? parts.join(", ") : `${cluster.lat.toFixed(2)}° N, ${cluster.lng.toFixed(2)}° E`;
}

/** Hour-stable id, so a feed reader sees the same advisory across refreshes within the hour. */
export function advisoryId(cityId: string, clusterKeyValue: string, issuedAt: Date) {
  const hour = issuedAt.toISOString().slice(0, 13).replace(/[-T]/g, "");
  return `tb-${cityId}-${clusterKeyValue.replace(/\./g, "p")}-${hour}`;
}

export function buildAdvisories(input: {
  city: CityConfig;
  clusters: FireCluster[];
  field: WindStation[];
  places: Map<string, SourcePlace>;
  /** The city's own state/region, compared with each source's state. */
  cityState: string | null;
  now: Date;
}): TransboundaryAdvisory[] {
  const { city, clusters, field, places, cityState, now } = input;
  const advisories: TransboundaryAdvisory[] = [];
  for (const cluster of clusters) {
    const trajectory = traceTrajectory(cluster, city, field);
    if (trajectory.arrivalHours === null) continue;
    const place = places.get(cluster.key) ?? { district: null, state: null, country: null };
    const etaHours = trajectory.arrivalHours;
    advisories.push({
      id: advisoryId(city.id, cluster.key, now),
      cityId: city.id,
      cityName: city.name,
      level: advisoryLevel(cluster.fireCount, etaHours),
      etaHours,
      arrivesAt: new Date(now.getTime() + etaHours * 3_600_000).toISOString(),
      fireCount: cluster.fireCount,
      distanceKm: cluster.distanceKm,
      source: { ...cluster, ...place, label: placeLabel(place, cluster) },
      interState: Boolean(place.state && cityState && !sameRegion(place.state, cityState)),
      path: trajectory.path,
      issuedAt: now.toISOString(),
    });
  }
  return advisories.sort(compareAdvisories);
}

function normalizeRegion(name: string) {
  return name
    .toLowerCase()
    .replace(/national capital territory of|nct|union territory of|state of/g, "")
    .replace(/[^a-z]/g, "");
}

export function sameRegion(a: string, b: string) {
  const left = normalizeRegion(a);
  const right = normalizeRegion(b);
  return Boolean(left && right && (left.includes(right) || right.includes(left)));
}

export type SourceRegionSummary = {
  state: string;
  fireCount: number;
  clusters: number;
  affectedCities: Array<{ cityId: string; cityName: string; etaHours: number; level: AdvisoryLevel }>;
};

/**
 * The same advisories seen from the source side: which states' fires are
 * reaching which cities. Each cluster counts once per state even when it
 * reaches several cities.
 */
export function summarizeBySourceState(advisories: TransboundaryAdvisory[]): SourceRegionSummary[] {
  type AffectedCity = SourceRegionSummary["affectedCities"][number];
  type Entry = { clusterFires: Map<string, number>; cities: Map<string, AffectedCity> };
  const byState = new Map<string, Entry>();
  for (const advisory of advisories) {
    if (!advisory.interState || !advisory.source.state) continue;
    const entry: Entry = byState.get(advisory.source.state) ?? { clusterFires: new Map(), cities: new Map() };
    entry.clusterFires.set(advisory.source.key, advisory.fireCount);
    const existing = entry.cities.get(advisory.cityId);
    if (!existing || advisory.etaHours < existing.etaHours || LEVEL_RANK[advisory.level] > LEVEL_RANK[existing.level]) {
      entry.cities.set(advisory.cityId, {
        cityId: advisory.cityId,
        cityName: advisory.cityName,
        etaHours: Math.min(advisory.etaHours, existing?.etaHours ?? Infinity),
        level: existing && LEVEL_RANK[existing.level] > LEVEL_RANK[advisory.level] ? existing.level : advisory.level,
      });
    }
    byState.set(advisory.source.state, entry);
  }
  return [...byState.entries()]
    .map(([state, entry]) => ({
      state,
      fireCount: [...entry.clusterFires.values()].reduce((sum, count) => sum + count, 0),
      clusters: entry.clusterFires.size,
      affectedCities: [...entry.cities.values()].sort((a, b) => a.etaHours - b.etaHours),
    }))
    .sort((a, b) => b.fireCount - a.fireCount);
}
