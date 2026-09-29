"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import ForecastChart from "@/components/forecast/ForecastChart";
import Icon, { HAZARD_ICON } from "@/components/shared/Icon";
import LiveIndicator from "@/components/shared/LiveIndicator";
import ReadAloud from "@/components/shared/ReadAloud";
import { closureDisplayState } from "@/lib/closure";
import { findCity, formatCityTime } from "@/lib/cities";
import { useCity } from "@/lib/cityContext";
import type { ForecastResult, SensorReading } from "@/lib/forecastEngine";
import { useLanguage, useT } from "@/lib/languageContext";
import { chronicReasonText, recentDateKeys } from "@/lib/recurrence";
import { TIER_LABELS } from "@/lib/supportEvidence";
// Type-only imports from server modules are erased at build time.
import type { HealthAdvice, HealthGroup } from "@/lib/server/googleAirQuality";
import type { ZoneBrief } from "@/lib/server/zoneBrief";
import type { ZoneSummary } from "@/lib/server/zoneSummary";

type Loadable<T> = { state: "loading" } | { state: "ready"; data: T } | { state: "error"; message: string };

type ForecastPayload = {
  forecast: ForecastResult;
  history: SensorReading[];
  isLiveHistory: boolean;
  station: string;
  dataSource: "live" | "archive" | "modelled" | null;
};

const HEALTH_ORDER: HealthGroup[] = [
  "generalPopulation",
  "children",
  "elderly",
  "lungDiseasePopulation",
  "heartDiseasePopulation",
  "pregnantWomen",
  "athletes",
];

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  const data = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok || !data) throw new Error(data?.error ?? `Request failed (${response.status}).`);
  return data;
}

function useLoadable<T>(url: string | null, pick: (raw: unknown) => T): Loadable<T> {
  const [result, setResult] = useState<{ url: string; value: Loadable<T> } | null>(null);
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    getJson<unknown>(url)
      .then((raw) => {
        if (!cancelled) setResult({ url, value: { state: "ready", data: pick(raw) } });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setResult({ url, value: { state: "error", message: error instanceof Error ? error.message : String(error) } });
        }
      });
    return () => {
      cancelled = true;
    };
    // `pick` is a stable module-level mapper at every call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);
  return result && result.url === url ? result.value : { state: "loading" };
}

const pickSummary = (raw: unknown) => raw as ZoneSummary;
const pickBrief = (raw: unknown) => (raw as { brief: ZoneBrief }).brief;
const pickAdvice = (raw: unknown) => (raw as { advice: HealthAdvice }).advice;
const pickForecast = (raw: unknown): ForecastPayload => {
  const { history, isLiveHistory, station, dataSource, ...forecast } = raw as ForecastResult & {
    history?: SensorReading[];
    isLiveHistory?: boolean;
    station?: string;
    dataSource?: ForecastPayload["dataSource"];
  };
  return {
    forecast: forecast as ForecastResult,
    history: history ?? [],
    isLiveHistory: Boolean(isLiveHistory),
    station: station ?? "",
    dataSource: dataSource ?? null,
  };
};

/** Geocoded addresses run long; the heading keeps the first two parts. */
function shortLabel(label: string | null) {
  if (!label) return null;
  const parts = label.split(",").map((part) => part.trim()).filter(Boolean);
  return parts.length > 2 ? parts.slice(0, 2).join(", ") : label;
}

function Unavailable({ message }: { message: string }) {
  return <p className="svd-muted-note">{message}</p>;
}

