import "server-only";

import { CLASSIFICATION_MODELS } from "@/lib/geminiClassifier";

const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_TIMEOUT_MS = 30_000;

export const GEMINI_TEXT_MODELS = CLASSIFICATION_MODELS;

export type GeminiPart = {
  text?: string;
  inline_data?: { data: string; mime_type: string };
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
  // Gemini 3 returns opaque thought signatures alongside function calls; they
  // must be sent back unchanged, which is why model turns are replayed as-is.
  thoughtSignature?: string;
};

export type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };

export type GeminiFunctionDeclaration = {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
};

type GenerateRequest = {
  contents: GeminiContent[] | Array<{ parts: GeminiPart[] }>;
  systemInstruction?: { parts: Array<{ text: string }> };
  tools?: Array<{ functionDeclarations: GeminiFunctionDeclaration[] }>;
  generationConfig?: Record<string, unknown>;
};

type GenerateResponse = {
  candidates?: Array<{ content?: GeminiContent; finishReason?: string }>;
  error?: { message?: string };
};

export function isGeminiConfigured() {
  return Boolean(process.env.GEMINI_API_KEY?.trim());
}

/**
 * POST generateContent, trying each model in order. Returns the first
 * candidate's content plus the model that produced it.
 */
export async function generateContent(
  request: GenerateRequest,
  options: { models?: string[]; timeoutMs?: number } = {},
): Promise<{ content: GeminiContent; model: string }> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new Error("Missing GEMINI_API_KEY.");

  const models = options.models ?? GEMINI_TEXT_MODELS;
  let lastError: unknown = null;

  for (const model of models) {
    try {
      const response = await fetch(`${GEMINI_ENDPOINT}/${model}:generateContent`, {
        body: JSON.stringify(request),
        headers: {
          "Content-Type": "application/json",
          // Header rather than ?key= so the key never lands in URL logs.
          "x-goog-api-key": apiKey,
        },
        method: "POST",
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      const json = (await response.json().catch(() => null)) as GenerateResponse | null;
      if (!response.ok) {
        const providerMessage = json?.error?.message?.trim();
        throw new Error(
          `Gemini ${model} request failed (${response.status})${providerMessage ? `: ${providerMessage}` : "."}`,
        );
      }
      const content = json?.candidates?.[0]?.content;
      if (!content?.parts?.length) {
        throw new Error(
          `Gemini ${model} returned no content (finishReason: ${json?.candidates?.[0]?.finishReason ?? "unknown"}).`,
        );
      }
      return { content: { role: "model", parts: content.parts }, model };
    } catch (error) {
      lastError = error;
      console.warn(`Gemini ${model} unavailable; trying next model.`, error instanceof Error ? error.message : error);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Gemini request failed.");
}

export function getText(content: GeminiContent) {
  return content.parts
    .map((part) => part.text ?? "")
    .join("")
    .trim();
}

/** Structured output: response constrained to `responseSchema`. */
export async function generateJson<T>(
  prompt: string,
  responseSchema: Record<string, unknown>,
  options: { temperature?: number; systemInstruction?: string } = {},
): Promise<{ data: T; model: string }> {
  const { content, model } = await generateContent({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    ...(options.systemInstruction
      ? { systemInstruction: { parts: [{ text: options.systemInstruction }] } }
      : {}),
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema,
      temperature: options.temperature ?? 0.2,
    },
  });
  const text = getText(content);
  try {
    return { data: JSON.parse(text) as T, model };
  } catch {
    throw new Error("Gemini returned invalid JSON for a structured request.");
  }
}

export type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

export type ToolStep = {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  error?: string;
};

/**
 * Function-calling loop: Gemini picks tools, we execute them against live
 * data, feed results back, and repeat until it answers in text.
 */
export async function runToolLoop(options: {
  systemInstruction: string;
  history: GeminiContent[];
  declarations: GeminiFunctionDeclaration[];
  handlers: Record<string, ToolHandler>;
  maxSteps?: number;
}): Promise<{ answer: string; steps: ToolStep[]; model: string }> {
  const contents: GeminiContent[] = [...options.history];
  const steps: ToolStep[] = [];
  const maxSteps = options.maxSteps ?? 6;
  let model = "";

  for (let round = 0; round <= maxSteps; round += 1) {
    const result = await generateContent(
      {
        contents,
        systemInstruction: { parts: [{ text: options.systemInstruction }] },
        tools: [{ functionDeclarations: options.declarations }],
        generationConfig: { temperature: 0.2 },
      },
      { timeoutMs: 45_000 },
    );
    model = result.model;
    const calls = result.content.parts.filter((part) => part.functionCall);

    if (calls.length === 0 || round === maxSteps) {
      const answer = getText(result.content);
      return {
        answer: answer || "I could not produce an answer from the available data.",
        steps,
        model,
      };
    }

    contents.push(result.content);
    const responses: GeminiPart[] = [];
    for (const part of calls) {
      const call = part.functionCall!;
      const args = call.args ?? {};
      const handler = options.handlers[call.name];
      try {
        if (!handler) throw new Error(`Unknown tool ${call.name}`);
        const output = await handler(args);
        steps.push({ tool: call.name, args, ok: true });
        responses.push({ functionResponse: { name: call.name, response: { result: output } } });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        steps.push({ tool: call.name, args, ok: false, error: message });
        responses.push({ functionResponse: { name: call.name, response: { error: message } } });
      }
    }
    contents.push({ role: "user", parts: responses });
  }

  return { answer: "I could not produce an answer from the available data.", steps, model };
}
