# Integrations

## One integration, every partner

A business configures two things, both per transaction:

1. **Receiving preferences**: how *its own* systems want to receive data from anyone on Logistics Pro. Example: Acme wants shipment status as JSON posted to its ERP and invoices as EDI 210 through its VAN. Carriers and drivers who work with Acme configure nothing; the hub reads Acme's preferences.
2. **Partner profiles**: how it exchanges data with a partner who is *not* on Logistics Pro. Example: tender to R+L by EDI 204, get rate quotes from Estes by JSON API.

Seed a partner from the catalog (`POST /v1/orgs/:orgId/partners/from-catalog/:code`), then change any transaction's method (`PUT /v1/orgs/:orgId/partners/:key`). Defaults prefer **JSON API, then XML API, then EDI** wherever the carrier supports more than one.

## Same required fields everywhere

There is one canonical schema per transaction. JSON, XML and EDI are renderings of it, so a partner on EDI and a partner on JSON are held to the same required fields. A JSON or XML field map that drops a required field is refused. `GET /v1/integrations/transactions` lists required and optional fields and the methods each transaction supports. Rate quotes and pickup requests have no standard X12 set and are API-only.

| Transaction | X12 set | Methods |
|---|---|---|
| Load tender | 204 | JSON, XML, EDI |
| Tender response | 990 | JSON, XML, EDI |
| Shipment status | 214 | JSON, XML, EDI |
| Freight invoice | 210 | JSON, XML, EDI |
| Rate quote | — | JSON, XML |
| Pickup request | — | JSON, XML |

Inbound EDI is answered with a 997 acknowledgment. Each transaction set in an interchange is accepted or rejected on its own.

## X12 4010 segment usage

| Set | Segments |
|---|---|
| 204 | B2, B2A (00 original, 04 change, 01 cancel), L11 (BM, PO, SI, ZZ service), G62*64 respond-by, NTE, N1*BT loop, N7 equipment (N711 code, N715 length), MEA oversize dimensions, S5 stop loops with L11*AO, G62 windows (69/38 pickup, 70/54 delivery, UT), N1*SH/CN loops, G61 contact, L5/AT8/LAD line items, LH1/LH2/LFH hazmat, L3 totals |
| 990 | B1 (A/D), N9*CN carrier PRO, K1 decline reason |
| 214 | B10, L11 (BM, PO), LX, AT7 status and reason (second AT7*AG carries an ETA), MS1 city/state/lat-long, MS2 equipment, L11*QN stop |
| 210 | B3, C3, N9 (BM, PO, CN), G62*86 pickup date, N1 BT/SH/CN loops, LX/L5/L0/L1 per charge, L3 totals |
| 997 | AK1, AK2, AK5, AK9 |

Code tables (equipment, status, reason and charge codes) are defaults. Every trading partner publishes its own implementation guide, so each table can be overridden per partner profile, and a partner should be certified with test files before going live.

## Transports

EDI goes out over **AS2** from the platform's central station (default for catalog carriers), or to a **VAN/SFTP** outbox for a gateway. See [EDI_AS2.md](EDI_AS2.md) for how sending and receiving work and how to connect a partner.

## Inbound endpoints

AS2 partners send to the central station at `POST /as2`. For HTTPS instead, issue a token with `POST /v1/orgs/:orgId/partners/:key/inbound-token`, then the partner sends with header `x-lp-inbound-token`:

- `POST /v1/inbound/:orgId/:key/edi` with an X12 interchange. The response body is the 997.
- `POST /v1/inbound/:orgId/:key/:transaction` with JSON or XML (by content type), shaped by that partner's field map.

Inbound tenders create loads for the receiving carrier, statuses update loads, tender responses book or release loads, and invoices land in the bill-to party's Money screen.

## Top 25 carriers

Ranks are from the Transport Topics 2026 Top 100 For-Hire Carriers list where a rank was confirmed. The list is completed with the largest LTL and truckload carriers from the 2026 TT segment rankings. "Documented" means the carrier's own developer portal or API guide describes the capability. "Reported" means third-party EDI networks or integrators describe it. "Assumed" means standard EDI support that must be confirmed during onboarding. Every carrier API requires an account, keys or an approval step with that carrier.

Columns show the default method the app picks for each transaction.

