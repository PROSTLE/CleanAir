import { existsSync } from "node:fs";
import { GoogleAuth } from "google-auth-library";
import { NextResponse } from "next/server";
import path from "path";

const CREDENTIALS_PATH = path.join(process.cwd(), "credentials", "cleanair-clear-streets-b2e96f18917e.json");

let auth: GoogleAuth | null = null;

function getAuth() {
  if (!auth) {
    // Use the local key file when it exists (dev); otherwise fall back to
    // Application Default Credentials — the runtime service account on
    // Cloud Run / App Hosting, where the gitignored key file is never present.
    auth = new GoogleAuth({
      ...(existsSync(CREDENTIALS_PATH) ? { keyFile: CREDENTIALS_PATH } : {}),
      scopes: ["https://www.googleapis.com/auth/cloud-translation"],
    });
  }
  return auth;
}

const MAX_TEXTS = 1000;
const MAX_TOTAL_CHARS = 100_000;

export async function POST(request: Request) {
  // The UI ships pre-generated locales (locales/*.json) and never calls this
  // route; it only exists for tooling. Left open, it is a public proxy onto
  // our billed Translation API, so it is off unless a secret is configured.
  const secret = process.env.TRANSLATE_API_SECRET?.trim();
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const { texts, target } = (await request.json()) as { texts: string[]; target: string };
    if (!texts?.length || !target) {
      return NextResponse.json({ error: "Missing texts or target" }, { status: 400 });
    }
    const totalChars = texts.reduce((sum, text) => sum + String(text).length, 0);
    if (texts.length > MAX_TEXTS || totalChars > MAX_TOTAL_CHARS) {
      return NextResponse.json({ error: "Request too large" }, { status: 413 });
    }
    
    // Get OAuth2 access token from service account
    const client = await getAuth().getClient();
    const tokenResponse = await client.getAccessToken();
    const token = tokenResponse.token;
    
    // Call Translation API v2 in batches of 128 (API limit)
    const BATCH = 128;
    const allTranslated: string[] = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      const batch = texts.slice(i, i + BATCH);
      const res = await fetch(
        `https://translation.googleapis.com/language/translate/v2`,
        {
          method: "POST",
          headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ q: batch, target, source: "en", format: "text" }),
        }
      );
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Google API error: ${err}`);
      }
      const data = await res.json() as { data: { translations: { translatedText: string }[] } };
      allTranslated.push(...data.data.translations.map((t) => t.translatedText));
    }
    
    return NextResponse.json({ translations: allTranslated });
  } catch (err) {
    console.error("[/api/translate]", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
