import type { GeoPoint } from "@logisticspro/domain";

export interface GeocodedAddress {
  /** One-line label to show the user, e.g. "600 Food Center Dr, Bronx, NY 10474". */
  label: string;
  line1?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country: string;
  geo: GeoPoint;
  /** 0..1, provider-reported where available. */
  confidence?: number;
}

export interface GeocodeOptions {
  limit?: number;
  /** Bias results toward this point (e.g. the truck's position). */
  near?: GeoPoint;
  countries?: string[];
}

/** Turns a typed address into coordinates. Implementations: Pelias, Nominatim, static. */
export interface Geocoder {
  search(query: string, opts?: GeocodeOptions): Promise<GeocodedAddress[]>;
}

type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const fetchOf = (f?: FetchLike) => f ?? (globalThis.fetch as unknown as FetchLike);

export function addressQuery(a: { line1?: string; city?: string; state?: string; postalCode?: string; country?: string }): string {
  return [a.line1, a.city, [a.state, a.postalCode].filter(Boolean).join(" "), a.country].filter((x) => x && x.trim()).join(", ");
}

function label(r: Omit<GeocodedAddress, "label">): string {
  return [r.line1, r.city, [r.state, r.postalCode].filter(Boolean).join(" ")].filter(Boolean).join(", ");
}

/**
 * Pelias (open source, self-hostable, pairs well with Valhalla). Also works
 * with hosted Pelias-compatible APIs such as Geocode Earth.
 */
export class PeliasGeocoder implements Geocoder {
  constructor(
    private readonly baseUrl: string,
    private readonly opts: { apiKey?: string; fetch?: FetchLike } = {},
  ) {}

  async search(query: string, o: GeocodeOptions = {}): Promise<GeocodedAddress[]> {
    const u = new URL(`${this.baseUrl.replace(/\/$/, "")}/v1/search`);
    u.searchParams.set("text", query);
    u.searchParams.set("size", String(o.limit ?? 5));
    if (o.countries?.length) u.searchParams.set("boundary.country", o.countries.join(","));
    if (o.near) {
      u.searchParams.set("focus.point.lat", String(o.near.lat));
      u.searchParams.set("focus.point.lon", String(o.near.lng));
    }
    if (this.opts.apiKey) u.searchParams.set("api_key", this.opts.apiKey);
    const res = await fetchOf(this.opts.fetch)(u.toString());
    if (!res.ok) throw new Error(`geocoding failed: HTTP ${res.status}`);
    const data = (await res.json()) as { features: Array<{ geometry: { coordinates: [number, number] }; properties: Record<string, string | number | undefined> }> };
    return data.features.map((f) => {
      const p = f.properties;
      const line1 = p.housenumber && p.street ? `${p.housenumber} ${p.street}` : (p.street as string | undefined) ?? (p.name as string | undefined);
      const r = {
        line1,
        city: (p.locality ?? p.localadmin ?? p.county) as string | undefined,
        state: (p.region_a as string | undefined)?.toUpperCase(),
        postalCode: p.postalcode as string | undefined,
        country: ((p.country_a as string | undefined) ?? "US").slice(0, 2).toUpperCase(),
        geo: { lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] },
        confidence: typeof p.confidence === "number" ? p.confidence : undefined,
      };
      return { ...r, label: (p.label as string | undefined) ?? label(r) };
    });
  }
}

const COUNTRY3: Record<string, string> = { USA: "US", CAN: "CA", MEX: "MX" };

/**
 * Nominatim (OpenStreetMap's geocoder). Self-host it for production; the
 * public nominatim.openstreetmap.org service forbids heavy or bulk use.
 */
export class NominatimGeocoder implements Geocoder {
  constructor(
    private readonly baseUrl: string,
    private readonly opts: { userAgent?: string; email?: string; fetch?: FetchLike } = {},
  ) {}

  async search(query: string, o: GeocodeOptions = {}): Promise<GeocodedAddress[]> {
    const u = new URL(`${this.baseUrl.replace(/\/$/, "")}/search`);
    u.searchParams.set("q", query);
    u.searchParams.set("format", "jsonv2");
    u.searchParams.set("addressdetails", "1");
    u.searchParams.set("limit", String(o.limit ?? 5));
    u.searchParams.set("countrycodes", (o.countries ?? ["us", "ca", "mx"]).join(",").toLowerCase());
    if (this.opts.email) u.searchParams.set("email", this.opts.email);
    const res = await fetchOf(this.opts.fetch)(u.toString(), { headers: { "user-agent": this.opts.userAgent ?? "LogisticsPro/0.1" } });
    if (!res.ok) throw new Error(`geocoding failed: HTTP ${res.status}`);
    const data = (await res.json()) as Array<{ lat: string; lon: string; display_name: string; importance?: number; address?: Record<string, string> }>;
    return data.map((d) => {
      const a = d.address ?? {};
      const iso = a["ISO3166-2-lvl4"];
      const line1 = a.house_number && a.road ? `${a.house_number} ${a.road}` : a.road;
      const country = (a.country_code ?? "us").toUpperCase();
      const r = {
        line1,
        city: a.city ?? a.town ?? a.village ?? a.hamlet ?? a.county,
        state: iso?.includes("-") ? iso.split("-")[1] : a.state,
        postalCode: a.postcode,
        country: COUNTRY3[country] ?? country,
        geo: { lat: Number(d.lat), lng: Number(d.lon) },
        confidence: d.importance,
      };
      return { ...r, label: label(r) || d.display_name };
    });
  }
}

/** Fixed answers keyed by lower-cased query fragments; for tests and demos without a geocoding server. */
export class StaticGeocoder implements Geocoder {
  constructor(private readonly entries: Array<{ match: string; result: GeocodedAddress }>) {}
  async search(query: string, o: GeocodeOptions = {}): Promise<GeocodedAddress[]> {
    const q = query.toLowerCase();
    return this.entries.filter((e) => q.includes(e.match.toLowerCase())).map((e) => e.result).slice(0, o.limit ?? 5);
  }
}
