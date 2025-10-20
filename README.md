# Toronto BikeShare Station Network — A4 Project

## 1) Introduction: Dataset and Goals (~1 min)
This project visualizes Toronto’s Bike Share ridership using monthly 2023 trip data (CSV files in /data and /sample-data). Each file contains trip-level records with information such as start/end station, time, and member type (Annual vs. Casual). The goal is to help readers:
- Understand spatial relationships in the station network (popular origins/destinations and flows).
- Compare demand by time (all months vs. a selected month).
- Contrast usage patterns by membership type.

Why this matters: bike share is a critical part of urban mobility. Identifying high-demand stations, seasonal peaks, and member behaviors can inform rebalancing, expansion planning, and targeted outreach to increase sustainable, equitable transport.

## 2) Demonstration of the A4 project so far (~1 min)
What’s implemented now:
- Interactive map (D3) of the station network with zoom controls (+/−) and a back button to return from detail view.
- Tooltip and route details on interaction, surfacing station-level insights.
- Controls to filter by member type (All, Annual, Casual).
- A "By Month" toggle that enables a month slider (1–12) with a dynamic label.
- Top 25 Starting Stations table that updates with filters, showing trips started/ended/total.
- A Data Load Debug panel (using sample dataset) that lists files, months, row counts, and column checks to validate data quality and schema alignment.

How to run locally:
- Option A (recommended): serve the folder with a simple static server, then open http://localhost:PORT
  - Examples: `npx http-server .` or `python3 -m http.server`
- Option B: open index.html directly in a modern browser (some features that fetch local files may require a local server, depending on your browser’s security settings).

Project entry point and assets:
- index.html — markup and UI scaffolding
- script.js — data loading, transformation, rendering, and interactions
- style.css — layout and visual styling
- data/ — full-year 2023 monthly CSVs
- sample-data/ — reduced CSVs for rapid iteration; includes its own README

## 3) Key design decisions and rationale (~1–1.5 mins)
Data preparation and quality checks:
- Chose monthly CSVs to keep loading responsive and allow per-month filtering without a large, monolithic file.
- Built a Data Load Debug table to quickly verify column presence and row counts when switching between sample and full datasets.
- Basic cleaning includes filtering malformed rows and standardizing column names where needed (see scripts/make-sample-data.js for sample generation logic).

Visual encodings:
- Nodes/links on the map communicate the station network and trip flows; station prominence reflects aggregated activity (starts/ends/total).
- Color/labels emphasize membership filters and temporal state (All months vs. a selected month) to maintain context.
- A ranked table complements the map to make “top stations” explicit and scannable, supporting both overview and exact lookup tasks.

Interaction model:
- Toggle + slider: separates the cognitive load of “time on/off” from the specific month selection, making the control self-explanatory.
- Member type radios: mutually exclusive states that are easy to compare by switching.
- Tooltips and a detail panel reveal additional information on demand without cluttering the primary view.
- Zoom controls and a "Back" affordance help users recover from navigational dead ends.

Alternatives considered / in progress:
- Temporal animation scrubbing to show month-by-month change over time (deferred to avoid motion overload before establishing stable encodings).
- Small multiples by season or quartiles instead of a slider; may add as a comparison mode if screen space allows.
- Flow bundling or edge aggregation to reduce visual clutter on dense routes; assessing performance and readability trade-offs.
- Choropleth overlays (e.g., by ward or neighborhood) to align station activity with administrative boundaries; requires additional boundary data.

Early EDA takeaways (with sample/full data):
- Strong seasonality (peaks in warmer months) and distinct member behavior: Annual members skew toward commute-like patterns; Casual users show more weekend/leisure activity. This motivated the member-type filter and the “Top Starting Stations” focus to capture commuter hubs.

## 4) Questions for peer critique (~30 secs)
- Does the current map + table pairing balance overview and detail, or does one dominate? What would you change?
- Are the time controls (By Month toggle + slider) intuitive, or would you prefer always-on slider or presets (seasons, quarters)?
- For membership comparison, would side-by-side small multiples be more effective than a toggle?
- What additional context (e.g., weather, events, transit hubs) would most improve interpretability without overwhelming the UI?
- Are there specific interactions (e.g., highlighting connected stations on hover) you expect but don’t see yet?

---

If you’re reviewing this project, please start by running a local server, exploring the member and month filters, and scanning the Top 25 Starting Stations table. Notes and suggestions on clarity, performance, and alternative encodings are very welcome.