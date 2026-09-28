import "server-only";

import { rankUpwindSources } from "@/lib/attribution";
import { cityTimeZoneLabel, getCity, isInCity, type CityConfig } from "@/lib/cities";
import { getFiresNear, getRegionalFireHotspots } from "@/lib/earthEngineSatellite";
import { adminDb } from "@/lib/firebaseAdmin";
import { resolveIncidentHazardType } from "@/lib/firestoreReports";
import { DELHI_H3_CELLS } from "@/lib/forecastEngine";
import { getH3CellId, toCoordinate } from "@/lib/geo";
import { getKnownSources } from "@/lib/knownSources";
import { getWindData } from "@/lib/weather";
import { getForecastForCell } from "@/lib/server/forecastService";
import { fetchCityStationReadings, fetchNearbyStations } from "@/lib/stations";
import {
  runToolLoop,
  type GeminiContent,
  type GeminiFunctionDeclaration,
  type ToolHandler,
} from "@/lib/server/gemini";

function systemInstruction(city: CityConfig) {
  return `You are VayuSetu's operations copilot for the ${city.name} (${city.country}) municipal pollution-response team.
You answer questions about live pollution hotspots and help plan dispatch.

Rules:
- Ground every claim in tool results. Call tools before answering anything about current conditions.
- Never invent incidents, readings, locations, or numbers. If data is missing or a tool fails, say so plainly.
- When recommending actions, rank by: confirmed evidence tier, severity, citizen report count, and sensitive exposure.
- Cite the incident id and the evidence (e.g. "station <name> PM2.5 212 µg/m³") for each recommendation.
- Ground stations here: ${city.stations.network}. Exceedances are judged against ${city.standards.source}.
- Be concise: short paragraphs or a numbered list. Times are ${cityTimeZoneLabel(city)} (${city.timeZone}).
- You cannot dispatch or resolve incidents yourself; tell the operator which to action in the dashboard.`;
}

function forecastZones(city: CityConfig) {
  return city.id === "delhi" ? DELHI_H3_CELLS.map((cell) => cell.label) : null;
}

function declarations(city: CityConfig): GeminiFunctionDeclaration[] {
  const zones = forecastZones(city);
  return [
    {
      name: "list_active_incidents",
      description:
        `List open (not resolved) pollution incidents in ${city.name} with their evidence tier, severity, confidence, report count, location and dispatch status. Optionally filter by hazard type.`,
      parameters: {
        type: "object",
        properties: {
          hazardType: {
            type: "string",
            enum: ["fire", "smog", "dust", "industrial", "particulate"],
            description: "Only return incidents of this hazard type.",
          },
          limit: { type: "integer", description: "Maximum incidents to return (default 15, max 40)." },
        },
      },
    },
    {
      name: "get_incident_details",
      description: "Full evidence trail for one incident: sensor, satellite, citizen notes, work order status.",
      parameters: {
        type: "object",
        properties: { incidentId: { type: "string" } },
        required: ["incidentId"],
      },
    },
    {
      name: "get_zone_forecast",
      description: zones
        ? `24-hour PM2.5 forecast for a monitored ${city.name} zone. Zones: ${zones.join(", ")}.`
        : `24-hour PM2.5 forecast for a ${city.name} monitoring station. Zone = the station name (see get_station_readings).`,
      parameters: {
        type: "object",
        properties: { zone: { type: "string", description: zones ? "Zone name from the list." : "Station name." } },
        required: ["zone"],
      },
    },
    {
      name: "get_station_readings",
      description: `Latest ground-station readings (${city.stations.network}: PM2.5, PM10, and NO2/SO2 where reported) near a point.`,
      parameters: {
        type: "object",
        properties: {
          lat: { type: "number" },
          lng: { type: "number" },
          radiusKm: { type: "number", description: "Search radius, default 5 km." },
        },
        required: ["lat", "lng"],
      },
    },
    {
      name: "get_wind",
      description: "Current wind speed and the direction it blows FROM at a point (Open-Meteo).",
      parameters: {
        type: "object",
        properties: { lat: { type: "number" }, lng: { type: "number" } },
        required: ["lat", "lng"],
      },
    },
    {
      name: "get_fire_activity",
      description:
        `NASA FIRMS active-fire detections in the last 48 h. Without coordinates returns the regional count across ${city.fireRegion.label}; with coordinates returns fires near that point.`,
      parameters: {
        type: "object",
        properties: {
          lat: { type: "number" },
          lng: { type: "number" },
          radiusKm: { type: "number", description: "Radius around the point, default 10 km." },
        },
      },
    },
    {
      name: "get_upwind_sources",
      description:
        "Rank known emission sources (landfills, industrial areas, traffic hubs, active fires, other incidents) lying upwind of a point, using live wind.",
      parameters: {
        type: "object",
        properties: { lat: { type: "number" }, lng: { type: "number" } },
        required: ["lat", "lng"],
      },
    },
  ];
}

