"use client";

import Link from "next/link";
import { useT } from "@/lib/languageContext";

// What operators and citizens get beyond detection. Each card maps to a
// shipped feature (see README "Features"), not a roadmap item.
const CAPABILITIES = [
  { step: "AI", titleKey: "cap_copilot_title", textKey: "cap_copilot_text" },
  { step: "WO", titleKey: "cap_workorder_title", textKey: "cap_workorder_text" },
  { step: "UP", titleKey: "cap_attribution_title", textKey: "cap_attribution_text" },
  { step: "ML", titleKey: "cap_forecast_title", textKey: "cap_forecast_text" },
  { step: "✓", titleKey: "cap_trust_title", textKey: "cap_trust_text" },
  { step: "↺", titleKey: "cap_loop_title", textKey: "cap_loop_text" },
];

export default function CapabilitiesSection() {
  const t = useT();

  return (
    <section id="capabilities" className="sv-section sv-method">
      <header className="sv-section-head sv-section-head-split">
        <div>
          <p className="sv-eyebrow">{t("cap_kicker")}</p>
          <h2>{t("cap_heading")}</h2>
        </div>
        <Link href="/dashboard" className="sv-underline-link">
          {t("cap_link")}
        </Link>
      </header>

      <ol className="sv-method-grid">
        {CAPABILITIES.map((item) => (
          <li className="sv-method-card" key={item.titleKey}>
            <span className="sv-method-step">{item.step}</span>
            <h3>{t(item.titleKey)}</h3>
            <p>{t(item.textKey)}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
