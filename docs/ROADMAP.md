# Roadmap and known gaps

What is built and tested is described in the README. This is what remains before a production launch, roughly in priority order.

## Must have before real customers
- **Database.** The API stores everything in memory and loses it on restart. Replace `MemoryStore` with PostgreSQL (loads as JSONB with indexed columns for status, parties and load number), and keep the transmission log for audit.
- **Carrier onboarding and certification.** The catalog seeds methods per carrier, but each carrier still needs credentials (API keys or OAuth clients stored as secrets), its exact field names as a field map, and EDI test cycles against its implementation guide. Start with the carriers your first customers use.
- **EDI connectivity.** EDI for AS2, SFTP and VAN partners is written to an outbox directory. Connect a gateway (an AS2 server or a VAN account) to send and receive those files.
- **Secrets management.** Partner credentials resolve from `LP_SECRET_*` environment variables. Move them to a secrets manager.
- **Device testing and store builds.** The app is typechecked, bundled for iOS and Android, and exercised on web. It still needs EAS builds, testing on physical phones, App Store and Play Store listings, and a Google Maps key for Android.

## Driver experience
- Camera document scanning for BOL and POD (today a document is added by link).
- Push notifications for tenders, messages and corridor violations.
- Background location while navigating, and CarPlay / Android Auto.
- Geocoding addresses so stops get coordinates automatically (today coordinates are optional input).
- ELD integration for live hours-of-service instead of estimates.
- Offline queueing of status updates in poor coverage.

## Oversize and overweight
- Import permit routes directly from state permit systems and restriction data (bridge clearances, posted weights) from a map data provider.
- Escort vehicle tracking alongside the load.

## Business
- Payments and factoring for invoices; settlement for drivers.
- Equipment registry (tractors, trailers) and maintenance.
- Rate quote and pickup request flows in the app (the engine supports both transactions; the screens are not built yet).
- Email invitations for team members (today members must already have an account).
- Audit log and role-based permissions finer than the current roles.
