import "server-only";

import { cellToLatLng, isValidCell } from "h3-js";
import { getPopulationNear, isEarthEngineKeyConfigured, type PopulationEstimate } from "@/lib/earthEngineSatellite";
import { adminDb, adminServerTimestamp } from "@/lib/firebaseAdmin";

// Per-cell facts that don't change with the weather. The WorldPop estimate is
// computed once per cell (Earth Engine) and kept in `cellStats/{cell}`, so
// public page views never re-run the reduction.
const memory = new Map<string, PopulationEstimate>();
const inFlight = new Map<string, Promise<PopulationEstimate>>();

export const POPULATION_RADIUS_KM = 1;

export function isPopulationConfigured() {
  return isEarthEngineKeyConfigured();
}

async function loadOrCompute(h3CellId: string): Promise<PopulationEstimate> {
  const ref = adminDb.collection("cellStats").doc(h3CellId);
  const snap = await ref.get();
  const stored = snap.exists ? (snap.data()?.population as PopulationEstimate | undefined) : undefined;
  if (stored && typeof stored.population === "number" && stored.radiusKm === POPULATION_RADIUS_KM) return stored;

  const [lat, lng] = cellToLatLng(h3CellId);
  const estimate = await getPopulationNear(lat, lng, POPULATION_RADIUS_KM);
  await ref.set({ population: estimate, updatedAt: adminServerTimestamp() }, { merge: true });
  return estimate;
}

/** The stored estimate only (no Earth Engine call); null if never computed. */
export async function getCachedCellPopulation(h3CellId: string): Promise<PopulationEstimate | null> {
  if (!isValidCell(h3CellId)) return null;
  const hit = memory.get(h3CellId);
  if (hit) return hit;
  const snap = await adminDb.collection("cellStats").doc(h3CellId).get();
  const stored = snap.exists ? (snap.data()?.population as PopulationEstimate | undefined) : undefined;
  return stored && typeof stored.population === "number" ? stored : null;
}

/** Residents within 1 km of the cell centre (WorldPop estimate, cached). */
export async function getCellPopulation(h3CellId: string): Promise<PopulationEstimate> {
  if (!isValidCell(h3CellId)) throw new Error("Invalid H3 cell.");
  const hit = memory.get(h3CellId);
  if (hit) return hit;
  let pending = inFlight.get(h3CellId);
  if (!pending) {
    pending = loadOrCompute(h3CellId).finally(() => inFlight.delete(h3CellId));
    inFlight.set(h3CellId, pending);
  }
  const value = await pending;
  memory.set(h3CellId, value);
  return value;
}
