import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { applyWhatsAppClosure } from "@/lib/server/closure";
import { handleRoute, HttpError, readJson } from "@/lib/server/http";

export const runtime = "nodejs";

function secretMatches(header: string | null, secret: string) {
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(header ?? "");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * Called by the WhatsApp bot (whatsapp_bot/index.js) when a reporter replies
 * FIXED or STILL. Shared secret, because the bot vouches for the sender's
 * number (Twilio signs the webhook it received).
 */
export async function POST(request: Request) {
  return handleRoute(async () => {
    const secret = process.env.WHATSAPP_CLOSURE_SECRET?.trim();
    if (!secret) throw new HttpError(503, "WHATSAPP_CLOSURE_SECRET is not configured.");
    if (!secretMatches(request.headers.get("authorization"), secret)) {
      throw new HttpError(401, "Invalid bot credentials.");
    }
    const body = await readJson<{ phone?: string; answer?: string }>(request);
    const phone = body.phone?.trim() ?? "";
    if (!/^\+?\d{6,16}$/.test(phone)) throw new HttpError(400, "A phone number is required.");
    if (body.answer !== "fixed" && body.answer !== "not_fixed") {
      throw new HttpError(400, "answer must be fixed or not_fixed.");
    }
    return NextResponse.json(await applyWhatsAppClosure(phone, body.answer));
  });
}
