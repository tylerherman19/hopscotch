# Hopscotch UI contract

## Source
The September 15, 2026 three-screen Today / Map / Details mockup supplied by
Tyler is the visual source of truth.

## Direction
Light iOS-native transit utility. Navy type, electric-blue route emphasis,
white cards, soft shadows, restrained green status. Today prioritises one next
departure, Map prioritises live vehicles, Details prioritises upcoming arrivals
and route actions.

## Data honesty
Use `data/static.json` and the `data` branch's `live.json`. Never replace a live
arrival, route, stop, alert, or vehicle position with a mock value. Where the
feed carries nothing, say so in the interface rather than showing a placeholder
that reads like data. Unsupported features must state that they are unavailable.

Two values on screen are derived rather than read directly, and both come from
live fields:

- **Direction assignment.** A vehicle is placed on one of a route's two
  alignments by comparing its reported `bearing` against the local tangent of
  each shape. A vehicle with no usable heading appears on both.
- **Direction label.** "Toward *X*" names the stop nearest the end of that
  direction's GTFS shape.

## Interface rules
- **No emoji and no typographic dingbats as iconography.** Every icon is a
  stroked SVG symbol defined once in the sprite at the top of `index.html` and
  referenced with `<use>`.
- **No dead controls.** A control that cannot do its job is removed, or is
  disabled with a label that explains why.
- Times are set in tabular figures so digits do not shift as they tick.
- Colour, radius, shadow and easing come from the tokens at the top of
  `styles.css`. Components do not hard-code palette values.
- Dark mode is a first-class theme, driven by `prefers-color-scheme`.
- Every interactive element has a visible `:focus-visible` ring, and motion is
  suppressed under `prefers-reduced-motion`.
