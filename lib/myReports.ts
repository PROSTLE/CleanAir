import { useMemo, useSyncExternalStore } from "react";

// Reports submitted from this browser, so an anonymous citizen can come back
// to /track/{id}. Per-device convenience only: storage may be unavailable
// (private mode) and everything must still work without it.
const STORAGE_KEY = "vayusetu_my_reports";
const MAX_ENTRIES = 20;

export type MyReport = { id: string; label: string; createdAt: string };

export function loadMyReports(): MyReport[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as MyReport[]) : [];
    return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry?.id === "string") : [];
  } catch {
    return [];
  }
}

export function saveMyReport(entry: MyReport) {
  try {
    const next = [entry, ...loadMyReports().filter((existing) => existing.id !== entry.id)].slice(0, MAX_ENTRIES);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    notifyMyReportsChanged();
  } catch {
    /* storage unavailable; the tracking link on screen still works */
  }
}

// ─── React binding ───────────────────────────────────────────────────────────
// useSyncExternalStore keeps SSR (empty) and the first client render
// consistent, and updates across tabs via the `storage` event.

const CHANGE_EVENT = "vayusetu-my-reports";

function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

function getRawSnapshot() {
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function useMyReports(): MyReport[] {
  const raw = useSyncExternalStore(subscribe, getRawSnapshot, () => "");
  return useMemo(() => (raw ? loadMyReports() : []), [raw]);
}

export function notifyMyReportsChanged() {
  window.dispatchEvent(new Event(CHANGE_EVENT));
}
