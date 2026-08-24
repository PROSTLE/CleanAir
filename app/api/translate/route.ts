import { GoogleAuth } from "google-auth-library";
import { NextResponse } from "next/server";
import path from "path";

const CREDENTIALS_PATH = path.join(process.cwd(), "credentials", "cleanair-clear-streets-b2e96f18917e.json");

let auth: GoogleAuth | null = null;

function getAuth() {
  if (!auth) {
    auth = new GoogleAuth({
      keyFile: CREDENTIALS_PATH,
      scopes: ["https://www.googleapis.com/auth/cloud-translation"],
    });
  }
  return auth;
}

export async function POST(request: Request) {
  try {
    const { texts, target } = (await request.json()) as { texts: string[]; target: string };
    if (!texts?.length || !target) {
      return NextResponse.json({ error: "Missing texts or target" }, { status: 400 });
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
