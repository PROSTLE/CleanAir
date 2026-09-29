// The 13 UI languages (locales/*.json), with the English name used in
// Gemini prompts and the BCP-47 tag used to pick a speech-synthesis voice.
export const UI_LANGUAGES: Record<string, { name: string; speech: string }> = {
  en: { name: "English", speech: "en-IN" },
  hi: { name: "Hindi", speech: "hi-IN" },
  ta: { name: "Tamil", speech: "ta-IN" },
  te: { name: "Telugu", speech: "te-IN" },
  kn: { name: "Kannada", speech: "kn-IN" },
  ml: { name: "Malayalam", speech: "ml-IN" },
  mr: { name: "Marathi", speech: "mr-IN" },
  bn: { name: "Bengali", speech: "bn-IN" },
  gu: { name: "Gujarati", speech: "gu-IN" },
  pa: { name: "Punjabi", speech: "pa-IN" },
  ur: { name: "Urdu", speech: "ur-IN" },
  or: { name: "Odia", speech: "or-IN" },
  as: { name: "Assamese", speech: "as-IN" },
};

export function normalizeUiLanguage(code: string | null | undefined) {
  const value = (code ?? "").trim().toLowerCase();
  return value in UI_LANGUAGES ? value : "en";
}
