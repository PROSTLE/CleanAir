"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import Icon from "@/components/shared/Icon";
import { LEVEL_COLOR, LEVEL_LABEL_KEY, formatEta, type AdvisoryFeed } from "@/components/federation/federationData";
import { useCity } from "@/lib/cityContext";
import { useT } from "@/lib/languageContext";

type State = { cityId: string; feed: AdvisoryFeed | null; error: boolean };

/** Fires outside the city whose smoke is forecast to arrive (transboundary advisories). */
export default function IncomingSmokeCard() {
  const t = useT();
  const { city, ready } = useCity();
  const [state, setState] = useState<State | null>(null);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    fetch(`/api/federation/v1/advisories?city=${city.id}`)
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        return (await response.json()) as AdvisoryFeed;
      })
      .then((feed) => !cancelled && setState({ cityId: city.id, feed, error: false }))
      .catch(() => !cancelled && setState({ cityId: city.id, feed: null, error: true }));
    return () => {
      cancelled = true;
    };
  }, [city.id, ready]);

  const current = state?.cityId === city.id ? state : null;
  const status = current?.feed?.cities[0];
  const advisories = current?.feed?.features.map((feature) => feature.properties) ?? [];

  return (
    <section className="svd-card svd-card-wide">
      <header className="svd-card-head">
        <h2 className="vs-title">
          <Icon name="wind" size={17} />
          {t("fed_incoming_card_title")}
        </h2>
        <p>{t("fed_incoming_card_detail")}</p>
      </header>
      {!current ? (
        <p className="svd-empty">{t("fed_tracing")}</p>
      ) : current.error || status?.error ? (
        <p className="svd-empty">{t("fed_city_unavailable")}</p>
      ) : advisories.length === 0 ? (
        <p className="svd-empty">
          {t("fed_city_clear")
            .replace("{clusters}", String(status?.clustersConsidered ?? 0))
            .replace("{fires}", String(status?.firesConsidered ?? 0))}
        </p>
      ) : (
        <ul className="fed-advisories">
          {advisories.slice(0, 3).map((advisory) => (
            <li key={advisory.id}>
              <span className="fed-level" style={{ color: LEVEL_COLOR[advisory.level], borderColor: LEVEL_COLOR[advisory.level] }}>
                {t(LEVEL_LABEL_KEY[advisory.level])}
              </span>
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
        </ul>
      )}
      <p className="svd-note">
        <Link href={`/federation#city-${city.id}`}>{t("fed_open_federation")}</Link>
      </p>
    </section>
  );
}
