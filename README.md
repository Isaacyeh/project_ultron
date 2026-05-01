# project_ultron

## Map selection

Map loading now supports map IDs.

- Map registry: `/public/assets/maps.json`
-- Map configs: `/public/assets/maps/map_1.json`, `/public/assets/maps/map_2.json`

Use either query parameter to pick a map:

-- `?map=map_1`
-- `?map=map_2`
- `?mapId=map_2`

If an unknown map id is provided, the app falls back to the default map in `maps.json`.