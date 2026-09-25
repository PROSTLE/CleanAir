import "server-only";

import { adminDb, adminServerTimestamp } from "@/lib/firebaseAdmin";
import { FieldValue } from "firebase-admin/firestore";

// Reporter contact details live in `reportContacts/{reportId}`, a collection
// the Firestore rules close to all clients, so phone numbers never reach the
// public reports feed. Only the WhatsApp channel has a contact today; web
// reporters follow progress on /track/{reportId}.

export type NotifyEvent = "dispatched" | "resolved";

type Contact = { channel?: string; phone?: string; lang?: string };

const MESSAGES: Record<NotifyEvent, Record<"en" | "hi", (area: string, action?: string) => string>> = {
  dispatched: {
    en: (area, action) =>
      `VayuSetu update: municipal action is under way for the pollution you reported near ${area}${action ? ` (${action})` : ""}. Thank you for reporting.`,
    hi: (area, action) =>
      `वायुसेतु अपडेट: ${area} के पास आपकी रिपोर्ट किए गए प्रदूषण पर नगर निगम कार्रवाई शुरू हो गई है${action ? ` (${action})` : ""}। रिपोर्ट करने के लिए धन्यवाद।`,
  },
  resolved: {
    en: (area) =>
      `VayuSetu update: the pollution hotspot you reported near ${area} has been marked resolved. Report again if it returns.`,
    hi: (area) =>
      `वायुसेतु अपडेट: ${area} के पास आपका रिपोर्ट किया गया प्रदूषण हॉटस्पॉट हल के रूप में चिह्नित किया गया है। दोबारा दिखे तो फिर से रिपोर्ट करें।`,
  },
};

function twilioConfig() {
  const sid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const token = process.env.TWILIO_AUTH_TOKEN?.trim();
  const from = process.env.TWILIO_WHATSAPP_FROM?.trim();
  if (!sid || !token || !from) return null;
  return { sid, token, from: from.startsWith("whatsapp:") ? from : `whatsapp:${from}` };
}

export function isWhatsAppNotifyConfigured() {
  return twilioConfig() !== null;
}

async function sendWhatsApp(to: string, body: string) {
  const config = twilioConfig();
  if (!config) throw new Error("Twilio WhatsApp sender is not configured.");
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${config.sid}/Messages.json`, {
    body: new URLSearchParams({
      Body: body,
      From: config.from,
      To: to.startsWith("whatsapp:") ? to : `whatsapp:${to}`,
    }),
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.sid}:${config.token}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    method: "POST",
    signal: AbortSignal.timeout(10_000),
  });
  const json = (await response.json().catch(() => ({}))) as { sid?: string; message?: string };
  if (!response.ok) throw new Error(json.message ?? `Twilio responded ${response.status}`);
  return json.sid ?? null;
}

/**
 * Messages every reachable reporter behind these reports. Failures are
 * recorded per contact and never block the operator action. Note: outside
 * WhatsApp's 24-hour session window Twilio requires an approved template,
 * so free-form sends can be rejected there; that shows up as `failed`.
 */
export async function notifyReporters(
  reportIds: string[],
  event: NotifyEvent,
  details: { area: string; action?: string },
) {
  const summary = { sent: 0, failed: 0, noContact: 0, configured: isWhatsAppNotifyConfigured() };
  if (reportIds.length === 0) return summary;

  const refs = reportIds.map((id) => adminDb.collection("reportContacts").doc(id));
  const snaps = await adminDb.getAll(...refs);

  for (const snap of snaps) {
    const contact = snap.exists ? (snap.data() as Contact) : null;
    if (!contact || contact.channel !== "whatsapp" || !contact.phone) {
      summary.noContact += 1;
      continue;
    }
    if (!summary.configured) {
      summary.failed += 1;
      continue;
    }
    const lang = contact.lang === "hi" ? "hi" : "en";
    try {
      const sid = await sendWhatsApp(contact.phone, MESSAGES[event][lang](details.area, details.action));
      summary.sent += 1;
      await snap.ref.update({
        notifications: FieldValue.arrayUnion({ event, sid, at: new Date().toISOString() }),
        lastNotifiedAt: adminServerTimestamp(),
      });
    } catch (error) {
      summary.failed += 1;
      await snap.ref
        .update({
          notifications: FieldValue.arrayUnion({
            event,
            error: error instanceof Error ? error.message : String(error),
            at: new Date().toISOString(),
          }),
        })
        .catch(() => undefined);
    }
  }
  return summary;
}
