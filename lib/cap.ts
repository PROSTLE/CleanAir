// Common Alerting Protocol 1.2 (OASIS) — the format India's NDMA uses for
// its national alert pipeline (SACHET), and the one most public warning
// systems ingest. VayuSetu publishes transboundary smoke advisories and
// promoted hotspots in it so another city or state can consume them without
// knowing anything about this app.
//
// Spec: https://docs.oasis-open.org/emergency/cap/v1.2/CAP-v1.2.html
// Element order inside <alert> and <info> is fixed by the schema.
import type { TransboundaryAdvisory, AdvisoryLevel } from "@/lib/transboundary";

export type CapSeverity = "Extreme" | "Severe" | "Moderate" | "Minor" | "Unknown";
export type CapUrgency = "Immediate" | "Expected" | "Future" | "Past" | "Unknown";
export type CapCertainty = "Observed" | "Likely" | "Possible" | "Unlikely" | "Unknown";

export type CapArea = {
  areaDesc: string;
  circle?: { lat: number; lng: number; radiusKm: number };
};

export type CapInfo = {
  language: string;
  categories: Array<"Env" | "Health" | "Fire" | "Safety">;
  event: string;
  responseType?: "Monitor" | "Prepare" | "Avoid" | "Assess" | "None";
  urgency: CapUrgency;
  severity: CapSeverity;
  certainty: CapCertainty;
  onset?: Date;
  expires?: Date;
  senderName: string;
  headline: string;
  description: string;
  instruction?: string;
  web?: string;
  parameters?: Array<{ valueName: string; value: string | number }>;
  areas: CapArea[];
};

export type CapAlert = {
  identifier: string;
  sender: string;
  sent: Date;
  status?: "Actual" | "Exercise" | "Test";
  msgType?: "Alert" | "Update" | "Cancel";
  scope?: "Public";
  note?: string;
  info: CapInfo;
};

export function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** CAP forbids "Z" and fractional seconds; UTC is written "-00:00". */
export function capDateTime(date: Date) {
  return `${date.toISOString().slice(0, 19)}-00:00`;
}

function element(name: string, value: string | number | undefined | null, indent: string) {
  if (value === undefined || value === null || value === "") return "";
  return `${indent}<${name}>${escapeXml(String(value))}</${name}>\n`;
}

export function buildCapXml(alert: CapAlert) {
  const { info } = alert;
  const i1 = "  ";
  const i2 = "    ";
  const i3 = "      ";
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">\n';
  xml += element("identifier", alert.identifier, i1);
  xml += element("sender", alert.sender, i1);
  xml += element("sent", capDateTime(alert.sent), i1);
  xml += element("status", alert.status ?? "Actual", i1);
  xml += element("msgType", alert.msgType ?? "Alert", i1);
  xml += element("scope", alert.scope ?? "Public", i1);
  xml += element("note", alert.note, i1);
  xml += `${i1}<info>\n`;
  xml += element("language", info.language, i2);
  for (const category of info.categories) xml += element("category", category, i2);
  xml += element("event", info.event, i2);
  xml += element("responseType", info.responseType, i2);
  xml += element("urgency", info.urgency, i2);
  xml += element("severity", info.severity, i2);
  xml += element("certainty", info.certainty, i2);
  xml += element("onset", info.onset ? capDateTime(info.onset) : undefined, i2);
  xml += element("expires", info.expires ? capDateTime(info.expires) : undefined, i2);
  xml += element("senderName", info.senderName, i2);
  xml += element("headline", info.headline, i2);
  xml += element("description", info.description, i2);
  xml += element("instruction", info.instruction, i2);
  xml += element("web", info.web, i2);
  for (const parameter of info.parameters ?? []) {
    xml += `${i2}<parameter>\n${element("valueName", parameter.valueName, i3)}${element("value", parameter.value, i3)}${i2}</parameter>\n`;
  }
  for (const area of info.areas) {
    xml += `${i2}<area>\n`;
    xml += element("areaDesc", area.areaDesc, i3);
    if (area.circle) {
      const { lat, lng, radiusKm } = area.circle;
      xml += element("circle", `${lat.toFixed(4)},${lng.toFixed(4)} ${radiusKm}`, i3);
    }
    xml += `${i2}</area>\n`;
  }
  xml += `${i1}</info>\n</alert>\n`;
  return xml;
}

const ADVISORY_SEVERITY: Record<AdvisoryLevel, CapSeverity> = {
  severe: "Severe",
  high: "Moderate",
  moderate: "Minor",
  watch: "Minor",
};

