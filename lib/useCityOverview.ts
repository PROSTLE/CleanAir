"use client";

import { useEffect, useState } from "react";

export type CityOverview = {
  id: string;
  name: string;
  region: string;
  group: string;
  liveStations: number;
  offlineStations: number;
  aqi: { value: number; category: string; color: string; dominant: string; basis: string; scaleLabelKey: string } | null;
  openHotspots: number | null;
  feedsAnswered: boolean;
};

type Overview = { at: string; cities: CityOverview[] };

// One request per page load, shared by every component that asks.
let shared: Promise<Overview | null> | null = null;

function load() {
  shared ??= fetch("/api/cities/overview")
    .then((response) => (response.ok ? (response.json() as Promise<Overview>) : null))
    .catch(() => null);
  return shared;
}

/** Live station counts, AQI and open hotspots per city (/api/cities/overview). */
export function useCityOverview() {
  const [state, setState] = useState<{ status: "loading" | "ready" | "error"; data: Overview | null }>({
    status: "loading",
    data: null,
  });
  useEffect(() => {
    let cancelled = false;
    load().then((data) => {
      if (!cancelled) setState({ status: data ? "ready" : "error", data });
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}
