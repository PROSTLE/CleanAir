"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { CITIES, CITY_GROUPS } from "@/lib/cities";
import { useCity } from "@/lib/cityContext";
import { useT } from "@/lib/languageContext";

type CitySelectorProps = {
  onSelect?: () => void;
};

/** Navbar pill + picker for the monitored city; styled like LanguageSelector. */
export default function CitySelector({ onSelect }: CitySelectorProps = {}) {
  const t = useT();
  const { city, setCityId } = useCity();
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        aria-label={t("city_select_label")}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "6px",
          background: "transparent",
          border: "1px solid var(--line)",
          cursor: "pointer",
          padding: "6px 12px",
          borderRadius: "999px",
          marginInlineStart: "4px",
        }}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--ink)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
          <circle cx="12" cy="10" r="3" />
        </svg>
        <span style={{ fontSize: "0.9rem", fontWeight: 750, color: "var(--ink)", fontFamily: "var(--font-geist-sans)" }}>
          {city.name}
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
            padding: "20px",
          }}
          onClick={() => setIsOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t("city_select_title")}
            style={{
              background: "var(--surface)",
              borderRadius: "16px",
              padding: "32px",
              width: "100%",
              maxWidth: "640px",
              maxHeight: "90vh",
              overflowY: "auto",
              boxShadow: "var(--shadow-lg)",
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "16px", marginBottom: "24px" }}>
              <div>
                <h2 style={{ margin: 0, fontSize: "1.25rem", fontWeight: 850, color: "var(--ink)" }}>{t("city_select_title")}</h2>
                <p style={{ margin: "4px 0 0 0", fontSize: "0.9rem", color: "var(--muted)" }}>{t("city_select_desc")}</p>
              </div>
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--muted)", padding: "4px" }}
                aria-label={t("city_select_close")}
              >
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            {CITY_GROUPS.map((group) => (
            <section key={group.id} style={{ marginTop: "18px" }} aria-labelledby={`city-group-${group.id}`}>
            <h3
              id={`city-group-${group.id}`}
              style={{ margin: "0 0 10px", fontSize: "0.74rem", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--muted)" }}
            >
              {t(group.labelKey)}
            </h3>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: "12px" }}>
              {CITIES.filter((option) => option.group === group.id).map((option) => {
                const selected = option.id === city.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => {
                      setCityId(option.id);
                      setIsOpen(false);
                      onSelect?.();
                    }}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "flex-start",
                      gap: "4px",
                      padding: "16px",
                      textAlign: "start",
                      background: selected ? "rgba(17, 124, 114, 0.08)" : "var(--surface-soft)",
                      border: `1px solid ${selected ? "var(--teal)" : "var(--line)"}`,
                      borderRadius: "12px",
                      cursor: "pointer",
                    }}
                  >
                    <span style={{ fontSize: "1.1rem", fontWeight: 800, color: selected ? "var(--teal)" : "var(--ink)" }}>
                      {option.name}
                    </span>
                    <span style={{ fontSize: "0.8rem", color: "var(--muted)", fontWeight: 600 }}>{option.region}</span>
                    <span style={{ fontSize: "0.72rem", color: "var(--muted)" }}>
                      {t(`city_coverage_${option.stations.coverage}`)}
                      {option.group === "brics" ? ` · ${option.stations.network}` : ""}
                    </span>
                  </button>
                );
              })}
            </div>
            {group.id === "brics" && (
              <p style={{ margin: "10px 0 0", fontSize: "0.8rem", color: "var(--muted)" }}>{t("city_select_excluded")}</p>
            )}
            </section>
            ))}
            <p style={{ margin: "20px 0 0", fontSize: "0.8rem", color: "var(--muted)" }}>{t("city_select_sources_note")}</p>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
