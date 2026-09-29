import "server-only";

import { createHash } from "node:crypto";
import type { AttributionResult } from "@/lib/attribution";
import { adminDb, adminServerTimestamp } from "@/lib/firebaseAdmin";
import { TIER_LABELS } from "@/lib/supportEvidence";
import { generateJson, isGeminiConfigured } from "@/lib/server/gemini";
import { HttpError } from "@/lib/server/http";
import { buildAttributionForPoint } from "@/lib/server/incidentContext";
import type { ZoneCell, ZoneSummary } from "@/lib/server/zoneSummary";
import { UI_LANGUAGES } from "@/lib/uiLanguages";

// A short plain-language summary of a cell for residents, written by Gemini
// from the same recorded evidence operators see (open incidents, nearest
// station, upwind attribution, 30-day recurrence). Grounded like the work
// order (lib/server/workOrder.ts): only the facts passed in, nothing invented.
// Cached per cell and language in `zoneBriefs`, regenerated only when the
// facts change, so public traffic does not multiply Gemini calls.

export type ZoneBrief = {
  headline: string;
  whatIsHappening: string;
  likelyCause: string;
  causeCertainty: "likely" | "possible" | "unknown";
  evidenceCited: string[];
  language: string;
  model: string;
  generatedAt: string;
  /** True when Gemini failed just now and this is the last saved summary. */
  stale?: boolean;
};

type GeneratedBrief = Omit<ZoneBrief, "language" | "model" | "generatedAt" | "stale">;

const MIN_REGENERATE_MS = 30 * 60 * 1000;
const MAX_AGE_MS = 6 * 60 * 60 * 1000;

