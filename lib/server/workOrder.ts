import "server-only";

import { adminServerTimestamp } from "@/lib/firebaseAdmin";
import { resolveIncidentHazardType } from "@/lib/firestoreReports";
import type { IncidentContext, Target } from "@/lib/server/incidentContext";
import { generateJson } from "@/lib/server/gemini";
import type { HazardType, WorkOrder } from "@/lib/types";

// Suggested first-responder agency per hazard. The operator confirms routing;
// the work order says "suggested" so nobody mistakes it for a mandate.
const DEPARTMENT_BY_HAZARD: Record<HazardType, string> = {
  fire: "Municipal Corporation of Delhi (MCD) — Sanitation / waste-burning enforcement",
  dust: "Municipal Corporation of Delhi (MCD) — construction & demolition dust enforcement",
  industrial: "Delhi Pollution Control Committee (DPCC)",
  smog: "Delhi Traffic Police — traffic management",
  particulate: "Delhi Pollution Control Committee (DPCC) — field inspection",
};

const WORK_ORDER_SCHEMA = {
  type: "OBJECT",
  properties: {
    priority: { type: "STRING", enum: ["immediate", "within_24h", "routine"] },
    subject: { type: "STRING" },
    summary: { type: "STRING" },
    bodyEn: { type: "STRING" },
    bodyHi: { type: "STRING" },
    actions: { type: "ARRAY", items: { type: "STRING" } },
    evidenceCited: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["priority", "subject", "summary", "bodyEn", "bodyHi", "actions", "evidenceCited"],
};

type GeneratedWorkOrder = Omit<WorkOrder, "department" | "generatedAt" | "generatedBy" | "model">;

function compactFacts(target: Target, context: IncidentContext | null) {
  const data = target.data;
  const validation = data.validation ?? {};
  const hazardType = resolveIncidentHazardType(data);
  const facts: Record<string, unknown> = {
    location: target.area,
    coordinates: `${target.lat.toFixed(5)}, ${target.lng.toFixed(5)}`,
    hazardType,
    citizenSelectedHazard: data.hazardLabel ?? null,
    geminiPhotoFinding: data.geminiClassification ?? null,
    promotionTier: validation.tier ?? null,
    promotionReason: validation.promotionReason ?? null,
    fusedConfidencePct: validation.fusion?.finalConfidence ?? null,
    citizenReports: validation.citizenSignal?.reportCount ?? null,
    citizenNotes: (data.citizenNotes ?? (data.note ? [data.note] : [])).slice(0, 5),
    nearestStation: validation.sensor?.stationName
      ? {
          name: validation.sensor.stationName,
          distanceKm: validation.sensor.distanceKm,
          pollutant: validation.sensor.primaryName,
          value: validation.sensor.primaryValue,
          pctAboveCpcb24hStandard: validation.sensor.primaryDelta,
          updated: validation.sensor.lastUpdated,
        }
      : "no CPCB station with data nearby",
    satellite: validation.satellite?.signal ?? null,
    firstSeen: data.createdAt?.toDate?.().toISOString?.() ?? null,
    triggerPollutants: data.triggerPollutants ?? null,
  };

  if (context) {
    if (context.attribution.status === "ok") {
      facts.upwindAnalysis = {
        mode: context.attribution.data.mode,
        wind: context.attribution.data.wind,
        likelySources: context.attribution.data.sources.map((source) => ({
          name: source.name,
          kind: source.kind,
          distanceKm: source.distanceKm,
        })),
        regionalUpwindFires48h: context.attribution.data.regionalUpwindFires,
      };
    }
    if (context.fires.status === "ok") facts.firmsFiresWithin10km = context.fires.data.count;
    if (context.sensitiveSites.status === "ok") {
      facts.sensitiveSitesWithin1km = context.sensitiveSites.data.slice(0, 6).map((site) => ({
        name: site.name,
        kind: site.kind,
        distanceKm: site.distanceKm,
      }));
    }
    if (context.googleAirQuality.status === "ok") facts.googleAirQuality = context.googleAirQuality.data;
  }
  return { facts, hazardType };
}

export async function generateWorkOrder(
  target: Target,
  context: IncidentContext | null,
  operatorUid: string | null,
): Promise<WorkOrder> {
  const { facts, hazardType } = compactFacts(target, context);
  const department = DEPARTMENT_BY_HAZARD[hazardType];

  const prompt = `Draft a municipal work order for this verified air-pollution hotspot in Delhi.
Addressed to: ${department} (suggested routing; the operator will confirm).

Use ONLY the facts below. Do not invent names, officers, phone numbers, measurements, or legal
section numbers. If a fact is missing, leave it out rather than guessing. Keep bodyEn under 180
words and write bodyHi as a faithful Hindi (Devanagari) version of bodyEn. actions: 3-5 concrete
field steps appropriate to the hazard. evidenceCited: short phrases naming which facts justify the
order (e.g. "3 citizen reports", "CPCB PM2.5 +85% at <station>"). Priority: "immediate" for an
active fire or sensitive sites nearby with high confidence, "within_24h" for confirmed hotspots,
otherwise "routine".

FACTS (JSON):
${JSON.stringify(facts, null, 2)}`;

  const { data, model } = await generateJson<GeneratedWorkOrder>(prompt, WORK_ORDER_SCHEMA, {
    systemInstruction:
      "You write concise, factual municipal work orders. You never fabricate details that are not in the provided facts.",
    temperature: 0.2,
  });

  const workOrder: WorkOrder = {
    department,
    priority: data.priority,
    subject: data.subject,
    summary: data.summary,
    bodyEn: data.bodyEn,
    bodyHi: data.bodyHi,
    actions: (data.actions ?? []).slice(0, 6),
    evidenceCited: (data.evidenceCited ?? []).slice(0, 8),
    generatedAt: new Date().toISOString(),
    generatedBy: operatorUid,
    model,
  };

  await target.ref.update({ workOrder, workOrderAt: adminServerTimestamp() });
  return workOrder;
}
