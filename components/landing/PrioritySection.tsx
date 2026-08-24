"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useT } from "@/lib/languageContext";

type Row = {
  id: string;
  step: string;
  badge: string;
  src: string;
  width: number;
  height: number;
  altKey: string;
  titleKey: string;
  keyKey: string;
  tone: "teal" | "rust" | "amber";
  textKey: string;
  statNumber: string;
  statLabel: string;
};

const ROWS: Row[] = [
  {
    id: "challenge",
    step: "01",
    badge: "Street-Level Crisis",
    src: "/priority/green-city.png",
    width: 896,
    height: 1200,
    altKey: "priority_one_alt",
    titleKey: "priority_one_title",
    keyKey: "priority_one_mark",
    tone: "teal",
    textKey: "priority_one_text",
    statNumber: "8+",
    statLabel: "Piloted Delhi zones mapped on H3 hex grid",
  },
  {
    id: "industrial",
    step: "02",
    badge: "Satellite Radar",
    src: "/priority/industrial.png",
    width: 896,
    height: 1200,
    altKey: "priority_two_alt",
    titleKey: "priority_two_title",
    keyKey: "priority_two_mark",
    tone: "rust",
    textKey: "priority_two_text",
    statNumber: "NO₂ & Aerosols",
    statLabel: "Sentinel-5P Earth Engine satellite detection",
  },
  {
    id: "monitor",
    step: "03",
    badge: "Ground Sensors",
    src: "/priority/monitor-sensor.png",
    width: 896,
    height: 1200,
    altKey: "priority_three_alt",
    titleKey: "priority_three_title",
    keyKey: "priority_three_mark",
    tone: "amber",
    textKey: "priority_three_text",
    statNumber: "24h",
    statLabel: "Predictive BigQuery forecast before spikes occur",
  },
];

