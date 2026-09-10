# Hopscotch UI contract

## Direction
Hopscotch is Milwaukee's live transit console: a full-bleed dark map with floating
glass panels, built around the question "what leaves next from Helen's corner?"
The visual language is an ops console, not a brochure — subordinate dark basemap,
transit data as the brightest layer, continuous motion as the liveness signal.
Dark theme is the default and only theme.

## Reference extraction
Rebuilt Sep 2026 from a benchmark pass over MTA Live Subway Map (Work & Co),
Transit App, TfL Go, Google Maps transit, Amtrak Track-a-Train, and indie
dashboards (mta-subway-feed, hatsmagee/bus-tracker). Research notes live outside
this repo; the stealable patterns implemented here are listed under Motion.

### Colors by job
- Canvas: `#05080e`, near-black with a blue undertone, behind everything.
- Panel glass: `rgba(11,17,28,.72)` + 16px blur + 1px `rgba(160,195,240,.14)` border.
- Ink: `#e9eff9`. Muted: `#8f9bb0`. Dim: `#5d6a82`.
- Accents come from GTFS `route_color` — the network colors the UI, not a brand gradient.
- Signal colors: `#ffb224` boarding/attention, `#ff5d5d` disruption, `#3ddc97` live/on-time, `#2f7cf6` interactive blue.

### Type
- UI: Space Grotesk (400/500/600/700).
- Times, countdowns, data: IBM Plex Mono with `tabular-nums`.
- Live-vs-scheduled is a brightness language: live countdowns are bright with a
  pulsing dot; scheduled times are dimmed/dashed. Never render scheduled with
  live confidence.

### Layout
- Desktop: full-bleed map; top bar (brand + freshness pill + layer toggles);
  left floating panel with tabs (Departures / My trips / Intel); right trip rail
  on vehicle/stop selection; disruption banner top-center; sticky ETA pill while
  following a vehicle. Never cover the map's center with chrome.
- Mobile: the panel becomes a bottom sheet with three detents
  (peek 148px / half / full), drag handle + tap to cycle.

### Components
- Freshness pill: `● LIVE · N vehicles · updated Ns ago`, ticking every second;
  dot green <90s, amber <5min, red beyond. Cheapest trust-builder in the product.
- Hero "Next out": the single soonest departure across Helen's anchor stops;
  under 2 min the countdown becomes a seconds ticker (`1:34`); at ≤30s the card
  inverts to a BOARD state. A draining time-rail sits under it.
- Board rows: one per route near Helen, grouped by direction → destination
  (TfL pattern). Next 3 departures as chips — nearest filled, rest outlined,
  scheduled dashed-dim. Delay chip per route (`on time` / `+N min`).
- Vehicle markers: route-colored pins with direction chevrons; selected vehicle
  gets an expanding pulse ring; stale vehicles (>2 min no GPS) ghost to 30%
  with a dashed ring and stay on the map — never delete, deletion reads as a bug.
- Route isolation: click a board row to isolate — its line goes full brightness,
  everything else dims to ~12%. `1–9` hotkeys, `Esc` clears, `/` searches stops.
- Trip rail: vertical station progress with glowing position node, per-stop
  countdowns, stops-away + ETA counters, follow mode with damped camera and a
  sticky ETA pill.
- Disrupted routes render dashed on the map with a slim banner; alerts,
  ghost buses, and reliability bars live in the Intel tab.

## Motion
- One rAF loop: vehicles advance along GTFS shape polylines by dead reckoning
  (reported speed) between 30s polls; new data retargets with an exponential
  ease (~1s), never a snap. Stopped vehicles hold — no drift, no reversing.
- Boarding transitions: row background fill expands, row promotes to top.
  Data refreshes update values in place with a 500ms value-flash; the list is
  never fully re-rendered on a tick.
- Boot: 650ms choreography — overlay fades, top bar drops in, panel slides up,
  vehicles pop with stagger.
- Springs (`cubic-bezier(0.34,1.45,0.44,1)`) for panels/sheets; 150–250ms
  ease-out micro-interactions; `prefers-reduced-motion` disables smoothing and
  choreography.

## Data contract (do not break)
- `data/static.json`, `data/tt-*.json`, `data/hotroutes.json` ship with the page (main branch).
- `data/live.json` + `data/summary.json` are read from the `data` branch via
  raw.githubusercontent.com — the collector owns them; the page never touches feeds.
- Vehicle: `{id, trip, route, lat, lon, bearing, speed, delay, next:[{stop, at, in, name}]}`.
- Stop predictions: `stops[stopId] = [[route, in_sec, at_epoch, trip_id], ...]`.
