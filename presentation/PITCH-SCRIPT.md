# VayuSetu: pitch script and demo guide

This goes with `VayuSetu-BRICS.pdf` / `.pptx` (16 slides). The **"Say"** lines are written to be spoken, and the **"Do"** lines are the exact clicks.

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
| 4 | `/zone/8831aa42b7fffff` | Area page: Temple of Heaven, Beijing (the screenshot on slide 10) |
| 5 | `/dashboard` | Command center, signed in as operator |
| 6 | `/forecast` | Forecast |

Checklist:
- [ ] **Sign in on the dashboard:** tab 5 → top right **Operator sign in** → the demo operator email (`operator@cleanair.gov`) and the team's private password. Do this before the pitch, not live.
- [ ] **City:** the city picker is the pin button in the navbar (it shows the current city, e.g. "New Delhi"). Set it to **Beijing** for the map and forecast demo; Beijing has the most live stations.
- [ ] **Language:** the globe button (**EN**) is next to the city picker. Check it's on English before you start.
- [ ] **Read aloud:** check it works on this laptop. Open tab 4 and press **Read aloud** on "What's happening". If the button is missing, the laptop has no voice for that language. Just skip that step.
- [ ] **Photo:** keep one real smoke or dust photo on the laptop or phone for the reporting demo (a garbage-fire photo works best).
- [ ] **Backup:** open the PDF in a separate window, in case the Wi-Fi fails.
- [ ] **Dashboard:** if the dashboard queue is empty, that is real (no open hotspot in that city right now). Switch the city picker to one with open incidents, or show the map.

---

## 2. The full pitch (about 8 minutes: slides plus live demo)

### Slide 1: Title, VayuSetu (20 s)
**Say:** "Hi, we're team ___. This is VayuSetu, 'bridge of air'. It finds pollution hotspots street by street in BRICS capitals, proves each one with independent evidence, and makes sure somebody actually fixes it."

### Slide 2: The problem (40 s)
**Say:**
- "A city-wide AQI hides the air people actually breathe. One monitor can sit kilometres from a garbage fire or a construction site, so that source disappears into the average."
- "Smoke doesn't stop at borders: crop burning in Punjab reaches Delhi, and haze moves across countries."
- "And even when the data exists, it rarely reaches a crew. Nobody is told which street to inspect or which department owns the fix."

### Slide 3: Our solution (40 s)
**Say:**
- "We do four things: sense, verify, fuse, act."
- "Citizens report with a photo, a voice note and a pin. Stations and satellites watch all the time."
- "Gemini checks every photo. Then we combine the report with the nearest ground station, Sentinel-5P satellite data, NASA fire detections and live wind."
- "Only then does it become a hotspot, which goes to the right department with a work order."

**Point at the numbers:** 4 evidence streams, ~0.7 km² cells, 6 promotion tiers, 13 languages.

### Slide 4: Built for BRICS (25 s)
**Say:** "It runs live in seven capitals: New Delhi, Beijing, Moscow, Pretoria, Abu Dhabi, Jakarta and Brasília. Each city uses its own country's legal limits, on one shared engine."

### Slide 5: What makes it different (30 s)
**Say:** "Most AQI dashboards show one number for the city. We work at street level, we combine five kinds of evidence, we don't take reports at face value, and we end with an action, not a chart."

### Slide 6: How a hotspot is verified (40 s)
**Say:**
- "Every alert must be backed by independent evidence."
- "A report goes through Gemini classification and an integrity check: photo time and GPS, duplicate photos, screenshots."
- "Then it's scored against the station, the satellite, fires and wind."
- "It becomes a hotspot only through one of these six tiers, strongest first. For example, a sensor and a satellite agreeing, or three different citizens."
- "Stations and satellites can also raise hotspots on their own. A scan checks every city every 30 minutes, with no photo needed."

### Slide 7: Citizen reporting, then DEMO 1 (1 min)
**Say:** "Reporting takes seconds, in your own language."

**Do (tab 2, `/report`):**
1. Click **Open camera or choose image** and pick your smoke photo.
2. Under **What are you seeing?**, choose the hazard (for example garbage fire).
3. Location: click **Detect my location**, or type in **Search for an area...**, or **Use map picker** to drop a pin.
4. Optional: click **Speak** and say one sentence. It's transcribed into the note box.
5. Click **Submit Report**.
6. Show the result card, then click **Track this report**. Point at the live steps: received → analysed → corroborated → dispatched → resolved.
7. On the track page, point at **About this area**. That leads into the next slides.

