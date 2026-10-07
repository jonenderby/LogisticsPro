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

### Paying by ACH

A carrier adds the bank account it is paid to under **Business > Bank account for ACH**: name on the account, routing number (checked) and account number. Like the factoring company, a change needs a fresh authenticator code and every customer is told. The full account number is stored encrypted and never shown again, only the last four digits. Each change is a new stored account, and an invoice keeps the account it was sent with. Changing the factoring company removes the bank account, since it belonged to the previous payee.

A shipper or broker adds its bank's ACH details under **Business > Paying by ACH**: company name for statements, its 10-character ACH company ID and its bank's routing number and name. Then **Money > Pay by ACH**:

1. Pick approved invoices. Invoices not approved, without bank details, or already in a file are listed with the reason.
2. Confirm with an authenticator code. The file holds account numbers.
3. Upload the file to your bank. It is a standard NACHA file of CCD credits effective the next business day, one entry per invoice for its balance, with the invoice number in an addenda record (`RMR*IV*<invoice>**<amount>\`) so the carrier's bank shows what was paid.
4. **Mark sent to the bank.** Each invoice gets an ACH payment with the entry's trace number as its reference, and each carrier is told.

A file can be downloaded again with a fresh code, or cancelled before it is marked sent. An invoice can't be in two open files.

### Remittance advice (EDI 820)

A payer's accounting system can report what it paid instead of someone entering it: it posts an 820 (or the same document as JSON or XML) to `/v1/inbound/:orgId/:partner/payment_advice` or with its EDI. Each RMR line is matched to an open invoice by number, among invoices billed to that business or sent to that partner, and recorded with the payment's trace or check number. Lines that match nothing are named in the response; if none match, the request fails.

When a payment is recorded, in the app or from an ACH file, the carrier's own systems get an 820 if their receiving preferences ask for it, and so does an off-platform carrier whose partner profile has a channel for it.

### Driver pay

A carrier sets how each driver is paid under **Business > Driver pay**: a percentage of the load's linehaul, an amount per loaded mile, or a flat amount per load. Then **Money > Driver pay**:

1. Pick the pay period (last week, Monday to Sunday, by default) and **Make statements**. Each driver with delivered loads in the period gets a draft statement; a load already on a statement isn't paid again. Drivers without a pay rule are named so the office can set one.
2. A team splits each load in half; on a relay, each driver is paid for their legs' share of the miles.
3. Add adjustments to a draft: advances and deductions come off, bonuses and reimbursements are added.
4. **Approve**: the driver sees it under **More > My pay** and is told. **Mark paid** with a reference when it's paid.
5. **Export CSV** for payroll.

### Aging

**Money** shows what is owed to a carrier, and what a shipper or broker owes, in buckets: not due yet, 1 to 30, 31 to 60, 61 to 90 and over 90 days late. It also shows the largest balances by customer or carrier and the average days to pay. Overdue and disputed invoices, and quick-pay requests, appear on Today.

API: `PUT /v1/orgs/:id/payer-terms`, `PUT /v1/orgs/:id/factoring`, `PUT /v1/orgs/:id/payout-account`, `PUT /v1/orgs/:id/ach-originator`, `GET` and `POST /v1/orgs/:id/payment-runs`, `POST /v1/payment-runs/:id/file`, `/sent` and `/cancel`, `GET /v1/orgs/:id/driver-pay`, `PUT /v1/orgs/:id/drivers/:accountId/pay`, `GET` and `POST /v1/orgs/:id/settlements`, `GET /v1/orgs/:id/settlements.csv`, `POST /v1/settlements/:id/adjustments`, `/approve`, `/paid` and `/discard`, `GET /v1/me/settlements`, `GET /v1/invoices/:id`, `POST /v1/invoices/:id/status`, `POST /v1/invoices/:id/payments`, `POST /v1/invoices/:id/quick-pay`, `POST /v1/invoices/:id/quick-pay/decision`, `GET /v1/orgs/:id/aging`.

## Limits

- Logistics Pro doesn't hold or send money. ACH payments go through the payer's own bank, from the file it uploads; other payments are recorded as they are made.
- The factoring company is told only through the carrier. A notice of assignment still goes from the carrier to its customers the usual way.
