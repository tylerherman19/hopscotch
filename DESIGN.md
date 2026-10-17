# Hopscotch UI contract

## Source and direction

The October 17, 2026 request to bring Hopscotch closer to Transit is the current product direction. Preserve Hopscotch's own identity while adopting a nearby-first arrival board, large readable departure times, agency route colors, a prominent destination entry point and clear mobile navigation.

Three views: Nearby, Map, Plan. Nearby prioritizes actual route/direction arrivals, followed by device-saved stops and journeys. On desktop, discovery and planning sit alongside the live map. Service updates remain part of Nearby.

Use a warm white surface, dark green ink, a restrained lime action color and system typography. Colored route badges identify real services. Route details list stops in travel order and offer an explicit direction selector.

## Data honesty
Use `data/static.json` + `data/hotroutes.json` and the `data` branch's
`live.json`. Never replace a live arrival, route, stop, alert, or vehicle
position with a mock value. Where the feed carries nothing, the interface says
so ("No bus to follow", "No live departures", scheduled times labelled
"Scheduled").

Freshness uses agency and per-vehicle timestamps, never the time a snapshot was downloaded. Reports older than three minutes are removed from the live display. Between reports, markers stay at the last reported GPS coordinates. Trip headsigns come from the exact static trip when available.

The October 2026 reliability update adds personal stop boards, route shortcuts, always-visible commute direction controls and readable scheduled fallback. The map uses a raster renderer so WebGL failure cannot strand the user on a blank map.

## Interface rules
- **No emoji and no typographic dingbats as iconography.** Every icon is an
  SVG symbol defined once in the sprite at the top of `index.html`.
- **No dead controls.** A control that cannot do its job is removed, or is
  disabled with a label that explains why.
- Times use tabular figures so digits do not shift as they tick.
- Colour, radius, shadow and easing come from the tokens at the top of
  `styles.css`. Components do not hard-code palette values.
- GTFS's ALL-CAPS stop and headsign strings are title-cased for display.
- Motion is suppressed under `prefers-reduced-motion` and the Reduce motion
  setting.

## Journey planning

Journeys are computed from service calendars and the exact stop order/times of published trips, supplemented by fresh reported predictions. Bus options are direct or have one transfer with a two-minute buffer plus estimated walking between stops up to 180 m apart. Direct Hop options require matching live vehicle estimates at both stops on the same line. Do not synthesize streetcar schedules or promise alighting alerts.

Walking access uses distance-based estimates and must be labelled approximate. A reported boarding estimate does not make a derived arrival a live prediction. Saved journeys are stored only in this browser; never commit personal starting points, destinations or labels to the repository.
