import "server-only";

import { cellToLatLng, getResolution, isValidCell } from "h3-js";
import type { PopulationEstimate } from "@/lib/earthEngineSatellite";
import { adminDb } from "@/lib/firebaseAdmin";
import { resolveCityForPoint, type CityConfig } from "@/lib/cities";
import { reportToIncident, type FirestoreReport } from "@/lib/firestoreReports";
import { H3_RESOLUTION, haversineKm } from "@/lib/geo";
import type { RecurrenceSummary } from "@/lib/recurrence";
import { getCellPopulation, isPopulationConfigured } from "@/lib/server/cellStats";
import { HttpError } from "@/lib/server/http";
import { getCellRecurrence } from "@/lib/server/incidentEvents";
import type { Piece } from "@/lib/server/incidentContext";
import { findSensitiveSites, isPlacesConfigured, reverseGeocode, type SensitiveSite } from "@/lib/server/places";
import { fetchCityStationReadings } from "@/lib/stations";
import type { StationFeed } from "@/lib/stationFeeds";
import { isSensorReadingFresh } from "@/lib/supportEvidence";
import type { Incident } from "@/lib/types";

// Everything the public area page (/zone/[cell]) shows about one H3 cell,
// assembled from sources the app already uses. Each section is a Piece, so a
// source that is missing or failing shows as such instead of as a number.

export type ZoneCell = { h3CellId: string; lat: number; lng: number; city: CityConfig };

export type ZoneStation = {
  stationName: string;
  distanceKm: number;
  pm25: number | null;
  pm10: number | null;
  no2: number | null;
  lastUpdated: string | null;
  fresh: boolean;
  source: StationFeed;
  attribution: string | null;
};

export type ZoneSummary = {
  h3CellId: string;
  center: { lat: number; lng: number };
  city: { id: string; name: string; country: string; timeZone: string; standards: CityConfig["standards"] };
  areaLabel: string | null;
  /** Open (unresolved) incidents in this cell, as the dashboard maps them. */
  open: Incident[];
  station: Piece<ZoneStation | null>;
  recurrence: Piece<RecurrenceSummary>;
  population: Piece<PopulationEstimate>;
  sensitiveSites: Piece<SensitiveSite[]>;
  generatedAt: string;
};

export const SENSITIVE_SITE_RADIUS_M = 1000;
/** Same search radius the rest of the app uses for "nearby" stations (lib/stations.ts). */
const STATION_RADIUS_KM = 10;

/** Validates a cell id from a URL and finds the monitored city it belongs to. */
export function resolveZoneCell(raw: string | null | undefined): ZoneCell {
  const h3CellId = (raw ?? "").trim().toLowerCase();
  if (!isValidCell(h3CellId) || getResolution(h3CellId) !== H3_RESOLUTION) {
    throw new HttpError(400, "Not a valid area id.");
  }
  const [lat, lng] = cellToLatLng(h3CellId);
  const city = resolveCityForPoint(lat, lng);
  if (!city) throw new HttpError(404, "This area is outside every monitored city.");
  return { h3CellId, lat, lng, city };
}

async function piece<T>(configured: boolean, reason: string, load: () => Promise<T>): Promise<Piece<T>> {
  if (!configured) return { status: "not_configured", reason };
  try {
    return { status: "ok", data: await load() };
  } catch (error) {
    return { status: "error", reason: error instanceof Error ? error.message : String(error) };
  }
}

async function loadCellDocs(h3CellId: string) {
  const [incidentSnap, reportSnap] = await Promise.all([
    adminDb.collection("incidents").where("h3CellId", "==", h3CellId).limit(20).get(),
    adminDb.collection("reports").where("h3CellId", "==", h3CellId).limit(50).get(),
  ]);
  const open = incidentSnap.docs
    .map((doc) => reportToIncident(doc.id, doc.data() as FirestoreReport))
    .filter((incident) => incident.status !== "resolved");
  const latestReportLabel =
    reportSnap.docs
      .map((doc) => doc.data() as FirestoreReport)
      .sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0))
      .map((report) => report.location?.label?.trim())
      .find((label): label is string => !!label) ?? null;
  return { open, latestReportLabel };
}

export async function getZoneSummary(cell: ZoneCell): Promise<ZoneSummary> {
  const { h3CellId, lat, lng, city } = cell;

  const [docs, station, recurrence, population, sensitiveSites] = await Promise.all([
    loadCellDocs(h3CellId),
    piece(true, "", async (): Promise<ZoneStation | null> => {
      // An empty network means the feed is down, which is not the same as
      // "no station nearby"; say which one it is.
      const stations = await fetchCityStationReadings(city);
      if (stations.length === 0) throw new Error(`${city.stations.network}: no readings available right now.`);
      const reading =
        stations
          .map((station) => ({ ...station, distanceKm: Number(haversineKm(lat, lng, station.lat, station.lng).toFixed(2)) }))
          .filter((station) => station.distanceKm <= STATION_RADIUS_KM)
          .sort((a, b) => a.distanceKm - b.distanceKm)[0] ?? null;
      if (!reading) return null;
      return {
        stationName: reading.stationName,
        distanceKm: reading.distanceKm,
        pm25: reading.pm25,
        pm10: reading.pm10,
        no2: reading.no2,
        lastUpdated: reading.lastUpdated,
        fresh: isSensorReadingFresh(reading.lastUpdated),
        source: reading.source,
        attribution: reading.attribution,
      };
    }),
    piece(true, "", () => getCellRecurrence(h3CellId)),
    piece(isPopulationConfigured(), "Earth Engine is not configured.", () => getCellPopulation(h3CellId)),
    piece(isPlacesConfigured(), "GOOGLE_PLACES_API_KEY is not set.", () =>
      findSensitiveSites(lat, lng, SENSITIVE_SITE_RADIUS_M),
    ),
  ]);

  // Prefer a label people already used for this spot; geocode only as a fallback.
  let areaLabel = docs.open.find((incident) => incident.neighborhood)?.neighborhood ?? docs.latestReportLabel;
  if (!areaLabel && isPlacesConfigured()) {
    areaLabel = await reverseGeocode(lat, lng).catch(() => null);
  }

  return {
    h3CellId,
    center: { lat, lng },
    city: { id: city.id, name: city.name, country: city.country, timeZone: city.timeZone, standards: city.standards },
    areaLabel,
    open: docs.open,
    station,
    recurrence,
    population,
    sensitiveSites,
    generatedAt: new Date().toISOString(),
  };
}
