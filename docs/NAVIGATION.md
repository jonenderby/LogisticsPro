# Navigation and addresses

## What Valhalla is

[Valhalla](https://github.com/valhalla/valhalla) is an open-source routing engine built on OpenStreetMap data. It is what draws the route and gives turn-by-turn directions. Its **truck** mode is why we use it: you tell it the truck's height, width, length, weight, axles and whether it carries hazmat, and it avoids roads and bridges the truck cannot legally use.

Logistics Pro calls Valhalla through `ValhallaProvider` (`packages/navigation/src/providers.ts`). Without a Valhalla server the app falls back to straight lines between stops, which is only good for demos.

**Verified here:** I built Valhalla routing tiles from a small synthetic map with a 3.5 m (11'6") bridge and ran the real Valhalla server against our provider. A 3.0 m truck took the bridge (3.3 km). A 4.1 m truck, a standard 13'6" trailer, was sent around it (5.8 km). The test is `packages/navigation/test/valhalla.live.test.ts`; the map and steps are in `deploy/valhalla-test-map`.

## Addresses

Valhalla needs coordinates. **Geocoding** turns a typed address into coordinates. Logistics Pro supports two open-source geocoders:

| Geocoder | Notes |
|---|---|
| **Nominatim** (default in `deploy/docker-compose.yml`) | OpenStreetMap's geocoder, one container. Self-host it: the public nominatim.openstreetmap.org service forbids bulk or commercial-scale use. |
| **Pelias** | Better type-ahead and address interpolation, more services to run. Also available hosted (e.g. Geocode Earth) through the same API. |

Set `LP_GEOCODER=nominatim` or `pelias` and `LP_GEOCODER_URL`. With a geocoder configured:
- New loads, stop changes, relay points and distribution centers get coordinates from their addresses automatically. If an address can't be found, the load is still created and the response lists which stop needs attention.
- `GET /v1/geocode?q=...` powers address search in the app.
- Drivers can **navigate to any address** (fuel, parking, a shop) from the Navigate screen. Oversize loads are refused: they stay on the permitted route.

Commercial truck-routing and geocoding APIs (HERE, Trimble/ALK, Google, Mapbox) can be added behind the same `RoutingProvider` and `Geocoder` interfaces if you prefer to pay per request instead of running servers.

## Setting it up

`deploy/docker-compose.yml` runs the API with Valhalla and Nominatim:

```bash
cd deploy
LP_JWT_SECRET=$(openssl rand -hex 32) docker compose up -d
```

By default it loads the Delaware map extract so the first start takes minutes. For production, set `MAP_PBF_URL=https://download.geofabrik.de/north-america/us-latest.osm.pbf` and `MAP_UPDATES_URL=https://download.geofabrik.de/north-america/us-updates/`. Plan for roughly:

| | Valhalla (US) | Nominatim (US) |
|---|---|---|
| First build | a few hours | one to two days |
| Memory | 16–32 GB while building | 32–64 GB recommended |
| Disk | tens of GB | 200 GB or more |

These are estimates from the projects' guidance; North America or Canada and Mexico add proportionally. Valhalla serves from its built tiles afterwards and needs far less memory. Nominatim keeps itself current with `MAP_UPDATES_URL`; rebuild Valhalla tiles on a schedule (weekly is common) to pick up road changes.

**Not validated here:** the container images could not be pulled in this environment (registry rate limits), so the compose file has not been started end to end. The Valhalla engine and our provider were tested directly as described above.
