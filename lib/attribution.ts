// Upwind source attribution. Meteorological wind direction is the bearing
// the wind blows FROM, so a source contributes to a hotspot when it lies in
// that direction. Sources are scored by how well they line up with the wind
// and how close they are. This is a screening aid for operators, not a
// dispersion model, and the UI labels it that way.
import { angularDifferenceDeg, bearingDeg, haversineKm } from "@/lib/geo";

export type AttributionCandidateKind =
  | "landfill"
  | "industrial_area"
  | "traffic_hub"
  | "active_fire"
  | "reported_incident";

export type AttributionCandidate = {
  name: string;
  kind: AttributionCandidateKind;
  lat: number;
  lng: number;
};

export type RankedSource = AttributionCandidate & {
  distanceKm: number;
  bearingDeg: number;
  offWindDeg: number | null;
  score: number;
};

export type AttributionResult = {
  mode: "upwind" | "calm" | "no_wind";
  wind: { fromDeg: number; speedMs: number } | null;
  sources: RankedSource[];
  /** FIRMS fires 30–400 km upwind (e.g. crop-residue burning in Punjab/Haryana). */
  regionalUpwindFires: number;
};

export const UPWIND_CONE_DEG = 35;
export const LOCAL_RADIUS_KM = 10;
export const FIRE_LOCAL_RADIUS_KM = 30;
export const REGIONAL_FIRE_RADIUS_KM = 400;
export const CALM_WIND_MS = 1;
export const PROXIMITY_RADIUS_KM = 3;

export function rankUpwindSources(input: {
  lat: number;
  lng: number;
  wind: { fromDeg: number; speedMs: number } | null;
  candidates: AttributionCandidate[];
  fires?: Array<{ lat: number; lng: number }>;
  maxResults?: number;
}): AttributionResult {
  const { lat, lng, wind } = input;
  const maxResults = input.maxResults ?? 5;
  const fireCandidates: AttributionCandidate[] = (input.fires ?? [])
    .filter((fire) => haversineKm(lat, lng, fire.lat, fire.lng) <= FIRE_LOCAL_RADIUS_KM)
    .map((fire) => ({ name: "Active fire (NASA FIRMS)", kind: "active_fire", lat: fire.lat, lng: fire.lng }));

  const measured = [...input.candidates, ...fireCandidates]
    .map((candidate) => ({
      ...candidate,
      distanceKm: Number(haversineKm(lat, lng, candidate.lat, candidate.lng).toFixed(2)),
      bearingDeg: Math.round(bearingDeg(lat, lng, candidate.lat, candidate.lng)),
    }))
    // Ignore the hotspot's own location.
    .filter((candidate) => candidate.distanceKm >= 0.2);

  const regionalUpwindFires =
    wind && wind.speedMs >= CALM_WIND_MS
      ? (input.fires ?? []).filter((fire) => {
          const distance = haversineKm(lat, lng, fire.lat, fire.lng);
          return (
            distance > FIRE_LOCAL_RADIUS_KM &&
            distance <= REGIONAL_FIRE_RADIUS_KM &&
            angularDifferenceDeg(bearingDeg(lat, lng, fire.lat, fire.lng), wind.fromDeg) <= UPWIND_CONE_DEG
          );
        }).length
      : 0;

  if (!wind || wind.speedMs < CALM_WIND_MS) {
    // Without a usable wind, the only defensible signal is proximity.
    const sources = measured
      .filter((candidate) => candidate.distanceKm <= PROXIMITY_RADIUS_KM)
      .map((candidate) => ({
        ...candidate,
        offWindDeg: null,
        score: Number((1 - candidate.distanceKm / PROXIMITY_RADIUS_KM).toFixed(2)),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);
    return { mode: wind ? "calm" : "no_wind", wind, sources, regionalUpwindFires };
  }

  const sources = measured
    .map((candidate) => {
      const offWindDeg = Math.round(angularDifferenceDeg(candidate.bearingDeg, wind.fromDeg));
      const maxDistance = candidate.kind === "active_fire" ? FIRE_LOCAL_RADIUS_KM : LOCAL_RADIUS_KM;
      const alignment = 1 - offWindDeg / UPWIND_CONE_DEG;
      const proximity = 1 - candidate.distanceKm / maxDistance;
      return {
        ...candidate,
        offWindDeg,
        score: Number((alignment * proximity).toFixed(2)),
        inRange: offWindDeg <= UPWIND_CONE_DEG && candidate.distanceKm <= maxDistance,
      };
    })
    .filter((candidate) => candidate.inRange && candidate.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(({ inRange: _inRange, ...candidate }) => {
      void _inRange;
      return candidate;
    });

  return { mode: "upwind", wind, sources, regionalUpwindFires };
}