const BRIEF_SCHEMA = {
  type: "OBJECT",
  properties: {
    headline: { type: "STRING" },
    whatIsHappening: { type: "STRING" },
    likelyCause: { type: "STRING" },
    causeCertainty: { type: "STRING", enum: ["likely", "possible", "unknown"] },
    evidenceCited: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["headline", "whatIsHappening", "likelyCause", "causeCertainty", "evidenceCited"],
};

export function isZoneBriefConfigured() {
  return isGeminiConfigured();
}

function buildFacts(summary: ZoneSummary, attribution: AttributionResult | null) {
  const { city } = summary;
  const facts: Record<string, unknown> = {
    area: summary.areaLabel ?? "unnamed area",
    city: `${city.name}, ${city.country}`,
    nationalStandard: city.standards.source,
    openHotspots: summary.open.map((incident) => {
      const evidence = incident.evidence;
      const sensor = evidence?.sensor;
      return {
        hazard: incident.hazardType,
        evidenceLevel: evidence?.tier ? TIER_LABELS[evidence.tier] : "not yet corroborated",
        citizenReports: evidence?.citizenSignal?.reportCount ?? 0,
        possibleSources: incident.possibleSources ?? null,
        station:
          sensor?.stationName && (sensor.source === "CPCB" || sensor.source === "WAQI")
            ? {
                name: sensor.stationName,
                pollutant: sensor.primaryName ?? null,
                value: sensor.primaryValue ?? null,
                pctAboveNationalStandard: sensor.primaryDelta ?? null,
              }
            : null,
        satellite: evidence?.satellite?.signal ?? null,
        activeFiresNearby: evidence?.satellite?.firmsFireCount ?? null,
        dispatched: incident.dispatchStatus === "dispatched",
      };
    }),
  };

  if (summary.station.status === "ok" && summary.station.data) {
    const station = summary.station.data;
    facts.nearestStationNow = {
      name: station.stationName,
      distanceKm: station.distanceKm,
      pm25: station.pm25,
      pm10: station.pm10,
      readingIsCurrent: station.fresh,
      nationalPm25Limit24h: city.standards.pm25,
    };
  } else {
    facts.nearestStationNow = "no station with data within 10 km";
  }

  if (attribution) {
    facts.upwind = {
      mode: attribution.mode,
      windFromDeg: attribution.wind?.fromDeg ?? null,
      windSpeedMs: attribution.wind?.speedMs ?? null,
      candidateSources: attribution.sources.slice(0, 4).map((source) => ({
        name: source.name,
        kind: source.kind,
        distanceKm: source.distanceKm,
      })),
      regionalUpwindFires48h: attribution.regionalUpwindFires,
    };
  }

  if (summary.recurrence.status === "ok") {
    const recurrence = summary.recurrence.data;
    facts.last30Days = {
      confirmedEpisodes: recurrence.episodes,
      daysWithCitizenReports: recurrence.reportDays,
      fixDidNotHold: recurrence.fixDidNotHold,
      chronic: recurrence.chronic,
    };
  }
  return facts;
}

function factsHash(facts: Record<string, unknown>, language: string) {
  return createHash("sha256").update(JSON.stringify({ facts, language })).digest("hex").slice(0, 32);
}

export async function getZoneBrief(cell: ZoneCell, summary: ZoneSummary, language: string): Promise<ZoneBrief> {
  const attribution = await buildAttributionForPoint(cell.lat, cell.lng).catch(() => null);
  const facts = buildFacts(summary, attribution);
  const hash = factsHash(facts, language);
  const ref = adminDb.collection("zoneBriefs").doc(`${cell.h3CellId}_${language}`);

  const cached = await ref.get();
  const stored = cached.exists ? cached.data() : null;
  const storedAtMs = Date.parse(stored?.brief?.generatedAt ?? "");
  if (stored?.brief && Number.isFinite(storedAtMs)) {
    const age = Date.now() - storedAtMs;
    if (age < MIN_REGENERATE_MS || (stored.hash === hash && age < MAX_AGE_MS)) return stored.brief as ZoneBrief;
  }

  const languageName = UI_LANGUAGES[language]?.name ?? "English";
  const prompt = `Write a short air-quality summary for residents of this area in ${cell.city.name}.
Write every field in ${languageName}. Plain words, no jargon, no alarmism.

Use ONLY the facts below. Do not invent measurements, sources, places, dates or health effects.
Do not give medical advice (health guidance is shown separately from an official source).
- headline: one sentence, under 15 words.
- whatIsHappening: 2-3 sentences on what the evidence shows right now. If openHotspots is empty,
  say no confirmed hotspot is open here and describe the nearest station reading if there is one.
- likelyCause: 1-2 sentences naming the most likely source ONLY if the facts support it (a named
  upwind source, possibleSources, or a citizen-reported hazard); otherwise say the cause is not known.
- causeCertainty: "likely" only when several facts agree, "possible" for a single supporting fact,
  "unknown" otherwise.
- If last30Days.chronic is true, say this spot has had repeated pollution recently.
- evidenceCited: short phrases naming the facts used (e.g. "PM2.5 +85% vs national standard at <station>").

FACTS (JSON):
${JSON.stringify(facts, null, 2)}`;

  let generated: { data: GeneratedBrief; model: string };
  try {
    generated = await generateJson<GeneratedBrief>(prompt, BRIEF_SCHEMA, {
      systemInstruction:
        "You explain local air-quality evidence to residents. You never fabricate facts that are not in the provided data.",
      temperature: 0.2,
    });
  } catch (error) {
    // Provider outage: the last summary, marked as such (it carries its own
    // time), beats an error; with none saved, say Gemini is unavailable.
    if (stored?.brief) return { ...(stored.brief as ZoneBrief), stale: true };
    throw new HttpError(
      503,
      `Gemini is unavailable right now (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
  const { data, model } = generated;

  const brief: ZoneBrief = {
    headline: data.headline,
    whatIsHappening: data.whatIsHappening,
    likelyCause: data.likelyCause,
    causeCertainty: data.causeCertainty,
    evidenceCited: (data.evidenceCited ?? []).slice(0, 6),
    language,
    model,
    generatedAt: new Date().toISOString(),
  };
  await ref.set({ brief, hash, h3CellId: cell.h3CellId, updatedAt: adminServerTimestamp() }).catch(() => undefined);
  return brief;
}
