import { initializeApp } from "firebase/app";
import { getFirestore, collection, getDocs, updateDoc } from "firebase/firestore";
import * as fs from "fs";

const envVars = fs.readFileSync(".env.local", "utf-8").split("\n");
const env: Record<string, string> = {};
for (const line of envVars) {
  if (line.includes("=")) {
    const [k, ...v] = line.split("=");
    env[k.trim()] = v.join("=").trim().replace(/^"|"$/g, '').replace(/^'|'$/g, '');
  }
}

const firebaseConfig = {
  apiKey: env["NEXT_PUBLIC_FIREBASE_API_KEY"],
  authDomain: env["NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN"],
  projectId: env["NEXT_PUBLIC_FIREBASE_PROJECT_ID"],
  storageBucket: env["NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET"],
  messagingSenderId: env["NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID"],
  appId: env["NEXT_PUBLIC_FIREBASE_APP_ID"],
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

async function run() {
  const incidents = await getDocs(collection(db, "incidents"));
  let count = 0;
  for (const doc of incidents.docs) {
    const data = doc.data();
    if (!data.photoUrl && data.linkedReportIds && data.linkedReportIds.length > 0) {
      const reports = await getDocs(collection(db, "reports"));
      const report = reports.docs.find(r => data.linkedReportIds.includes(r.id) && !!r.data().photoUrl);
      if (report) {
        await updateDoc(doc.ref, { photoUrl: report.data().photoUrl });
        console.log("Updated incident with photo:", report.data().photoUrl);
        count++;
      }
    }
  }
  console.log("Updated", count, "incidents");
  process.exit(0);
}
run();
