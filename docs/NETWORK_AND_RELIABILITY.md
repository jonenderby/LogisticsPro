# Truckers, carriers and reliability

## Every trucker drives for a carrier

- A **self-employed trucker** registers their own trucking company. They become its owner and a driver at the same time (an owner-operator), and their driving and company work share one Today screen.
- A **company driver** joins a carrier. Until they do, Today shows "Join your carrier" first, and they cannot be dispatched.
- A trucker may be in more than one carrier's network (for example a leased owner-operator who also hauls for another fleet).

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

The **score** is the average of the three rates. Exceptions (damage, shortage, overage, refused) can be reported by the shipper, broker, carrier or driver after pickup, and the score updates.

| Profile | Window |
|---|---|
| Trucker overall | Last 1,000 shipments |
| Trucker with one business | Last 100 shipments for that business |
| Carrier overall | Last 1,000 × number of truckers (10 truckers → 10,000) |
| Carrier with one business | Last 100 × number of truckers (10 truckers → 1,000) |

A "business" is the shipper, and the broker too when the load is brokered.

On relays, drivers are judged only on the stops they were responsible for: pickup counts for the first leg's drivers, delivery for the last leg's drivers, and damage for everyone who drove the load.

### Who sees what

- **Truckers** see their own profile, overall and per customer.
- **Carriers** see their own profile with every customer, and each driver's profile when choosing who runs a load.
- **Shippers and brokers** see a carrier's overall score and its score **with their own business only**, including on every bid. Company A's excellent relationship with Carrier B is visible to Company A and is not dragged down by Company C's experience, and Company C cannot see Company A's numbers.
