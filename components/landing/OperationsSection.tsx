"use client";

import Link from "next/link";
import { useT } from "@/lib/languageContext";

/**
 * Standing operating windows for the programme — the seasonal protocols the
 * platform runs against. These are programme definitions, not a log of past
 * events, so they stay static between deployments.
 */
const PROGRAMMES = [
  {
    id: "winter",
    nameKey: "ops_one_name",
    zoneKey: "ops_one_zone",
    from: "Nov 01",
    to: "Feb 28",
    modeKey: "ops_one_mode",
    hoursKey: "ops_one_hours",
  },
  {
    id: "stubble",
    nameKey: "ops_two_name",
    zoneKey: "ops_two_zone",
    from: "Oct 05",
    to: "Nov 30",
    modeKey: "ops_two_mode",
    hoursKey: "ops_two_hours",
  },
  {
    id: "dust",
    nameKey: "ops_three_name",
    zoneKey: "ops_three_zone",
    from: "Jan 01",
    to: "Dec 31",
    modeKey: "ops_three_mode",
    hoursKey: "ops_three_hours",
  },
];

export default function OperationsSection() {
  const t = useT();

  return (
    <section id="operations" className="sv-section sv-operations">
      <header className="sv-ops-head">
        <div>
          <p className="sv-eyebrow">{t("ops_kicker")}</p>
          <Link href="/dashboard" className="sv-underline-link">
            {t("ops_link")}
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="1.4" />
              <path d="M9 12h6M12.5 9l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Link>
        </div>
        <h2>{t("ops_heading")}</h2>
      </header>

      <ul className="sv-ops-list">
        {PROGRAMMES.map((programme) => (
          <li key={programme.id} className="sv-ops-row">
            <div className="sv-ops-name">
              <h3>{t(programme.nameKey)}</h3>
              <p>{t(programme.zoneKey)}</p>
            </div>

            <div className="sv-ops-dates">
              <div className="sv-ops-date">
                <span>{t("ops_from")}</span>
                <strong>{programme.from}</strong>
              </div>
              <p className="sv-ops-note">{t(programme.modeKey)}</p>
              <div className="sv-ops-date">
                <span>{t("ops_to")}</span>
                <strong>{programme.to}</strong>
              </div>
            </div>

            <div className="sv-ops-mode">
              <h4>{t("ops_channel")}</h4>
              <p>{t(programme.hoursKey)}</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
