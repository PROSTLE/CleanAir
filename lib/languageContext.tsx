"use client";
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

async function loadEN(): Promise<Record<string, string>> {
  const mod = await import("../locales/en.json");
  return mod.default as Record<string, string>;
}

async function loadLocaleFile(lang: string): Promise<Record<string, string>> {
  // Dynamic import of the static pre-built locale file.
  // These files are generated once by `node scripts/generate-locales.js`
  // and committed to the repo. No API calls happen at runtime.
  switch (lang) {
    case "hi": return (await import("../locales/hi.json")).default as Record<string, string>;
    case "ta": return (await import("../locales/ta.json")).default as Record<string, string>;
    case "te": return (await import("../locales/te.json")).default as Record<string, string>;
    case "kn": return (await import("../locales/kn.json")).default as Record<string, string>;
    case "ml": return (await import("../locales/ml.json")).default as Record<string, string>;
    case "mr": return (await import("../locales/mr.json")).default as Record<string, string>;
    case "bn": return (await import("../locales/bn.json")).default as Record<string, string>;
    case "gu": return (await import("../locales/gu.json")).default as Record<string, string>;
    case "pa": return (await import("../locales/pa.json")).default as Record<string, string>;
    case "ur": return (await import("../locales/ur.json")).default as Record<string, string>;
    case "or": return (await import("../locales/or.json")).default as Record<string, string>;
    case "as": return (await import("../locales/as.json")).default as Record<string, string>;
    default:   return loadEN();
  }
}

interface LanguageContextValue {
  locale: string;
  setLocale: (lang: string) => void;
  t: (key: string) => string;
  loading: boolean;
}

const LanguageContext = createContext<LanguageContextValue>({
  locale: "en",
  setLocale: () => {},
  t: (key) => key,
  loading: false,
});

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState("en");
  const [translations, setTranslations] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const enRef = useRef<Record<string, string>>({});

  const applyLocale = useCallback(async (lang: string) => {
    if (lang === "en") {
      setTranslations(enRef.current);
      return;
    }
    setLoading(true);
    try {
      const localeData = await loadLocaleFile(lang);
      setTranslations(localeData);
    } catch {
      // Fallback to English if the file fails to load
      setTranslations(enRef.current);
    } finally {
      setLoading(false);
    }
  }, []);

  // Load English base on mount, then restore saved language
  useEffect(() => {
    loadEN().then(async (en) => {
      enRef.current = en;
      const saved = typeof window !== "undefined"
        ? localStorage.getItem("preferred_locale") || "en"
        : "en";
      if (saved !== "en") {
        setLocaleState(saved);
        await applyLocale(saved);
      } else {
        setTranslations(en);
      }
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const setLocale = useCallback((lang: string) => {
    setLocaleState(lang);
    localStorage.setItem("preferred_locale", lang);
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "ur" ? "rtl" : "ltr";
    applyLocale(lang);
  }, [applyLocale]);

  const t = useCallback((key: string): string => {
    const val = translations[key];
    if (val && val.trim() !== "") return val;
    const enVal = enRef.current[key];
    if (enVal && enVal.trim() !== "") return enVal;
    return key;
  }, [translations]);

  return (
    <LanguageContext.Provider value={{ locale, setLocale, t, loading }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  return useContext(LanguageContext);
}

// Shorthand hook — drop-in for useTranslations() return value
export function useT() {
  const { t } = useContext(LanguageContext);
  return t;
}
