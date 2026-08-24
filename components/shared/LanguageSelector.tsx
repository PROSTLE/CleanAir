"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { useLanguage } from "@/lib/languageContext";

const LANGUAGES = [
  { code: "en", name: "English", script: "EN" },
  { code: "hi", name: "Hindi", script: "हिन्दी" },
  { code: "ta", name: "Tamil", script: "தமிழ்" },
  { code: "te", name: "Telugu", script: "తెలుగు" },
  { code: "kn", name: "Kannada", script: "ಕನ್ನಡ" },
  { code: "ml", name: "Malayalam", script: "മലയാളം" },
  { code: "mr", name: "Marathi", script: "मराठी" },
  { code: "bn", name: "Bengali", script: "বাংলা" },
  { code: "gu", name: "Gujarati", script: "ગુજરાતી" },
  { code: "pa", name: "Punjabi", script: "ਪੰਜਾਬੀ" },
  { code: "ur", name: "Urdu", script: "اردو" },
  { code: "or", name: "Odia", script: "ଓଡ଼ିଆ" },
  { code: "as", name: "Assamese", script: "অসমীয়া" },
];

type LanguageSelectorProps = {
  onSelect?: () => void;
};

export default function LanguageSelector({ onSelect }: LanguageSelectorProps = {}) {
  const { locale, setLocale, loading } = useLanguage();
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setIsOpen(true)}
        aria-label="Select Language"
        style={{
          display: "flex",
          alignItems: "center",
          gap: "6px",
          background: "transparent",
          border: "1px solid var(--line)",
          cursor: "pointer",
          padding: "6px 12px",
          borderRadius: "999px",
          opacity: loading ? 0.5 : 1,
          marginInlineStart: "4px",
        }}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--ink)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="10" />
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
          <path d="M2 12h20" />
        </svg>
        <span style={{ fontSize: "0.9rem", fontWeight: 750, color: "var(--ink)", fontFamily: "var(--font-geist-sans)" }}>
          {LANGUAGES.find((l) => l.code === locale)?.script || "EN"}
        </span>
      </button>

      {isOpen && typeof document !== "undefined" && createPortal(
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 9999,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(16, 24, 40, 0.4)",
            backdropFilter: "blur(4px)",
            animation: "fadeIn 0.2s ease-out",
            padding: "20px"
          }}
          onClick={() => setIsOpen(false)}
        >
          <div
            style={{
              background: "var(--surface)",
              borderRadius: "16px",
              padding: "32px",
              width: "100%",
              maxWidth: "640px",
              maxHeight: "90vh",
              overflowY: "auto",
              boxShadow: "var(--shadow-lg)",
              animation: "slideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "24px" }}>
              <div>
                <h2 style={{ margin: 0, fontSize: "1.25rem", fontWeight: 850, color: "var(--ink)" }}>Choose your language</h2>
                <p style={{ margin: "4px 0 0 0", fontSize: "0.9rem", color: "var(--muted)" }}>Select a language for the VayuSetu interface.</p>
              </div>
              <button
                onClick={() => setIsOpen(false)}
                style={{
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  color: "var(--muted)",
                  padding: "4px",
                }}
                aria-label="Close"
              >
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              </button>
            </div>

            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
              gap: "12px"
            }}>
              {LANGUAGES.map((lang) => (
                <button
                  key={lang.code}
                  onClick={() => {
                    setLocale(lang.code);
                    setIsOpen(false);
                    onSelect?.();
                  }}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "flex-start",
                    padding: "16px",
                    background: locale === lang.code ? "rgba(17, 124, 114, 0.08)" : "var(--surface-soft)",
                    border: `1px solid ${locale === lang.code ? "var(--teal)" : "var(--line)"}`,
                    borderRadius: "12px",
                    cursor: "pointer",
                    transition: "all 0.2s ease",
                  }}
                  onMouseEnter={(e) => {
                    if (locale !== lang.code) e.currentTarget.style.borderColor = "var(--line-strong)";
                  }}
                  onMouseLeave={(e) => {
                    if (locale !== lang.code) e.currentTarget.style.borderColor = "var(--line)";
                  }}
                >
                  <span style={{ fontSize: "1.25rem", fontWeight: 800, color: locale === lang.code ? "var(--teal)" : "var(--ink)", marginBottom: "4px" }}>
                    {lang.script}
                  </span>
                  <span style={{ fontSize: "0.75rem", color: "var(--muted)", fontWeight: 600 }}>
                    {lang.name}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>,
        document.body
      )}

      <style dangerouslySetInnerHTML={{__html: `
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes slideUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
      `}} />
    </>
  );
}
