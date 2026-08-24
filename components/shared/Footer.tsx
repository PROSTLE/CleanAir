"use client";

import Link from "next/link";
import { useT } from "@/lib/languageContext";
import VayuSetuLogo from "@/components/shared/VayuSetuLogo";

export default function Footer() {
  const t = useT();

  return (
    <footer className="gov-footer">
      <div className="footer-container">
        <div className="footer-top">
          <div className="footer-brand">
            <Link href="/" className="brand-lockup" aria-label="VayuSetu home" style={{ marginBottom: '16px' }}>
              <VayuSetuLogo size={36} variant="dark" className="brand-mark" style={{ objectFit: 'contain', background: 'transparent', boxShadow: 'none' }} />
              <span className="brand-name" style={{ fontSize: '1.25rem', display: 'flex', gap: '2px', color: 'white' }}>
                <span style={{ fontWeight: 600, color: '#4ade80' }}>{t("nav_brand_kicker")}</span>
                <span style={{ fontWeight: 850, color: 'white' }}>{t("nav_brand_name")}</span>
              </span>
            </Link>
            <h2>{t("jury_snapshot_title")}</h2>
            <p className="gov-affiliation">
              {t("footer_affiliation")}
            </p>
          </div>
          
          <div className="footer-links">
            <div className="footer-nav-column">
              <h3>{t("footer_resources")}</h3>
              <Link href="/map">{t("footer_live_map")}</Link>
              <Link href="/report">{t("footer_report_hotspot")}</Link>
            </div>
            <div className="footer-nav-column">
              <h3>{t("footer_policies")}</h3>
              <Link href="#">{t("footer_privacy_policy")}</Link>
              <Link href="#">{t("footer_terms_of_service")}</Link>
              <Link href="#">{t("footer_accessibility")}</Link>
            </div>
          </div>
        </div>

        <div className="footer-bottom">
          <p>{t("footer_copyright").replace("{year}", new Date().getFullYear().toString())}</p>
        </div>
      </div>
    </footer>
  );
}
