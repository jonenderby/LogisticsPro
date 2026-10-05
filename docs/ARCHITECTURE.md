# Architecture

## The idea in one picture

```
 Shipper ERP ──┐                                   ┌── Carrier TMS / ERP
 (JSON, XML    │      ┌────────────────────────┐   │   (JSON, XML or EDI)
  or EDI)      ├────► │   Logistics Pro hub    │ ◄─┤
 3PL TMS ──────┘      │  one canonical record  │   └── Off-platform carriers
                      │  per load, invoice,    │       (Estes API, R+L EDI, ...)
 Mobile app ────────► │  status and message    │
 (driver, dispatcher, └────────────────────────┘
  shipper, owner-operator)
```

Every business integrates once, with the hub. The hub translates between the canonical record and whatever each party wants. When both parties are on Logistics Pro they share the same load record, so nothing needs to be transmitted for them to see the same data. Transmission only happens to systems that asked for it.

## Packages

### `packages/domain`
Plain TypeScript plus zod, with no Node-only imports, so it runs on the server and inside the mobile app.

- **Load lifecycle**: `DRAFT → POSTED → TENDERED → BOOKED → DISPATCHED → AT_PICKUP → IN_TRANSIT → AT_DELIVERY → DELIVERED → INVOICED` (or `CANCELLED`). Status events move the lifecycle; drivers may skip intermediate taps.
- **Refinement lock**: the shipper or broker can change stops, freight, references, equipment and notes until the driver reports `LOADED` or the shipper issues a ship confirm. Changes after a carrier is assigned go out as a 204 with purpose *change*.
- **Relays**: `planRelay` inserts relay stops and cuts the trip into legs. Each leg has its own driver or team. `RELAY_HANDOFF` completes one leg and starts the next.
- **Teams**: team-expedited loads refuse solo assignments and solo bids. `estimateTransit` compares solo hours-of-service (11 h driving, 30-minute break, 10 h reset) with a team.
- **LTL consolidation**: `planConsolidation` routes LTL loads through a carrier distribution center, groups them by destination 3-digit ZIP, bin-packs trailers by weight and linear feet, and orders deliveries by nearest neighbor.
- **Bids and invoices**: award one bid and reject the rest; build invoices from the agreed rate plus fuel and accessorials.
- **Arrival estimates**: `shipmentEta` estimates arrival at the final delivery from the truck's last position, the stops still ahead and hours-of-service, prefers a recent carrier ETA, and classifies the shipment as late, at risk, on time or early with reasons. See [TRACKING.md](TRACKING.md).

