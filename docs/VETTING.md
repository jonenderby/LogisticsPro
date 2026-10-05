# Carrier vetting and double-brokering protection

Before a shipper or broker tenders a load or awards a bid, Logistics Pro checks the carrier against FMCSA, the US motor carrier registry. A carrier that **fails** can't be used. One that **needs review** can be used once someone at the shipper or broker has looked and signed off. Bids show each bidder's result, and so does the load page.

## The checks

| Check | Fails when | Needs review when |
|---|---|---|
| USDOT on file | The carrier hasn't entered one, or FMCSA doesn't know it | |
| Allowed to operate | FMCSA says it isn't | |
| Out of service | It has been put out of service | |
| Operating authority | No active common or contract authority, or only broker authority | |
| MC number | The MC entered isn't registered to that USDOT | |
| Authority age | | Younger than the shipper's minimum (90 days by default) |
| Liability insurance | Below the minimum on file ($750,000 by default) | None on file |
| Cargo insurance | | Below the minimum on file ($100,000 by default) |
| Safety rating | Unsatisfactory | Conditional, unless the shipper accepts it |
| Name | | The company name doesn't match the FMCSA legal or DBA name |
| Contact | | The owners' and admins' emails don't match the email FMCSA lists |
| Recent changes | | FMCSA phone, email, address or legal name changed in the last 90 days |
| Same USDOT twice | | Another company on Logistics Pro claims the same USDOT |

Shippers and brokers set the minimums under **Business > Carrier vetting**.

## Double brokering

Double brokering is when someone takes a load and hands it to another carrier without telling the shipper, often under a real carrier's stolen identity, and then collects the payment. Logistics Pro makes each step harder:

- **Brokers posing as carriers fail.** Broker-only authority can't haul.
- **Stolen identities show up.** A new authority, contact details that don't match FMCSA, or FMCSA details that changed recently all need review. The check tells the reviewer to call the number FMCSA lists, not one the carrier gave them.
- **The load can't be passed on.** Only the carrier's own drivers can be dispatched on a load, and the rate confirmation forbids re-brokering.
- **Pickup is verified.** The load page tells the shipper whether the carrier's own driver's phone was at the dock when the freight was loaded. If it wasn't, it says so.
- **Payments can't be quietly redirected.** Changing where a carrier gets paid needs a fresh authenticator code, and every customer is told. See [PAYMENTS.md](PAYMENTS.md#factoring).
- **Carriers are re-checked.** Once a day, carriers holding undelivered loads are checked again. If one stops passing, for example its authority is revoked or its insurance lapses, the shipper or broker gets a push and a message on each load.

## Setting it up

Get a free FMCSA QCMobile web key at [mobile.fmcsa.dot.gov/QCDevsite](https://mobile.fmcsa.dot.gov/QCDevsite) and set `LP_FMCSA_WEBKEY`. Records are cached for a day; **Check FMCSA again now** on the carrier check fetches a fresh one.

Without a key, carriers show **Not checked** and nothing is blocked. For demos and staging, `LP_FMCSA_FIXTURES` can point at a JSON array of records in the same shape.

API: `GET /v1/carriers/:id/vetting`, `POST /v1/carriers/:id/vetting/refresh`, `POST /v1/orgs/:id/carrier-approvals`, `POST /v1/orgs/:id/carrier-approvals/:carrierId/remove`, `PUT /v1/orgs/:id/vetting-policy`, `GET /v1/loads/:id/carrier-check`.

## Limits

- QCMobile doesn't give the carrier's email or the date its authority was granted, so the contact and authority-age checks only run when another source supplies them. A commercial monitoring service can be plugged in behind the same `FmcsaClient` interface.
- Insurance on file at FMCSA can lag a cancellation by up to 30 days. For high-value freight, also get the certificate from the insurer.
- Carriers reached through a partner profile (EDI or API, not on the platform) aren't checked automatically.
