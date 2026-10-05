# Fuel tax (IFTA)

Carriers file IFTA every quarter: the miles each truck ran in each state and province, and the fuel bought in each. Logistics Pro builds that from the trucks' location trails and the fuel receipts drivers enter, so the quarter's report is ready when it is due.

## Miles by state and province

Every location fix from a driver's phone is matched to the fix before it. The stretch between them is credited to the states and provinces it passed through.

- **Only driving counts.** Stretches slower than 5 mph (GPS drift while parked) or faster than 90 mph (a jump after a gap) are skipped.
- **Road miles.** Fixes a minute apart are close to the road. Across a gap longer than five minutes, the straight line is stretched to typical road miles.
- **Border crossings** are found by splitting the stretch until each piece sits in one jurisdiction, so a stretch that crosses a line is shared out by where the line falls.
- **Per truck.** Miles go to the unit number on the leg (`Unit 112`). A leg without one goes under the driver's own truck.
- **Team trucks** count once. Both phones report, but only the first driver whose phone reported in the last ten minutes is credited. If that phone goes quiet, the other takes over.
- **Several carriers.** A driver who hauls for more than one carrier adds miles to the carrier whose load is moving, or their home carrier when they have no load.

### Boundary data

`apps/api/data/jurisdictions.json` holds the 48 states, DC, Alaska, Hawaii and the 13 provinces and territories:

| Source | Used for | Precision |
|---|---|---|
| US Census Bureau 2020 cartographic boundaries, 1:500,000 | US states and DC | About 100 m after simplification |
| Natural Earth 1:10m admin-1 | Canadian provinces and territories | About 1 km |

Both are public domain. A truck within a few hundred metres of a state line, or about a kilometre of a provincial one, can be credited to the wrong side for that short stretch. Over a quarter it nets out to a fraction of a mile.

Alaska, Hawaii, DC, Yukon, Northwest Territories and Nunavut are not IFTA members. Their miles show in the report but carry no tax line.

## Fuel purchases

Drivers enter fuel from **More > Fuel tax**: date, state or province, gallons, and optionally the amount and the stop. The office can enter it for any unit. Drivers see their own entries; owners, admins and billing see everyone's.

## The quarterly report

Owners, admins and billing open **More > Fuel tax** and pick a quarter. Per jurisdiction it shows:

- miles driven;
- taxable gallons, the jurisdiction's miles divided by the fleet's miles per gallon for the quarter;
- tax-paid gallons, from the purchases entered there;
- net gallons, taxable less tax-paid.

It also lists each truck's miles and gallons. **Export CSV** downloads the same table for the filing or the accountant. Tax rates change every quarter and are not built in: the report gives gallons, and the filing portal applies the rates.

API: `GET /v1/orgs/:id/ifta?quarter=2026-Q4` (add `&format=csv` for the file), `GET/POST /v1/orgs/:id/fuel-purchases`.

## Limits

- Miles come from the drivers' phones. A trip with the phone off or location denied has no trail. ELD connections, when added, will fill the gaps from the truck's own GPS.
- Receipts are entered by hand; there is no fuel card import yet.
- This is a filing aid, not an audit record. Keep the receipts.
