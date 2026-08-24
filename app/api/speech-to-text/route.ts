import { NextResponse } from "next/server";

export const runtime = "nodejs";

type SpeechRecognizeResponse = {
  results?: Array<{
    alternatives?: Array<{ transcript?: string; confidence?: number }>;
  }>;
};

export async function POST(request: Request) {
  const apiKey = process.env.GOOGLE_SPEECH_API_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json(
      { error: "Speech-to-Text is not configured on the server." },
      { status: 500 },
    );
  }

  let body: { audio?: string; languageCode?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { audio, languageCode } = body;
  if (!audio) {
    return NextResponse.json({ error: "Missing audio content." }, { status: 400 });
  }

  // Strip a data URL prefix if the client sent one (e.g. "data:audio/webm;base64,...").
  const base64Audio = audio.includes(",") ? audio.split(",")[1] : audio;

  try {
    const response = await fetch(
      `https://speech.googleapis.com/v1/speech:recognize?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          config: {
            encoding: "WEBM_OPUS",
            // Deliberately no sampleRateHertz: the WebM container header already carries
            // the real rate, and a hardcoded/mismatched value here silently zeroes results.
            languageCode: languageCode || "en-IN",
            enableAutomaticPunctuation: true,
            model: "default",
          },
          audio: { content: base64Audio },
        }),
      },
    );

    const payload = (await response.json()) as SpeechRecognizeResponse & { error?: { message?: string } };

    if (!response.ok) {
      return NextResponse.json(
        { error: payload.error?.message ?? "Speech-to-Text request failed." },
        { status: response.status },
      );
    }

    const transcript = (payload.results ?? [])
      .map((result) => result.alternatives?.[0]?.transcript ?? "")
      .filter(Boolean)
      .join(" ")
      .trim();

    if (!transcript) {
      console.warn("Speech-to-Text returned no results", {
        audioBytes: base64Audio.length,
        languageCode: languageCode || "en-IN",
        rawResultCount: payload.results?.length ?? 0,
      });
      return NextResponse.json(
        {
          error:
            "Could not detect speech in that recording. Speak a little louder or closer to the mic, then try again.",
        },
        { status: 422 },
      );
    }

    return NextResponse.json({ transcript });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Speech-to-Text request failed." },
      { status: 500 },
    );
  }
}