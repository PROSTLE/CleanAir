import "server-only";

import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { adminAppCheck, adminAuth, adminDb } from "@/lib/firebaseAdmin";

/** Thrown inside route logic; converted to a JSON response by `handleRoute`. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function handleRoute(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof HttpError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[api]", error);
    // Unexpected errors can carry internal details (credentials, paths);
    // log them, but only echo them to the client outside production.
    const detail =
      process.env.NODE_ENV !== "production" && error instanceof Error ? error.message : null;
    return NextResponse.json(
      { error: detail ?? "Unexpected server error. Please try again." },
      { status: 500 },
    );
  }
}

export async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
}

// ─── Operator auth ──────────────────────────────────────────────────────────

export type Operator = { uid: string; email: string | null };

function getOperatorEmails() {
  return (process.env.OPERATOR_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

export function isOperatorAuthConfigured() {
  return getOperatorEmails().length > 0;
}

/**
 * Operators are Firebase Auth users who are either on the OPERATOR_EMAILS
 * allowlist or carry the custom claim `operator: true`. The client sends its
 * Firebase ID token as `Authorization: Bearer <token>`; everything that
 * mutates incidents or spends operator-only API quota goes through here.
 */
export async function requireOperator(request: Request): Promise<Operator> {
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer (.+)$/);
  if (!match) throw new HttpError(401, "Sign in as an operator to do this.");

  let decoded;
  try {
    decoded = await adminAuth.verifyIdToken(match[1], true);
  } catch {
    throw new HttpError(401, "Your operator session has expired. Sign in again.");
  }

  const email = decoded.email?.toLowerCase() ?? null;
  const allowlisted = email !== null && decoded.email_verified !== false && getOperatorEmails().includes(email);
  if (!allowlisted && decoded.operator !== true) {
    throw new HttpError(403, "This account is not an authorised operator.");
  }

  return { uid: decoded.uid, email };
}

// ─── App Check ──────────────────────────────────────────────────────────────

/**
 * When APP_CHECK_ENFORCE=true, citizen write endpoints require a valid
 * Firebase App Check token (reCAPTCHA Enterprise on the web), which stops
 * scripted report spam that never loads the real app.
 */
export async function verifyAppCheckIfEnforced(request: Request) {
  if (process.env.APP_CHECK_ENFORCE !== "true") return;
  const token = request.headers.get("x-firebase-appcheck");
  if (!token) throw new HttpError(401, "Missing App Check token.");
  try {
    await adminAppCheck.verifyToken(token);
  } catch {
    throw new HttpError(401, "Invalid App Check token.");
  }
}

// ─── Rate limiting ──────────────────────────────────────────────────────────

export function getClientIp(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
}

function hashKey(value: string) {
  // Store a hash, never the raw IP.
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

/**
 * Fixed-window counter in Firestore (shared across instances, unlike an
 * in-memory map). Throws 429 once `limit` is exceeded within `windowMs`.
 */
export async function enforceRateLimit(bucket: string, identity: string, limit: number, windowMs: number) {
  const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
  const ref = adminDb
    .collection("rateLimits")
    .doc(`${bucket}-${hashKey(identity)}-${windowStart}`);

  const count = await adminDb.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    const next = (snap.exists ? Number(snap.data()?.count ?? 0) : 0) + 1;
    transaction.set(ref, {
      bucket,
      count: next,
      // Lets a Firestore TTL policy on `expiresAt` clean these up.
      expiresAt: new Date(windowStart + windowMs * 2),
    });
    return next;
  });

  if (count > limit) {
    throw new HttpError(429, "Too many requests from this device. Please try again later.");
  }
}

// ─── Cron auth ──────────────────────────────────────────────────────────────

export function requireCronSecret(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) throw new HttpError(503, "CRON_SECRET is not configured.");
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    throw new HttpError(401, "Invalid cron credentials.");
  }
}
