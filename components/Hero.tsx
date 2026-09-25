"use client";

import HeroSection from "@/components/landing/HeroSection";
import PrioritySection from "@/components/landing/PrioritySection";
import MethodSection from "@/components/landing/MethodSection";
import CapabilitiesSection from "@/components/landing/CapabilitiesSection";
import OperationsSection from "@/components/landing/OperationsSection";
import LiveReports from "@/components/landing/LiveReports";
import ManifestoBanner from "@/components/landing/ManifestoBanner";
import SectionRail from "@/components/landing/SectionRail";
import Navbar from "@/components/shared/Navbar";
import { useT } from "@/lib/languageContext";

export default function Hero() {
  const t = useT();

  const sections = [
    { id: "top", label: t("rail_top") },
    { id: "priority", label: t("rail_priority") },
    { id: "method", label: t("rail_method") },
    { id: "capabilities", label: t("rail_capabilities") },
    { id: "operations", label: t("rail_operations") },
    { id: "reports", label: t("rail_reports") },
  ];

  return (
    <main className="sv-page">
      <SectionRail sections={sections} />

      {/* The nav lives at page level, not inside the hero. A sticky element is
          bounded by its containing block, so nested in the hero's container it
          would stop sticking the moment the hero scrolled past. */}
      <div className="sv-navbar-wrap">
        <div className="app-page-container" style={{ paddingTop: 0 }}>
          <Navbar />
        </div>
      </div>

      <section id="top" className="sv-hero-shell">
        <div className="sv-container">
          <HeroSection />
        </div>
      </section>

      <div className="sv-container">
        <PrioritySection />
        <MethodSection />
        <CapabilitiesSection />
        <OperationsSection />
        <LiveReports />
      </div>

      <ManifestoBanner />
    </main>
  );
}
