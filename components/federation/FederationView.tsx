"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import Icon from "@/components/shared/Icon";
import LiveIndicator from "@/components/shared/LiveIndicator";
import { CITIES, formatCityTime, getCity } from "@/lib/cities";
import { useT } from "@/lib/languageContext";
import CorridorSection, { type CorridorFeed } from "@/components/federation/CorridorSection";
import { LEVEL_COLOR, LEVEL_LABEL_KEY, formatEta, type AdvisoryFeed } from "@/components/federation/federationData";

// MapLibre loads after the page shell, as on the public map.
const FederationMap = dynamic(() => import("@/components/federation/FederationMap"), { ssr: false });

const REFRESH_MS = 10 * 60 * 1000;
const FEED_BASE = "/api/federation/v1";

type Group = "india" | "brics";

function LevelChip({ level }: { level: keyof typeof LEVEL_COLOR }) {
  const t = useT();
  return (
    <span className="fed-level" style={{ color: LEVEL_COLOR[level], borderColor: LEVEL_COLOR[level] }}>
      {t(LEVEL_LABEL_KEY[level])}
    </span>
  );
}

export default function FederationView() {
  const t = useT();
  const [group, setGroup] = useState<Group>("india");
  const [state, setState] = useState<{ group: Group; feed: AdvisoryFeed | null; error: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(`${FEED_BASE}/advisories?city=${group}`);
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
        if (!cancelled) setState({ group, feed: body as AdvisoryFeed, error: "" });
      } catch (loadError) {
        const message = loadError instanceof Error ? loadError.message : String(loadError);
        // Keep the last good feed on a failed refresh.
        if (!cancelled) setState((previous) => ({ group, feed: previous?.group === group ? previous.feed : null, error: message }));
      }
    };
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [group]);

  const [corridors, setCorridors] = useState<{ feed: CorridorFeed | null; error: string }>({ feed: null, error: "" });

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(`${FEED_BASE}/corridors`);
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
        if (!cancelled) setCorridors({ feed: body as CorridorFeed, error: "" });
      } catch (loadError) {
        const message = loadError instanceof Error ? loadError.message : String(loadError);
        if (!cancelled) setCorridors((previous) => ({ feed: previous.feed, error: message }));
      }
    };
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const current = state?.group === group ? state : null;
  const feed = current?.feed ?? null;
  const error = current?.error ?? "";
  const loading = !current;

  const byCity = useMemo(() => {
    const cities = CITIES.filter((city) => city.group === group);
    return cities.map((city) => ({
      city,
      status: feed?.cities.find((entry) => entry.cityId === city.id) ?? null,
      advisories: (feed?.features ?? []).filter((feature) => feature.properties.cityId === city.id).map((feature) => feature.properties),
    }));
  }, [feed, group]);

  const totals = useMemo(() => {
    const advisories = feed?.features ?? [];
    return {
      advisories: advisories.length,
      interState: advisories.filter((feature) => feature.properties.interState).length,
      citiesAffected: new Set(advisories.map((feature) => feature.properties.cityId)).size,
      sourceStates: feed?.bySourceState.length ?? 0,
    };
  }, [feed]);

  const feeds = [
    { id: "discovery", href: FEED_BASE, format: "JSON", title: t("fed_feed_discovery"), detail: t("fed_feed_discovery_detail") },
    { id: "hotspots", href: `${FEED_BASE}/hotspots?city=${group}`, format: "GeoJSON", title: t("fed_feed_hotspots"), detail: t("fed_feed_hotspots_detail") },
    { id: "advisories", href: `${FEED_BASE}/advisories?city=${group}`, format: "GeoJSON", title: t("fed_feed_advisories"), detail: t("fed_feed_advisories_detail") },
    { id: "corridors", href: `${FEED_BASE}/corridors`, format: "JSON", title: t("fed_feed_corridors"), detail: t("fed_feed_corridors_detail") },
    { id: "cap", href: `${FEED_BASE}/cap?city=${group}`, format: "CAP 1.2 · Atom", title: t("fed_feed_cap"), detail: t("fed_feed_cap_detail") },
  ];

  return (
    <div className="svd fed">
      <header className="svd-head">
        <div>
          <LiveIndicator
            state={loading ? "connecting" : error ? "offline" : "live"}
            label={loading ? t("fed_tracing") : error ? t("fed_feed_error") : t("fed_live")}
          />
          <h1>{t("fed_title")}</h1>
          <p className="svd-lede">{t("fed_lede")}</p>
        </div>
        <div className="svd-viewnav" role="tablist" aria-label={t("fed_group_label")}>
          {(["india", "brics"] as const).map((id) => (
            <button
              aria-selected={group === id}
              className={group === id ? "svd-viewnav-item is-active" : "svd-viewnav-item"}
              key={id}
              onClick={() => setGroup(id)}
              role="tab"
              type="button"
            >
              {t(id === "india" ? "city_group_india" : "city_group_brics")}
            </button>
          ))}
        </div>
      </header>

      {error && (
        <p className="svd-alert" role="status">
          {t("fed_feed_error")}: {error}
        </p>
      )}

      <ul className="svd-kpis">
        {[
          { id: "advisories", value: totals.advisories, label: t("fed_kpi_advisories"), detail: t("fed_kpi_advisories_detail") },
          { id: "interstate", value: totals.interState, label: t("fed_kpi_interstate"), detail: t("fed_kpi_interstate_detail") },
          { id: "cities", value: totals.citiesAffected, label: t("fed_kpi_cities"), detail: t("fed_kpi_cities_detail") },
          { id: "states", value: totals.sourceStates, label: t("fed_kpi_states"), detail: t("fed_kpi_states_detail") },
        ].map((kpi) => (
          <li className="svd-kpi" key={kpi.id}>
            <strong>{feed ? kpi.value : "—"}</strong>
            <span>{kpi.label}</span>
            <small>{kpi.detail}</small>
          </li>
        ))}
      </ul>

      <section className="svd-card fed-map-card">
        <header className="svd-card-head">
          <h2 className="vs-title">
            <Icon name="wind" size={17} />
            {t("fed_map_title")}
          </h2>
          <p>{t("fed_map_detail")}</p>
        </header>
        <FederationMap feed={feed} group={group} corridors={group === "india" ? corridors.feed : null} />
        <ul className="fed-legend">
          {(["severe", "high", "moderate", "watch"] as const).map((level) => (
            <li key={level}>
              <span style={{ background: LEVEL_COLOR[level] }} aria-hidden="true" />
              {t(LEVEL_LABEL_KEY[level])}
            </li>
          ))}
        </ul>
      </section>

      <div className="svd-grid">
        <section className="svd-card svd-card-wide">
          <header className="svd-card-head">
            <h2 className="vs-title">
              <Icon name="flame" size={17} />
              {t("fed_incoming_title")}
            </h2>
            <p>{t("fed_incoming_detail")}</p>
          </header>
          <ul className="fed-cities">
            {byCity.map(({ city, status, advisories }) => (
              <li className="fed-city" id={`city-${city.id}`} key={city.id}>
                <div className="fed-city-head">
                  <strong>{city.name}</strong>
                  <span>{city.region}</span>
                </div>
                {!status ? (
                  <p className="svd-empty">{loading ? t("fed_tracing") : "—"}</p>
                ) : status.error ? (
                  <p className="svd-empty">{t("fed_city_unavailable")}</p>
                ) : advisories.length === 0 ? (
                  <p className="svd-empty">
                    {t("fed_city_clear")
                      .replace("{clusters}", String(status.clustersConsidered))
                      .replace("{fires}", `${status.firesConsidered}${status.firesTruncated ? "+" : ""}`)}
                  </p>
                ) : (
                  <ul className="fed-advisories">
                    {advisories.slice(0, 4).map((advisory) => (
                      <li key={advisory.id}>
                        <LevelChip level={advisory.level} />
                        <span className="fed-source">
                          {advisory.source.label}
                          {advisory.interState && <em>{t("fed_interstate")}</em>}
                        </span>
                        <span className="fed-meta">
                          {t("fed_fires_count").replace("{count}", String(advisory.fireCount))} · {advisory.distanceKm} km
                        </span>
                        <strong className="fed-eta">{formatEta(advisory.etaHours)}</strong>
                      </li>
                    ))}
                    {advisories.length > 4 && (
                      <li className="fed-more">{t("fed_more_sources").replace("{count}", String(advisories.length - 4))}</li>
                    )}
                  </ul>
                )}
                {status && !status.error && (
                  <p className="svd-note">
                    {t("fed_computed_at").replace("{time}", formatCityTime(getCity(city.id), status.computedAt))}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>

        <section className="svd-card svd-card-wide">
          <header className="svd-card-head">
            <h2 className="vs-title">
              <Icon name="shield" size={17} />
              {t("fed_source_title")}
            </h2>
            <p>{t("fed_source_detail")}</p>
          </header>
          {!feed ? (
            <p className="svd-empty">{loading ? t("fed_tracing") : "—"}</p>
          ) : feed.bySourceState.length === 0 ? (
            <p className="svd-empty">{t("fed_source_none")}</p>
          ) : (
            <table className="fed-table">
              <thead>
                <tr>
                  <th scope="col">{t("fed_col_state")}</th>
                  <th scope="col">{t("fed_col_fires")}</th>
                  <th scope="col">{t("fed_col_affects")}</th>
                </tr>
              </thead>
              <tbody>
                {feed.bySourceState.map((row) => (
                  <tr key={row.state}>
                    <th scope="row">
                      {row.state}
                      <small>{t("fed_clusters").replace("{count}", String(row.clusters))}</small>
                    </th>
                    <td>{row.fireCount}</td>
                    <td>
                      <ul className="fed-affects">
                        {row.affectedCities.map((entry) => (
                          <li key={entry.cityId} style={{ borderColor: LEVEL_COLOR[entry.level] }}>
                            {entry.cityName} <span>{formatEta(entry.etaHours)}</span>
                          </li>
                        ))}
                      </ul>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="svd-note">{t("fed_source_note")}</p>
        </section>

        {group === "india" && <CorridorSection feed={corridors.feed} error={corridors.error} />}

        <section className="svd-card svd-card-full">
          <header className="svd-card-head">
            <h2 className="vs-title">
              <Icon name="database" size={17} />
              {t("fed_feeds_title")}
            </h2>
            <p>{t("fed_feeds_detail")}</p>
          </header>
          <ul className="fed-feeds">
            {feeds.map((entry) => (
              <li key={entry.id}>
                <div>
                  <strong>{entry.title}</strong>
                  <span className="fed-format">{entry.format}</span>
                </div>
                <p>{entry.detail}</p>
                <a href={entry.href} target="_blank" rel="noreferrer">
                  <code>{entry.href}</code>
                </a>
              </li>
            ))}
          </ul>
          <p className="svd-note">{t("fed_method_note")}</p>
        </section>
      </div>
    </div>
  );
}
