# Hopscotch

Milwaukee, live: real-time MCTS buses and The Hop streetcar, in your pocket.

**https://tylerherman19.github.io/hopscotch/**

## How it works

Hopscotch is a static site. The browser reads agency snapshots and renders them. It polls every 15 seconds while visible; the collector normally publishes about every 30 seconds. GitHub Actions scheduling and upstream feed delays can create gaps. The app expires live predictions and positions after three minutes, then uses explicitly labeled timetable departures.

| File | Branch | Written by | Contents |
| --- | --- | --- | --- |
| `data/static.json` | `main` | `build_static.py` | Routes, stops, per-direction shapes, service calendar, Hop lines |
| `data/hotroutes.json` | `main` | by hand | Public route examples (Marquette, lakefront) as stop-to-stop legs |
| `data/tt-*.json` | `main` | `build_static.py` | Per-route timetable packs |
| `live.json` | `data` | `collector.py` | Vehicle positions, stop predictions, service alerts |

`collector.py` runs on a schedule in GitHub Actions, polls the MCTS GTFS-Realtime
feeds and the Hop TransLoc API, and commits the result to the orphan `data`
branch. The site fetches that file directly from `raw.githubusercontent.com`, so
a collector outage degrades to a stale-feed notice rather than a broken page.

## The site

| File | Role |
| --- | --- |
| `index.html` | The whole app shell: Home, Map, tab bar, SVG icon sprite |
| `styles.css` | Design tokens and every component style |
| `app.js` | Data loading, rendering, map, and interaction |
| `system.html` | Legacy entry point that redirects to the map |

## Running it locally

```sh
python3 -m http.server 8000
```

Then open <http://localhost:8000/>. The page pulls `live.json` from the `data`
branch over the network, so local development shows real current data.

## Rebuilding the static data

```sh
curl -o /tmp/gtfs.zip https://kamino.mcts.org/gtfs/google_transit.zip
python3 build_static.py /tmp/gtfs.zip
```

This rewrites `data/static.json` and `data/tt-*.json` in place. Commit the
result to `main`; the collector reads these files on its next run.

## Personal transit features

- Save any bus or streetcar stop to a departure board on Home. Saves stay on this device.
- Search route numbers, stop names, or stop IDs. Open a route to save it or choose one of its stops.
- Switch the public Marquette and lakefront route examples between outbound and return trips. Predictions must serve the boarding stop **before** the destination; return trips use the opposite-side stop IDs.
- Open Nearby to see stops within 1.5 km of the map center. The location button centers the map on your location after browser permission.
- Follow a bus or streetcar's reported GPS position. Positions are never extrapolated beyond the agency report. A missing signal does not confirm a cancellation.
- Route lines show published alignments, which may differ during detours. Service alerts retain closed-stop details; consult the linked agency information when data is unavailable.

The map uses the bundled Leaflet 1.9.4 renderer, OpenStreetMap data and standard raster tiles, so it does not require WebGL. A map-tile outage does not prevent searching for departure boards.

## Data correctness

`transit.js` handles Central-time service dates (including after-midnight GTFS times), explicit calendar exceptions, destination eligibility, cancellation/skipped-stop suppression and live/schedule merging by trip instance. Schema-2 snapshots separate realtime predictions from timetable fallback. If a raw branch URL serves stale data, the browser resolves the current data commit through GitHub at most once per 90 seconds and fetches that immutable snapshot. A cached older snapshot never replaces newer data. Legacy mixed snapshots are treated as schedule-only.

The collector preserves independent source timestamps and partial failures. The Hop's `VehicleEstimates` are live predictions; its `ScheduledTimes` remain labeled scheduled. Streetcar predictions are attached to stops, never to an unrelated selected car.

The timetable builder retains all trip patterns and per-trip destinations, including short turns and branches. The daily **Refresh published timetables** workflow refreshes the agency GTFS data. Dates outside the published calendar show a warning instead of guessing weekday service. GitHub Actions may delay scheduled jobs; it is not a guaranteed always-on backend.

## Checks

```sh
npm ci
npm test
pip install gtfs-realtime-bindings protobuf
python3 -m unittest discover -s tests -v
python3 -m py_compile collector.py build_static.py
```

CI runs the same checks for pull requests. The collector's existing SMS watches are preserved; no new notification subscriptions are created by the app.

## Transit-inspired rider experience

The **Nearby** screen puts direction-specific arrivals first. Agency route colors, large countdowns and explicit live/scheduled labels make the next ride easy to scan. Use the location button to recenter discovery; it never requests location automatically. The default is clearly identified as Downtown Milwaukee.

The **Plan** screen searches bus/streetcar stops and a small set of public destination anchors. Pick both suggestions before planning. It supports direct MCTS journeys, one-transfer MCTS journeys (including short walks between stops), and direct Hop journeys when the same live streetcar is reported at both stops. It does not include arbitrary address geocoding or multi-transfer routing. Walking is a distance-based estimate, not a routed pedestrian path.

`journey.js` checks service dates, stop order, boarding access time, cancellations, skipped stops, real-time updates and a two-minute connection buffer in addition to transfer walking time. Unreported arrival times remain explicitly estimated. The planner refreshes open results as new snapshots arrive. Save journeys on this device and reopen them to calculate new departure options.

Route details now have direction selection and stops in travel order. Every stop board can become the start or destination of a trip. On wider screens, Nearby and Plan appear alongside the live map; on phones, the three views remain separate full-screen pages.
