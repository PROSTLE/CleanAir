// Geo helpers shared by client and server code. Kept free of Firebase
// imports so server modules don't pull in the client Firestore SDK.
import { latLngToCell } from "h3-js";

/** App-wide H3 resolution (~0.7 km² hexagons). Must match ml/data-prep.py. */
export const H3_RESOLUTION = 8;

/** Number("") is 0, so blank strings must be rejected explicitly. */
export function toCoordinate(value: string | number | null | undefined) {
  if (value === null || value === undefined) return NaN;
  if (typeof value === "string" && value.trim() === "") return NaN;
  return Number(value);
}

export function getH3CellId(location: { lat: string | number; lng: string | number; label?: string }) {
  const lat = toCoordinate(location.lat);
  const lng = toCoordinate(location.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new Error("A valid latitude/longitude is required to compute an H3 cell.");
  }
  return latLngToCell(lat, lng, H3_RESOLUTION);
}

export function getSeverity(confidence: number) {
  if (confidence >= 80) return "critical";
  if (confidence >= 70) return "medium";
  return "low";
}

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number) {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const latDelta = toRadians(lat2 - lat1);
  const lngDelta = toRadians(lng2 - lng1);
  const a =
    Math.sin(latDelta / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(lngDelta / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Initial great-circle bearing from point 1 to point 2, degrees clockwise from north. */
export function bearingDeg(lat1: number, lng1: number, lat2: number, lng2: number) {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const phi1 = toRadians(lat1);
  const phi2 = toRadians(lat2);
  const deltaLambda = toRadians(lng2 - lng1);
  const y = Math.sin(deltaLambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Smallest absolute difference between two compass bearings (0-180). */
export function angularDifferenceDeg(a: number, b: number) {
  const diff = Math.abs(((a - b) % 360) + 360) % 360;
  return diff > 180 ? 360 - diff : diff;
}

export function compassLabel(deg: number) {
  const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;
  const normalized = ((deg % 360) + 360) % 360;
  return directions[Math.round(normalized / 45) % directions.length];
}
