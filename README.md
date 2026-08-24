# SwachhVayu — CleanAir & Clear Streets

**Track 2 · Build with AI: Code for Communities (hack2skill)**

Spotting early signs of pollution so residents never have to question the air on their street.

SwachhVayu fuses citizen-uploaded photos, satellite NO₂ data, and ground sensor readings into one live, neighbourhood-level pollution hotspot map — so municipal teams can act on the block that needs it, hours before the spike, not days after the complaint.

---

## 🔗 Live Demo

**Command Center Dashboard:**
[https://cleanair-backend--cleanair-clear-streets.asia-southeast1.hosted.app/dashboard](https://cleanair-backend--cleanair-clear-streets.asia-southeast1.hosted.app/dashboard)

**Login credentials for judges/testers:**

| Field | Value |
|---|---|
| Email | `operator@cleanair.gov` |
| Password | `123456` |

> The `/dashboard` route is the municipal Command Center — the operator-facing view where validated pollution reports, live hotspots, and the 24-hour forecast are surfaced for dispatch decisions.

---

## The Problem

City-wide AQI readings can't reflect hyper-local events — a garbage-pile fire in Mundka, a smog trap at ITO junction — because:

- **One city-wide number, thousands of realities** — hyper-local spikes disappear into the average.
- **No eyes on every street** — municipal teams can't station a sensor or officer on every corner.
- **Reactive, not predictive** — cleanup crews get deployed after complaints pile up, not before air quality actually spikes.

## The Solution

Three data feeds fuse on a shared **H3 hexagonal grid**, turning scattered signals into one confidence-scored hotspot map, updated continuously:

1. **Citizen reports** — photos of smoke, dust, or haze, classified instantly by Gemini 2.5 Flash. Anonymous, from any phone, in 13 Indian languages, or via the WhatsApp bot.
2. **Satellite NO₂** — Sentinel-5P readings via Google Earth Engine, giving objective coverage even where no one has reported yet.
3. **Ground sensors** — CPCB station readings anchor the model to real, calibrated air quality numbers.

### How It Works

1. **Citizen uploads photo/voice note** → saved to Firebase as pending, grouped into an H3 hex cell.
2. **Gemini classifies** → evaluated strictly for visible pollution; ignored if clear/unclear, moved to fusion if pollution is detected.
3. **Fused with satellite + sensors** → snapped onto the same H3 hex as Earth Engine NO₂ data and the nearest CPCB reading.
4. **Promoted to Command Center** if it has overwhelming citizen consensus (3+ reports), a single report backed by hard data, hard data spiking on its own, or manual operator verification.

**Result:** a public hotspot map for citizens, and a validated incident queue for the municipal command center.

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Frontend** | Next.js 15 (App Router, TypeScript), Tailwind CSS 4 |
| **Backend** | Firebase (Firestore, Auth, Cloud Functions), Firebase App Hosting |
| **AI / ML** | Gemini 2.5 Flash (image classification), Google Cloud Speech-to-Text (en-IN, voice reporting), Google Cloud Translation API v2 (13 Indian languages), BigQuery (24-hour predictive forecast engine) |
| **Geo / Data** | Google Earth Engine + Sentinel-5P (satellite NO₂), CPCB API (data.gov.in, ground sensors), OpenWeatherMap API (wind data for forecast dampening), Google Maps JavaScript API, H3 hexagonal grid |
| **Media / Storage** | ImgBB (image hosting for AI analysis) |
| **Citizen channel** | WhatsApp Bot (see `/whatsapp_bot`) |

### APIs Used

- **Gemini 2.5 Flash API** — visually classifies citizen-uploaded photos to detect smoke, dust, or fire
- **Google Earth Engine API** — pulls Sentinel-5P satellite data to detect localized NO₂ and aerosol anomalies
- **CPCB API (data.gov.in)** — fetches real-time ground sensor readings (PM2.5, PM10) to corroborate citizen reports
- **OpenWeatherMap API** — retrieves local wind metrics to dynamically adjust and dampen pollution forecasts
- **Google Cloud Speech-to-Text API** — transcribes user voice notes using an Indian English (en-IN) model
- **Google Cloud Translation API v2** — auto-translates the web app interface into regional languages
- **ImgBB API** — hosts citizen-uploaded photos and generates public URLs for AI analysis
- **Firebase Firestore API** — real-time database syncing citizen reports to the municipal dashboard
- **Google BigQuery API** — queries archived historical PM2.5 sensor data to power the 24-hour predictive forecast engine
- **Google Maps JavaScript API** — renders the interactive municipal map with live hotspots and hex overlays

---

## Repository Structure

```
CleanAir-Clear-Streets/
├── whatsapp_bot/       # WhatsApp bot code citizens use to report pollution
│   └── ...
├── app/ (or src/)      # Next.js 15 App Router pages
│   ├── dashboard/      # Municipal Command Center
│   ├── forecast/       # 24-hour AQI forecast view
│   └── ...
├── functions/          # Firebase Cloud Functions (Gemini calls, fusion logic)
├── public/
├── .env.example
└── README.md
```

> **WhatsApp reporting:** The `/whatsapp_bot` folder contains the bot citizens can message directly to submit pollution reports (photo or voice note) without needing to open the web app — widening access for residents without a smartphone data plan or app familiarity.

---

## Local Setup

### Prerequisites

- Node.js 18+
- pnpm
- A Firebase project with Firestore, Auth, and Cloud Functions enabled
- API keys for the services listed

### 1. Clone the repository

```bash
git clone https://github.com/aryankalra404/CleanAir-Clear-Streets.git
cd CleanAir-Clear-Streets
```

### 2. Install dependencies

```bash
pnpm install
```

### 3. Configure environment variables

Create a `.env.local` file in the project root:

```shellscript
# Google Maps
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=

# Firebase
NEXT_PUBLIC_FIREBASE_API_KEY=
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=
NEXT_PUBLIC_FIREBASE_PROJECT_ID=
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=
NEXT_PUBLIC_FIREBASE_APP_ID=
NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID=

# AI / Classification
GEMINI_API_KEY=

# Image hosting
IMGBB_API_KEY=

# Pollution data sources
CPCB_API_KEY=
OPENWEATHER_API_KEY=

# Forecast engine
BIGQUERY_PROJECT_ID=

# Voice reporting
GOOGLE_SPEECH_API_KEY=
```

> Get Firebase credentials from your [Firebase Console](https://console.firebase.google.com/) → Project Settings. Get Google Cloud API keys (Maps, Speech-to-Text, Earth Engine, BigQuery) from the [Google Cloud Console](https://console.cloud.google.com/). CPCB keys are issued via [data.gov.in](https://data.gov.in/). OpenWeatherMap keys via [openweathermap.org/api](https://openweathermap.org/api). ImgBB keys via [api.imgbb.com](https://api.imgbb.com/).

### 4. Set up Firebase

```bash
npm install -g firebase-tools
firebase login
firebase use --add   # select your Firebase project
```

Deploy Firestore rules and Cloud Functions:

```bash
firebase deploy --only firestore:rules,functions
```

### 5. Run the development server

```bash
pnpm dev
```

The app will be available at `http://localhost:3000`. The Command Center dashboard will be at `http://localhost:3000/dashboard`.

### 6. Build for production

```bash
pnpm build
pnpm start
```

> **WhatsApp bot:** The `/whatsapp_bot` folder contains the Twilio-based bot citizens can message to submit pollution reports. It requires its own `.env` (Twilio credentials) — see `whatsapp_bot/` for setup details.

---

## Who It Serves

**Citizens & residents**
- Report smoke, dust, or a garbage fire in under a minute — anonymously, by voice or photo, in their own language, via web or WhatsApp.
- See a live neighbourhood hotspot map instead of one city-wide number.

**Municipal & pollution-control teams**
- The Command Center pinpoints exactly which hex needs a water-mist cannon or a cleanup crew, and when.
- The 24-hour forecast lets teams pre-position resources ahead of a predicted spike.

---

## Why It's Deployable Now

- **Live on Firebase App Hosting** — deployed at `asia-southeast1`, already serving real requests during testing.
- **Real APIs, not mocks** — Gemini classification, Earth Engine satellite pulls, and Speech-to-Text are all live calls.
- **Near-static, low-cost frontend** — heavy AI calls run in Cloud Functions, keeping the Next.js frontend fast and cheap to serve at scale.
- **Accessible by design** — 13-language support removes the single biggest adoption barrier for citizen reporting in Delhi NCR.
- **Abuse-resistant by default** — no-signal and low-confidence reports are quarantined from the public map automatically, no manual moderation bottleneck.
- **Grounded in real geography** — seeded and tested against actual Delhi pollution zones: Anand Vihar, Wazirpur, ITO, Mundka, Okhla, RK Puram, Rohini, Naraina.

---

## Scaling Beyond the Pilot

1. **City → state** — the H3 grid and fusion pipeline are geography-agnostic; onboarding a new city means pointing at its CPCB stations and Earth Engine tile.
2. **Heavier AI where it counts** — move from single-photo classification to multi-frame verification and anomaly detection across the historical snapshot archive already being collected.
3. **Close the loop with dispatch** — BigQuery-backed analytics connect directly to municipal dispatch systems, turning a validated hotspot into an auto-generated work order.
4. **Deeper citizen trust loop** — public resolution status ("cleanup crew dispatched", "resolved") on reports to keep citizens engaged past the first submission.

---

## Stats

| | |
|---|---|
| **13** | languages supported |
| **8+** | Delhi zones piloted | 
| **24h** | air quality forecast window |

---

*CleanAir & Clear Streets — Track 2, Build with AI: Code for Communities (hack2skill)*