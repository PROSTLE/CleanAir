// The app's one service account for the tooling scripts: FIREBASE_SERVICE_ACCOUNT_KEY
// (raw JSON or base64) from the environment or .env.local, the same key the
// server uses (lib/server/serviceAccount.ts).
const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "..", ".env.local"), quiet: true });

function serviceAccountAuthOptions(scopes) {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY?.trim();
  if (!raw) {
    console.error("FIREBASE_SERVICE_ACCOUNT_KEY is not set (environment or .env.local).");
    process.exit(1);
  }
  const key = JSON.parse(raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8"));
  return {
    credentials: { client_email: key.client_email, private_key: key.private_key },
    projectId: key.project_id,
    scopes,
  };
}

module.exports = { serviceAccountAuthOptions };