| # | Carrier | SCAC | API | EDI sets | Tender | Status | Invoice | Rate quote | Pickup | Confidence |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | UPS | UPSN | JSON (account-holder) | 210, 214 | JSON | JSON | EDI | JSON | JSON | documented |
| 2 | FedEx | FDEG | JSON (account-holder) | 210 | JSON | JSON | EDI | JSON | JSON | documented |
| 3 | J.B. Hunt Transport Services | HJBT | JSON (approval) | 204, 210, 214, 990, 997 | JSON | JSON | EDI | — | — | documented |
| 4 | FedEx Freight | FXFE, FXNL | JSON (account-holder) | 204, 210, 214, 990, 997 | JSON | JSON | EDI | JSON | JSON | documented |
| 5 | XPO | CNWY | JSON (account-holder) | 204, 210, 214, 990, 997 | JSON | JSON | EDI | JSON | JSON | documented |
| 6 | TFI International (TForce Freight) | UPGF | JSON (account-holder) | 204, 210, 214, 990, 997 | JSON | JSON | EDI | JSON | JSON | documented |
| 7 | Ryder System | confirm | none found | 204, 210, 214, 990, 997 | EDI | EDI | EDI | — | — | assumed |
| 8 | Knight-Swift Transportation | KNIG, SWFT | none found | 204, 210, 214, 990 | EDI | EDI | EDI | — | — | reported |
| 9 | Estes Express Lines | EXLA | JSON/XML (account-holder) | 204, 210, 214, 990, 997 | JSON | JSON | EDI | JSON | JSON | documented |
| 10 | Schneider National | SNLU | JSON (approval) | 204, 210, 214, 990 | JSON | JSON | EDI | JSON | — | reported |
| 11 | Old Dominion Freight Line | ODFL | JSON/XML (account-holder) | 204, 210, 214, 990, 997 | JSON | JSON | EDI | XML | JSON | documented |
| 12 | Landstar System | confirm | none found | 204, 210, 214, 990, 997 | EDI | EDI | EDI | — | — | assumed |
| 13 | Penske Logistics | confirm | none found | 204, 210, 214, 990, 997 | EDI | EDI | EDI | — | — | assumed |
| 14 | ArcBest (ABF Freight) | ABFS | XML/JSON (invitation) | 204, 210, 214, 990, 997 | JSON | JSON | EDI | JSON | JSON | documented |
| 15 | Hub Group | HUBG | JSON (approval) | 204, 210, 214, 990 | EDI | JSON | EDI | — | — | reported |
| 16 | R+L Carriers | RLCA | JSON/XML (account-holder) | 204, 210, 214, 990, 997 | JSON | JSON | EDI | JSON | JSON | documented |
| 18 | Saia | SAIA | JSON/XML (account-holder) | 204, 210, 214, 990, 997 | XML | JSON | EDI | XML | XML | documented |
| 19 | Werner Enterprises | WERN | JSON (approval) | 204, 210, 214, 990, 997 | JSON | JSON | EDI | — | — | reported |
| 20 | Prime Inc. | confirm | none found | 204, 210, 214, 990, 997 | EDI | EDI | EDI | — | — | assumed |
| — | Southeastern Freight Lines | SEFL | JSON/XML (account-holder) | 204, 210, 214, 990, 997 | EDI | JSON | EDI | JSON | — | documented |
| — | Averitt Express | AVRT | JSON (account-holder) | 204, 210, 214, 990, 997 | JSON | JSON | EDI | JSON | JSON | documented |
| — | AAA Cooper Transportation | AACT | XML (account-holder) | 204, 210, 214, 990, 997 | EDI | XML | EDI | XML | XML | documented |
| — | Dayton Freight Lines | DAFG | none found | 204, 210, 214, 990, 997 | EDI | EDI | EDI | — | — | assumed |
| — | NFI | confirm | none found | 204, 210, 214, 990, 997 | EDI | EDI | EDI | — | — | assumed |
| — | CRST The Transportation Solution | confirm | none found | 204, 210, 214, 990, 997 | EDI | EDI | EDI | — | — | assumed |

Sources:

- UPS: <https://developer.ups.com>
- FedEx: <https://developer.fedex.com/api/en-us/support.html>
- J.B. Hunt Transport Services: <https://apiportal.jbhunt.com/docs/services/orders-api/operations/get-order>, <https://www.stacksync.com/edi/jb-hunt/hunt-j-b-transport-inc-truckload-asset>
- FedEx Freight: <https://developer.fedex.com/api/en-us/catalog/ltl-freight/docs.html>, <https://developer.fedexfreight.com/ltl-ship-overview>
- XPO: <https://www.xpo.com/help-center/integration-with-customer-systems/api/>, <https://www.xpo.com/cdn/files/s1/XPO_API_Rating_Guide.pdf>
- TFI International (TForce Freight): <https://developer.tforcefreight.com/>, <https://www.tforcefreight.com/downloads/Shipping-API-User-Manual-V1.pdf>
- Knight-Swift Transportation: <https://github.com/api-evangelist/swift-transportation>
- Estes Express Lines: <https://developer.estes-express.com/>, <https://www.estes-express.com/resources/digital-services/api/>
- Schneider National: <https://schneider.com/resources/case-study/FreightPower-API-connection-delivers-more-capacity-faster-freight-quotes>, <https://www.stacksync.com/edi/schneider-national-carriers-inc>
- Old Dominion Freight Line: <https://www.odfl.com/us/en/resources/shipping-api-integrations.html>, <https://www.odfl.com/content/dam/odfl/us/en/documents/web-services/Rate%20Estimate%20API%20Development%20Guide.pdf>
- Landstar System: <https://www.landstar.com/blog/clarity/>
- ArcBest (ABF Freight): <https://arcb.com/technology/shippers/API>
- Hub Group: <https://www.freightwaves.com/news/hub-group-rolls-out-enhanced-end-to-end-visibility-for-customers-to-track-shipments-in-real-time>, <https://www.stacksync.com/edi/hub-group-inc/204>
- R+L Carriers: <https://www.rlcarriers.com/freight/shipping-software/freight-api-overview>, <https://technology.rlcarriers.com/>
- Saia: <https://www.saia.com/tools-and-resources/web-integration-services>, <https://api.saia.com/customer-api/public/api-docs/index>
- Werner Enterprises: <https://www.werner.com/technology/>
- Southeastern Freight Lines: <https://www.sefl.com/seflWebsite/technology/webConnect.jsp>
- Averitt Express: <https://www.averitt.com/technology/api>
- AAA Cooper Transportation: <https://www.aaacooper.com/web-services>
- Rankings: <https://www.ttnews.com/for-hire/rankings/2026>, <https://www.ttnews.com/for-hire/ltl/2026>, <https://www.ttnews.com/for-hire/tl/2026>
