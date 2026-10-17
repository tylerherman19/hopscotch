# Hopscotch UI contract

## Source
The September 21, 2026 two-screen Home / Map mockup supplied by Tyler is the
visual source of truth ("Needs to be this. Fully go."). The earlier
September 15 mockup is superseded. No Alerts tab: saved routes live on Home
and MCTS service updates fold into Home as their own section.

## Direction
Light iOS-native transit utility. White background, iOS system type, one green
(live times + healthy status), one blue (buttons, links, route lines), red for
late, yellow star for saved. Home prioritises his saved routes; Map prioritises
live vehicles.

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
