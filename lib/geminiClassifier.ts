// Gemini photo-classification contract, shared verbatim by the live pipeline
// (lib/server/classifyReport.ts) and the offline evaluation harness
// (scripts/eval-classifier.mjs), so measured accuracy describes exactly what
// production runs. Keep this file dependency-free and limited to erasable
// TypeScript: Node's built-in type stripping loads it directly.

export const CLASSIFICATION_MODELS = ["gemini-3.5-flash", "gemini-3.1-flash-lite"];

export const CLASSIFICATION_PROMPT = `You are an air quality sensor for a municipal pollution monitoring system in Delhi NCR.
Analyze this citizen-uploaded photo for VISIBLE, active air pollution signals only.

Count as pollution:
- Smoke plumes (from fires, vehicles, industrial stacks)
- Visible dust clouds (from construction or soil disturbance)
- Open flames or actively burning material
- Dense atmospheric haze with a clear pollution source visible

Do NOT flag as pollution:
- Natural fog, morning mist, or overcast/cloudy sky
- Camera glare, lens flare, or blurry/dark photos
- Garbage or waste with NO visible smoke or dust rising from it
- General grey sky with no identifiable pollution source

Also judge authenticity, because reports can be spam:
- "camera_photo": an ordinary photo taken on site
- "screen_or_screenshot": a photo of a screen, a screenshot, or has app/UI overlays
- "edited_or_stock": watermarked, stock-looking, collage, or visibly edited/AI-generated
- "unsure": cannot tell

Respond ONLY with valid JSON, no markdown, no preamble:
{
  "type": "smoke" | "dust" | "haze" | "fire" | "clear" | "unclear",
  "severity": 1-5 (1=barely visible trace, 3=clearly present, 5=severe dense plume or active fire),
  "confidence": 0.0-1.0,
  "authenticity": "camera_photo" | "screen_or_screenshot" | "edited_or_stock" | "unsure",
  "description": "one sentence: what specific pollution signal is visible, or why image is unclear/clean"
}

Set type to "unclear" and severity to 0 if the image is blurry, too dark, shows only weather/fog, or you cannot confidently identify an active pollution source.`;

export type ClassificationType = "clear" | "dust" | "fire" | "haze" | "smoke" | "unclear";
export type Authenticity = "camera_photo" | "screen_or_screenshot" | "edited_or_stock" | "unsure";

export interface Classification {
  confidence: number;
  description: string;
  severity: number;
  type: ClassificationType;
  authenticity: Authenticity;
}

const VALID_TYPES: ClassificationType[] = ["clear", "dust", "fire", "haze", "smoke", "unclear"];
const VALID_AUTHENTICITY: Authenticity[] = [
  "camera_photo",
  "screen_or_screenshot",
  "edited_or_stock",
  "unsure",
];
export const POLLUTION_TYPES: ClassificationType[] = ["dust", "fire", "haze", "smoke"];

export function isPollutionClassification(classification: Pick<Classification, "severity" | "type">) {
  return classification.severity > 0 && POLLUTION_TYPES.includes(classification.type);
}

export function buildClassificationPayload(inlineData: { data: string; mimeType: string }) {
  return {
    contents: [
      {
        parts: [
          { text: CLASSIFICATION_PROMPT },
          { inline_data: { data: inlineData.data, mime_type: inlineData.mimeType } },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.1,
    },
  };
}

function stripJsonFences(text: string) {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

/** Gemini occasionally appends prose after a valid JSON object. */
export function extractFirstJsonObject(text: string) {
  const start = text.indexOf("{");
  if (start < 0) throw new Error("Gemini response did not include a JSON object.");

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }

  throw new Error("Gemini response included incomplete classification JSON.");
}

export function parseClassification(text: string): Classification {
  const normalized = stripJsonFences(text);
  let parsed: Partial<Classification>;
  try {
    parsed = JSON.parse(normalized) as Partial<Classification>;
  } catch {
    parsed = JSON.parse(extractFirstJsonObject(normalized)) as Partial<Classification>;
  }

  if (
    !parsed ||
    !VALID_TYPES.includes(parsed.type as ClassificationType) ||
    typeof parsed.severity !== "number" ||
    typeof parsed.confidence !== "number" ||
    typeof parsed.description !== "string"
  ) {
    throw new Error("Gemini returned malformed classification JSON.");
  }

  return {
    confidence: Math.max(0, Math.min(1, parsed.confidence)),
    description: parsed.description,
    severity: Math.max(0, Math.min(5, Math.round(parsed.severity))),
    type: parsed.type as ClassificationType,
    authenticity: VALID_AUTHENTICITY.includes(parsed.authenticity as Authenticity)
      ? (parsed.authenticity as Authenticity)
      : "unsure",
  };
}
