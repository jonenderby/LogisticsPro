# Roadmap and known gaps

What is built and tested is described in the README. This is what remains before a production launch, roughly in priority order.

## Must have before real customers
- **Database.** The API stores everything in memory and loses it on restart. Replace `MemoryStore` with PostgreSQL (loads as JSONB with indexed columns for status, parties and load number), and keep the transmission log for audit.
- **Carrier onboarding and certification.** The catalog seeds methods per carrier, but each carrier still needs credentials (API keys or OAuth clients stored as secrets), its exact field names as a field map, and EDI test cycles against its implementation guide. Start with the carriers your first customers use.
- **EDI connectivity.** AS2 is built in (central station, signed and encrypted, synchronous MDNs). Still to do: asynchronous MDNs, AS2 compression, certificate-exchange messages, and a native SFTP/VAN client (today those go through an outbox directory).
- **Map servers.** Run Valhalla and Nominatim (or Pelias) with the full North America extract; see [NAVIGATION.md](NAVIGATION.md).
- **Secrets management.** Partner credentials resolve from `LP_SECRET_*` environment variables. Move them to a secrets manager.
- **Device testing and store builds.** The app is typechecked, bundled for iOS and Android, and exercised on web. It still needs EAS builds, testing on physical phones, App Store and Play Store listings, and a Google Maps key for Android.

## Website
- Desktop-first screens for heavy office work: bulk load entry or CSV import, and a dispatch board with drag-and-drop driver assignment.
- Content Security Policy headers tuned to the exported bundle.

## Driver experience
- Camera document scanning for BOL and POD (today a document is added by link).
- Push notifications for corridor violations (tenders, messages and arrival alerts already push).
- Web push for the website while it is closed (needs VAPID keys and a service worker).
- Background location, so tracking continues with the app closed (today the app shares location while open), and CarPlay / Android Auto.
- Arrival estimates from Valhalla route times and live traffic instead of road-factor miles.
- Address type-ahead while typing stops (search exists; the New load form does not use it yet).
- ELD integration (Motive, Samsara, Geotab and others) for the legal hours-of-service record instead of estimates.
- Split sleeper-berth pairings, the adverse driving conditions extension and the short-haul exception in the hours clock.
- Offline queueing of status updates in poor coverage.

## Oversize and overweight
- Import permit routes directly from state permit systems and restriction data (bridge clearances, posted weights) from a map data provider.
- Escort vehicle tracking alongside the load.

## Reliability
- Count reliability for external carriers reached by EDI or API (today only carriers on the platform get profiles).
- Let customers weigh the three metrics differently, and add claims amounts and tender acceptance rate.

## Business
- Payments and factoring for invoices; settlement for drivers.
- Equipment registry (tractors, trailers) and maintenance.
- Rate quote and pickup request flows in the app (the engine supports both transactions; the screens are not built yet).
- Email invitations for team members (today members must already have an account).
- Audit log and role-based permissions finer than the current roles.
