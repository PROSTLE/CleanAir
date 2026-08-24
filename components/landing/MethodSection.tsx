"use client";

import { useT } from "@/lib/languageContext";
import { techStack } from "@/components/landing/landingData";

const STEPS = [
  { step: "01", titleKey: "workflow_step1_title", textKey: "workflow_step1_text" },
  { step: "02", titleKey: "workflow_step2_title", textKey: "workflow_step2_text" },
  { step: "03", titleKey: "workflow_step3_title", textKey: "workflow_step3_text" },
];

export default function MethodSection() {
  const t = useT();

  return (
    <section id="method" className="sv-section sv-method">
      <header className="sv-section-head sv-section-head-split">
        <div>
          <p className="sv-eyebrow">{t("how_it_works_step2")}</p>
          <h2>{t("how_it_works_subtitle")}</h2>
        </div>
      </header>

      <ol className="sv-method-grid">
        {STEPS.map((item) => (
          <li className="sv-method-card" key={item.step}>
            <span className="sv-method-step">{item.step}</span>
            <h3>{t(item.titleKey)}</h3>
            <p>{t(item.textKey)}</p>
          </li>
        ))}
      </ol>

      <ul className="sv-stack" aria-label="Built with">
        {techStack.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  );
}