export default function ZoneView({ cell }: { cell: string }) {
  const t = useT();
  const { locale } = useLanguage();
  const { city: selectedCity, setCityId } = useCity();

  const summary = useLoadable(`/api/zone/${cell}`, pickSummary);
  const brief = useLoadable(`/api/zone/${cell}/brief?lang=${locale}`, pickBrief);
  const advice = useLoadable(`/api/zone/${cell}/health?lang=${locale}`, pickAdvice);
  const forecast = useLoadable(`/api/forecast?h3CellId=${cell}`, pickForecast);

  const zone = summary.state === "ready" ? summary.data : null;
  const zoneCity = zone ? findCity(zone.city.id) : null;

  // Every page follows the selected city; an area page opened from a link
  // switches it, so the forecast chart and navbar use this city's time zone.
  useEffect(() => {
    if (zoneCity && zoneCity.id !== selectedCity.id) setCityId(zoneCity.id);
  }, [zoneCity, selectedCity.id, setCityId]);

  const nowMs = zone ? Date.parse(zone.generatedAt) : NaN;
  const recurrence = zone?.recurrence.status === "ok" ? zone.recurrence.data : null;
  const days = zone && recurrence ? recentDateKeys(nowMs, recurrence.windowDays, zone.city.timeZone) : [];
  const activeDays = new Set(recurrence?.activeDates ?? []);

  const briefText =
    brief.state === "ready" ? `${brief.data.headline} ${brief.data.whatIsHappening} ${brief.data.likelyCause}` : "";
  const adviceGroups =
    advice.state === "ready" ? HEALTH_ORDER.filter((group) => advice.data.recommendations[group]) : [];
  const generalAdvice = advice.state === "ready" ? advice.data.recommendations.generalPopulation ?? "" : "";

  return (
    <div className="svd svd-zone">
      <header className="svd-head">
        <div>
          <LiveIndicator
            state={summary.state === "ready" ? "live" : summary.state === "loading" ? "connecting" : "offline"}
            label={t("zone_kicker")}
          />
          <h1>{zone ? (shortLabel(zone.areaLabel) ?? t("zone_unnamed")) : summary.state === "loading" ? t("drawer_loading") : t("zone_unnamed")}</h1>
          {zone?.areaLabel && shortLabel(zone.areaLabel) !== zone.areaLabel && (
            <p className="svd-note">{zone.areaLabel}</p>
          )}
          <p className="svd-lede">
            {zone ? t("zone_lede").replace("{city}", `${zone.city.name}, ${zone.city.country}`) : t("zone_lede_generic")}
          </p>
          <p className="svd-note">
            {t("zone_cell_note")} <code>{cell}</code>
          </p>
        </div>
        <Link href="/report" className="svd-btn svd-btn-primary">
          {t("nav_report_button")}
        </Link>
      </header>

      {summary.state === "error" && <p className="svd-alert">{summary.message}</p>}

      {zone && (
        <div className="svd-grid">
          {/* ── Right now ───────────────────────────────────────────────── */}
          <section className="svd-card svd-card-wide">
            <header className="svd-card-head">
              <h2 className="vs-title">
                <Icon name="alert" size={17} />
                {t("zone_now_title")}
              </h2>
              <p>{t("zone_now_detail")}</p>
            </header>
            {zone.open.length === 0 ? (
              <p className="svd-empty">{t("zone_now_none")}</p>
            ) : (
              <ul className="svd-rank-list">
                {zone.open.map((incident) => {
                  const closure = closureDisplayState(incident.closure, nowMs);
                  return (
                    <li key={incident.id}>
                      <strong className="vs-title">
                        <Icon name={HAZARD_ICON[incident.hazardType] ?? "particulate"} size={14} />
                        {t(`hazard_${incident.hazardType}`)}
                      </strong>
                      <span>
                        {incident.evidence?.tier
                          ? t(`tier_${incident.evidence.tier}`) || TIER_LABELS[incident.evidence.tier]
                          : t("drawer_unpromoted")}
                        {(incident.evidence?.citizenSignal?.reportCount ?? 0) > 0 &&
                          ` · ${t("map_citizen_reports").replace("{count}", String(incident.evidence?.citizenSignal.reportCount))}`}
                      </span>
                      <span className="svd-chip-row">
                        {incident.dispatchStatus === "dispatched" && <span className="svd-chip is-ok">{t("dash_dispatched")}</span>}
                        {closure === "disputed" && <span className="svd-chip is-warn">{t("closure_chip_disputed")}</span>}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            <ul className="svd-readings svd-zone-readings">
              {zone.station.status !== "ok" ? (
                <li>
                  <span>{t("zone_station")}</span>
                  <strong>—</strong>
                </li>
              ) : !zone.station.data ? (
                <li>
                  <span>{t("zone_station_none")}</span>
                  <strong>—</strong>
                </li>
              ) : (
                <>
                  <li>
                    <span>
                      {zone.station.data.stationName} · {zone.station.data.distanceKm} km
                    </span>
                    <strong>
                      {zone.station.data.pm25 ?? "—"}
                      <em>PM2.5 µg/m³</em>
                    </strong>
                  </li>
                  <li>
                    <span>{t("zone_station_limit").replace("{limit}", String(zone.city.standards.pm25))}</span>
                    <strong>
                      {zone.station.data.pm25 == null
                        ? "—"
                        : `${zone.station.data.pm25 > zone.city.standards.pm25 ? "+" : ""}${Math.round(((zone.station.data.pm25 - zone.city.standards.pm25) / zone.city.standards.pm25) * 100)}%`}
                    </strong>
                  </li>
                </>
              )}
            </ul>
            {zone.station.status !== "ok" && <Unavailable message={zone.station.reason} />}
            {zone.station.status === "ok" && zone.station.data && (
              <p className="svd-muted-note">
                {zone.station.data.source}
                {zone.station.data.attribution ? ` · ${zone.station.data.attribution}` : ""}
                {zone.station.data.lastUpdated ? ` · ${t("dash_sensor_updated")} ${zone.station.data.lastUpdated}` : ""}
                {!zone.station.data.fresh && ` · ${t("zone_station_stale")}`}
              </p>
            )}
          </section>

          {/* ── Resident summary (Gemini) ──────────────────────────────── */}
          <section className="svd-card svd-card-wide">
            <header className="svd-card-head svd-card-head-split">
              <div>
                <h2 className="vs-title">
                  <Icon name="message" size={17} />
                  {t("zone_brief_title")}
                </h2>
                <p>{t("zone_brief_detail")}</p>
              </div>
              {briefText && <ReadAloud text={briefText} />}
            </header>
            {brief.state === "loading" && <p className="svd-empty">{t("drawer_loading")}</p>}
            {brief.state === "error" && <Unavailable message={brief.message} />}
            {brief.state === "ready" && (
              <div className="svd-zone-brief">
                <h3>{brief.data.headline}</h3>
                <p>{brief.data.whatIsHappening}</p>
                <p>
                  <span className={`svd-chip ${brief.data.causeCertainty === "likely" ? "is-ok" : "is-off"}`}>
                    {t(`zone_cause_${brief.data.causeCertainty}`)}
                  </span>{" "}
                  {brief.data.likelyCause}
                </p>
                {brief.data.evidenceCited.length > 0 && (
                  <ul className="svd-chip-row">
                    {brief.data.evidenceCited.map((item) => (
                      <li key={item} className="svd-chip">
                        {item}
                      </li>
                    ))}
                  </ul>
                )}
                <p className="svd-muted-note">
                  {t("zone_brief_generated")
                    .replace("{model}", brief.data.model)
                    .replace("{time}", zoneCity ? formatCityTime(zoneCity, brief.data.generatedAt) : brief.data.generatedAt)}
                  {brief.data.stale ? ` · ${t("zone_brief_stale")}` : ""}
                </p>
              </div>
            )}
          </section>

          {/* ── Health advice (Google Air Quality) ─────────────────────── */}
          <section className="svd-card svd-card-wide">
            <header className="svd-card-head svd-card-head-split">
              <div>
                <h2 className="vs-title">
                  <Icon name="shield" size={17} />
                  {t("zone_health_title")}
                </h2>
                <p>{t("zone_health_detail")}</p>
              </div>
              {generalAdvice && <ReadAloud text={generalAdvice} />}
            </header>
            {advice.state === "loading" && <p className="svd-empty">{t("drawer_loading")}</p>}
            {advice.state === "error" && <Unavailable message={advice.message} />}
            {advice.state === "ready" && (
              <>
                {(advice.data.localAqi != null || advice.data.universalAqi != null) && (
                  <p className="svd-big-number">
                    {advice.data.localAqi ?? advice.data.universalAqi}
                    <span>
                      {advice.data.localAqi != null
                        ? `${advice.data.localIndexName ?? ""} · ${advice.data.localCategory ?? ""}`
                        : advice.data.universalCategory ?? ""}
                    </span>
                  </p>
                )}
                {adviceGroups.length === 0 ? (
                  <p className="svd-muted-note">{t("zone_health_none")}</p>
                ) : (
                  <>
                    {generalAdvice && <p className="svd-zone-advice-lead">{generalAdvice}</p>}
                    {adviceGroups.some((group) => group !== "generalPopulation") && (
                      <details className="svd-zone-details">
                        <summary>{t("zone_health_groups")}</summary>
                        <dl className="svd-facts svd-zone-advice">
                          {adviceGroups
                            .filter((group) => group !== "generalPopulation")
                            .map((group) => (
                              <div key={group}>
                                <dt>{t(`health_group_${group}`)}</dt>
                                <dd>{advice.data.recommendations[group]}</dd>
                              </div>
                            ))}
                        </dl>
                      </details>
                    )}
                  </>
                )}
                <p className="svd-muted-note">{t("zone_health_source")}</p>
              </>
            )}
          </section>

          {/* ── Last 30 days ───────────────────────────────────────────── */}
          <section className="svd-card svd-card-wide">
            <header className="svd-card-head">
              <h2 className="vs-title">
                <Icon name="clock" size={17} />
                {t("zone_history_title")}
              </h2>
              <p>{t("zone_history_detail")}</p>
            </header>
            {zone.recurrence.status !== "ok" ? (
              <Unavailable message={zone.recurrence.reason} />
            ) : (
              <>
                {recurrence?.chronic && (
                  <p className="svd-callout">
                    {t("zone_chronic")}{" "}
                    {recurrence.chronicReasons.map((reason) => chronicReasonText(reason, t)).join(" · ")}
                  </p>
                )}
                <ol className="svd-day-strip" aria-label={t("zone_history_title")}>
                  {days.map((day) => (
                    <li key={day} className={activeDays.has(day) ? "is-active" : ""} title={day} />
                  ))}
                </ol>
                <ul className="svd-readings">
                  <li>
                    <span>{t("zone_history_episodes")}</span>
                    <strong>{recurrence?.episodes ?? "—"}</strong>
                  </li>
                  <li>
                    <span>{t("zone_history_report_days")}</span>
                    <strong>{recurrence?.reportDays ?? "—"}</strong>
                  </li>
                </ul>
                <p className="svd-muted-note">
                  {recurrence?.trackingSinceMs && zoneCity
                    ? t("zone_history_since").replace(
                        "{date}",
                        formatCityTime(zoneCity, recurrence.trackingSinceMs, { dateStyle: "medium" }),
                      )
                    : t("zone_history_no_events")}
                </p>
              </>
            )}
          </section>

          {/* ── Who's affected ─────────────────────────────────────────── */}
          <section className="svd-card svd-card-wide">
            <header className="svd-card-head">
              <h2 className="vs-title">
                <Icon name="citizens" size={17} />
                {t("zone_people_title")}
              </h2>
              <p>{t("zone_people_detail")}</p>
            </header>
            {zone.population.status === "ok" ? (
              <>
                <p className="svd-big-number">
                  ≈ {zone.population.data.population.toLocaleString("en-IN")}
                  <span>{t("zone_people_residents").replace("{km}", String(zone.population.data.radiusKm))}</span>
                </p>
                <p className="svd-muted-note">
                  {t("zone_people_source").replace("{year}", String(zone.population.data.year))}
                </p>
              </>
            ) : (
              <Unavailable message={zone.population.reason} />
            )}
            <h3 className="svd-zone-subhead">{t("drawer_sites_title")}</h3>
            {zone.sensitiveSites.status !== "ok" ? (
              <Unavailable message={zone.sensitiveSites.reason} />
            ) : zone.sensitiveSites.data.length === 0 ? (
              <p className="svd-muted-note">{t("drawer_sites_none")}</p>
            ) : (
              <ul className="svd-rank-list">
                {zone.sensitiveSites.data.slice(0, 6).map((site) => (
                  <li key={`${site.name}-${site.distanceKm}`}>
                    <strong className="vs-title">
                      <Icon name={site.kind === "hospital" ? "hospital" : "school"} size={14} />
                      {site.name}
                    </strong>
                    <span>
                      {t(`site_kind_${site.kind}`)} · {site.distanceKm} km
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* ── Next 24 hours ──────────────────────────────────────────── */}
          <section className="svd-card svd-card-full">
            <header className="svd-card-head svd-card-head-split">
              <div>
                <h2 className="vs-title">
                  <Icon name="chart" size={17} />
                  {t("zone_forecast_title")}
                </h2>
                <p>
                  {forecast.state === "ready"
                    ? t("zone_forecast_detail").replace("{station}", forecast.data.station)
                    : t("zone_forecast_detail_generic")}
                </p>
              </div>
              <Link href="/forecast" className="sv-underline-link">
                {t("tabs_forecast")} →
              </Link>
            </header>
            {forecast.state === "loading" && <p className="svd-empty">{t("forecast_loading")}</p>}
            {forecast.state === "error" && <Unavailable message={forecast.message} />}
            {forecast.state === "ready" && (
              <>
                {forecast.data.dataSource === "modelled" ? (
                  <>
                    <LiveIndicator state="archive" label={t("fc_state_modelled")} />
                    <p className="svd-muted-note">{t("fc_modelled_body")}</p>
                  </>
                ) : (
                  !forecast.data.isLiveHistory && <LiveIndicator state="archive" label={t("fc_state_archive")} />
                )}
                {zoneCity?.id === selectedCity.id ? (
                  <ForecastChart
                    forecast={forecast.data.forecast}
                    history={forecast.data.history}
                    modelled={forecast.data.dataSource === "modelled"}
                  />
                ) : (
                  <p className="svd-empty">{t("drawer_loading")}</p>
                )}
                <p className="svd-muted-note">{forecast.data.forecast.summary}</p>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