### `packages/integration`
- **Canonical transactions**: `LOAD_TENDER`, `TENDER_RESPONSE`, `SHIPMENT_STATUS`, `FREIGHT_INVOICE`, `RATE_QUOTE`, `PICKUP_REQUEST`. One zod schema each. Required fields are listed by `fieldPaths()` and served at `GET /v1/integrations/transactions`.
- **Renderers**: JSON (with optional per-partner field map), XML (same field map, schema-guided parsing), X12 4010 (204, 990, 214, 210, and 997 acknowledgments). Every method parses back to the identical canonical document; the tests prove it for all four EDI-capable transactions.
- **Profiles**: a `PartnerProfile` belongs to one business and says, per transaction, which method, endpoint, auth (secret *references*, never secrets) and transport to use. A business's own `receiving` profile tells everyone on the platform how it wants to receive data.
- **Transports**: HTTPS with retry and OAuth client-credentials; **AS2** (`src/as2`: S/MIME signing and encryption with node-forge, signature verification with Node's crypto, MDNs and MIC checks); an outbox for SFTP/VAN gateways; and an in-memory transport for development. See [EDI_AS2.md](EDI_AS2.md).

- **Reliability**: `shipmentOutcome` scores each delivered shipment (on-time pickup, on-time delivery, damage-free); `driverReliability` and `carrierReliability` roll them over windows that scale with the carrier's trucker count. See [NETWORK_AND_RELIABILITY.md](NETWORK_AND_RELIABILITY.md).
- **Network**: join-code format and join requests.

### `packages/navigation`
- `ValhallaProvider` asks a Valhalla server for a truck route that respects height, width, length, weight and hazmat. `StaticProvider` draws straight lines for demos.
- `StandardNavigationSession` snaps GPS fixes to the route, announces maneuvers, and requests a reroute after three off-route fixes.
- `OversizeNavigationSession` treats the permit route as the only route. It warns when the truck drifts toward the corridor edge, logs a violation and notifies dispatch (and escorts) when it leaves, guides the driver back to the route ahead, detects wrong-way travel, announces restrictions the load cannot clear, and flags travel outside the daylight window. It never reroutes.
- `PeliasGeocoder` / `NominatimGeocoder` turn addresses into coordinates. See [NAVIGATION.md](NAVIGATION.md).
- `checkOversizeTrip` is the pre-trip gate: permits valid at departure, no gaps between state permits, no blocking restriction on the corridor, daylight and weekend rules.

### `packages/workspace`
Turns an account's driver profile and company memberships into capabilities (`DRIVE`, `DISPATCH`, `BID`, `SHIP`, `BROKER`, `INVOICE`, `PAY`, ...). From those it builds:
- **Tabs**: at most four primary destinations plus More, following Apple HIG and Material 3 guidance of 3–5 bottom tabs.
- **Load filters**: Driving, Fleet, Shipments, Brokered, all on one Loads screen.
- **Today feed**: one prioritized list across every hat. An owner-operator sees "Loaded" for the truck they are driving next to "Accept tender" for their company.

## API (`apps/api`)
Fastify. Notable rules:
- **Auth**: registration returns an enrollment token that can only activate TOTP. A session is issued only after a valid authenticator code; 10 single-use recovery codes are shown once. Five failed passwords lock the email for 15 minutes. Refresh tokens rotate on every use and are stored hashed.
- **Visibility**: a load is visible to members of its shipper, broker and carrier orgs, to drivers assigned to any leg, and to carriers while it is posted on the board.
- **Integration hub** (`services/hub.ts`): decides who receives each event and in which format. Inbound partner traffic is authenticated with a per-partner token, and a partner can only touch loads it carries or tendered.
- **Tracking** (`routes/tracking.ts`): drivers' phones report positions; carriers get a fleet view of every driver, shippers and 3PLs get every undelivered shipment with its arrival status. Truck positions are shown to a shipper only while that truck is moving their freight.
- **Notifications** (`services/notify.ts`): every notification lands in an in-app inbox and is pushed to the person's phones in the background. New tenders and tender answers are raised from `saveLoad` and from the integration hub; messages from the message route.
- **Hours of service** (`services/hos.ts`): each driver's duty log and location trail; location fixes switch Driving and On duty automatically, and `hosClock` in the domain package applies the 11, 14, 8 and 60/70-hour rules.
- **Arrival alerts** (`services/alerts.ts`): a once-a-minute check that pushes when a shipment becomes late, at risk, early or on time, and sends scheduled summaries, to people who asked. Pushes go through Expo's push service (`services/push.ts`); everything also lands in an in-app inbox.
- **Persistence** (`persistence/`): routes read and write the in-memory store, whose collections report every change. With `LP_DATABASE_URL` set, `PgPersistence` writes the changes to Postgres in batches, and a response is sent only after its changes are committed. On start everything is loaded back. Records live as JSONB documents keyed by collection, and location trails are rows in an append-only table so a ping never rewrites a whole trail.
- **Several API servers**: after each commit a server announces what changed over Postgres LISTEN/NOTIFY, and the others re-read those records, so every server serves the same data within milliseconds. Concurrent writes to one record resolve to the last commit, and all servers converge on it. A Postgres advisory lock picks one server to run background jobs (arrival alerts, push receipts); if it stops, another takes over within 15 seconds. Load numbers come from blocks reserved through a database sequence, so servers never collide. Sign-in lockouts and join-code limits are shared too. All servers need the same `LP_JWT_SECRET`.

## Website
The website is the same Expo app exported for the browser (`npm run build:web`), not a separate codebase, so every feature lands on phones and the web together.
- **Layout**: below 900 px wide it matches the phone app. Above that it switches to a sidebar listing every destination (the phone's More overflow included), centers content at a readable width, shows loads as a table and the Today feed as a grid.
- **URLs**: every screen has a path (`/loads`, `/loads/load/:id`, `/load/:loadId/messages`, `/business/integrations`, ...). Browser back, forward, reload and bookmarks work. The same paths open the phone app through the `logisticspro://` scheme.
- **Sessions**: in the browser the refresh token is an httpOnly, SameSite=Strict cookie scoped to `/v1/auth` (Secure in production). The access token stays in memory. Credentialed CORS is allowed only for origins listed in `LP_WEB_ORIGINS`.
- **Hosting**: with `LP_WEB_DIR` set, the API serves the site at `/` with long-lived caching for hashed assets, falls back to `index.html` for deep links, and keeps `/v1` 404s as JSON. Pages get `X-Frame-Options: DENY` and `nosniff`.
- **Dialogs**: React Native's `Alert` does nothing in a browser, so confirmations and messages go through `ui/dialog.ts`, which uses native dialogs on phones and the browser's on the web.

## Mobile (`apps/mobile`)
Expo SDK 57, React Navigation (native stacks inside bottom tabs), expo-secure-store for the refresh token, expo-location and react-native-maps for navigation, expo-symbols for SF Symbols on iOS and Material Symbols on Android. The tab bar and Today feed come from `GET /v1/me`, so the same build serves a company driver, an owner-operator, a dispatcher, a shipper and a broker. The navigation screen runs the same navigation package as the server. Tracking maps use react-native-maps on phones and Leaflet on the website (`ui/FleetMap.tsx` and `ui/FleetMap.native.tsx`). While a driver has a load, `state/useLocationSharing.ts` reports their position about once a minute.
