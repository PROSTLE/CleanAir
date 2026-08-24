require("dotenv").config();
const functions = require("firebase-functions");
const admin = require("firebase-admin");
const axios = require("axios");
const twilio = require("twilio");
const { latLngToCell } = require("h3-js");
const { TEXT, LANG_ORDER } = require("./translations");

if (admin.apps.length === 0) admin.initializeApp();

// ===== CREDENTIALS =====
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const IMGBB_API_KEY = process.env.IMGBB_API_KEY;



const APP_URL = "https://cleanair-backend--cleanair-clear-streets.asia-southeast1.hosted.app/";

const db = admin.firestore();
const CATEGORY_LABELS = { "1": "garbage_fire", "2": "traffic_smog", "3": "construction_dust", "4": "industrial_emission" };

const H3_RESOLUTION = 8;
const DEFAULT_H3_CELL_ID = "883da114bbfffff";

const HAZARD_MAP = {
  garbage_fire: { hazardId: "garbage-fire", hazardLabel: "Garbage fire", aiConfidence: 78, result: "Likely garbage fire" },
  traffic_smog: { hazardId: "traffic-smog", hazardLabel: "Traffic smog", aiConfidence: 71, result: "Likely traffic smog trap" },
  construction_dust: { hazardId: "construction-dust", hazardLabel: "Construction dust", aiConfidence: 74, result: "Likely construction dust" },
  industrial_emission: { hazardId: "industrial-emission", hazardLabel: "Industrial emission", aiConfidence: 82, result: "Likely industrial emission" },
};

const CIRCLED_NUMBERS = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩", "⑪", "⑫", "⑬"];

function buildLangMenu() {
  return "👋 Welcome to CleanAir reporter!\nChoose your language / भाषा चुनें:\n\n" +
    LANG_ORDER.map((code, i) => {
      const num = CIRCLED_NUMBERS[i] || `(${i + 1})`;
      return `\u200E${num} ${TEXT[code]?.name || code}`;
    }).join("\n");
}

function getH3CellId(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return DEFAULT_H3_CELL_ID;
  return latLngToCell(lat, lng, H3_RESOLUTION);
}

