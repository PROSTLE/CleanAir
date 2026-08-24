"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useT } from "@/lib/languageContext";

const HeroPortal = dynamic(() => import("@/components/three/HeroPortal"), {
  ssr: false,
  loading: () => <div className="sv-portal-fallback" aria-hidden="true" />,
});

const SOCIALS = [
  {
    label: "Share",
    path: "M18 8a3 3 0 1 0-2.83-4H15a3 3 0 0 0 .17 1L8.7 8.51a3 3 0 1 0 0 6.98l6.47 3.5A3 3 0 1 0 18 16a3 3 0 0 0-2.13.89L9.4 13.4a3 3 0 0 0 0-2.8l6.47-3.49A3 3 0 0 0 18 8Z",
  },
  {
    label: "Community",
    path: "M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4Zm0 2c-4 0-7 2.2-7 5v1h14v-1c0-2.8-3-5-7-5Z",
  },
  {
    label: "Open data",
    path: "M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2Zm6.9 9h-3a15.6 15.6 0 0 0-1.2-5.4A8 8 0 0 1 18.9 11ZM12 4.2A13.4 13.4 0 0 1 13.8 11h-3.6A13.4 13.4 0 0 1 12 4.2ZM5.1 13h3a15.6 15.6 0 0 0 1.2 5.4A8 8 0 0 1 5.1 13Zm3-2h-3a8 8 0 0 1 4.2-5.4A15.6 15.6 0 0 0 8.1 11Zm3.9 8.8A13.4 13.4 0 0 1 10.2 13h3.6A13.4 13.4 0 0 1 12 19.8Zm2.7-1.4a15.6 15.6 0 0 0 1.2-5.4h3a8 8 0 0 1-4.2 5.4Z",
  },
];

export default function HeroSection() {
  const t = useT();

  return (
    <div className="sv-hero">
      <div className="sv-hero-copy">
        <p className="sv-eyebrow">{t("hero_kicker")}</p>

        <h1 className="sv-hero-title">
          <span className="sv-hero-title-lead">{t("hero_headline_main")}</span>
          <span className="sv-hero-title-sub">{t("hero_headline_sub")}</span>
        </h1>

        <Link href="/map" className="sv-pill">
          {t("hero_cta_map")}
          <svg viewBox="0 0 24 24" aria-hidden="true" className="sv-pill-arrow">
            <path d="M5 12h13M13 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Link>
      </div>

      <div className="sv-hero-visual">
        <div className="sv-portal">
          <HeroPortal />
        </div>
      </div>

      <div className="sv-hero-notes">
        <article>
          <h2>{t("hero_note_one_title")}</h2>
          <p>{t("hero_note_one_text")}</p>
        </article>
        <article>
          <h2>{t("hero_note_two_title")}</h2>
          <p>{t("hero_note_two_text")}</p>
        </article>
      </div>

      <ul className="sv-social-rail" aria-label="Elsewhere">
        {SOCIALS.map((social) => (
          <li key={social.label}>
            <span className="sv-social-dot" title={social.label}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d={social.path} fill="currentColor" />
              </svg>
              <span className="sv-sr-only">{social.label}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
