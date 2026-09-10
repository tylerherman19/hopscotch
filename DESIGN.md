# Hopscotch UI contract

## Direction
Hopscotch is a Milwaukee transit authority departure system, in the lineage of
SBB/Müller-Brockmann and Vignelli's NYCTA work: flat warm paper, one grotesque
used with discipline, tabular mono for all times, hairline rules, zero
decoration. Light mode only. Authority comes from the system, not styling.
(Deliberately the opposite of the AI-slop starter pack: no gradients, no glow,
no glassmorphism, no pulsing dots, no spring physics, no emoji, no em-dashes.)

## Tokens
- Paper `#f6f4ef`, panel `#fdfcf8`, ink `#16130e`, muted `#6f6a5e`,
  hairline `#e2ddd1` / `#cfc8b8`. No shadows anywhere, ever.
- Radius: 2px max on everything. Pills do not exist.
- Swiss red `#eb0000`: reserved for live/disruption/selection states only.
- Status colors are operational, never decorative: green on-time, amber delayed,
  red disrupted.
- Route colors come from GTFS `route_color` and mean line identity only.
- Type: Archivo (400-800, tight headlines, tracked uppercase micro-labels) +
  IBM Plex Mono with `tabular-nums` for every time, countdown, and metric.

## Layout
- Masthead: 54px bar. Wordmark left, date + feed status as plain mono text
  right (`FEED LIVE · 212 VEHICLES · 12S AGO`), text buttons (SEARCH / BUS / HOP).
  No pills, no pulse dots. Stale feed turns the status text red.
- Board (left column, 400px): hero "next out" as an inverted black block with
  huge mono countdown; at ≤30s it inverts to red (BOARDING). Below: text tabs
  with 2px underline indicators. Departures are flat rows with hairline
  dividers: route square, destination, tabular times (live bright, scheduled
  dimmed). Row click isolates the route.
- Map: CARTO Positron (light). Route lines flat, 3.5px, isolated route full
  opacity / others 30%. Disrupted routes dashed. Vehicles are flat squares in
  route colors with white route numbers and a small bearing tick; stale
  vehicles go hollow at 55%; selected gets a 3px red outline. Stops are 7px
  black squares at zoom ≥ 13.5.
- Disruptions: flat red band under the masthead, white mono text. No stripes.
- Trip rail: flat panel, square station nodes on a hairline, red "here" node.
- Mobile (≤860px): board becomes a bottom sheet (peek 168px / half / full)
  with drag handle; masthead condenses; rows ≥56px; rail becomes a bottom sheet.

## Motion (functional only)
- Vehicles interpolate along GTFS shapes between 30s polls: dead reckoning by
  reported speed + exponential ease to the new fix (~1s). Stopped vehicles hold.
- Countdowns tick in place every second (tabular numerals, no layout shift).
- Data refresh flashes updated rows once (warm 450ms); list is never rebuilt
  on a tick.
- Sheet/panel transitions: 200ms ease-out. No springs, no stagger, no boot
  choreography: instant shell with static skeleton rows.

## States
- Loading: static skeleton rows. Error: `FEED DOWN · LAST UPDATE HH:MM:SS ·
  RETRYING` band with retry. Empty: plain "No departures…" lines. Edge: ghost
  buses and reliability in Intel. Permanent updated stamp in the masthead.

## Copy
- The data is the headline ("14 · 3 min"). No marketing copy, no em-dashes
  (middots/colons), plain verbs (Refresh, Filter, Follow).

## Data contract (do not break)
- `data/static.json` (routes, stops as `[sid,name,lat,lon]`, `stop_routes`,
  `calendar`, `shapes` as `{rid:{dir:pts}}`, `hop`, `tindex`), `data/tt-*.json`
  (`{rid:{stops,headsign,services,trips}}`, trip =
  `[tripId, svcIdx, patternKey, deltas]`, deltas[0] = sec since central midnight,
  deltas[i] = sec since previous stop), `data/hotroutes.json` ship with the page.
- `data/live.json` + `data/summary.json` from the `data` branch via
  raw.githubusercontent.com. Vehicle:
  `{id, trip, route, lat, lon, bearing, speed, delay, next:[{stop, at, in, name}]}`.
  Stop predictions: `stops[stopId] = [[route, in_sec, at_epoch, trip_id], ...]`.