exports.whatsappWebhook = functions.https.onRequest(async (req, res) => {
  if (req.method !== "POST") return res.sendStatus(400);
  const twiml = new twilio.twiml.MessagingResponse();
  const { From, Body, NumMedia, MediaUrl0, Latitude, Longitude, Address } = req.body;
  const userPhone = From.replace("whatsapp:", "");
  const text = (Body || "").trim();

  try {
    const sessionRef = db.collection("whatsapp_sessions").doc(userPhone);
    const sessionSnap = await sessionRef.get();
    const session = sessionSnap.exists ? sessionSnap.data() : { step: "start", data: {} };
    const lang = session.data?.lang || "en";
    const t = TEXT[lang] || TEXT["en"];
    let reply = "";

    const isPhoneNumber = /^\d{10}$/.test(text.replace(/\s/g, ""));

    if (isPhoneNumber && session.step !== "start" && session.step !== "awaiting_another_complaint") {
      reply = "Restarting from the beginning!\n\n" + buildLangMenu();
      await sessionRef.set({ step: "awaiting_language", data: {} });
      twiml.message(reply);
      res.writeHead(200, { "Content-Type": "text/xml" });
      return res.end(twiml.toString());
    }

    switch (session.step) {
      case "start":
        reply = buildLangMenu();
        await sessionRef.set({ step: "awaiting_language", data: {} });
        break;

      case "awaiting_language": {
        const idx = parseInt(text) - 1;
        const chosenLang = LANG_ORDER[idx];
        if (!chosenLang) {
          reply = `Please reply with a number 1-${LANG_ORDER.length}.\n\n` + buildLangMenu();
          break;
        }
        reply = TEXT[chosenLang]?.askCategory || "What are you seeing?\n1️⃣ Garbage fire\n2️⃣ Traffic smog\n3️⃣ Construction dust\n4️⃣ Industrial emission\n\nReply with a number (1-4)";
        await sessionRef.set({ step: "awaiting_category", data: { lang: chosenLang } });
        break;
      }

      case "awaiting_category": {
        const category = CATEGORY_LABELS[text];
        if (!category) {
          reply = t.invalidCategory || "⚠️ Invalid choice. Please reply with a number between 1 and 4.";
          break;
        }
        const categoryName = t.categories ? t.categories[category] : category;
        const gotCatStr = t.gotCategory ? t.gotCategory(categoryName) : `Got it: ${categoryName} ✅`;
        const askPhotoStr = t.askPhoto || "📷 Please send a photo of what you're seeing.";

        reply = `${gotCatStr}\n\n${askPhotoStr}`;
        await sessionRef.set({ step: "awaiting_photo", data: { ...session.data, category } });
        break;
      }

      case "awaiting_photo": {
        if (NumMedia && Number(NumMedia) > 0 && MediaUrl0) {
          const result = await uploadToImgBB(MediaUrl0);

          if (result.success) {
            reply = t.askLocation || "📍 Now please share your location (tap 📎 attachment → Location → Send Current Location)";
            await sessionRef.set({ step: "awaiting_location", data: { ...session.data, photoUrl: result.url } });
          } else {
            reply = `⚠️ Image upload failed: ${result.error}\n\nPlease try sending the photo again.`;
          }
        } else {
          reply = t.noPhoto || "⚠️ Please attach a photo to continue.";
        }
        break;
      }

      case "awaiting_location": {
        let location = null, locationLabel = "";
        if (Latitude && Longitude) {
          location = { lat: parseFloat(Latitude), lng: parseFloat(Longitude) };
          locationLabel = Address || "Shared GPS location";
        } else {
          const extracted = extractCoords(text);
          if (extracted) { location = extracted; locationLabel = "Coordinates typed"; }
          else {
            reply = t.needLocation || "⚠️ We need a location. Please tap 📎 attachment → Location.";
            break;
          }
        }
        reply = t.locationSaved || "✅ Location saved!\n\nWould you like to add any extra notes? (Reply YES or NO)";
        await sessionRef.set({ step: "awaiting_note_choice", data: { ...session.data, location, locationLabel } });
        break;
      }

      case "awaiting_note_choice": {
        const answer = text.toLowerCase();
        if (answer.startsWith("y") || answer.startsWith("हाँ") || answer.startsWith("ஆம்") || answer.startsWith("అవును")) {
          reply = t.askNote || "📝 Please type your note now.";
          await sessionRef.set({ step: "awaiting_note_text", data: session.data });
        } else if (answer.startsWith("n") || answer.startsWith("नहीं") || answer.startsWith("இல்லை") || answer.startsWith("కాదు")) {
          await saveReport(userPhone, session.data, "");
          const thanksStr = t.thanks || "🙏 Thank you! Your report has been submitted.";
          reply = thanksStr + "\n\nDo you want to file another complaint using this same number? (Reply YES or NO)";
          await sessionRef.set({ step: "awaiting_another_complaint", data: { lang: session.data.lang } });
        } else {
          reply = t.yesNoPrompt || "Please reply with YES or NO.";
        }
        break;
      }

      case "awaiting_note_text": {
        await saveReport(userPhone, session.data, text);
        const thanksStr = t.thanks || "🙏 Thank you! Your report has been submitted.";
        reply = thanksStr + "\n\nDo you want to file another complaint using this same number? (Reply YES or NO)";
        await sessionRef.set({ step: "awaiting_another_complaint", data: { lang: session.data.lang } });
        break;
      }

      case "awaiting_another_complaint": {
        const answer = text.toLowerCase();
        if (answer.startsWith("y")) {
          reply = t.askCategory || "What are you seeing?\n1️⃣ Garbage fire\n2️⃣ Traffic smog\n3️⃣ Construction dust\n4️⃣ Industrial emission\n\nReply with a number (1-4)";
          await sessionRef.set({ step: "awaiting_category", data: { lang: session.data.lang } });
        } else {
          reply = "Thank you! Have a great day. 🌱";
          await sessionRef.delete();
        }
        break;
      }

      default:
        reply = buildLangMenu();
        await sessionRef.set({ step: "awaiting_language", data: {} });
    }

    twiml.message(reply);
    res.writeHead(200, { "Content-Type": "text/xml" });
    return res.end(twiml.toString());
  } catch (error) {
    console.error("Webhook error:", error);
    twiml.message(TEXT?.en?.error || "⚠️ An internal error occurred. Please try again later.");
    res.writeHead(200, { "Content-Type": "text/xml" });
    return res.end(twiml.toString());
  }
});

