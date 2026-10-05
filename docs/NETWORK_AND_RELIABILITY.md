# Truckers, carriers and reliability

## Every trucker drives for a carrier

- A **self-employed trucker** registers their own trucking company. They become its owner and a driver at the same time (an owner-operator), and their driving and company work share one Today screen.
- A **company driver** joins a carrier. Until they do, Today shows "Join your carrier" first, and they cannot be dispatched.
- A trucker may be in more than one carrier's network (for example a leased owner-operator who also hauls for another fleet). Every shipment belongs to exactly one carrier, the one hauling it, so only that carrier is scored on it. See [Truckers in more than one carrier](#truckers-in-more-than-one-carrier).

## Join codes

| | |
|---|---|
| Format | 8 characters, shown as `ABCD-2345`, without look-alike characters (no 0/O, 1/I/L) |
| Who sees it | The carrier's owner, admins and dispatchers (Business screen) |
| Lifetime | 7 days by default (`LP_JOIN_CODE_TTL_HOURS`), then it rotates automatically |
| Rotate now | Any time; the old code stops working immediately |
| What it grants | Only a **request** to join. The carrier approves or declines it. |
| Guessing | Each account gets 10 attempts per hour |

Approval is what makes a leaked code harmless, so codes can live long enough for real recruiting. Carriers can still add drivers directly by email, remove members, and drivers can leave.

## Reliability

Each delivered shipment is scored on three things:

| Metric | On time / good when |
|---|---|
| On-time pickup | "Loaded" is reported by the end of the pickup window, plus 15 minutes |
| On-time delivery | Arrival at the final delivery is by the end of its window, plus 15 minutes |
| Damage-free | No damage exception was reported on the shipment |

The **score** is the average of the three rates. Every carrier is scored on every load it hauls, including carriers a business reaches only by API or EDI. Exceptions (damage, shortage, overage, refused) can be reported by the shipper, broker, carrier or driver after pickup, and the score updates.

| Profile | Window |
|---|---|
| Trucker overall | Last 1,000 shipments |
| Trucker with one business | Last 100 shipments for that business |
| Carrier overall | Last 1,000 × number of truckers (10 truckers → 10,000) |
| Carrier with one business | Last 100 × number of truckers (10 truckers → 1,000) |

A "business" is the shipper, and the broker too when the load is brokered.

On relays, drivers are judged only on the stops they were responsible for: pickup counts for the first leg's drivers, delivery for the last leg's drivers, and damage for everyone who drove the load.

### Missed appointments

A shipper or broker can report that the carrier missed a pickup or delivery appointment, as a **no-show** or **arrived late** (with minutes late and a note). This is the business's own judgment and overrides what the carrier reported: a missed pickup counts as a late pickup even if the carrier reported "Loaded" on time.

| Rule | |
|---|---|
| Who can report | The shipper, or the broker on a brokered load |
| When | Once the stop's window has closed, plus 15 minutes |
| Charged to | The carrier hauling the load when the appointment was missed, and the drivers on that leg |
| Never charged to | A carrier that took the load after the appointment had passed, or any other carrier a driver also works for |
| One per stop | Each stop can be reported once per carrier |
| Carrier response | The carrier can dispute it with a note. It keeps counting until the business withdraws it |
| Withdraw | The business that reported it can withdraw it, and the scores recover |

Reports and responses are posted to the load's message thread. Carriers see their missed appointments on their Business screen. Shippers see them, and can report one, on the load.

**After a no-show** the shipper can **release the carrier** before pickup. The load returns to draft so it can go to another carrier, and the first carrier is told it is cancelled for them. The no-show stays on the first carrier's record as a shipment of its own. The rescuing carrier is judged only on windows that were still open when it took the load. If the shipper moves the windows, the new ones count.

### Truckers in more than one carrier

- Each shipment is recorded against the carrier hauling it, never against the trucker's other carriers. A shared trucker cannot drag one carrier down with another carrier's loads.
- The trucker has one record of their own across all carriers, and sees it split **by carrier**.
- A carrier looking at a shared trucker sees the trucker's overall score and the trucker's shipments **for that carrier** only, not the other carrier's customers.
- On the fleet map, a shared trucker who is hauling for another carrier shows as "Other carrier" with no location and no load details.

### Carriers connected by API or EDI

A carrier that is not on Logistics Pro, reached through a business's partner connection, is scored on that business's shipments with it. Only that business sees the score (`GET /v1/reliability/partners/:partnerKey`). It counts as one truck for its windows, because its roster is unknown.

### Who sees what

- **Truckers** see their own profile, overall, per customer and per carrier.
- **Carriers** see their own profile with every customer, and each driver's profile when choosing who runs a load.
- **Shippers and brokers** see a carrier's overall score and its score **with their own business only**, including on every bid. Company A's excellent relationship with Carrier B is visible to Company A and is not dragged down by Company C's experience, and Company C cannot see Company A's numbers.
