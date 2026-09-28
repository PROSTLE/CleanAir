"use client";
import React, { createContext, useCallback, useContext, useSyncExternalStore } from "react";
import { DEFAULT_CITY_ID, findCity, getCity, type CityConfig } from "@/lib/cities";

const STORAGE_KEY = "preferred_city";
const CHANGE_EVENT = "vayusetu:city-change";
// Fallback when storage is blocked, so switching still works for the session.
let memoryCityId: string | null = null;

interface CityContextValue {
  city: CityConfig;
  setCityId: (id: string) => void;
  /**
   * False during the first (server-matching) render, before the saved city is
   * read. City-specific fetches and maps wait for it, so a page opened for
   * Jakarta never fetches Delhi first.
   */
  ready: boolean;
}

const CityContext = createContext<CityContextValue>({
  city: getCity(DEFAULT_CITY_ID),
  setCityId: () => {},
  ready: false,
});

const subscribeNever = () => () => {};

function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

function readSavedCityId() {
  try {
    return findCity(localStorage.getItem(STORAGE_KEY) ?? memoryCityId)?.id ?? DEFAULT_CITY_ID;
  } catch {
    return findCity(memoryCityId)?.id ?? DEFAULT_CITY_ID;
  }
}

/** The selected monitored city, shared by every page and remembered per browser. */
export function CityProvider({ children }: { children: React.ReactNode }) {
  const cityId = useSyncExternalStore(subscribe, readSavedCityId, () => DEFAULT_CITY_ID);
  const ready = useSyncExternalStore(subscribeNever, () => true, () => false);

  const setCityId = useCallback((id: string) => {
    const city = findCity(id);
    if (!city) return;
    memoryCityId = city.id;
    try {
      localStorage.setItem(STORAGE_KEY, city.id);
    } catch {
      // Ignore: the choice just won't persist.
    }
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);

  return <CityContext.Provider value={{ city: getCity(cityId), setCityId, ready }}>{children}</CityContext.Provider>;
}

export function useCity() {
  return useContext(CityContext);
}
