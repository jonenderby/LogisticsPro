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

### `packages/integration`
- **Canonical transactions**: `LOAD_TENDER`, `TENDER_RESPONSE`, `SHIPMENT_STATUS`, `FREIGHT_INVOICE`, `RATE_QUOTE`, `PICKUP_REQUEST`. One zod schema each. Required fields are listed by `fieldPaths()` and served at `GET /v1/integrations/transactions`.
- **Renderers**: JSON (with optional per-partner field map), XML (same field map, schema-guided parsing), X12 4010 (204, 990, 214, 210, and 997 acknowledgments). Every method parses back to the identical canonical document; the tests prove it for all four EDI-capable transactions.
- **Profiles**: a `PartnerProfile` belongs to one business and says, per transaction, which method, endpoint, auth (secret *references*, never secrets) and transport to use. A business's own `receiving` profile tells everyone on the platform how it wants to receive data.
- **Transports**: HTTPS with retry and OAuth client-credentials, an outbox for AS2/SFTP/VAN gateways, and an in-memory transport for development.

### `packages/navigation`
- `ValhallaProvider` asks a Valhalla server for a truck route that respects height, width, length, weight and hazmat. `StaticProvider` draws straight lines for demos.
- `StandardNavigationSession` snaps GPS fixes to the route, announces maneuvers, and requests a reroute after three off-route fixes.
- `OversizeNavigationSession` treats the permit route as the only route. It warns when the truck drifts toward the corridor edge, logs a violation and notifies dispatch (and escorts) when it leaves, guides the driver back to the route ahead, detects wrong-way travel, announces restrictions the load cannot clear, and flags travel outside the daylight window. It never reroutes.
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
- **Persistence**: `MemoryStore` is a set of maps behind one class, so a database-backed store can replace it without touching routes.

## Mobile (`apps/mobile`)
Expo SDK 57, React Navigation (native stacks inside bottom tabs), expo-secure-store for the refresh token, expo-location and react-native-maps for navigation, expo-symbols for SF Symbols on iOS and Material Symbols on Android. The tab bar and Today feed come from `GET /v1/me`, so the same build serves a company driver, an owner-operator, a dispatcher, a shipper and a broker. The navigation screen runs the same navigation package as the server.
