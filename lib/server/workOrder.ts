import "server-only";

import { adminServerTimestamp } from "@/lib/firebaseAdmin";
import { resolveIncidentHazardType } from "@/lib/firestoreReports";
import type { IncidentContext, Target } from "@/lib/server/incidentContext";
import { generateJson } from "@/lib/server/gemini";
import { getCity, resolveCityForPoint, type CityConfig } from "@/lib/cities";
import type { WorkOrder } from "@/lib/types";
import { getCachedCellPopulation } from "@/lib/server/cellStats";
import { getCellRecurrence } from "@/lib/server/incidentEvents";

/**
 * Repeat-hotspot history and residents nearby, when recorded. Missing data is
 * left out (never guessed), exactly like the other facts.
 */
async function areaFacts(h3CellId: unknown) {
  if (typeof h3CellId !== "string" || !h3CellId) return {};
  const [recurrence, population] = await Promise.all([
    getCellRecurrence(h3CellId).catch(() => null),
    getCachedCellPopulation(h3CellId).catch(() => null),
  ]);
  const facts: Record<string, unknown> = {};
  if (recurrence) {
    facts.last30Days = {
      confirmedEpisodes: recurrence.episodes,
      daysWithCitizenReports: recurrence.reportDays,
      previousFixDidNotHold: recurrence.fixDidNotHold,
      chronicHotspot: recurrence.chronic,
    };
  }
  if (population) {
    facts.residentsWithin1km = { estimate: population.population, source: `WorldPop ${population.year}` };
  }
  return facts;
}

function workOrderSchema(localLanguage: CityConfig["localLanguage"]) {
  const required = ["priority", "subject", "summary", "bodyEn", "actions", "evidenceCited"];
  return {
    type: "OBJECT",
    properties: {
      priority: { type: "STRING", enum: ["immediate", "within_24h", "routine"] },
      subject: { type: "STRING" },
      summary: { type: "STRING" },
      bodyEn: { type: "STRING" },
      ...(localLanguage ? { bodyLocal: { type: "STRING" } } : {}),
      actions: { type: "ARRAY", items: { type: "STRING" } },
      evidenceCited: { type: "ARRAY", items: { type: "STRING" } },
    },
    required: localLanguage ? [...required, "bodyLocal"] : required,
  };
}

type GeneratedWorkOrder = Omit<
  WorkOrder,
  "department" | "generatedAt" | "generatedBy" | "model" | "localLanguage" | "bodyHi"
>;

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
          pctAboveNational24hStandard: validation.sensor.primaryDelta,
          network: validation.sensor.source,
          operator: validation.sensor.attribution ?? null,
          updated: validation.sensor.lastUpdated,
        }
      : "no ground station with data nearby",
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
  Object.assign(facts, await areaFacts(target.data.h3CellId));
  const city = resolveCityForPoint(target.lat, target.lng) ?? getCity("delhi");
  const department = city.authorities[hazardType];
  const localLanguage = city.localLanguage;

  const prompt = `Draft a municipal work order for this verified air-pollution hotspot in ${city.name}, ${city.country}.
Addressed to: ${department} (suggested routing; the operator will confirm).
Sensor percentages compare against ${city.standards.source}.

Use ONLY the facts below. Do not invent names, officers, phone numbers, measurements, or legal
section numbers. If a fact is missing, leave it out rather than guessing. Keep bodyEn under 180
words${localLanguage ? ` and write bodyLocal as a faithful ${localLanguage.name} (language code "${localLanguage.code}") version of bodyEn` : ""}. actions: 3-5 concrete
field steps appropriate to the hazard. evidenceCited: short phrases naming which facts justify the
order (e.g. "3 citizen reports", "PM2.5 +85% vs national standard at <station>"). Priority: "immediate" for an
active fire or sensitive sites nearby with high confidence, "within_24h" for confirmed hotspots,
otherwise "routine".
If last30Days.chronicHotspot is true, say the spot keeps recurring and include one action aimed at
stopping it at the source (not only another clean-up).

FACTS (JSON):
${JSON.stringify(facts, null, 2)}`;

  const { data, model } = await generateJson<GeneratedWorkOrder>(prompt, workOrderSchema(localLanguage), {
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
    bodyLocal: localLanguage ? (data.bodyLocal ?? null) : null,
    localLanguage,
    actions: (data.actions ?? []).slice(0, 6),
    evidenceCited: (data.evidenceCited ?? []).slice(0, 8),
    generatedAt: new Date().toISOString(),
    generatedBy: operatorUid,
    model,
  };

  await target.ref.update({ workOrder, workOrderAt: adminServerTimestamp() });
  return workOrder;
}