function num(value: unknown, name: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number.`);
  return parsed;
}

function ageHours(value: { toDate?: () => Date } | undefined) {
  const date = value?.toDate?.();
  return date ? Math.round(((Date.now() - date.getTime()) / 3_600_000) * 10) / 10 : null;
}

function handlers(city: CityConfig): Record<string, ToolHandler> {
  return {
    async list_active_incidents(args) {
      const limit = Math.min(40, Math.max(1, Number(args.limit ?? 15) || 15));
      const snapshot = await adminDb.collection("incidents").where("status", "!=", "resolved").limit(200).get();
      const incidents = snapshot.docs
        .map((doc) => {
          const data = doc.data();
          const validation = data.validation ?? {};
          return {
            id: doc.id,
            location: data.location?.label ?? null,
            lat: toCoordinate(data.location?.lat),
            lng: toCoordinate(data.location?.lng),
            hazardType: resolveIncidentHazardType(data),
            tier: validation.tier ?? null,
            severity: data.geminiClassification?.severity ?? null,
            fusedConfidencePct: validation.fusion?.finalConfidence ?? null,
            citizenReports: validation.citizenSignal?.reportCount ?? 0,
            dispatchStatus: data.dispatchStatus ?? "not_dispatched",
            ageHours: ageHours(data.createdAt),
            hasWorkOrder: Boolean(data.workOrder),
          };
        })
        .filter((incident) => isInCity(city, incident.lat, incident.lng))
        .filter((incident) => !args.hazardType || incident.hazardType === args.hazardType)
        .sort((a, b) => (b.fusedConfidencePct ?? 0) - (a.fusedConfidencePct ?? 0));
      return { total: incidents.length, incidents: incidents.slice(0, limit) };
    },

    async get_incident_details(args) {
      const id = String(args.incidentId ?? "").replace(/^firestore-/, "");
      if (!id || id.includes("/")) throw new Error("incidentId is required.");
      const snap = await adminDb.collection("incidents").doc(id).get();
      if (!snap.exists) throw new Error(`No incident ${id}.`);
      const data = snap.data() ?? {};
      return {
        id,
        location: data.location ?? null,
        status: data.status ?? null,
        dispatchStatus: data.dispatchStatus ?? null,
        hazardType: resolveIncidentHazardType(data),
        geminiClassification: data.geminiClassification ?? null,
        evidence: data.validation ?? null,
        citizenNotes: data.citizenNotes ?? [],
        triggerPollutants: data.triggerPollutants ?? null,
        workOrder: data.workOrder ? { subject: data.workOrder.subject, priority: data.workOrder.priority } : null,
        ageHours: ageHours(data.createdAt),
      };
    },

    async get_zone_forecast(args) {
      const zone = String(args.zone ?? "").toLowerCase();
      const matches = (label: string) => label.toLowerCase().includes(zone) || zone.includes(label.toLowerCase());
      let target: { label: string; h3CellId: string } | undefined;
      if (city.id === "delhi") {
        target = DELHI_H3_CELLS.find((candidate) => matches(candidate.label));
        if (!target) throw new Error(`Unknown zone. Choose one of: ${DELHI_H3_CELLS.map((c) => c.label).join(", ")}.`);
      } else {
        const station = (await fetchCityStationReadings(city)).find((candidate) => matches(candidate.stationName));
        if (!station) throw new Error(`No ${city.name} station matches "${args.zone}".`);
        target = { label: station.stationName, h3CellId: getH3CellId({ lat: station.lat, lng: station.lng }) };
      }
      const result = await getForecastForCell(target.h3CellId);
      if (!result.ok) throw new Error(result.error);
      return {
        zone: target.label,
        station: result.station,
        dataSource: result.dataSource,
        isLiveHistory: result.isLiveHistory,
        historyAgeHours: result.historyAgeHours,
        currentPm25: result.forecast.currentPm25,
        peakPm25: result.forecast.peakPm25,
        peakHourLocal: result.forecast.peakHour,
        trend: result.forecast.trend,
        backtest: result.backtest,
        arimaPeak: result.arima.points
          ? Math.max(...result.arima.points.map((point) => point.value))
          : null,
      };
    },

    async get_station_readings(args) {
      const stations = await fetchNearbyStations(num(args.lat, "lat"), num(args.lng, "lng"), Number(args.radiusKm ?? 5) || 5);
      return stations.slice(0, 4).map((station) => ({
        station: station.stationName,
        distanceKm: station.distanceKm,
        pm25: station.pm25,
        pm10: station.pm10,
        no2: station.no2,
        so2: station.so2,
        lastUpdated: station.lastUpdated,
        network: station.source,
        operator: station.attribution,
      }));
    },

    async get_wind(args) {
      const wind = await getWindData(num(args.lat, "lat"), num(args.lng, "lng"));
      if (!wind) throw new Error("Wind data unavailable (Open-Meteo request failed).");
      return { speedMs: wind.windSpeedMs, fromDeg: wind.windDegrees, gustMs: wind.windGustMs, fetchedAt: wind.fetchedAt };
    },

    async get_fire_activity(args) {
      if (args.lat === undefined || args.lng === undefined) {
        const regional = await getRegionalFireHotspots(city.id);
        if (regional.error) throw new Error(regional.error);
        return {
          region: city.fireRegion.label,
          fireDetections48h: regional.fires.length,
          truncated: regional.truncated,
          windowStart: regional.windowStart,
          windowEnd: regional.windowEnd,
        };
      }
      const summary = await getFiresNear(num(args.lat, "lat"), num(args.lng, "lng"), Number(args.radiusKm ?? 10) || 10);
      if (summary.error) throw new Error(summary.error);
      return summary;
    },

    async get_upwind_sources(args) {
      const lat = num(args.lat, "lat");
      const lng = num(args.lng, "lng");
      const [wind, regional] = await Promise.all([
        getWindData(lat, lng),
        getRegionalFireHotspots(city.id).catch(() => null),
      ]);
      return rankUpwindSources({
        lat,
        lng,
        wind: wind ? { fromDeg: wind.windDegrees, speedMs: wind.windSpeedMs } : null,
        candidates: getKnownSources(city.id),
        fires: regional && !regional.error ? regional.fires : [],
      });
    },
  };
}

export type CopilotMessage = { role: "user" | "assistant"; text: string };

export async function askCopilot(messages: CopilotMessage[], cityId: string) {
  const city = getCity(cityId);
  const history: GeminiContent[] = messages.slice(-10).map((message) => ({
    role: message.role === "assistant" ? "model" : "user",
    parts: [{ text: message.text.slice(0, 4000) }],
  }));
  if (history.length === 0 || history[history.length - 1].role !== "user") {
    throw new Error("The last message must be from the operator.");
  }
  const now = new Date().toLocaleString("en-GB", { timeZone: city.timeZone });
  return runToolLoop({
    systemInstruction: `${systemInstruction(city)}\nCurrent time: ${now} ${cityTimeZoneLabel(city)}.`,
    history,
    declarations: declarations(city),
    handlers: handlers(city),
    maxSteps: 6,
  });
}
