# Rate confirmations and getting paid

## Rate confirmations

Every load a carrier accepts gets a rate confirmation: the agreement between the shipper or broker and the carrier. Nobody types it up or emails a PDF back and forth.

| When | What happens |
|---|---|
| The carrier accepts the tender | Version 1 is written, signed by both sides. The tender is the shipper's or broker's signature; accepting is the carrier's. An EDI 990 or API acceptance from a carrier off the platform signs it too. |
| The shipper changes the load after that | If anything the carrier agreed to changed (stops or times, freight, equipment, references, notes), a new version replaces it. It is signed by the person who made the change and waits for the carrier. Dispatch sees "Sign rate confirmation" on Today. |
| The carrier's own work | Dispatching drivers, status updates and stop times never reopen it. |
| The carrier is released or the load cancelled | It is marked void. |

Each version holds the parties with their MC, USDOT and SCAC; the stops and appointment windows; equipment, commodity, weight and hazmat; references; the all-in rate and accessorials; the carrier's detention terms; the payer's payment terms and quick-pay offer; and the standard terms. The standard terms forbid re-brokering, require location sharing, and say payment only goes to the remit-to on file.

A SHA-256 fingerprint of the content is printed on it, so any later change shows. On the website, **Print or save as PDF** opens a print-ready copy; phones share a text copy.

API: `GET /v1/loads/:id/rate-confirmation` (`?version=2`, `&format=html`), `POST /v1/loads/:id/rate-confirmation/sign`.

## Getting paid

### Terms

Shippers and brokers set their terms under **Business > Paying carriers**: pay within so many days (30 by default), and optionally quick pay, for example 2 days at a 3% fee. The terms print on every rate confirmation and set each invoice's due date.

### An invoice from sent to paid

| Status | Who | Meaning |
|---|---|---|
| Sent | Carrier | Delivered to the customer in the app and in the format they chose (JSON, XML or EDI 210) |
| Received | Payer | They have it |
| Approved | Payer | Approved for payment by the due date |
| Disputed | Payer | Something is wrong; a reason is required and the carrier is told |
| Part paid | Payer | A payment for less than the balance was recorded |
| Paid | Payer | The balance is paid |

The payer records each payment with the amount, the method (ACH, check, wire) and a reference. The carrier's owner, billing and the driver who invoiced get a push for every approval, dispute and payment. The invoice carries the load's BOL, POD and receipts.

### Quick pay

If the customer offers it, the carrier taps **Ask for quick pay** on the invoice. The payer approves or declines. Once approved, the invoice is due that many days from approval, for the total less the fee.

### Factoring

A carrier that factors its invoices sets the factoring company under **Business > Getting paid**. New invoices are then paid to the factor. Redirecting payments is how freight fraud gets paid, so:

- the change needs a fresh code from the owner's or admin's authenticator app;
- every customer with open loads or invoices is told, and so are the carrier's own owners and billing;
- invoices already sent keep the remit-to they were sent with.

### Aging

**Money** shows what is owed to a carrier, and what a shipper or broker owes, in buckets: not due yet, 1 to 30, 31 to 60, 61 to 90 and over 90 days late. It also shows the largest balances by customer or carrier and the average days to pay. Overdue and disputed invoices, and quick-pay requests, appear on Today.

API: `PUT /v1/orgs/:id/payer-terms`, `PUT /v1/orgs/:id/factoring`, `GET /v1/invoices/:id`, `POST /v1/invoices/:id/status`, `POST /v1/invoices/:id/payments`, `POST /v1/invoices/:id/quick-pay`, `POST /v1/invoices/:id/quick-pay/decision`, `GET /v1/orgs/:id/aging`.

## Limits

- Payments are recorded, not moved. Logistics Pro doesn't hold or send money; the payer pays as it does today and records it.
- The factoring company is told only through the carrier. A notice of assignment still goes from the carrier to its customers the usual way.
- Inbound EDI 820 remittance advice is not read yet; payments are entered in the app or by API.
