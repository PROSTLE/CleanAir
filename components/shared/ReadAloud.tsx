"use client";

import { useEffect, useState } from "react";
import Icon from "@/components/shared/Icon";
import { useLanguage, useT } from "@/lib/languageContext";
import { UI_LANGUAGES } from "@/lib/uiLanguages";

// Reads text aloud with the browser's own speech synthesis (no API, no key).
// Hidden when the device has no voice for the current UI language: an English
// voice reading Hindi text is worse than no button.

function pickVoice(voices: SpeechSynthesisVoice[], tag: string) {
  const lower = tag.toLowerCase();
  const base = lower.split("-")[0];
  return (
    voices.find((voice) => voice.lang.toLowerCase() === lower) ??
    voices.find((voice) => voice.lang.toLowerCase().replace("_", "-").startsWith(`${base}-`)) ??
    voices.find((voice) => voice.lang.toLowerCase() === base) ??
    null
  );
}

export default function ReadAloud({ text, className }: { text: string; className?: string }) {
  const t = useT();
  const { locale } = useLanguage();
  const [voice, setVoice] = useState<SpeechSynthesisVoice | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const tag = UI_LANGUAGES[locale]?.speech ?? "en-IN";

  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const synth = window.speechSynthesis;
    const update = () => setVoice(pickVoice(synth.getVoices(), tag));
    update();
    // Chrome loads the voice list asynchronously.
    synth.addEventListener("voiceschanged", update);
    return () => {
      synth.removeEventListener("voiceschanged", update);
      synth.cancel();
    };
  }, [tag]);

  if (!voice || !text.trim()) return null;

  const toggle = () => {
    const synth = window.speechSynthesis;
    if (speaking) {
      synth.cancel();
      setSpeaking(false);
      return;
    }
    synth.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.voice = voice;
    utterance.lang = voice.lang;
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    setSpeaking(true);
    synth.speak(utterance);
  };

  return (
    <button
      type="button"
      className={`svd-action svd-read-aloud ${className ?? ""}`.trim()}
      aria-pressed={speaking}
      onClick={toggle}
    >
      <Icon name="volume" size={14} />
      {speaking ? t("read_aloud_stop") : t("read_aloud")}
    </button>
  );
}