**Say while it analyses:** "Gemini is checking the photo right now: is it smoke, dust, fire or haze, and is it a real photo, not a screenshot."

> Submitting creates a real report in the live database. That's fine for a demo. If you'd rather not, just show the form and the slide.

### Slide 8: Live map, then DEMO 2 (40 s)
**Do (tab 3, `/map`, city = Beijing):**
1. Point at the station pins, coloured by PM2.5.
2. Click **3D** in the **Map view** switch to show the buildings, then **2D** to go back.
3. Tick **Show satellite fires** to show the NASA FIRMS fire layer.
4. Click any pin; the pop-up has **View this area →**. Click it (it opens the area page).

**Say:** "Every official station, at its real coordinates, plus satellite fires and live hotspots."

### Slide 9: Command center, then DEMO 3 (1 min 15 s)
**Say:** "This is what a municipal operator sees: what to fix first, and why."

**Do (tab 5, `/dashboard`, already signed in):**
1. Point at the **Response queue**: ranked by evidence tier and confidence. Mention the chips: **Repeat hotspot**, **Overdue**, **Disputed by resident**.
2. Click **Review** on the top row; the drawer opens.
3. **Evidence trail:** the combined confidence, the station reading vs the national limit, the satellite window.
4. **Last 30 days:** the history of this exact spot, and **Open area page**.
5. **Field context → Load:** upwind sources from live wind, schools and hospitals within 1 km, and Google's cross-check.
6. **Work order → Draft with Gemini:** an English and local-language work order to the right agency, citing its evidence.
7. Don't click dispatch or **Resolve** on a real incident during the demo unless you mean it; it notifies reporters.
8. Optional: scroll to **Operations copilot**, click the suggestion "Which open hotspots need a crew first, and why?", and show the **Data used** list.

**Say:** "Every answer shows the evidence behind it. Nothing is generated without a source."

### Slide 10: Area page (NEW), then DEMO 4 (1 min)
**Say:** "Residents get the same evidence, in plain language. Every neighbourhood has its own page."

**Do (tab 4, `/zone/8831aa42b7fffff`):**
1. **Right now:** the nearest station, 0.27 km away, against China's 75 µg/m³ limit.
2. **What's happening:** Gemini's summary, written only from this page's evidence. Press **Read aloud**.
3. **Health advice:** Google's advice. Open **Advice for children, older adults and other sensitive groups**.
4. **Last 30 days:** the 30-day strip. A repeat hotspot would be flagged here.
5. **Who's affected:** about 71,838 residents within 1 km (WorldPop), plus schools and hospitals.
6. Optional: switch the globe (**EN**) to **Hindi**. The page and the Gemini summary switch language.

### Slide 11: Closing the loop (NEW) (50 s)
**Say:**
- "Most systems stop at 'resolved'. We don't."
- "When an operator marks a hotspot fixed, the people who reported it get 72 hours to answer: is it really fixed? On the website, or by replying FIXED or STILL on WhatsApp."
- "If someone says 'still there', the incident reopens as Disputed and goes straight back to the queue."
- "Every step is logged. So if the same spot keeps coming back (three episodes in 30 days, reports on three different days, or a fix that didn't hold), it's flagged as a repeat hotspot. The next work order asks for action at the source, not another clean-up."
- "And every work order has a clock: 4, 24 or 72 hours, by priority."

### Slide 12: The intelligence layer (40 s)
**Say:**
- "Gemini does three jobs here: it checks photos, answers operators' questions using live data, and writes work orders."
- "Forecasting runs on BigQuery with a BigQuery ML model, tested against a simple baseline."
- "And cross-border attribution uses live wind and NASA fires across each capital's upwind region: Punjab and Haryana for Delhi, Hebei for Beijing."

### Slide 13: Forecast pipeline (NEW), then DEMO 5 (50 s)
**Say:**
- "Every 30 minutes, Cloud Scheduler pulls every station into BigQuery."
- "A forecast needs 12 hours of a station's own readings. Until a station has that, we use Google's Air Quality history, in a separate table, and the page says 'Modelled data'. Real readings always win."

**Do (tab 6, `/forecast`, city = Beijing):**
1. Click a zone tab. Point at the orange **Modelled data** badge (or **Live** once the station has 12 hours).
2. Point at the chart legend (**Recent modelled**, or **Recent actual** for station data) and the **History source** box under Model comparison.

