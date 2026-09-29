import "server-only";

// The one Google service account the server uses: firebase-adminsdk in the
// cleanair-clear-streets project, from FIREBASE_SERVICE_ACCOUNT_KEY (raw JSON
// or base64). Firebase Admin, Earth Engine and BigQuery all authenticate with
// it, so the key lives in exactly one secret.
export type ServiceAccountKey = {
  client_email: string;
  private_key: string;
  project_id: string | null;
};

let cached: ServiceAccountKey | null | undefined;

export function parseServiceAccountKey(raw: string | undefined | null): ServiceAccountKey | null {
  const value = raw?.trim();
  if (!value) return null;
  const json = JSON.parse(value.startsWith("{") ? value : Buffer.from(value, "base64").toString("utf8")) as {
    client_email?: string;
    clientEmail?: string;
    private_key?: string;
    privateKey?: string;
    project_id?: string;
    projectId?: string;
  };
  const clientEmail = json.client_email ?? json.clientEmail;
  const privateKey = json.private_key ?? json.privateKey;
  if (!clientEmail || !privateKey) throw new Error("Service account key is missing client_email or private_key.");
  return { client_email: clientEmail, private_key: privateKey, project_id: json.project_id ?? json.projectId ?? null };
}

export function getServiceAccountKey(): ServiceAccountKey | null {
  if (cached === undefined) cached = parseServiceAccountKey(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
  return cached;
}
