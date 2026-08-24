"use client";

import Link from "next/link";
import { workflowSteps } from "@/components/landing/landingData";
import { useT } from "@/lib/languageContext";

export default function HowItWorks() {
  const t = useT();

  return (
    <section className="workflow-section">
      <div className="section-container">
        <div className="section-heading">
          <div>
            <p>{t("how_it_works_step2")}</p>
            <h2>{t("how_it_works_subtitle")}</h2>
          </div>
          <Link href="/report" className="btn btn-outline">
            {t("how_it_works_step1")}
          </Link>
        </div>

        <div className="workflow-grid">
          {workflowSteps.map((item) => (
            <article className="workflow-card" key={item.step}>
              <span>{item.step}</span>
              <h3>{item.step === "01" ? t("workflow_step1_title") : item.step === "02" ? t("workflow_step2_title") : t("workflow_step3_title")}</h3>
              <p>{item.step === "01" ? t("workflow_step1_text") : item.step === "02" ? t("workflow_step2_text") : t("workflow_step3_text")}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
