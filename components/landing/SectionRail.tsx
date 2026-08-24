"use client";

import { useEffect, useState } from "react";

/**
 * The vertical dot rail on the left edge. Doubles as a scroll-spy: the dot for
 * whichever section owns the most viewport height grows and fills in.
 */
export default function SectionRail({ sections }: { sections: Array<{ id: string; label: string }> }) {
  const [activeId, setActiveId] = useState(sections[0]?.id ?? "");

  useEffect(() => {
    const nodes = sections
      .map((section) => document.getElementById(section.id))
      .filter((node): node is HTMLElement => node !== null);

    if (nodes.length === 0) return;

    const ratios = new Map<string, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => ratios.set(entry.target.id, entry.intersectionRatio));
        let bestId = activeId;
        let bestRatio = -1;
        ratios.forEach((ratio, id) => {
          if (ratio > bestRatio) {
            bestRatio = ratio;
            bestId = id;
          }
        });
        if (bestRatio > 0) setActiveId(bestId);
      },
      { threshold: [0, 0.15, 0.35, 0.55, 0.75, 1] },
    );

    nodes.forEach((node) => observer.observe(node));
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sections]);

  return (
    <nav className="sv-rail" aria-label="Page sections">
      <ul>
        {sections.map((section) => (
          <li key={section.id}>
            <a
              href={`#${section.id}`}
              className={`sv-rail-dot ${activeId === section.id ? "is-active" : ""}`}
              aria-current={activeId === section.id ? "true" : undefined}
            >
              <span className="sv-sr-only">{section.label}</span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
