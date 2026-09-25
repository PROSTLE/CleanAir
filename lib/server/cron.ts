import "server-only";

import { scanAmbientHotspots } from "@/lib/ambientScan";
import { fetchAllStationReadings } from "@/lib/cpcbSensor";
import { getRegionalFireHotspots } from "@/lib/earthEngineSatellite";
import { adminDb, adminServerTimestamp } from "@/lib/firebaseAdmin";
import {
  ARIMA_MIN_TRAINING_ROWS,
  countLiveTrainingRows,
  insertLiveReadings,
  isBigQueryConfigured,
  startArimaTraining,
} from "@/lib/server/bigqueryLive";
import { classifyReport, MAX_CLASSIFICATION_ATTEMPTS } from "@/lib/server/classifyReport";

const PENDING_GRACE_MS = 2 * 60 * 1000;
const SWEEP_LIMIT = 10;
const ARIMA_RETRAIN_INTERVAL_MS = 20 * 60 * 60 * 1000;

type StepResult = Record<string, unknown> & { ok: boolean };

async function step(name: string, fn: () => Promise<Record<string, unknown>>): Promise<[string, StepResult]> {
  const startedAt = Date.now();
  try {
    return [name, { ok: true, ms: Date.now() - startedAt, ...(await fn()) }];
  } catch (error) {
    console.error(`[cron] ${name} failed`, error);
    return [name, { ok: false, ms: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) }];
  }
}

/** Reports whose background classification never finished (instance recycled, provider outage). */
async function sweepUnclassifiedReports(origin: string) {
  const snapshot = await adminDb
    .collection("reports")
    .where("status", "in", ["pending", "classification_failed"])
    .limit(50)
    .get();
  const now = Date.now();
  const due = snapshot.docs
    .filter((doc) => {
      const data = doc.data();
      const createdMs = data.createdAt?.toDate?.().getTime?.() ?? 0;
      return now - createdMs >= PENDING_GRACE_MS && (data.classificationAttempts ?? 0) < MAX_CLASSIFICATION_ATTEMPTS;
    })
    .slice(0, SWEEP_LIMIT);

  let classified = 0;
  let failed = 0;
  for (const doc of due) {
    try {
      await classifyReport(doc.id, { origin });
      classified += 1;
    } catch {
      failed += 1;
    }
  }
  return { candidates: snapshot.size, attempted: due.length, classified, failed };
}

async function recordLiveReadings() {
  if (!isBigQueryConfigured()) return { skipped: "BIGQUERY_PROJECT_ID is not set." };
  const stations = await fetchAllStationReadings();
  if (stations.length === 0) return { skipped: "CPCB returned no station readings." };
  return { stations: stations.length, ...(await insertLiveReadings(stations)) };
}

async function maybeRetrainArima() {
  if (!isBigQueryConfigured()) return { skipped: "BIGQUERY_PROJECT_ID is not set." };
  const stateRef = adminDb.collection("system").doc("arimaTraining");
  const state = (await stateRef.get()).data();
  const lastStartedMs = state?.startedAt?.toDate?.().getTime?.() ?? 0;
  if (Date.now() - lastStartedMs < ARIMA_RETRAIN_INTERVAL_MS) {
    return { skipped: "Trained within the last 20 hours." };
  }
  const rows = await countLiveTrainingRows();
  if (rows < ARIMA_MIN_TRAINING_ROWS) {
    return { skipped: `Only ${rows} station-hours collected; need ${ARIMA_MIN_TRAINING_ROWS}.` };
  }
  const { jobId } = await startArimaTraining();
  await stateRef.set({ startedAt: adminServerTimestamp(), jobId, trainingRows: rows });
  return { started: true, jobId, trainingRows: rows };
}

export async function runScheduledTick(origin: string) {
  const startedAt = new Date().toISOString();
  // Independent steps; one failing provider never blocks the rest.
  const results = await Promise.all([
    step("classificationSweep", () => sweepUnclassifiedReports(origin)),
    step("ambientScan", async () => {
      const result = await scanAmbientHotspots();
      return { scanned: result.scanned, promoted: result.promoted.length, watching: result.watching.length };
    }),
    step("bigqueryIngest", recordLiveReadings),
    step("fireRefresh", async () => {
      const fires = await getRegionalFireHotspots({ refresh: true });
      if (fires.error) throw new Error(fires.error);
      return { fires: fires.fires.length, truncated: fires.truncated };
    }),
  ]);
  // Training reads what ingest just wrote, so it runs after.
  const arima = await step("arimaRetrain", maybeRetrainArima);

  const summary = { startedAt, finishedAt: new Date().toISOString(), ...Object.fromEntries([...results, arima]) };
  await adminDb
    .collection("system")
    .doc("lastTick")
    .set({ ...summary, at: adminServerTimestamp() })
    .catch(() => undefined);
  return summary;
}
