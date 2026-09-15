# Hopscotch UI contract

## Source
The September 15, 2026 three-screen Today / Map / Details mockup supplied by Tyler is the visual source of truth.

## Direction
Light iOS-native transit utility. Navy type, electric-blue route emphasis, white cards, soft shadows, restrained green status. Today prioritizes one next departure, Map prioritizes live vehicles, Details prioritizes upcoming arrivals and route actions.

## Data
Use `data/static.json` and the data branch `live.json`. Never replace live arrival, route, stop, alert, or vehicle-position values with mock values. Unsupported notification actions must say they are unavailable.
