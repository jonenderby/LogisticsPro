# Roadmap and known gaps

What is built and tested is described in the README. This is what remains before a production launch, roughly in priority order.

## Must have before real customers
- **Database at scale.** Postgres persistence, multiple servers, indexes, archiving of finished loads and record locks are built (see [ARCHITECTURE.md](ARCHITECTURE.md)). Each server keeps what is in play in memory: active loads and roughly four months of finished ones. Load test with production volumes before launch; past tens of thousands of active loads, read loads per request from their own table instead of keeping them in memory.
- **Carrier onboarding and certification.** The catalog seeds methods per carrier, but each carrier still needs credentials (API keys or OAuth clients stored as secrets), its exact field names as a field map, and EDI test cycles against its implementation guide. Start with the carriers your first customers use.
- **EDI connectivity.** AS2 is built in (central station, signed and encrypted, synchronous MDNs). Still to do: asynchronous MDNs, AS2 compression, certificate-exchange messages, and a native SFTP/VAN client (today those go through an outbox directory).
- **Map servers.** Run Valhalla and Nominatim (or Pelias) with the full North America extract; see [NAVIGATION.md](NAVIGATION.md).
- **Secrets management.** Partner credentials resolve from `LP_SECRET_*` environment variables, and ELD keys are encrypted in the database. Move both to a secrets manager with key rotation.
- **Device testing and store builds.** The app is typechecked, bundled for iOS and Android, and exercised on web, and `eas.json` has preview and production profiles (see [DEPLOYMENT.md](DEPLOYMENT.md)). It still needs an EAS project, Apple and Google push credentials, testing on physical phones, App Store and Play Store listings, and a Google Maps key for Android.

## Website
- Desktop-first screens for heavy office work: bulk load entry or CSV import, and a dispatch board with drag-and-drop driver assignment.
- Content Security Policy headers tuned to the exported bundle.

## Driver experience
- A native document scanner (edge detection and de-skew) in place of the cropped photo; needs a development build.
- Push notifications for corridor violations (tenders, messages and arrival alerts already push).
- Web push for the website while it is closed (needs VAPID keys and a service worker).
- CarPlay and Android Auto.
- Live traffic in arrival estimates (Valhalla route times are used; they have no traffic).
- Address type-ahead while typing stops (search exists; the New load form does not use it yet).
- More ELD providers (Omnitracs, Verizon Connect, J.J. Keller) behind the same adapter, and testing the three built adapters against live accounts.
- Split sleeper-berth pairings, the adverse driving conditions extension and the short-haul exception in the hours clock.
- Offline queueing of status updates in poor coverage.

## Oversize and overweight
- Import permit routes directly from state permit systems and restriction data (bridge clearances, posted weights) from a map data provider.
- Escort vehicle tracking alongside the load.

## Reliability
- Count reliability for external carriers reached by EDI or API (today only carriers on the platform get profiles).
- Let customers weigh the three metrics differently, and add claims amounts and tender acceptance rate.

## Business
- Moving money: ACH payouts, reading EDI 820 remittance advice, and driver settlement. Invoice status, quick pay and factoring are built; payments are recorded, not sent.
- Commercial carrier monitoring (insurance certificates from insurers, identity verification) behind the FMCSA vetting interface.
- Equipment registry (tractors, trailers) and maintenance.
- Rate quote and pickup request flows in the app (the engine supports both transactions; the screens are not built yet).
- Email invitations for team members (today members must already have an account).
- Audit log and role-based permissions finer than the current roles.