### Slide 14: By the numbers (NEW) (30 s)
**Say:** "These numbers come from the live system, not a projection:
- 7 capitals;
- 77 ground stations streaming into BigQuery;
- 46 of 48 hotspots raised automatically from stations and satellites;
- about 71,800 residents counted near one Beijing landmark;
- a 72-hour window for residents to confirm a fix."

### Slide 15: Federated by design (25 s)
**Say:** "Each nation keeps its own rules and language. Adding a new capital is one configuration entry: its boundary, station network, legal limits, fire region, agencies and languages. No code changes."

### Slide 16: Close (20 s)
**Say:** "VayuSetu gives citizens a voice in their own language, operators a ranked list of evidence-backed hotspots, and nations one shared engine that keeps their own rules. Clean air, verified street by street, across BRICS. Thank you."

---

## 3. The 3-minute video version

Use it for a submission video: no live typing, just screen recording plus voice.

| Time | Show | Say |
| --- | --- | --- |
| 0:00–0:15 | Slide 1 | "VayuSetu finds pollution hotspots street by street in seven BRICS capitals, proves each one, and makes sure it's fixed." |
| 0:15–0:35 | Slide 2 | "A city AQI hides the garbage fire down the road. Smoke crosses borders, and data rarely reaches a crew." |
| 0:35–0:55 | Recording: `/report` | Pick a photo, choose the hazard, drop a pin, press **Submit Report**. "Citizens report in 13 languages; Gemini checks the photo." |
| 0:55–1:15 | Slide 6 | "A report becomes a hotspot only with independent evidence: station, satellite, fires, wind or other citizens." |
| 1:15–1:40 | Recording: `/dashboard` | Click **Review**, then **Load**, then **Draft with Gemini**. "Operators see what to fix first and why, with a work order to the right agency." |
| 1:40–2:05 | Recording: `/zone/8831aa42b7fffff` | Scroll the page; press **Read aloud**. "Every neighbourhood gets a page: what's happening, health advice, who's affected." |
| 2:05–2:25 | Slide 11 | "When it's marked fixed, residents confirm it. 'Still there' reopens it, and repeat spots are flagged." |
| 2:25–2:45 | Slide 13, then `/forecast` | "Forecasts for every capital from BigQuery, clearly labelled when the history is modelled." |
| 2:45–3:00 | Slide 16 | "Clean air, verified street by street, across BRICS." |

---

## 4. If something breaks during the demo

| What you see | Why | What to say / do |
| --- | --- | --- |
| Delhi station feed says unavailable | data.gov.in (CPCB) goes down at times | "The government feed is down right now, and the app says so instead of guessing." Switch the city to Beijing or Moscow. |
| "Gemini is unavailable right now" | Google capacity (503) | "It shows the last saved summary with its time, or tells you it's unavailable. It never invents one." Move on. |
| Report stays on "Analysing" | Classification queue | "It runs on the server; the scheduler retries anything missed." Show slide 7 instead. |
| Dashboard queue is empty | No open hotspot in that city now | "Nothing open right now, which is also real." Switch city, or open the map. |
| No **Read aloud** button | No voice for that language on this laptop | Skip it; it's hidden on purpose rather than reading with the wrong voice. |
| Wi-Fi fails | — | Present from the PDF; slides 7–10 and 13 have real screenshots and flow charts. |

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

**How do you add a new country?**
One configuration entry: boundary, station network, legal limits, fire region, agencies, languages and time zone.

**What does it cost to run?**
It runs on Firebase App Hosting and pay-as-you-go Google APIs. Paid calls are either operator-only, rate-limited or cached (Gemini summaries per area, population per area, Google history in BigQuery).

**What's next?**
- WhatsApp alerts when a hotspot is confirmed near you.
- An "after" photo when a crew resolves a hotspot.
- Each city's own response targets, instead of our placeholders.

---

## 6. Refreshing the numbers before a later pitch

The numbers on slides 13 and 14 were taken on 29 Sep 2026 and will grow:
- **Station count and table rows:** in the BigQuery console, the dataset `cleanair_analytics` (tables `cpcb_live_readings` and `google_aq_history`).
- **Incident counts:** Firestore → `incidents` (and the `source` field for the automatic ones).
- **Residents near the Temple of Heaven:** open tab 4 and read **Who's affected**.

If a number changes, update the slide text and this script together, so they never disagree.
