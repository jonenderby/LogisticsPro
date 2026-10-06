# Insights for shippers and brokers

**More > Insights** shows how a shipper's or broker's freight is moving, for the last 30 days, 90 days or 12 months. The period filter at the top scopes everything on the screen.

| Section | What it shows |
|---|---|
| Headline numbers | Loads delivered, on-time delivery, cost per mile and freight spend, with the change against the period before |
| On-time delivery by carrier | One bar per carrier, the share of its deliveries inside the appointment window. Tap or hover a bar for loads, on-time pickup and cost per mile. Up to eight carriers; the rest are grouped as Other |
| Cost per mile by week | The agreed rate over loaded miles for loads delivered each week. Weeks without deliveries show as gaps. Hover, drag or tap for the week's value, loads and on-time share |
| Lanes | The ten busiest lanes (pickup city to final delivery city) with loads, on-time share, average rate and cost per mile |

Each chart has a table view.

## How it's measured

- **On time** uses the same rules as reliability scores: arrival at the final delivery within the window plus the grace period, and loaded within the pickup window. A load whose carrier took it after a window had already closed isn't counted against that carrier. Missed appointments reported against a carrier count as late.
- **Cost per mile** is the agreed rate divided by the road miles between stops (straight-line distance times 1.18). Accessorials billed later aren't included.
- **Weeks** start on Monday (UTC) and a load counts in the week it was delivered.

API: `GET /v1/orgs/:id/analytics?days=30|90|365`.

## Limits

- Spend is the agreed linehaul rate, not what was invoiced or paid.
- Lanes are city pairs; there is no grouping by region or ZIP3 yet.
