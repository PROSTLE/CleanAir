# VayuSetu — hyperlocal air-pollution hotspots for BRICS capitals

VayuSetu turns citizen photos, ground monitoring stations, Sentinel-5P satellite data and NASA FIRMS fire detections into a neighbourhood-level hotspot map. It then helps municipal teams act on each hotspot: who to send, where the pollution is probably coming from, and who nearby needs a warning.

Built on Google's AI and Cloud stack: Gemini, Earth Engine, BigQuery / BigQuery ML, Maps Platform (Maps, Places, Air Quality), and Firebase.

**Live deployment:** https://cleanair-backend--cleanair-clear-streets.asia-southeast1.hosted.app (Delhi-only build until the multi-city version is redeployed)

Pick a city in the navbar (New Delhi, Beijing, Moscow, Pretoria, Abu Dhabi, Jakarta, Brasília); every page below follows it.
- `/report` — citizen reporting (photo, voice note in the city's language, 13 UI languages)
- `/map` — public hotspot map with the satellite fire layer
- `/dashboard` — municipal command center (anyone can view it; actions need operator sign-in)
- `/forecast` — 24-hour PM2.5 forecast with model comparison
- `/track/<reportId>` — live status of a single report

> **Operator access for judges:** operator actions (dispatch, resolve, field context, work orders, copilot) require a Firebase Auth account listed in `OPERATOR_EMAILS`. The team shares demo operator credentials privately; they are not published in this repository.

---

## The problem

A city-wide AQI hides the things residents actually breathe: a garbage fire in Mundka, dust from a construction site, a smog trap at ITO. Municipal teams can't station a sensor or an officer on every corner, so they react after complaints pile up.

## How it works

```
Citizen photo (web / WhatsApp)
        │  POST /api/reports — validated, rate-limited, optional App Check
        ▼
Gemini vision ─► pollution type, severity, confidence, authenticity
        │        + duplicate-photo (SHA-256) and EXIF checks
        ▼
Context fusion on an H3 hexagon (res 8, ~0.7 km²)
   • CPCB station reading (nearest with data, freshness-checked)
   • Sentinel-5P NO₂ / aerosol anomaly vs 90-day baseline (Earth Engine, NRTI)
   • NASA FIRMS active fires (Earth Engine)
   • Open-Meteo wind (no key)
        │
        ▼
Promotion to a municipal incident when evidence is independent:
   sensor + satellite · 3+ citizens · citizen + sensor · citizen + satellite
        │
        ▼
Command center: evidence trail → upwind attribution → sensitive sites →
Gemini work order (EN/HI) → dispatch / resolve / false positive
        │
        └─► reporter sees it on /track/<id>; WhatsApp reporters get a message
```

A second path runs with no citizen input: the **ambient scan** checks every ground station in each city, together with Sentinel-5P, against its own recorded baseline. It needs two consecutive observations before it raises an incident, unless a single reading already crosses the immediate-alert level (Indian AQI "Poor" in Delhi, 1.5× the national 24-hour limit elsewhere).

## Cities

A city picker in the navbar switches every page — map, report form, dashboard, copilot, forecast — to one capital. Each city is one entry in `lib/cities.ts`: map view, OpenStreetMap boundary (`lib/cityBoundaries.ts`), station network, national 24-hour PM limits, FIRMS fire region, suggested authorities, work-order language, voice-note language and time zone.

| City | Ground stations | Limits used (24 h, PM2.5 / PM10 µg/m³) |
| --- | --- | --- |
| New Delhi | CPCB / DPCC via data.gov.in | India NAAQS 60 / 100 (plus NO₂, SO₂) |
| Beijing | China national network via WAQI | GB 3095-2012 Grade II 75 / 150 |
| Moscow | Mosecomonitoring via WAQI | SanPiN 1.2.3685-21 35 / 60 |
| Pretoria | SAAQIS and local stations via WAQI | South Africa NAAQS 40 / 75 |
| Abu Dhabi | EAD stations via WAQI | UAE EAQI 2023 60 / 150 |
| Jakarta | Jakarta stations and sensors via WAQI | PP 22/2021 55 / 75 |
| Brasília | Distrito Federal sensors via WAQI (sparse) | CONAMA 491/2018 PI-2 50 / 100 |

A capital is listed only if a public real-time station feed covers it. Cairo and Addis Ababa are left out: their only live monitors were US Embassy stations, offline since March 2025. Tehran is left out because its public feed has not updated since December 2025. WAQI lists government stations first; citizen low-cost sensors only top up cities with fewer than 8 official stations.

WAQI publishes US-EPA AQI sub-indices, not concentrations. `lib/usAqi.ts` converts PM2.5 and PM10 back to µg/m³ with the 2012 EPA breakpoints that WAQI documents. Gas sub-indices are not converted, so outside Delhi the industrial check relies on Sentinel-5P NO₂. Only Delhi has curated known-source lists and forecast zones; other cities forecast at their live stations, without Delhi's diurnal profile.

## Features

| Feature | What it does | Where |
|---|---|---|
| Photo classification | Gemini labels smoke/dust/haze/fire, severity, confidence, and whether the image is a screenshot, edited, or stock photo | `lib/geminiClassifier.ts`, `lib/server/classifyReport.ts` |
| Evidence fusion | Weighted fusion using only the sources that actually returned data; the weights shown are the weights used | `lib/fusionConfidence.ts` |
| Server-side pipeline | Reports are written and classified on the server (`after()`), with a cron sweeper for anything missed | `app/api/reports`, `lib/server/cron.ts` |
| Operations copilot | Gemini function calling over 7 live tools (incidents, CPCB, wind, FIRMS, forecasts, upwind sources); shows the tools each answer used | `lib/server/copilot.ts` |
| Work orders | Gemini structured output: an EN + HI work order grounded only in recorded evidence, routed to a suggested agency | `lib/server/workOrder.ts` |
| Upwind attribution | Ranks landfills, industrial areas, traffic hubs, active fires and other incidents by alignment with the live wind; counts regional (Punjab/Haryana) fires upwind | `lib/attribution.ts` |
| Sensitive sites | Schools and hospitals within 1 km (Places API) | `lib/server/places.ts` |
| Google Air Quality cross-check | Independent modelled AQI/PM2.5, now and for 24 h | `lib/server/googleAirQuality.ts` |
| Forecast | Live CPCB history in BigQuery → heuristic forecast with a **measured backtest vs persistence**, plus a **BigQuery ML ARIMA_PLUS** model and the Google forecast for comparison | `lib/server/forecastService.ts`, `lib/server/bigqueryLive.ts` |
| Spam resistance | Duplicate-photo hash, screenshot/stock detection, EXIF age/GPS checks, per-IP rate limits, optional App Check. Flagged reports stay visible but never count toward promotion | `app/api/reports`, `lib/server/http.ts` |
| Closing the loop | Public tracking page; WhatsApp messages on dispatch and resolve (Twilio) | `components/report/TrackView.tsx`, `lib/server/notify.ts` |
| Model quality | Operator-verified precision from real outcomes, plus an offline classifier evaluation | `components/dashboard/ModelQualityCard.tsx`, `scripts/eval-classifier.mjs` |
| 13 languages + voice | Pre-generated locales; Speech-to-Text for voice notes | `locales/`, `app/api/speech-to-text` |

## Security model

- **Browsers only read** `reports` and `incidents`. Every write goes through a server route using the Admin SDK (`firestore.rules`).
- **Operator actions** require a verified Firebase ID token for an allowlisted email or an `operator` custom claim (`lib/server/http.ts`).
- **Phone numbers** live in `reportContacts`, which no client can read.
- **Paid APIs** are either operator-only or rate-limited. The translate proxy is off unless `TRANSLATE_API_SECRET` is set.
- The **WhatsApp webhook** verifies Twilio's signature. The **image fetcher** only accepts ImgBB URLs. **Map pop-ups** escape citizen text.

## Tech stack

Next.js 16 (App Router, TypeScript) · React 19 · Firebase App Hosting, Firestore, Auth, App Check · Gemini 3.5 Flash (3.1 Flash-Lite fallback) · Earth Engine (Sentinel-5P NRTI/OFFL, NASA FIRMS) · BigQuery + BigQuery ML · Google Maps JS, Places API (New), Air Quality API · Cloud Speech-to-Text · CPCB via data.gov.in · World Air Quality Index (WAQI) · Open-Meteo · OpenFreeMap / OpenStreetMap · Twilio WhatsApp · H3.

---

## Local setup

**Prerequisites:** Node.js ≥ 22.18 and a Firebase project with Firestore and Auth (Email/Password) enabled.

```bash
pnpm install          # or npm install
cp .env.example .env.local   # fill in what you have; missing integrations show "not configured"
pnpm dev
```

### API keys and services

Every integration is optional at runtime: a missing one shows as *not configured* on the dashboard's **Data sources** card instead of inventing numbers. Put the variables in `.env.local` locally, and in Secret Manager / `apphosting.yaml` for Firebase App Hosting.

| Service | What it powers | Variable | Where to get it |
| --- | --- | --- | --- |
| Firebase (client + Admin) | Reports, incidents, sign-in | `NEXT_PUBLIC_FIREBASE_*`, `FIREBASE_SERVICE_ACCOUNT_KEY` | [Firebase console](https://console.firebase.google.com/) → Project settings → General (web config) and Service accounts (Admin key) |
| Gemini | Photo classification, copilot, work orders | `GEMINI_API_KEY` | [Google AI Studio](https://aistudio.google.com/app/apikey) |
| CPCB (Delhi stations) | Delhi ground stations | `CPCB_API_KEY` | [data.gov.in](https://data.gov.in/) → sign in → My Account → API key |
| WAQI (other capitals) | Stations for Beijing, Moscow, Pretoria, Abu Dhabi, Jakarta, Brasília | `WAQI_API_TOKEN` | [aqicn.org token](https://aqicn.org/data-platform/token/) (free, non-commercial) |
| Earth Engine | Sentinel-5P NO₂ / aerosol, NASA FIRMS fires | `EARTH_ENGINE_SERVICE_ACCOUNT_KEY` (or `credentials/earth-engine-key.json`), optional `EARTH_ENGINE_PROJECT_ID` | [Register project](https://code.earthengine.google.com/register) · [Enable API](https://console.cloud.google.com/apis/library/earthengine.googleapis.com) · [Service accounts](https://console.cloud.google.com/iam-admin/serviceaccounts) · [Service-account guide](https://developers.google.com/earth-engine/guides/service_account) |
| BigQuery | Live station history, forecasts, ARIMA_PLUS | `BIGQUERY_PROJECT_ID` | [Enable API](https://console.cloud.google.com/apis/library/bigquery.googleapis.com) · [BigQuery console](https://console.cloud.google.com/bigquery) |
| Cloud Scheduler | Runs `/api/cron/tick` every 30 min | `CRON_SECRET` (any long random string) | [Enable API](https://console.cloud.google.com/apis/library/cloudscheduler.googleapis.com) |
| Google Maps JavaScript + Places | Report location picker and search | `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` | [Maps JS API](https://console.cloud.google.com/apis/library/maps-backend.googleapis.com) · [Places API](https://console.cloud.google.com/apis/library/places-backend.googleapis.com) · [Credentials](https://console.cloud.google.com/apis/credentials) |
| Google Air Quality | Independent modelled cross-check, reported in each country's own AQI | `GOOGLE_AIR_QUALITY_API_KEY` | [Enable API](https://console.cloud.google.com/apis/library/airquality.googleapis.com) · [Credentials](https://console.cloud.google.com/apis/credentials) |
| Places API (New) | Schools / hospitals near a hotspot | `GOOGLE_PLACES_API_KEY` | [Enable API](https://console.cloud.google.com/apis/library/places.googleapis.com) |
| Speech-to-Text | Voice notes in the report form | `GOOGLE_SPEECH_API_KEY` | [Enable API](https://console.cloud.google.com/apis/library/speech.googleapis.com) |
| Cloud Translation | Translating new UI strings (`scripts/generate-locales.js`) | service-account file in `credentials/` | [Enable API](https://console.cloud.google.com/apis/library/translate.googleapis.com) |
| ImgBB | Photo hosting for reports | `IMGBB_API_KEY` | [api.imgbb.com](https://api.imgbb.com/) |
| Twilio WhatsApp | Status messages to WhatsApp reporters | `TWILIO_*` | [Twilio console](https://console.twilio.com/) |

The map tiles (OpenFreeMap), weather (Open-Meteo) and city outlines (OpenStreetMap, stored in the repo) need no key.

**Earth Engine permissions.** The service account needs, in the project it belongs to: *Service Usage Consumer* and *Earth Engine Resource Viewer* ([IAM page](https://console.cloud.google.com/iam-admin/iam)); the project must be registered for Earth Engine and have the Earth Engine API enabled. Without these the fire layer and satellite checks report `Caller does not have required permission to use project …`.

Check what is connected at `GET /api/system-status` or on the dashboard's **Data sources** card.

### Deploying the backend pieces

1. **Firestore rules:** `firebase deploy --only firestore:rules`
2. **Operators:** create users in Firebase Auth → add their emails to `OPERATOR_EMAILS`.
3. **BigQuery:** edit the project ID in `scripts/setup-bigquery.sql`, then run `bq query --use_legacy_sql=false < scripts/setup-bigquery.sql`. The runtime service account needs *BigQuery Data Editor* and *BigQuery Job User*.
4. **Earth Engine:** register a service account for Earth Engine (see *Earth Engine permissions* above) and provide it as `EARTH_ENGINE_SERVICE_ACCOUNT_KEY`.
5. **Scheduler:** every 30 minutes, run the ambient scan, BigQuery ingest, the classification sweep, the fire refresh, and daily ARIMA retraining:
   ```bash
   gcloud scheduler jobs create http vayusetu-tick \
     --schedule="*/30 * * * *" --time-zone="Asia/Kolkata" \
     --uri="https://<your-host>/api/cron/tick" --http-method=GET \
     --headers="Authorization=Bearer <CRON_SECRET>"
   ```
6. **Optional Firestore TTL:** add a TTL policy on `rateLimits.expiresAt`.

### WhatsApp bot (`/whatsapp_bot`)

A Firebase Cloud Function (Twilio webhook). Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `IMGBB_API_KEY`, and `APP_URL` (the web app origin). Set `TWILIO_WEBHOOK_URL` if the function sits behind a proxy. Signature checking is on whenever the auth token is set.

## Testing & evaluation

```bash
npm test                 # unit tests: attribution, forecast/backtest, IST and per-city time zones,
                         # city boundaries, WAQI AQI→µg/m³ conversion, H3 cells, evidence rules
                         # (incl. stale-reading rejection), fusion, classifier parsing, EXIF
npm run lint
npx tsc --noEmit         # type check
npm run build
npm run eval:classifier  # offline Gemini classifier evaluation → public/eval/classifier-eval.json
```

Quick live checks once the server runs (`npm run build && npm start`):

```bash
curl localhost:3000/api/system-status                 # which integrations are configured
curl "localhost:3000/api/stations?city=beijing"       # live stations (delhi, beijing, moscow, pretoria,
                                                      #   abu-dhabi, jakarta, brasilia)
curl "localhost:3000/api/fires?city=brasilia"         # FIRMS fires in the city's upwind region
curl "localhost:3000/api/scan-ambient?city=moscow"    # sensor/satellite-only hotspot scan (writes to Firestore)
```

For the classifier evaluation, put labelled photos in `eval/photos/<label>/` (see `eval/README.md`). The results appear on the dashboard's *Model quality* card.

## Known limitations

- **Forecast data:** the forecast uses live station history once `/api/cron/tick` has been collecting it. Until then Delhi falls back to the 2015–2020 Kaggle archive (marked as archived in the UI); other cities show no forecast until 12 hourly readings exist.
- **WAQI:** free for non-commercial use, with attribution to WAQI and the originating agency (shown in station pop-ups). Some WAQI stations are low-cost sensors, especially in Jakarta and Brasília.
- **WhatsApp bot:** reports from any city are filed by their coordinates, but the bot's messages are English/Hindi only.
- **Outages:** when data.gov.in is down, Delhi station lookups fail after about 40 s and then fail fast for 2 minutes; the UI shows the feed as unavailable.
- **ARIMA timing:** ARIMA_PLUS needs about 7 days of live readings before the first training run.
- **Attribution is a screening aid**, not a dispersion model. Sensor and satellite checks are thresholds on public data, not calibrated source apportionment.
- **WhatsApp limits:** outside the 24-hour session window, WhatsApp requires approved message templates. Failed sends are recorded and never block an operator action.
- **Translations:** new UI strings are in English. Run `node scripts/generate-locales.js` to translate them into the other 12 locales.

*Build with AI: Code for Communities (Google Cloud × hack2skill) — Track 2, Pollution hotspot detection.*
