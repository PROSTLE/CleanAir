import { NextResponse } from "next/server";
import { askCopilot, type CopilotMessage } from "@/lib/server/copilot";
import { isGeminiConfigured } from "@/lib/server/gemini";
import { enforceRateLimit, handleRoute, HttpError, readJson, requireOperator } from "@/lib/server/http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return handleRoute(async () => {
    const operator = await requireOperator(request);
    if (!isGeminiConfigured()) throw new HttpError(503, "GEMINI_API_KEY is not set.");
    await enforceRateLimit("copilot", operator.uid, 60, 60 * 60 * 1000);

    const body = await readJson<{ messages?: CopilotMessage[] }>(request);
    const messages = (body.messages ?? []).filter(
      (message): message is CopilotMessage =>
        (message?.role === "user" || message?.role === "assistant") && typeof message.text === "string",
    );
    if (messages.length === 0) throw new HttpError(400, "Ask a question first.");

    const result = await askCopilot(messages);
    return NextResponse.json(result);
  });
}