export default function PrioritySection() {
  const t = useT();
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [scrollProgress, setScrollProgress] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    const handleScroll = () => {
      if (!scrollContainerRef.current) return;

      const rect = scrollContainerRef.current.getBoundingClientRect();
      const containerHeight = scrollContainerRef.current.offsetHeight;
      const windowHeight = window.innerHeight;

      const scrollableDistance = containerHeight - windowHeight;
      if (scrollableDistance <= 0) return;

      const currentScroll = -rect.top;
      const progress = Math.min(Math.max(currentScroll / scrollableDistance, 0), 1);

      setScrollProgress(progress);

      const idx = Math.min(Math.floor(progress * ROWS.length), ROWS.length - 1);
      setActiveIndex(idx);
    };

    window.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("resize", handleScroll);
    handleScroll();

    return () => {
      window.removeEventListener("scroll", handleScroll);
      window.removeEventListener("resize", handleScroll);
    };
  }, []);

  const scrollToSlide = (index: number) => {
    if (!scrollContainerRef.current) return;
    const containerTop = scrollContainerRef.current.offsetTop;
    const containerHeight = scrollContainerRef.current.offsetHeight;
    const windowHeight = window.innerHeight;
    const scrollableDistance = containerHeight - windowHeight;

    const targetY = containerTop + (index / (ROWS.length - 1)) * scrollableDistance;
    window.scrollTo({ top: targetY, behavior: "smooth" });
  };

  // Full-page translation: (ROWS.length - 1) * 100vw
  const maxTranslateVw = (ROWS.length - 1) * 100;
  const currentTranslateVw = scrollProgress * maxTranslateVw;

  return (
    <section id="priority" className="sv-priority-fullscreen-section">
      {/* Outer pinned scroll container: tall to enable natural scrolling */}
      <div ref={scrollContainerRef} className="sv-priority-scroll-container">
        {/* Sticky 100vw x 100vh full-page frame */}
        <div className="sv-priority-fullscreen-frame">
          {/* Top Floating HUD bar */}
          <div className="sv-priority-hud">
            <div className="sv-priority-hud-left">
              <span className="sv-live-dot" />
              <span className="sv-hud-title">OUR PRIORITY · {t("priority_heading")}</span>
            </div>

            <div className="sv-priority-hud-nav">
              <div className="sv-priority-hud-steps">
                {ROWS.map((row, idx) => (
                  <button
                    key={row.id}
                    type="button"
                    onClick={() => scrollToSlide(idx)}
                    className={`sv-priority-hud-btn ${activeIndex === idx ? "is-active" : ""}`}
                    aria-label={`Go to ${row.step}`}
                  >
                    <span className="sv-hud-btn-num">{row.step}</span>
                    <span className="sv-hud-btn-label">{t(row.keyKey)}</span>
                  </button>
                ))}
              </div>

              {/* Progress Line */}
              <div className="sv-priority-hud-progress">
                <div
                  className="sv-priority-hud-progress-fill"
                  style={{ width: `${Math.max(10, scrollProgress * 100)}%` }}
                />
              </div>
            </div>
          </div>

          {/* Fullscreen Horizontal Sliding Track */}
          <div
            className="sv-priority-fullscreen-track"
            style={{
              transform: `translate3d(-${currentTranslateVw}vw, 0, 0)`,
            }}
          >
            {ROWS.map((row, index) => {
              // Calculate slide scale and entrance
              const slideProgress = scrollProgress * (ROWS.length - 1);
              const dist = Math.abs(slideProgress - index);
              const contentOpacity = Math.max(0.2, 1 - dist * 0.9);
              const contentTranslateX = (slideProgress - index) * 40;

              return (
                <div
                  key={row.id}
                  className={`sv-priority-full-slide sv-priority-slide-${row.tone} ${
                    activeIndex === index ? "is-active-slide" : ""
                  }`}
                >
                  <div
                    className="sv-priority-slide-content"
                    style={{
                      opacity: contentOpacity,
                      transform: `translateX(${contentTranslateX}px)`,
                    }}
                  >
                    {/* Left Column: Huge Editorial Copy */}
                    <div className="sv-priority-slide-copy">
                      <div className="sv-priority-slide-badge-row">
                        <span className={`sv-priority-badge sv-priority-badge-${row.tone}`}>
                          Problem {row.step} · {row.badge}
                        </span>
                        <span className="sv-priority-slide-counter">
                          0{index + 1} / 0{ROWS.length}
                        </span>
                      </div>

                      <h2 className="sv-priority-slide-title">
                        {t(row.titleKey)}{" "}
                        <span className={`sv-key sv-key-${row.tone}`}>{t(row.keyKey)}</span>
                      </h2>

                      <p className="sv-priority-slide-desc">{t(row.textKey)}</p>

                      <div className="sv-priority-slide-stat-card">
                        <span className="sv-priority-stat-num">{row.statNumber}</span>
                        <span className="sv-priority-stat-label">{row.statLabel}</span>
                      </div>
                    </div>

                    {/* Right Column: Heroic Floating Artwork */}
                    <div className="sv-priority-slide-visual">
                      <div className={`sv-priority-visual-glow sv-glow-${row.tone}`} />
                      <figure className="sv-priority-visual-figure">
                        <Image
                          src={row.src}
                          alt={t(row.altKey)}
                          width={row.width}
                          height={row.height}
                          priority={index === 0}
                          className="sv-priority-visual-img"
                          sizes="(max-width: 1080px) 90vw, 45vw"
                        />
                      </figure>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Bottom Floating Indicator */}
          <div className="sv-priority-hud-bottom">
            <span className="sv-priority-scroll-indicator">
              Scroll down to slide · {activeIndex + 1} of {ROWS.length}
            </span>
          </div>
        </div>
      </div>

      {/* Program / Forecast Section continues below seamlessly */}
      <div className="sv-container sv-program-section-wrap">
        <div className="sv-program">
          <header className="sv-editorial-head">
            <h2>{t("program_heading")}</h2>
            <p>{t("program_sub")}</p>
          </header>

          <article className="sv-program-card">
            <figure className="sv-program-figure">
              <Image
                src="/priority/smog-city.jpg"
                alt={t("program_forecast_alt")}
                width={1200}
                height={896}
                sizes="(max-width: 1080px) 90vw, 42vw"
              />
            </figure>

            <div className="sv-program-copy">
              <p className="sv-eyebrow">{t("program_forecast_kicker")}</p>
              <h3>{t("program_forecast_title")}</h3>
              <p className="sv-program-body">{t("program_forecast_text")}</p>
              <Link href="/forecast" className="sv-underline-link sv-program-link">
                {t("program_forecast_link")}
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M5 12h13M13 6l6 6-6 6"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </Link>
            </div>
          </article>
        </div>
      </div>
    </section>
  );
}
