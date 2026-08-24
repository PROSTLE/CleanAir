import { initializeApp } from "firebase/app";
import { getFirestore, collection, getDocs, updateDoc } from "firebase/firestore";
import fs from "fs";
import dotenv from "dotenv";

// Load .env.local
const envConfig = dotenv.parse(fs.readFileSync(".env.local"));
for (const k in envConfig) {
  process.env[k] = envConfig[k];
}

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

async function run() {
  const incidents = await getDocs(collection(db, "incidents"));
  let updated = 0;
  for (const doc of incidents.docs) {
    const data = doc.data();
    if (!data.photoUrl) {
      // Find a report with a photo
      if (data.linkedReportIds && data.linkedReportIds.length > 0) {
        const reports = await getDocs(collection(db, "reports"));
        const report = reports.docs.find(r => r.id === data.linkedReportIds[0]);
        if (report && report.data().photoUrl) {
          await updateDoc(doc.ref, { photoUrl: report.data().photoUrl });
          updated++;
          console.log(`Updated incident ${doc.id} with photoUrl`);
        }
      }
    }
  }
  console.log(`Done! Updated ${updated} incidents.`);
  process.exit(0);
}
run();
