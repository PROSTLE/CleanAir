"use client";

import Link from "next/link";
import { CITY_GROUPS } from "@/lib/cities";
import { useCity } from "@/lib/cityContext";
import { useT } from "@/lib/languageContext";
import { useCityOverview } from "@/lib/useCityOverview";

/**
 * Every monitored city right now: live stations, the city AQI (median of its
 * live stations) and open hotspots, read from /api/cities/overview. Nothing
 * here is typed in; a city whose feeds are down says so.
 */
export default function OperationsSection() {
  const t = useT();
  const { setCityId } = useCity();
  const overview = useCityOverview();
  const cities = overview.data?.cities ?? [];

  return (
    <section id="operations" className="sv-section sv-operations">
      <header className="sv-ops-head">
        <div>
          <p className="sv-eyebrow">{t("live_cities_kicker")}</p>
          <Link href="/map" className="sv-underline-link">
            {t("live_cities_link")}
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="1.4" />
              <path d="M9 12h6M12.5 9l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Link>
        </div>
        <h2>{t("live_cities_heading")}</h2>
      </header>

      {overview.status === "loading" && <p className="sv-live-note">{t("live_cities_loading")}</p>}
      {overview.status === "error" && <p className="sv-live-note">{t("live_cities_error")}</p>}

      {overview.status === "ready" &&
        CITY_GROUPS.map((group) => {
          const rows = cities.filter((city) => city.group === group.id);
          if (rows.length === 0) return null;
          return (
            <div key={group.id} className="sv-live-group">
              <h3 className="sv-live-group-title">{t(group.labelKey)}</h3>
              <div className="sv-live-table-wrap">
                <table className="sv-live-table">
                  <thead>
                    <tr>
                      <th scope="col">{t("live_cities_col_city")}</th>
                      <th scope="col">{t("live_cities_col_aqi")}</th>
                      <th scope="col">{t("live_cities_col_stations")}</th>
                      <th scope="col">{t("live_cities_col_hotspots")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((city) => (
                      <tr key={city.id}>
                        <th scope="row">
                          <Link href="/map" onClick={() => setCityId(city.id)}>
                            {city.name}
                          </Link>
                          <small>{city.region}</small>
                        </th>
                        <td>
                          {city.aqi ? (
                            <span className="sv-live-aqi">
                              <i style={{ background: city.aqi.color }} aria-hidden="true" />
                              <strong>{city.aqi.value}</strong>
                              <span>
                                {t(city.aqi.category)}
                                <small>
                                  {t(city.aqi.scaleLabelKey)} · {t("aqi_gauge_led_by").replace("{pollutant}", city.aqi.dominant)}
                                </small>
                              </span>
                            </span>
                          ) : (
                            <span className="sv-live-none">{t("aqi_gauge_no_live")}</span>
                          )}
                        </td>
                        <td>
                          <strong>{city.liveStations}</strong> {t("live_cities_live")}
                          {city.offlineStations > 0 && (
                            <small>
                              {city.offlineStations} {t("live_cities_offline")}
                            </small>
                          )}
                        </td>
                        <td>{city.openHotspots ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })}

      {overview.status === "ready" && overview.data && (
        <p className="sv-live-note">
          {t("live_cities_updated").replace(
            "{time}",
            new Date(overview.data.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }),
          )}
        </p>
      )}
    </section>
  );
}
