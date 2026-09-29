import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { adminDb, adminServerTimestamp } from "@/lib/firebaseAdmin";

// Reports are publicly readable, so a report id alone proves nothing. Each
// web report gets a random token, handed once to the browser that filed it
// (kept in its localStorage, lib/myReports.ts); only its SHA-256 is stored,
// in `reportTokens`, which the Firestore rules close to every client. The
// token is what lets that reporter answer "is it fixed?".

function hash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export async function issueReportToken(reportId: string) {
  const token = randomBytes(18).toString("base64url");
  await adminDb.collection("reportTokens").doc(reportId).set({ hash: hash(token), createdAt: adminServerTimestamp() });
  return token;
}

export async function verifyReportToken(reportId: string, token: unknown) {
  if (typeof token !== "string" || token.length < 16 || token.length > 64) return false;
  const snap = await adminDb.collection("reportTokens").doc(reportId).get();
  const stored = snap.exists ? String(snap.data()?.hash ?? "") : "";
  if (!stored) return false;
  const expected = Buffer.from(stored, "hex");
  const actual = Buffer.from(hash(token), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
