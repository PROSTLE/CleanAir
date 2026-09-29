import "server-only";

import { applicationDefault, cert, getApps, initializeApp, type ServiceAccount } from "firebase-admin/app";
import { getAppCheck } from "firebase-admin/app-check";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { getServiceAccountKey } from "@/lib/server/serviceAccount";

const DEFAULT_FIREBASE_PROJECT_ID = "cleanair-clear-streets";

function getServiceAccountFromEnv(): ServiceAccount | null {
  const key = getServiceAccountKey();
  if (!key) return null;
  return { clientEmail: key.client_email, privateKey: key.private_key, projectId: key.project_id ?? undefined };
}

const firebaseServiceAccount = getServiceAccountFromEnv();

function getFirebaseProjectId() {
  if (firebaseServiceAccount?.projectId) return firebaseServiceAccount.projectId;
  if (process.env.FIREBASE_PROJECT_ID) return process.env.FIREBASE_PROJECT_ID;
  if (process.env.GOOGLE_CLOUD_PROJECT) return process.env.GOOGLE_CLOUD_PROJECT;
  if (process.env.GCP_PROJECT) return process.env.GCP_PROJECT;
  if (process.env.GCLOUD_PROJECT) return process.env.GCLOUD_PROJECT;
  if (process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID) return process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;

  const firebaseConfig = process.env.FIREBASE_CONFIG;
  if (firebaseConfig?.trim().startsWith("{")) {
    const parsedConfig = JSON.parse(firebaseConfig) as { projectId?: string; project_id?: string };
    return parsedConfig.projectId ?? parsedConfig.project_id;
  }

  return DEFAULT_FIREBASE_PROJECT_ID;
}

const firebaseProjectId = getFirebaseProjectId();

const adminApp =
  getApps()[0] ??
  initializeApp(
    firebaseServiceAccount
      ? {
          credential: cert(firebaseServiceAccount),
          projectId: firebaseProjectId,
        }
      : {
          credential: applicationDefault(),
          projectId: firebaseProjectId,
        },
  );

export const adminDb = getFirestore(adminApp);
export const adminAuth = getAuth(adminApp);
export const adminAppCheck = getAppCheck(adminApp);
export const adminServerTimestamp = FieldValue.serverTimestamp;