export function advisoryToCap(
  advisory: TransboundaryAdvisory,
  options: { sender: string; web: string; cityCenter: { lat: number; lng: number }; cityRadiusKm?: number },
): CapAlert {
  const issued = new Date(advisory.issuedAt);
  const onset = new Date(advisory.arrivesAt);
  const eta = Math.round(advisory.etaHours);
  return {
    identifier: advisory.id,
    sender: options.sender,
    sent: issued,
    note: "Screening estimate from NASA FIRMS fire detections and a forward trajectory on Open-Meteo forecast wind. Not a dispersion model.",
    info: {
      language: "en-IN",
      categories: ["Env", "Health"],
      event: "Transboundary smoke",
      responseType: advisory.level === "severe" || advisory.level === "high" ? "Prepare" : "Monitor",
      urgency: advisory.etaHours <= 6 ? "Expected" : "Future",
      severity: ADVISORY_SEVERITY[advisory.level],
      certainty: "Possible",
      onset,
      // Re-issued hourly; a stale advisory should drop out within a few hours.
      expires: new Date(Math.max(onset.getTime(), issued.getTime()) + 6 * 3_600_000),
      senderName: "VayuSetu",
      headline: `Smoke from ${advisory.fireCount} fires near ${advisory.source.label} may reach ${advisory.cityName} in about ${eta} h`,
      description:
        `NASA FIRMS detected ${advisory.fireCount} active fire pixels in the last 48 h around ${advisory.source.label}, ` +
        `${advisory.distanceKm} km from ${advisory.cityName}. On the forecast wind, smoke from this area is estimated to ` +
        `reach ${advisory.cityName} in about ${eta} hours if burning continues.`,
      instruction:
        `Receiving authority: watch PM2.5 at ${advisory.cityName} stations and prepare health advisories. ` +
        `Source authority (${advisory.source.state ?? "source region"}): verify and act on residue burning near ${advisory.source.label}.`,
      web: options.web,
      parameters: [
        { valueName: "advisoryLevel", value: advisory.level },
        { valueName: "firePixels48h", value: advisory.fireCount },
        { valueName: "etaHours", value: advisory.etaHours },
        { valueName: "distanceKm", value: advisory.distanceKm },
        { valueName: "interState", value: String(advisory.interState) },
      ],
      areas: [
        {
          areaDesc: `${advisory.cityName} (receiving)`,
          circle: { ...options.cityCenter, radiusKm: options.cityRadiusKm ?? 25 },
        },
        {
          areaDesc: `${advisory.source.label} (source)`,
          circle: { lat: advisory.source.lat, lng: advisory.source.lng, radiusKm: 30 },
        },
      ],
    },
  };
}

export type CapHotspot = {
  id: string;
  cityName: string;
  lat: number;
  lng: number;
  hazardType: string;
  tier: string | null;
  severity: "low" | "medium" | "critical" | null;
  status: string;
  confidencePct: number | null;
  updatedAt: Date;
};

const HOTSPOT_SEVERITY: Record<NonNullable<CapHotspot["severity"]>, CapSeverity> = {
  critical: "Severe",
  medium: "Moderate",
  low: "Minor",
};

const HAZARD_EVENT: Record<string, string> = {
  fire: "Open burning",
  dust: "Dust pollution",
  industrial: "Industrial emission",
  smog: "Smog / traffic emission",
  particulate: "Particulate pollution spike",
};

export function hotspotToCap(hotspot: CapHotspot, options: { sender: string; web: string }): CapAlert {
  const event = HAZARD_EVENT[hotspot.hazardType] ?? "Air pollution hotspot";
  // An operator-verified or dispatched incident has been seen on the ground.
  const observed = hotspot.status === "verified" || hotspot.status === "dispatched";
  const independent = hotspot.tier === "sensor_satellite_confirmed" || hotspot.tier === "crowd_verified";
  return {
    identifier: `vayusetu-inc-${hotspot.id}`,
    sender: options.sender,
    sent: hotspot.updatedAt,
    info: {
      language: "en-IN",
      categories: ["Env", "Health"],
      event,
      responseType: "Monitor",
      urgency: "Immediate",
      severity: hotspot.severity ? HOTSPOT_SEVERITY[hotspot.severity] : "Unknown",
      certainty: observed ? "Observed" : independent ? "Likely" : "Possible",
      senderName: "VayuSetu",
      headline: `${event} hotspot in ${hotspot.cityName}`,
      description:
        `Hyperlocal ${event.toLowerCase()} hotspot (~0.7 km² H3 cell) in ${hotspot.cityName}. ` +
        `Evidence: ${hotspot.tier ? hotspot.tier.replace(/_/g, " ") : "under review"}` +
        (hotspot.confidencePct !== null ? `, fused confidence ${hotspot.confidencePct}%.` : "."),
      instruction: "People with heart or lung conditions, children and older adults nearby should limit time outdoors.",
      web: options.web,
      parameters: [
        { valueName: "hazardType", value: hotspot.hazardType },
        { valueName: "evidenceTier", value: hotspot.tier ?? "none" },
        { valueName: "status", value: hotspot.status },
      ],
      areas: [{ areaDesc: `${hotspot.cityName} hotspot`, circle: { lat: hotspot.lat, lng: hotspot.lng, radiusKm: 0.5 } }],
    },
  };
}

export type CapFeedEntry = { id: string; title: string; updated: Date; summary: string; capUrl: string };

/** Atom index of current alerts, each linking to its CAP document (the usual CAP feed layout). */
export function buildCapAtomFeed(feed: { id: string; title: string; selfUrl: string; updated: Date; entries: CapFeedEntry[] }) {
  const entries = feed.entries
    .map(
      (entry) =>
        `  <entry>\n` +
        `    <id>${escapeXml(entry.id)}</id>\n` +
        `    <title>${escapeXml(entry.title)}</title>\n` +
        `    <updated>${entry.updated.toISOString()}</updated>\n` +
        `    <summary>${escapeXml(entry.summary)}</summary>\n` +
        `    <link rel="alternate" type="application/cap+xml" href="${escapeXml(entry.capUrl)}"/>\n` +
        `  </entry>\n`,
    )
    .join("");
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">\n' +
    `  <id>${escapeXml(feed.id)}</id>\n` +
    `  <title>${escapeXml(feed.title)}</title>\n` +
    `  <updated>${feed.updated.toISOString()}</updated>\n` +
    `  <author><name>VayuSetu</name></author>\n` +
    `  <link rel="self" href="${escapeXml(feed.selfUrl)}"/>\n` +
    entries +
    "</feed>\n"
  );
}
