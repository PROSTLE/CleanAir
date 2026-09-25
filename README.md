# VayuSetu — hyperlocal air-pollution hotspots for Delhi

VayuSetu turns citizen photos, CPCB ground sensors, Sentinel-5P satellite data and NASA FIRMS fire detections into a neighbourhood-level hotspot map. It then helps municipal teams act on each hotspot: who to send, where the pollution is probably coming from, and who nearby needs a warning.

Built on Google's AI and Cloud stack: Gemini, Earth Engine, BigQuery / BigQuery ML, Maps Platform (Maps, Places, Air Quality), and Firebase.

**Live deployment:** https://cleanair-backend--cleanair-clear-streets.asia-southeast1.hosted.app
- `/report` — citizen reporting (photo, voice note, 13 languages)
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
   • OpenWeatherMap wind
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

A second path runs with no citizen input: the **ambient scan** checks every Delhi CPCB station, together with Sentinel-5P, against its own recorded baseline. It needs two consecutive observations before it raises an incident, unless a single reading already crosses an Indian AQI "Poor" threshold.

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

Next.js 16 (App Router, TypeScript) · React 19 · Firebase App Hosting, Firestore, Auth, App Check · Gemini 3.5 Flash (3.1 Flash-Lite fallback) · Earth Engine (Sentinel-5P NRTI/OFFL, NASA FIRMS) · BigQuery + BigQuery ML · Google Maps JS, Places API (New), Air Quality API · Cloud Speech-to-Text · CPCB via data.gov.in · OpenWeatherMap · Twilio WhatsApp · H3.

---

## Local setup

**Prerequisites:** Node.js ≥ 22.18 and a Firebase project with Firestore and Auth (Email/Password) enabled.

```bash
pnpm install          # or npm install
cp .env.example .env.local   # fill in what you have; missing integrations show "not configured"
pnpm dev
```

### Deploying the backend pieces

1. **Firestore rules:** `firebase deploy --only firestore:rules`
2. **Operators:** create users in Firebase Auth → add their emails to `OPERATOR_EMAILS`.
3. **BigQuery:** edit the project ID in `scripts/setup-bigquery.sql`, then run `bq query --use_legacy_sql=false < scripts/setup-bigquery.sql`. The runtime service account needs *BigQuery Data Editor* and *BigQuery Job User*.
4. **Earth Engine:** register a service account for Earth Engine and provide it as `EARTH_ENGINE_SERVICE_ACCOUNT_KEY`.
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
npm test                 # unit tests: attribution, forecast/backtest, IST handling, H3 cells,
                         # evidence rules, fusion, classifier parsing, EXIF
npm run lint
npm run eval:classifier  # offline Gemini classifier evaluation → public/eval/classifier-eval.json
```

For the classifier evaluation, put labelled photos in `eval/photos/<label>/` (see `eval/README.md`). The results appear on the dashboard's *Model quality* card.

## Known limitations

- **Forecast data:** the forecast uses live CPCB history once `/api/cron/tick` has been collecting it. Until then it falls back to the 2015–2020 Kaggle archive, and the UI marks that output as archived rather than live.
- **ARIMA timing:** ARIMA_PLUS needs about 7 days of live readings before the first training run.
- **Attribution is a screening aid**, not a dispersion model. Sensor and satellite checks are thresholds on public data, not calibrated source apportionment.
- **WhatsApp limits:** outside the 24-hour session window, WhatsApp requires approved message templates. Failed sends are recorded and never block an operator action.
- **Translations:** new UI strings are in English. Run `node scripts/generate-locales.js` to translate them into the other 12 locales.

*Build with AI: Code for Communities (Google Cloud × hack2skill) — Track 2, Pollution hotspot detection.*
