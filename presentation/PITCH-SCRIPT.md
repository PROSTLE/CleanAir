# VayuSetu: pitch script and demo guide

This goes with `VayuSetu-BRICS.pdf` / `.pptx` (12 slides; each slide also has these notes in PowerPoint's Presenter View). The **"Say"** lines are written to be spoken, and the **"Do"** lines are the exact clicks.

Every number in the deck and in this script came from the live system on **29 Sep 2026**. If you present later, refresh them first (see [Before you start](#1-before-you-start-10-minutes-earlier)).

**Live site:** https://cleanair-backend--cleanair-clear-streets.asia-southeast1.hosted.app

---

## 1. Before you start (10 minutes earlier)

Open these tabs in this order, in one browser window (Chrome works best):

| Tab | URL (add to the live site address) | Why |
| --- | --- | --- |
| 1 | `/` | Landing page, to start the demo |
| 2 | `/report` | Citizen reporting |
| 3 | `/map` | Live map |
| 4 | `/zone/8831aa42b7fffff` | Area page: Temple of Heaven, Beijing (the screenshot on slide 7) |
| 5 | `/dashboard` | Command center, signed in as operator |
| 6 | `/forecast` | Forecast |

Checklist:
- [ ] **Sign in on the dashboard:** tab 5 → top right **Operator sign in** → the demo operator email (`operator@cleanair.gov`) and the team's private password. Do this before the pitch, not live.
- [ ] **City:** the city picker is the pin button in the navbar (it shows the current city, e.g. "New Delhi"). It has two groups: **Indian cities** and **BRICS capitals**. Use **New Delhi** (28 live stations) or **Kolkata** for the Indian part and **Beijing** (34) or **Moscow** (50) for the BRICS part. Avoid Hyderabad, Mumbai, Chennai and Bengaluru for live readings: CPCB has been offline since 24 Sep, so they show mostly grey offline pins.
- [ ] **Language:** the globe button (**EN**) is next to the city picker. Check it's on English before you start.
- [ ] **Read aloud:** check it works on this laptop. Open tab 4 and press **Read aloud** on "What's happening". If the button is missing, the laptop has no voice for that language. Just skip that step.
- [ ] **Photo:** keep one real smoke or dust photo on the laptop or phone for the reporting demo (a garbage-fire photo works best).
- [ ] **Backup:** open the PDF in a separate window, in case the Wi-Fi fails.
- [ ] **Dashboard:** if the dashboard queue is empty, that is real (no open hotspot in that city right now). Switch the city picker to one with open incidents, or show the map.

---

## 2. The full pitch (about 8 minutes: 12 slides plus live demo)

The deck follows the judging weights: Gen AI and technical merit 40% (slides 4, 5, 6, 10), problem and impact 25% (slides 2, 11), innovation 25% (slides 3, 9), UX 10% (slides 7, 8).

### Slide 1: Title, VayuSetu (20 s)
**Say:** "Hi, we're team ___. This is VayuSetu, 'bridge of air'. It finds the pollution hotspot on your street, proves it, and gets it fixed. It's live today in twelve cities: six major Indian cities and the six other BRICS capitals, with 137 live ground stations, 13 languages, and Gemini doing four jobs that are all grounded in evidence."

### Slide 2: The problem (40 s)
**Say:**
- "According to the WHO, 99% of people live where its air-quality guidelines are not met."
- "Outdoor air pollution caused 4.2 million premature deaths in 2019, and 89% of them were in low- and middle-income countries: India and most of BRICS."
- "Three gaps make it worse. A garbage fire far from the nearest monitor vanishes into the city average. Smoke crosses borders. And even when the data exists, nobody tells a crew which street to go to."

### Slide 3: Our solution (45 s)
**Say:**
- "Four steps: sense, verify, fuse, act."
- "Citizens send a photo, a voice note and a pin, while stations and satellites watch all the time."
- "Gemini checks the photo. We score it against the nearest station, the satellite, NASA fires and wind. Then it's ranked, dispatched with a work order, and confirmed by residents."

**Point at the table:** "Compared with a typical AQI dashboard: street level instead of one city number, five kinds of evidence instead of one, every report checked, and it ends with a fix, not a chart."

### Slide 4: Architecture (45 s)
**Say:**
- "Three boxes: inputs, Google Cloud, outputs."
- "Citizens, ground stations (OpenAQ, WAQI and CPCB, merged per city), satellites and weather come in. Gemini, Earth Engine, BigQuery, Firebase, Maps Platform and Cloud Scheduler do the work. Residents, operators, agencies and everyone else get the results."
- "The key decision is at the bottom. Every report, station reading and satellite pixel is placed on the same ~0.7 km² hexagon, so evidence from different sources can be compared in the same place."

### Slide 5: Gemini (50 s)
**Say:**
- "Gemini does four jobs."
- "One: it checks every photo (smoke, dust, fire or haze) and flags screenshots, edits and stock images."
- "Two: an operations copilot that answers by calling seven live tools."
- "Three: work orders as structured output, in English and the city's language; for a repeat hotspot it asks for action at the source."
- "Four: plain-language summaries for residents, in 13 languages, with read-aloud."
- "Guardrails: only recorded facts go in, and every output lists what it used. There's a fallback model, and if both fail the page says so. Health advice comes from Google's Air Quality API, not from Gemini."

### Slide 6: How a hotspot is verified (45 s)
**Say:**
- "No alert without independent evidence."
- "Report, classify, integrity check (photo time and GPS, duplicate hashes, screenshots), then fuse with station, satellite, fires and wind, then dispatch."
- "Six promotion tiers, strongest first."
- "And 53 of our 55 incidents were raised automatically: the scan checks every station and the satellite every 30 minutes, with no photo needed."

### Slide 7: For residents, then DEMO 1 (1 min 30 s)
**Say:** "Reporting takes seconds, and every street gets its own page."

**Do (tab 2, `/report`):**
1. Click **Open camera or choose image** and pick your smoke photo.
2. Under **What are you seeing?**, choose the hazard.
3. Location: click **Detect my location**, or type in **Search for an area...**, or **Use map picker**.
4. Optional: click **Speak** and say one sentence.
5. Click **Submit Report**, then **Track this report**. Point at the live steps.

**Do (tab 4, `/zone/8831aa42b7fffff`):**
1. **AQI gauge and Right now:** the Temple of Heaven station, 0.27 km away, shown on the US EPA AQI (the BRICS capitals' scale; Indian cities use India's National AQI) and against China's 75 µg/m³ limit.
2. **What's happening:** Gemini's summary. Press **Read aloud**.
3. **Health advice:** open **Advice for children, older adults and other sensitive groups**.
4. **Who's affected:** about 71,838 residents within 1 km.

> Submitting creates a real report in the live database. If you'd rather not, show the form and the slide.

### Slide 8: For operators, then DEMO 2 (1 min 15 s)
**Say:** "Operators see what to fix first, and why."

**Do (tab 5, `/dashboard`, signed in):**
1. **Response queue:** ranked by evidence; point at the **Repeat hotspot**, **Overdue** and **Disputed by resident** chips when they're present.
2. Click **Review**. Show the **Evidence trail** and **Last 30 days**.
3. **Field context → Load:** upwind sources, schools and hospitals, and Google's cross-check.
4. **Work order → Draft with Gemini**.
5. Don't press dispatch or **Resolve** on a real incident.

**Do (tab 3, `/map`, city = New Delhi, then Beijing):** point at the **AQI gauge** (the city's median live station), click **3D** (it zooms in to street level and raises the buildings), tick **Show satellite fires**, click a pin, then **View this area →**. Grey dashed pins are monitors that stopped reporting; they never show a value.

### Slide 9: Closing the loop (50 s)
**Say:**
- "Most systems stop at 'resolved'. We don't."
- "When an operator marks a hotspot fixed, the people who reported it get 72 hours to answer: is it really fixed? On the website, or by replying FIXED or STILL on WhatsApp."
- "'Still there' reopens it as Disputed and sends it back to the queue."
- "Every step is logged. So a spot that keeps coming back (three episodes in 30 days, reports on three days, or a fix that didn't hold) is flagged, and the next work order targets the source."
- "We tested this end to end against the live database."

### Slide 10: Forecasts in every city, then DEMO 3 (45 s)
**Say:**
- "Every 30 minutes, Cloud Scheduler pulls every station into BigQuery: OpenAQ, WAQI and CPCB for the Indian cities, WAQI for the BRICS capitals."
- "A forecast needs 12 hours of a station's own readings. Until a station has that, we use Google's modelled history from a separate table, and the page says 'Modelled data'."
- "Real readings always win, and ARIMA_PLUS trains only on them. All twelve cities have a forecast, even Hyderabad while CPCB is offline."

**Do (tab 6, `/forecast`, city = Beijing):** point at the **Modelled data** badge (or **Live**) and at **History source** under Model comparison.

### Slide 11: Built for India and BRICS (40 s)
**Say:**
- "Twelve cities, seven legal limits, one engine. Delhi, Mumbai, Kolkata, Chennai, Bengaluru and Hyderabad are judged at India's 60 micrograms; Beijing at 75, Moscow at 35, each capital by its own national law."
- "137 stations are live, and 53 of 55 hotspots were raised automatically."
- "A new city is one configuration entry, with no code changes."

### Slide 12: What's next, and close (40 s)
**Say:**
- "In the next 90 days: a pilot with one municipal team, WhatsApp alerts when a hotspot is confirmed near you, and an after-photo from the crew as proof of the fix."
- "VayuSetu gives citizens a voice in their own language, operators an evidence-backed list, and nations one engine that keeps their own rules."
- "Clean air, street by street, across India and BRICS. Thank you."

---

## 3. The 3-minute video version

Use it for a submission video: no live typing, just screen recording plus voice.

| Time | Show | Say |
| --- | --- | --- |
| 0:00–0:15 | Slide 1 | "VayuSetu finds pollution hotspots street by street in six Indian cities and six BRICS capitals, proves each one, and makes sure it's fixed." |
| 0:15–0:35 | Slide 2 | "A city AQI hides the garbage fire down the road. Smoke crosses borders, and data rarely reaches a crew." |
| 0:35–0:55 | Recording: `/report` | Pick a photo, choose the hazard, drop a pin, press **Submit Report**. "Citizens report in 13 languages; Gemini checks the photo." |
| 0:55–1:15 | Slides 5–6 | "Gemini checks the photo, and a report becomes a hotspot only with independent evidence: station, satellite, fires, wind or other citizens." |
| 1:15–1:40 | Recording: `/dashboard` | Click **Review**, then **Load**, then **Draft with Gemini**. "Operators see what to fix first and why, with a work order to the right agency." |
| 1:40–2:05 | Recording: `/zone/8831aa42b7fffff` | Scroll the page; press **Read aloud**. "Every neighbourhood gets a page: what's happening, health advice, who's affected." |
| 2:05–2:25 | Slide 9 | "When it's marked fixed, residents confirm it. 'Still there' reopens it, and repeat spots are flagged." |
| 2:25–2:45 | Slide 10, then `/forecast` | "Forecasts for every city from BigQuery, clearly labelled when the history is modelled." |
| 2:45–3:00 | Slide 12 | "Clean air, street by street, across India and BRICS." |

---

## 4. If something breaks during the demo

| What you see | Why | What to say / do |
| --- | --- | --- |
| An Indian city shows mostly grey pins | CPCB (and OpenAQ's copy of it) has been offline since 24 Sep 2026 | "The government feed is down right now; the grey pins are real monitors with their last-report date, and the app never shows them as live." Switch to New Delhi, Kolkata, Beijing or Moscow. |
| "Gemini is unavailable right now" | Google capacity (503) | "It shows the last saved summary with its time, or tells you it's unavailable. It never invents one." Move on. |
| Report stays on "Analysing" | Classification queue | "It runs on the server; the scheduler retries anything missed." Show slide 7 instead. |
| Dashboard queue is empty | No open hotspot in that city now | "Nothing open right now, which is also real." Switch city, or open the map. |
| No **Read aloud** button | No voice for that language on this laptop | Skip it; it's hidden on purpose rather than reading with the wrong voice. |
| Wi-Fi fails | — | Present from the PDF; slides 4, 6 and 9–10 are flow charts, and slides 7–8 have real screenshots. |

---

## 5. Questions judges may ask (short, honest answers)

**How do you stop fake reports?**
Gemini checks each photo for screenshots, edits and stock images. We also compare the photo's own time and GPS, and catch duplicates by hash. Flagged reports stay visible but never count toward a hotspot. There are per-IP rate limits and optional App Check. And a report alone isn't enough; it needs independent evidence.

**What if there's no sensor nearby?**
The satellite (Sentinel-5P NO₂ and aerosol), NASA fires and other citizens can corroborate instead. The page shows exactly which evidence was used.

**Is the forecast accurate?**
We show a backtest against a naive "same as last hour" baseline on the forecast page. When a station has under 12 hours of data, the forecast uses Google's modelled history and is labelled "Modelled data".

**Does Gemini make things up?**
Work orders and summaries are generated only from a list of recorded facts, and they list the evidence they cite. Health advice comes from Google's Air Quality API, not from Gemini.

**How do you know a fix really worked?**
The reporter confirms it within 72 hours. "Still there" reopens it. Repeat spots are flagged from a history log of every step.

**Privacy?**
Reports are anonymous. Phone numbers sit in a collection no browser can read. The fix-check uses a random per-report token, and only its hash is stored.

**How do you add a new city or country?**
One configuration entry: group, boundary, station feeds, legal limits, AQI scale, fire region, agencies, languages and time zone. Station positions come from the public feeds, never typed in by hand.

**Why two AQI scales?**
Indian cities show India's National AQI, which people there know. The BRICS capitals show the US EPA AQI, the index their WAQI stations publish. Each gauge says which scale it uses.

**What does it cost to run?**
It runs on Firebase App Hosting and pay-as-you-go Google APIs. Paid calls are either operator-only, rate-limited or cached (Gemini summaries per area, population per area, Google history in BigQuery).

**What's next?**
- WhatsApp alerts when a hotspot is confirmed near you.
- An "after" photo when a crew resolves a hotspot.
- Each city's own response targets, instead of our placeholders.

---

## 6. Refreshing the numbers before a later pitch

The numbers on slides 1, 6, 10 and 11 were taken on 29 Sep 2026 and will grow:
- **Live station count:** add up the live stations from `/api/stations?city=<id>` for all twelve cities (entries without `"stale": true`).
- **Table rows:** in the BigQuery console, the dataset `cleanair_analytics` (tables `cpcb_live_readings` and `google_aq_history`).
- **Incident counts:** Firestore → `incidents` (and the `source` field for the automatic ones).
- **Residents near the Temple of Heaven:** open tab 4 and read **Who's affected**.

If a number changes, update the slide text and this script together, so they never disagree.
