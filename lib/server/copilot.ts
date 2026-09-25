import "server-only";

import { rankUpwindSources } from "@/lib/attribution";
import { fetchNearbyStations } from "@/lib/cpcbSensor";
import { getFiresNear, getRegionalFireHotspots } from "@/lib/earthEngineSatellite";
import { adminDb } from "@/lib/firebaseAdmin";
import { resolveIncidentHazardType } from "@/lib/firestoreReports";
import { DELHI_H3_CELLS } from "@/lib/forecastEngine";
import { toCoordinate } from "@/lib/geo";
import { KNOWN_SOURCES } from "@/lib/knownSources";
import { getWindData } from "@/lib/openWeather";
import { isInOperationalRegion } from "@/lib/operationalRegion";
import { getForecastForCell } from "@/lib/server/forecastService";
import {
  runToolLoop,
  type GeminiContent,
  type GeminiFunctionDeclaration,
  type ToolHandler,
} from "@/lib/server/gemini";

const SYSTEM_INSTRUCTION = `You are VayuSetu's operations copilot for Delhi's municipal pollution-response team.
You answer questions about live pollution hotspots and help plan dispatch.

Rules:
- Ground every claim in tool results. Call tools before answering anything about current conditions.
- Never invent incidents, readings, locations, or numbers. If data is missing or a tool fails, say so plainly.
- When recommending actions, rank by: confirmed evidence tier, severity, citizen report count, and sensitive exposure.
- Cite the incident id and the evidence (e.g. "CPCB Anand Vihar PM2.5 212 µg/m³") for each recommendation.
- Be concise: short paragraphs or a numbered list. Times are IST (Asia/Kolkata).
- You cannot dispatch or resolve incidents yourself; tell the operator which to action in the dashboard.`;

const DECLARATIONS: GeminiFunctionDeclaration[] = [
  {
    name: "list_active_incidents",
    description:
      "List open (not resolved) pollution incidents in Delhi with their evidence tier, severity, confidence, report count, location and dispatch status. Optionally filter by hazard type.",
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
    description: `24-hour PM2.5 forecast for a monitored Delhi zone. Zones: ${DELHI_H3_CELLS.map((cell) => cell.label).join(", ")}.`,
    parameters: {
      type: "object",
      properties: { zone: { type: "string", description: "Zone name from the list." } },
      required: ["zone"],
    },
  },
  {
    name: "get_station_readings",
    description: "Latest CPCB ground-station readings (PM2.5, PM10, NO2, SO2) near a point.",
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
    description: "Current wind speed and the direction it blows FROM at a point (OpenWeatherMap).",
    parameters: {
      type: "object",
      properties: { lat: { type: "number" }, lng: { type: "number" } },
      required: ["lat", "lng"],
    },
  },
  {
    name: "get_fire_activity",
    description:
      "NASA FIRMS active-fire detections in the last 48 h. Without coordinates returns the regional count across Punjab, Haryana and Delhi (crop-residue burning season); with coordinates returns fires near that point.",
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

function num(value: unknown, name: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number.`);
  return parsed;
}

function ageHours(value: { toDate?: () => Date } | undefined) {
  const date = value?.toDate?.();
  return date ? Math.round(((Date.now() - date.getTime()) / 3_600_000) * 10) / 10 : null;
}

const HANDLERS: Record<string, ToolHandler> = {
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
      .filter((incident) => isInOperationalRegion(incident.lat, incident.lng))
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
    const cell = DELHI_H3_CELLS.find(
      (candidate) => candidate.label.toLowerCase().includes(zone) || zone.includes(candidate.label.toLowerCase()),
    );
    if (!cell) throw new Error(`Unknown zone. Choose one of: ${DELHI_H3_CELLS.map((c) => c.label).join(", ")}.`);
    const result = await getForecastForCell(cell.h3CellId);
    if (!result.ok) throw new Error(result.error);
    return {
      zone: cell.label,
      station: result.station,
      dataSource: result.dataSource,
      isLiveHistory: result.isLiveHistory,
      historyAgeHours: result.historyAgeHours,
      currentPm25: result.forecast.currentPm25,
      peakPm25: result.forecast.peakPm25,
      peakHourIst: result.forecast.peakHour,
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
    }));
  },

  async get_wind(args) {
    const wind = await getWindData(num(args.lat, "lat"), num(args.lng, "lng"));
    if (!wind) throw new Error("Wind data unavailable (OpenWeatherMap not configured or failed).");
    return { speedMs: wind.windSpeedMs, fromDeg: wind.windDegrees, gustMs: wind.windGustMs, fetchedAt: wind.fetchedAt };
  },

  async get_fire_activity(args) {
    if (args.lat === undefined || args.lng === undefined) {
      const regional = await getRegionalFireHotspots();
      if (regional.error) throw new Error(regional.error);
      return {
        region: "Punjab, Haryana and Delhi NCR",
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
    const [wind, regional] = await Promise.all([getWindData(lat, lng), getRegionalFireHotspots().catch(() => null)]);
    return rankUpwindSources({
      lat,
      lng,
      wind: wind ? { fromDeg: wind.windDegrees, speedMs: wind.windSpeedMs } : null,
      candidates: KNOWN_SOURCES,
      fires: regional && !regional.error ? regional.fires : [],
    });
  },
};

export type CopilotMessage = { role: "user" | "assistant"; text: string };

export async function askCopilot(messages: CopilotMessage[]) {
  const history: GeminiContent[] = messages.slice(-10).map((message) => ({
    role: message.role === "assistant" ? "model" : "user",
    parts: [{ text: message.text.slice(0, 4000) }],
  }));
  if (history.length === 0 || history[history.length - 1].role !== "user") {
    throw new Error("The last message must be from the operator.");
  }
  const now = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  return runToolLoop({
    systemInstruction: `${SYSTEM_INSTRUCTION}\nCurrent time: ${now} IST.`,
    history,
    declarations: DECLARATIONS,
    handlers: HANDLERS,
    maxSteps: 6,
  });
}
