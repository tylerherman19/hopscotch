# Hopscotch

Live Milwaukee transit: every county bus and Hop streetcar on one map, with
arrival predictions read straight from the public feeds.

**https://tylerherman19.github.io/hopscotch/**

## How it works

Hopscotch is a static site. There is no backend at request time — the page
reads two snapshots and renders them.

| File | Branch | Written by | Contents |
| --- | --- | --- | --- |
| `data/static.json` | `main` | `build_static.py` | Routes, stops, per-direction shapes, service calendar, Hop lines |
| `data/tt-*.json` | `main` | `build_static.py` | Per-route timetable packs, balanced across eight files |
| `live.json` | `data` | `collector.py` | Vehicle positions, stop predictions, service alerts |

`collector.py` runs on a schedule in GitHub Actions, polls the MCTS GTFS-Realtime
feeds and the Hop TransLoc API, and commits the result to the orphan `data`
branch. The site fetches that file directly from `raw.githubusercontent.com`, so
a collector outage degrades to a stale-feed notice rather than a broken page.

## The site

| File | Role |
| --- | --- |
| `index.html` | The whole app: Today, Map and Alerts |
| `styles.css` | Design tokens and every component style, light and dark |
| `ios-app.js` | Data loading, rendering, map, and interaction |
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
