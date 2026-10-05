import type { Address } from "@logisticspro/domain";
import { addressQuery } from "@logisticspro/navigation";
import type { AppContext } from "../http.js";

/**
 * Give an address coordinates when it has none. Never fails the request: if
 * no geocoder is configured or nothing matches, the address is returned
 * unchanged with a warning the app can show.
 */
export async function withGeo(ctx: AppContext, address: Address, what: string): Promise<{ address: Address; warning?: string }> {
  if (address.geo) return { address };
  if (!ctx.geocoder) return { address, warning: `${what}: no coordinates and address search is not configured` };
  try {
    const [hit] = await ctx.geocoder.search(addressQuery(address), { limit: 1, countries: [address.country ?? "US"] });
    if (!hit) return { address, warning: `${what}: address not found on the map` };
    return { address: { ...address, geo: hit.geo } };
  } catch (e) {
    return { address, warning: `${what}: address search failed (${(e as Error).message})` };
  }
}

export async function geocodeStops<T extends { address: Address; type: string }>(ctx: AppContext, stops: T[]): Promise<{ stops: T[]; warnings: string[] }> {
  const warnings: string[] = [];
  const out: T[] = [];
  for (const [i, s] of stops.entries()) {
    const r = await withGeo(ctx, s.address, `Stop ${i + 1} (${s.type.toLowerCase()})`);
    if (r.warning) warnings.push(r.warning);
    out.push({ ...s, address: r.address });
  }
  return { stops: out, warnings };
}
