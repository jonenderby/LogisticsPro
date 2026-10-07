# ELD connections

A carrier connects its electronic logging device account once, under **Business > ELD**. From then on:

- **Hours of service** come from the ELD, the legal record, instead of the phone's estimate. Drivers see "Driving on your Samsara ELD, updated 2:14 PM" on Today and the Hours screen, and change duty status on the ELD.
- **Truck GPS** stands in for the driver's phone. It keeps tracking, ETAs, stop arrival and departure (detention) and fuel-tax miles going when the app is closed or the phone is off.
- **ETAs and load suggestions** use the ELD's remaining drive, shift, break and cycle time.

| ELD | What to enter | Read |
|---|---|---|
| Motive | An API key (Admin > API keys) | Drivers, available time, vehicle locations |
| Samsara | An API token with read access to drivers, vehicles and hours of service | Drivers, HOS clocks, vehicle locations, driver-vehicle assignments |
| Geotab | A MyGeotab service account: server, database, user name, password | Users, duty status availability, device status, devices |

The credentials are checked by listing drivers before anything is saved. They are stored encrypted (AES-256-GCM, key from `LP_DATA_KEY`, or `LP_JWT_SECRET` when that isn't set) and never shown again; the screen shows only "Key ending 1234".

## Matching drivers

ELD drivers are matched to the carrier's drivers on Logistics Pro by email, then CDL number, then exact name, only where exactly one person fits. Dispatch can link or unlink anyone by hand; hand-made links survive reconnecting.

## Sync

The server polls each ELD every five minutes (on the one server holding the job lock). **Sync now** polls immediately. A failure is shown on the ELD section and retried at the next interval. An ELD clock older than 15 minutes is not used; the phone's estimate takes over until the ELD reports again.

A truck's position counts for the driver the ELD says is logged in to it. Trucks with no logged-in driver are counted but not tracked.

API: `GET /v1/orgs/:id/eld`, `PUT /v1/orgs/:id/eld`, `PUT /v1/orgs/:id/eld/drivers/:externalId`, `POST /v1/orgs/:id/eld/sync`, `POST /v1/orgs/:id/eld/remove`.

## Testing against live accounts

`apps/api/test/eld.live.test.ts` reads drivers, hours clocks and truck locations from real accounts and checks they arrive in the shape the adapters expect: clocks in minutes within the legal limits, recent timestamps, valid coordinates, and clocks only for drivers the account lists. Each provider runs only when its credentials are set; without any, the tests are skipped, as they are in CI. They only read.

```bash
LP_TEST_MOTIVE_KEY=... npm run test:eld-live
LP_TEST_SAMSARA_TOKEN=... npm run test:eld-live
LP_TEST_GEOTAB_DATABASE=... LP_TEST_GEOTAB_USER=... LP_TEST_GEOTAB_PASSWORD=... npm run test:eld-live   # LP_TEST_GEOTAB_SERVER defaults to my.geotab.com
```

Run them when a carrier first connects each provider, and after a provider announces API changes.

## Limits

- The adapters follow each provider's published API and are tested against their documented response shapes. Live accounts haven't been run yet; the live tests above are the check to run with the first real account of each.
- Motive and Samsara also offer OAuth apps for marketplace listings; this uses API keys and tokens, which the carrier creates.
- Duty status is read, not written: Logistics Pro never edits the ELD's record.
- With a team on one truck, the truck's GPS goes to whichever driver the ELD has logged in.
