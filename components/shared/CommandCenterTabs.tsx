"use client";

import Link from "next/link";
import { useT } from "@/lib/languageContext";

type CommandCenterTabsProps = {
  active: "incidents" | "forecast";
};

export default function CommandCenterTabs({ active }: CommandCenterTabsProps) {
  const t = useT();

  const tabs = [
    {
      href: "/dashboard",
      id: "incidents",
      label: t("tabs_incidents"),
      description: t("tabs_incidents_desc"),
    },
    {
      href: "/forecast",
      id: "forecast",
      label: t("tabs_forecast"),
      description: t("tabs_forecast_desc"),
    },
  ] as const;

  return (
    <div className="command-tabs" aria-label="Command Center views">
      {tabs.map((tab) => (
        <Link
          aria-current={active === tab.id ? "page" : undefined}
          className={active === tab.id ? "command-tab active" : "command-tab"}
          href={tab.href}
          key={tab.id}
        >
          <span>{tab.label}</span>
          <small>{tab.description}</small>
        </Link>
      ))}
    </div>
  );
}
