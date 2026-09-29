# VayuSetu — hyperlocal air-pollution hotspots for BRICS capitals

VayuSetu turns citizen photos, ground monitoring stations, Sentinel-5P satellite data and NASA FIRMS fire detections into a neighbourhood-level hotspot map. It then helps municipal teams act on each hotspot: who to send, where the pollution is probably coming from, and who nearby needs a warning.

Built on Google's AI and Cloud stack: Gemini, Earth Engine, BigQuery / BigQuery ML, Maps Platform (Maps, Places, Air Quality), and Firebase.

**Live deployment:** https://cleanair-backend--cleanair-clear-streets.asia-southeast1.hosted.app (all seven capitals, redeployed 29 Sep 2026)

Pick a city in the navbar (New Delhi, Beijing, Moscow, Pretoria, Abu Dhabi, Jakarta, Brasília); every page below follows it.
- `/report` — citizen reporting (photo, voice note in the city's language, 13 UI languages)
- `/map` — public hotspot map with the satellite fire layer
- `/dashboard` — municipal command center (anyone can view it; actions need operator sign-in)
- `/forecast` — 24-hour PM2.5 forecast with model comparison, in every capital
- `/track/<reportId>` — live status of a single report, and the "Is it fixed?" check once it is resolved
- `/zone/<h3CellId>` — public area page for one ~0.7 km² hexagon (open it from any map pop-up, "View this area →")

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
Command center: evidence trail → 30-day history → upwind attribution →
sensitive sites → Gemini work order (EN + local language) → dispatch / resolve / false positive
        │
        ├─► reporter sees it on /track/<id>; WhatsApp reporters get a message
        │
        ▼
Resolve opens a 72 h resident fix-check ("Is it fixed?")
   yes  → counted as a resident-confirmed fix
   no   → incident reopens as "Disputed" and returns to the queue
        │
        ▼
Every lifecycle step is appended to `incidentEvents` → 30-day recurrence →
"Repeat hotspot" flag in the queue, on the area page and in the next work order
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
| Forecast | Live CPCB history in BigQuery → heuristic forecast with a **measured backtest vs persistence**, plus a **BigQuery ML ARIMA_PLUS** model and the Google forecast for comparison. When a station has fewer than 12 hourly readings, it falls back to Google Air Quality **modelled** history (own BigQuery table `google_aq_history`, labelled "Modelled data" everywhere) | `lib/server/forecastService.ts`, `lib/server/bigqueryLive.ts`, `lib/server/modelledHistory.ts` |
| Spam resistance | Duplicate-photo hash, screenshot/stock detection, EXIF age/GPS checks, per-IP rate limits, optional App Check. Flagged reports stay visible but never count toward promotion | `app/api/reports`, `lib/server/http.ts` |
| Closing the loop | Public tracking page; WhatsApp messages on dispatch and resolve (Twilio); resident fix-check after resolve (see below) | `components/report/TrackView.tsx`, `lib/server/notify.ts` |
| Model quality | Operator-verified precision from real outcomes, resident-confirmed and disputed fixes, plus an offline classifier evaluation | `components/dashboard/ModelQualityCard.tsx`, `scripts/eval-classifier.mjs` |
| 13 languages + voice | Pre-generated locales; Speech-to-Text for voice notes | `locales/`, `app/api/speech-to-text` |
| Area page | `/zone/<h3>`: open hotspots, nearest station, Gemini summary for residents, Google health advice, 30-day history, WorldPop residents and schools/hospitals within 1 km, 24 h forecast. Linked from map pop-ups, the track page and the incident drawer | `components/zone/ZoneView.tsx`, `lib/server/zoneSummary.ts`, `lib/server/zoneBrief.ts` |
| Repeat hotspots | Append-only `incidentEvents` log (promoted, reopened, dispatched, resolved, disputed) → 30-day recurrence and a "repeat hotspot" flag in the queue; fed into work orders | `lib/recurrence.ts`, `lib/server/incidentEvents.ts` |
| Resident fix-check | On resolve, reporters are asked "is it fixed?" for 72 h (track page, or FIXED/STILL on WhatsApp). "Still there" reopens the incident as disputed | `lib/server/closure.ts`, `app/api/reports/[id]/closure` |
| Response targets | Overdue chip from the work-order priority (4 h / 24 h / 72 h, editable) | `lib/sla.ts` |
| Read aloud | Browser speech synthesis on the area page, track page; hidden when no voice exists for the language | `components/shared/ReadAloud.tsx` |

## What changed in September 2026

New since the Code for Communities build, all additive: no existing screen, rule or ranking was removed or reordered.

**For residents**
- **Area page** (`/zone/<h3CellId>`), for any ~0.7 km² hexagon in a monitored city:
  - open hotspots and the nearest station against the national limit;
  - a Gemini summary written only from that page's evidence, in the reader's UI language (cached, regenerated only when the evidence changes);
  - Google Air Quality health advice for everyone and six sensitive groups;
  - the last 30 days;
  - WorldPop residents within 1 km, plus schools and hospitals;
  - the 24-hour forecast.

  Reach it from map pop-ups ("View this area →"), the report-success card and the track page ("About this area").
- **"Is it fixed?"** When an operator resolves a hotspot, the people who reported it get 72 hours to confirm or dispute the fix, on the track page (only from the browser that filed the report) or by replying FIXED or STILL on WhatsApp. "Still there" reopens the incident as **Disputed**, clears the dispatch, and puts it back in the queue.
- **Read aloud** on the area page and track page, using the device's own voices. The button is hidden when there is no voice for the chosen language.

**For operators**
- **Repeat hotspot** chip in the response queue. A cell is flagged after 3+ confirmed episodes in 30 days, citizen reports on 3+ separate days, or a fix that didn't hold (it came back within 7 days, or a resident disputed it).
- **Overdue** chip, from the work order's priority: immediate 4 h, within 24 h, routine 72 h.
- **Disputed by resident** chip, and resident-confirmed and disputed fix counts on the Model quality card.
- **Incident drawer:** a "Last 30 days" section, a link to the public area page, and the response target next to the work-order priority.
- **Work orders** now receive the 30-day history and the WorldPop estimate. For a repeat hotspot, Gemini is asked for one action aimed at the source.

**Data**
- **`incidentEvents`:** an append-only history of each incident's steps (promoted, reopened, dispatched, resolved, fix confirmed, disputed). It is written after the promotion transaction, the ambient scan and operator actions, never blocking them.
- **Modelled forecast fallback:** a separate BigQuery table, `google_aq_history`, holds Google Air Quality hourly PM history.
  - It is used only when a station has fewer than 12 hourly readings, and is labelled "Modelled data" on every page.
  - It was backfilled for all 49 forecast zones on 28 Sep 2026; other zones are fetched on first view.
- **Honest outage states:** when a station feed is down, the area page says so instead of "no station nearby"; when Gemini is unavailable, it shows the last saved summary with its time.

**New routes:**

| Route | Purpose |
| --- | --- |
| `GET /api/zone/[cell]` | Area summary |
| `GET /api/zone/[cell]/brief?lang=` | Gemini summary |
| `GET /api/zone/[cell]/health?lang=` | Google health advice |
| `GET /api/zones/recurrence?cells=` | 30-day history for up to 20 cells |
| `POST /api/reports/[id]/closure` | Resident answer (needs the report token) |
| `POST /api/closure/whatsapp` | Bot relay (needs `WHATSAPP_CLOSURE_SECRET`) |
| `GET /api/cron/backfill-history` | Modelled history backfill (needs `CRON_SECRET`) |

**New Firestore collections** (all server-only):

| Collection | Holds |
| --- | --- |
| `incidentEvents` | Lifecycle history |
| `reportTokens` | SHA-256 of each report's fix-check token |
| `cellStats` | Cached WorldPop estimate per cell |
| `zoneBriefs` | Cached Gemini summaries |

**New fields:** `closure` and `reopenedBy` on incidents and reports; `incidentId` is now read on the track page.

## Security model

- **Browsers only read** `reports` and `incidents`. Every write goes through a server route using the Admin SDK (`firestore.rules`).
- **Operator actions** require a verified Firebase ID token for an allowlisted email or an `operator` custom claim (`lib/server/http.ts`).
- **Phone numbers** live in `reportContacts`, which no client can read.
- **Paid APIs** are either operator-only or rate-limited. The translate proxy is off unless `TRANSLATE_API_SECRET` is set.
- The **WhatsApp webhook** verifies Twilio's signature. The **image fetcher** only accepts ImgBB URLs. **Map pop-ups** escape citizen text.
- **Fix-check answers** need a per-report secret: `/api/reports` returns a random token to the browser that filed the report, and only its SHA-256 is stored, in `reportTokens`. The WhatsApp relay (`/api/closure/whatsapp`) needs `WHATSAPP_CLOSURE_SECRET`.
- **Public area endpoints** (`/api/zone/*`, `/api/zones/recurrence`) are rate-limited per IP; Gemini summaries and WorldPop estimates are cached, so page views don't multiply paid calls.
- **Server-only collections** (`incidentEvents`, `cellStats`, `zoneBriefs`, `reportTokens`) are closed to every client in `firestore.rules`.

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
| Earth Engine | Sentinel-5P NO₂ / aerosol, NASA FIRMS fires | Uses `FIREBASE_SERVICE_ACCOUNT_KEY`; set `EARTH_ENGINE_PROJECT_ID` | [Register project](https://code.earthengine.google.com/register) · [Enable API](https://console.cloud.google.com/apis/library/earthengine.googleapis.com) · [Service accounts](https://console.cloud.google.com/iam-admin/serviceaccounts) · [Service-account guide](https://developers.google.com/earth-engine/guides/service_account) |
| BigQuery | Live station history, forecasts, ARIMA_PLUS | `BIGQUERY_PROJECT_ID` (authenticates with `FIREBASE_SERVICE_ACCOUNT_KEY`) | [Enable API](https://console.cloud.google.com/apis/library/bigquery.googleapis.com) · [BigQuery console](https://console.cloud.google.com/bigquery) |
| Cloud Scheduler | Runs `/api/cron/tick` every 30 min | `CRON_SECRET` (any long random string) | [Enable API](https://console.cloud.google.com/apis/library/cloudscheduler.googleapis.com) |
| Google Maps JavaScript | Draggable pin on the report form's map picker | `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` (browser key, referrer-restricted) | [Maps JS API](https://console.cloud.google.com/apis/library/maps-backend.googleapis.com) · [Credentials](https://console.cloud.google.com/apis/credentials) |
| Google Air Quality | Independent modelled cross-check, reported in each country's own AQI | `GOOGLE_AIR_QUALITY_API_KEY` | [Enable API](https://console.cloud.google.com/apis/library/airquality.googleapis.com) · [Credentials](https://console.cloud.google.com/apis/credentials) |
| Places API (New) + Geocoding | Report location search, pin-to-address, and schools / hospitals near a hotspot (server-side via `/api/places`) | `GOOGLE_PLACES_API_KEY` | [Places API (New)](https://console.cloud.google.com/apis/library/places.googleapis.com) · [Geocoding API](https://console.cloud.google.com/apis/library/geocoding-backend.googleapis.com) |
| Speech-to-Text | Voice notes in the report form | `GOOGLE_SPEECH_API_KEY` | [Enable API](https://console.cloud.google.com/apis/library/speech.googleapis.com) |
| Cloud Translation | Translating new UI strings (`scripts/generate-locales.js`) | service-account file in `credentials/` | [Enable API](https://console.cloud.google.com/apis/library/translate.googleapis.com) |
| ImgBB | Photo hosting for reports | `IMGBB_API_KEY` | [api.imgbb.com](https://api.imgbb.com/) |
| Twilio WhatsApp | Status messages to WhatsApp reporters | `TWILIO_*` | [Twilio console](https://console.twilio.com/) |
| WhatsApp fix-check | FIXED / STILL replies from the bot | `WHATSAPP_CLOSURE_SECRET` (same value in the app and `whatsapp_bot`) | Any long random string |

The map tiles (OpenFreeMap), weather (Open-Meteo) and city outlines (OpenStreetMap, stored in the repo) need no key.

**One service account.** Firebase Admin, Earth Engine and BigQuery all authenticate with `FIREBASE_SERVICE_ACCOUNT_KEY` (`firebase-adminsdk-fbsvc@<project>.iam.gserviceaccount.com`). In [IAM](https://console.cloud.google.com/iam-admin/iam) it needs *Service Usage Consumer*, *Earth Engine Resource Viewer*, *BigQuery Data Editor* and *BigQuery Job User*; the project must be registered for Earth Engine with the Earth Engine and BigQuery APIs enabled. Without these the fire layer and satellite checks report `Caller does not have required permission to use project …`.

Check what is connected at `GET /api/system-status` or on the dashboard's **Data sources** card.

### Deploying the web app

`apphosting.yaml` lists every runtime variable: public browser config inline, keys as Cloud Secret Manager references. Create or rotate a key with `firebase apphosting:secrets:set <NAME> --data-file <file> --force`, then deploy the local source:

```bash
firebase deploy --only apphosting:cleanair-backend --project cleanair-clear-streets --force
```

`--force` answers the CLI's "deploy local source over the GitHub-linked repository?" prompt; without it the command waits, or exits having deployed nothing.

`firebase.json` excludes `.env*`, `credentials/`, service-account JSON files and `app/zz-preview` from the upload. The backend is also linked to a GitHub repository; a push there starts its own rollout from that repository's code.

### Deploying the backend pieces

1. **Firestore rules:** `firebase deploy --only firestore:rules`
2. **Operators:** create users in Firebase Auth → add their emails to `OPERATOR_EMAILS`.
3. **BigQuery:** edit the project ID in `scripts/setup-bigquery.sql`, then run `bq query --use_legacy_sql=false < scripts/setup-bigquery.sql`. The runtime service account needs *BigQuery Data Editor* and *BigQuery Job User*. The app creates `google_aq_history` itself, in the same dataset (and location) as the live table; the live deployment's dataset is in `asia-south2`.
4. **Earth Engine:** grant the app's service account the roles listed under *One service account* above and register the project for Earth Engine.
5. **Scheduler:** every 30 minutes, run the ambient scan, BigQuery ingest, the classification sweep, the fire refresh, and daily ARIMA retraining:
   ```bash
   gcloud scheduler jobs create http vayusetu-tick \
     --schedule="*/30 * * * *" --time-zone="Asia/Kolkata" \
     --uri="https://<your-host>/api/cron/tick" --http-method=GET \
     --headers="Authorization=Bearer <CRON_SECRET>"
   ```
6. **Optional Firestore TTL:** add a TTL policy on `rateLimits.expiresAt`.
7. **Optional forecast backfill:** `GET /api/cron/backfill-history` (same `Authorization: Bearer <CRON_SECRET>`, optional `?city=`) creates `google_aq_history` and loads a week of Google Air Quality modelled PM history for every city's forecast zones. Zones not covered are fetched and stored on first view.

### WhatsApp bot (`/whatsapp_bot`)

A Firebase Cloud Function (Twilio webhook). Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `IMGBB_API_KEY`, and `APP_URL` (the web app origin). Set `TWILIO_WEBHOOK_URL` if the function sits behind a proxy. Signature checking is on whenever the auth token is set.

To let reporters answer the fix-check by replying **FIXED** or **STILL**, set the same `WHATSAPP_CLOSURE_SECRET` in the bot and the web app and redeploy the bot first. The reply is read only outside a report conversation. Until the secret is set, the resolve message does not ask the question.

## Testing & evaluation

```bash
npm test                 # 43 unit tests: attribution, forecast/backtest, IST and per-city time zones,
                         # city boundaries, WAQI AQI→µg/m³ conversion, H3 cells, evidence rules
                         # (incl. stale-reading rejection), fusion, classifier parsing, EXIF,
                         # 30-day recurrence, response targets, resident fix-check states
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
curl localhost:3000/api/zone/8831aa42b7fffff          # area summary (Temple of Heaven, Beijing)
curl "localhost:3000/api/zones/recurrence?cells=883da11415fffff"   # 30-day history for one or more cells
curl "localhost:3000/api/forecast?h3CellId=8831aa42b7fffff"        # dataSource: live | archive | modelled
```

For the classifier evaluation, put labelled photos in `eval/photos/<label>/` (see `eval/README.md`). The results appear on the dashboard's *Model quality* card.

## Known limitations

- **Forecast data:** the forecast uses live station history once `/api/cron/tick` has been collecting it (the live table started filling on 28 Sep 2026). Until a station has 12 hourly readings, the forecast uses Google Air Quality modelled history, shown as "Modelled data", never as live. Delhi would use the 2015–2020 Kaggle archive first if it were loaded; it is not loaded in the live deployment. ARIMA_PLUS trains only on station readings.
- **WAQI:** free for non-commercial use, with attribution to WAQI and the originating agency (shown in station pop-ups). Some WAQI stations are low-cost sensors, especially in Jakarta and Brasília.
- **WhatsApp bot:** reports from any city are filed by their coordinates, but the bot's messages are English/Hindi only.
- **Outages:** when data.gov.in is down, Delhi station lookups fail after about 40 s and then fail fast for 2 minutes; the UI shows the feed as unavailable.
- **ARIMA timing:** ARIMA_PLUS needs about 7 days of live readings before the first training run.
- **Attribution is a screening aid**, not a dispersion model. Sensor and satellite checks are thresholds on public data, not calibrated source apportionment.
- **WhatsApp limits:** outside the 24-hour session window, WhatsApp requires approved message templates. Failed sends are recorded and never block an operator action.
- **Translations:** the strings added in September 2026 are machine-translated into all 12 other locales. About 300 older strings were never translated and still fall back to English. `node scripts/generate-locales.js` re-translates every string and overwrites existing translations.
- **Estimates are labelled as estimates:** residents within 1 km are WorldPop 2020 figures, and modelled PM history is Google's 500 m estimate. Health advice is Google's own text, and its language coverage varies.
- **Response targets** (4 h / 24 h / 72 h by work-order priority, `lib/sla.ts`) are placeholders until the municipality sets its own.
- **Repeat-hotspot history** starts with the first recorded event per cell (28–29 Sep 2026); citizen-report days use every report ever filed.

*Build with AI: Code for Communities (Google Cloud × hack2skill) — Track 2, Pollution hotspot detection.*
