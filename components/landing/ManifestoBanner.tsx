"use client";

import dynamic from "next/dynamic";
import { useEffect, useId, useRef, useState } from "react";
import { useT } from "@/lib/languageContext";

const LiveVisual = dynamic(() => import("@/components/three/LiveVisual"), {
  ssr: false,
  loading: () => <div className="sv-blob-fallback" aria-hidden="true" />,
});

/**
 * Giant headline with the live ocean showing through the letterforms.
 *
 * The knockout is an SVG mask: a white rect (opaque → dark panel paints) with
 * black text punched into it (transparent → the WebGL canvas underneath shows).
 * The viewBox is kept in exact 1:1 pixel sync with the element via a
 * ResizeObserver, so the type never stretches the way a fixed viewBox would.
 */
export default function ManifestoBanner() {
  const t = useT();
  const maskId = useId().replace(/:/g, "");
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 1200, height: 460 });

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setSize({ width, height });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const { width, height } = size;
  const fontSize = Math.min(width * 0.108, height * 0.3);
  const lineGap = fontSize * 1.02;
  const centerY = height * 0.47;

  const lines = [t("manifesto_line_one"), t("manifesto_line_two")];

  return (
    <section id="manifesto" className="sv-manifesto" ref={containerRef}>
      <div className="sv-manifesto-canvas" aria-hidden="true">
        <LiveVisual variant="coast" className="sv-manifesto-visual" />
      </div>

      <svg
        className="sv-manifesto-mask"
        width="100%"
        height="100%"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <defs>
          <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width={width} height={height}>
            <rect x="0" y="0" width={width} height={height} fill="#ffffff" />
            {lines.map((line, index) => (
              <text
                key={line + index}
                x={width / 2}
                y={centerY + (index - (lines.length - 1) / 2) * lineGap}
                textAnchor="middle"
                dominantBaseline="middle"
                fill="#000000"
                style={{
                  fontFamily: "var(--font-geist-sans), system-ui, sans-serif",
                  fontWeight: 800,
                  fontSize: `${fontSize}px`,
                  letterSpacing: `${fontSize * -0.035}px`,
                }}
              >
                {line}
              </text>
            ))}
          </mask>
        </defs>
        <rect x="0" y="0" width={width} height={height} fill="var(--sv-night)" mask={`url(#${maskId})`} />
      </svg>

      <p className="sv-manifesto-caption">{t("manifesto_caption")}</p>

      {/* Accessible equivalent of the masked type. */}
      <h2 className="sv-sr-only">
        {lines.join(" ")}
      </h2>
    </section>
  );
}