async function uploadToImgBB(mediaUrl) {
  try {
    let twilioResponse;
    try {
      twilioResponse = await axios.get(mediaUrl, {
        auth: { username: TWILIO_ACCOUNT_SID, password: TWILIO_AUTH_TOKEN },
        responseType: "arraybuffer",
      });
    } catch (twilioErr) {
      const status = twilioErr.response ? twilioErr.response.status : "Unknown";
      return { success: false, error: `Twilio Auth Error (${status}). Please check your TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.` };
    }

    const base64Image = Buffer.from(twilioResponse.data).toString("base64");

    const body = new URLSearchParams();
    body.append("image", base64Image);

    let imgbbResponse;
    try {
      imgbbResponse = await axios.post(
        `https://api.imgbb.com/1/upload?key=${IMGBB_API_KEY}`,
        body.toString(),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
      );
    } catch (imgbbErr) {
      const status = imgbbErr.response ? imgbbErr.response.status : "Unknown";
      return { success: false, error: `ImgBB Auth Error (${status}). Please check your IMGBB_API_KEY.` };
    }

    return { success: true, url: imgbbResponse.data.data.url };
  } catch (err) {
    return { success: false, error: "Unexpected system error during upload." };
  }
}

async function saveReport(phone, data, note) {
  try {
    const hazard = HAZARD_MAP[data.category] || HAZARD_MAP.garbage_fire;
    const lat = data.location?.lat ?? 28.6264;
    const lng = data.location?.lng ?? 77.3192;
    const label = data.locationLabel || "Shared via WhatsApp";
    const h3CellId = getH3CellId(Number(lat), Number(lng));

    const newReport = {
      anonymous: true,
      hazardId: hazard.hazardId,
      hazardLabel: hazard.hazardLabel,
      aiConfidence: hazard.aiConfidence,
      result: hazard.result,
      location: { label, lat: String(lat), lng: String(lng) },
      photoUrl: data.photoUrl || "",
      note: note || "",
      source: "citizen",
      channel: "whatsapp",
      status: "pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      h3CellId,
    };

    const docRef = await db.collection("reports").add(newReport);
    console.log(`Report saved: ${docRef.id}. Attempting classification trigger at ${APP_URL}`);

    if (APP_URL && !APP_URL.includes("PASTE_YOUR")) {
      try {
        const response = await axios.post(
          `${APP_URL}/api/classify-report`,
          { reportId: docRef.id },
          { timeout: 20000 }
        );
        console.log(`Classification trigger SUCCESS for ${docRef.id}:`, response.status, response.data);
      } catch (err) {
        console.error(`Classification trigger FAILED for ${docRef.id}:`, err.message);
        if (err.response) {
          console.error("Response status:", err.response.status);
          console.error("Response data:", JSON.stringify(err.response.data));
        } else if (err.request) {
          console.error("No response received — request may have timed out or URL is unreachable.");
        }
      }
    } else {
      console.log("APP_URL not set — skipping classify-report trigger. Report saved as pending.");
    }

    return docRef.id;
  } catch (error) {
    console.error("Database save failed:", error);
    throw error;
  }
}

function extractCoords(text) {
  const match = text.match(/(\d+\.\d+)\s*,?\s*(\d+\.\d+)/);
  return match ? { lat: parseFloat(match[1]), lng: parseFloat(match[2]) } : null;
}