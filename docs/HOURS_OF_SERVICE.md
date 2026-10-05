# Hours of service

Drivers see how much legal driving time they have left, why, and how far that time goes.

<p align="center">
  <img src="screenshots/driver-hours-today.png" width="230" alt="Today on a phone: 5 h 55 min left to drive, 100 miles driven this shift, about 284 more">
  <img src="screenshots/web-hours-of-service.png" width="560" alt="Hours of service screen with a meter for each limit and the duty log">
</p>

## What the driver sees

On **Today**, and in more detail under **More > Hours of service**:

- **Time left to drive now**, and which limit sets it: the 30-minute break, the 11-hour driving limit, the 14-hour window or the weekly cycle. At zero it says to stop and what rest is needed.
- **Miles driven this shift**, from the phone's location trail.
- **About how many more miles** the remaining time allows, at the driver's own pace this shift (50 mph until there is enough driving to measure).
- A **duty status switch**: Off duty, Sleeper, On duty, Driving.
- A meter per limit, the duty log for the last 8 days, and the weekly cycle setting.
- When resting, when a fresh 11 hours becomes available.
- A warning if the log shows a limit was exceeded.

Dispatchers see each driver's time left on the Fleet screen. A driver who works for several carriers has one set of hours across all of them, as the law counts it.

## The rules

FMCSA property-carrying rules (49 CFR 395.3):

| Limit | Rule |
|---|---|
| Driving | 11 hours after 10 consecutive hours off duty or in the sleeper berth |
| Window | No driving after the 14th hour since coming on duty; off-duty time inside the window does not extend it |
| Break | A 30-minute break from driving (off duty, sleeper or on duty not driving) after 8 hours of driving |
| Cycle | 70 hours on duty in 8 days, or 60 in 7, as the carrier runs; 34 hours off in a row restarts it |

Not modeled: split sleeper-berth pairings, the adverse driving conditions extension, the 16-hour short-haul exception and personal conveyance. Without them the clock can show less time than the law allows, never more.

## Where the duty log comes from

- **The driver** sets their status. Changes take effect now; the log is not edited after the fact.
- **The truck's movement**, as an ELD does it: while the app is open and the driver has a load or is on duty, the phone reports its position about once a minute and checks in every 2 minutes while stopped. Moving over 5 mph switches the driver to **Driving**; 5 minutes stopped switches them back to **On duty**. These entries are marked **Auto**.
- On a **team truck** movement says nothing about who is at the wheel, so team drivers set their status themselves.
- GPS jumps faster than a truck can go are ignored, both for duty status and for miles.

## It is not an ELD

This is an estimate from the driver's own entries and phone. It is not a registered electronic logging device and does not replace one; the ELD's record is the legal one. Reading hours from the carrier's ELD provider is on the [roadmap](ROADMAP.md).

API: `GET /v1/me/hos`, `POST /v1/me/duty-status`, `PUT /v1/me/hos-settings`. `GET /v1/me` includes the summary for drivers.
