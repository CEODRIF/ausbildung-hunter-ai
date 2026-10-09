import "server-only";

import demoFixture from "./fixtures/demo-listings.json";
import { geocodePlace } from "./geocode";
import type {
  GeocodeFn,
  HousingListing,
  HousingProviderAdapter,
  HousingSearchParams,
  HousingSearchOptions,
  HousingSearchResult,
} from "./types";

/**
 * Housing / "Wohnen" — provider layer.
 *
 * The product ships ZERO live rental providers: there is no licensed, free
 * German rental data API, and scraping is explicitly out of scope. Instead:
 *
 *   1. The listing surface is a provider-ADAPTER abstraction. A future licensed
 *      adapter implements {@link HousingProviderAdapter} and is registered in
 *      {@link PROVIDER_ADAPTERS}; it must be `isLicensed()` (with a citable
 *      `termsRef`), declare its `supportedFilters`, and not be kill-switched
 *      before its results are ever served.
 *   2. Until such an adapter exists, `searchHousing()` serves clearly-labeled
 *      DEMO fixtures (data_status = "demo") that link out to real portal
 *      homepages (never fabricated deep links) and never claim to be live data.
 *
 * Runtime guarantees (all testable offline via `HousingSearchOptions`):
 *   * failure isolation — one adapter error/timeout never breaks the search;
 *   * per-adapter timeout — a hanging source is dropped, not awaited;
 *   * dedupe — one card per `provider:source_id` (live beats demo);
 *   * expiry — listings the provider marks inactive (`listing_active: false`)
 *     are dropped; `null` (unknown) is kept;
 *   * honest radius — the radius is applied ONLY when the city geocodes
 *     (Nominatim, fail-open); otherwise `radius_applied: false` is reported;
 *   * pagination — `limit`/`offset` with a stable pre-pagination `total` and
 *     `has_more` so the UI can page without re-querying.
 *
 * Every result is normalized to {@link HousingListing} so the UI, the saved
 * list, and the DB snapshot all share one shape.
 */

/** Re-export so existing imports (`from "./providers"`) keep working. */
export type { HousingProviderAdapter } from "./types";

/** A single adapter may not hold the whole search hostage. */
export const ADAPTER_TIMEOUT_MS = 8000;
const EARTH_RADIUS_KM = 6371;

/** Registered live adapters. Intentionally EMPTY — there is no licensed free
 *  German rental API. Adding a licensed source here (isLicensed() true, with a
 *  real `termsRef`) is the ONLY way live data can enter the product. */
export const PROVIDER_ADAPTERS: readonly HousingProviderAdapter[] = [];

/**
 * Per-provider kill switches. A provider id present here with `false` is
 * excluded from results even if licensed. Absent ids default to enabled.
 */
const PROVIDER_KILL_SWITCHES: Record<string, boolean> = {};

function providerEnabled(providerId: string): boolean {
  return PROVIDER_KILL_SWITCHES[providerId] !== false;
}

/** The demo fixture set — the only built-in data source. */
function demoListings(): HousingListing[] {
  const raw = demoFixture as unknown as {
    is_demo?: boolean;
    label?: string;
    listings?: Array<Partial<HousingListing>>;
  };
  return (raw.listings ?? []).map((item) => normalizeListing(item));
}

/** Normalize a partial fixture/provider row into a complete, null-safe listing. */
export function normalizeListing(partial: Partial<HousingListing>): HousingListing {
  return {
    provider: partial.provider ?? "demo",
    source_id: partial.source_id ?? "",
    title: partial.title ?? "",
    listing_url: partial.listing_url ?? "",
    city: partial.city ?? "",
    postal_code: partial.postal_code ?? null,
    address: partial.address ?? null,
    latitude: partial.latitude ?? null,
    longitude: partial.longitude ?? null,
    rent_cold_eur: partial.rent_cold_eur ?? null,
    additional_costs_eur: partial.additional_costs_eur ?? null,
    rent_warm_eur: partial.rent_warm_eur ?? null,
    deposit_eur: partial.deposit_eur ?? null,
    rooms: partial.rooms ?? null,
    living_area_sqm: partial.living_area_sqm ?? null,
    available_from: partial.available_from ?? null,
    furnished: partial.furnished ?? false,
    balcony: partial.balcony ?? false,
    pets_allowed: partial.pets_allowed ?? null,
    wg_suitable: partial.wg_suitable ?? false,
    verified: partial.verified ?? false,
    accommodation_type: partial.accommodation_type ?? "apartment",
    images: partial.images ?? [],
    features: partial.features ?? [],
    description: partial.description ?? null,
    provider_updated_at: partial.provider_updated_at ?? null,
    last_checked_at: partial.last_checked_at ?? null,
    source_terms_version: partial.source_terms_version ?? null,
    data_status: partial.data_status ?? "demo",
    listing_active: partial.listing_active ?? null,
  };
}

/** Label shown in the demo banner. Always non-empty. */
export const DEMO_LABEL: string =
  (demoFixture as { label?: string }).label ??
  "Demo-Daten — keine echten Mietangebote";

/** Pure great-circle distance in km (exported for tests + the UI). */
export function haversineKm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Race a promise against a timeout; rejection → the adapter is skipped. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Adapter timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * One card per `provider:source_id`. Live data wins over demo data for the
 * same identity (demo rows are placeholders until the real source is wired).
 */
function dedupeByProviderSource(listings: HousingListing[]): HousingListing[] {
  const out: HousingListing[] = [];
  const indexByKey = new Map<string, number>();
  for (const listing of listings) {
    const key = `${listing.provider}:${listing.source_id}`;
    const existing = indexByKey.get(key);
    if (existing === undefined) {
      indexByKey.set(key, out.length);
      out.push(listing);
    } else if (out[existing].data_status === "demo" && listing.data_status === "live") {
      out[existing] = listing;
    }
  }
  return out;
}

function matchesParams(
  listing: HousingListing,
  params: HousingSearchParams,
): boolean {
  const city = params.city.trim().toLowerCase();
  if (city && !listing.city.toLowerCase().includes(city)) return false;

  const plz = params.postal_code.trim();
  if (plz && !(listing.postal_code ?? "").startsWith(plz)) return false;

  if (params.accommodation_type !== "all" && listing.accommodation_type !== params.accommodation_type)
    return false;

  // A max-warm filter requires a known warm rent to compare against.
  if (params.max_warm_rent != null) {
    if (listing.rent_warm_eur == null) return false;
    if (listing.rent_warm_eur > params.max_warm_rent) return false;
  }

  if (params.rooms !== "all" && listing.rooms !== params.rooms) return false;

  // "available before": listings without a stated date are kept (unknown
  // availability is not evidence of a mismatch).
  if (params.available_before != null) {
    if (listing.available_from != null && listing.available_from > params.available_before)
      return false;
  }

  if (params.min_area_sqm != null) {
    if (listing.living_area_sqm == null || listing.living_area_sqm < params.min_area_sqm)
      return false;
  }

  if (params.furnished_only && !listing.furnished) return false;
  if (params.wg_suitable_only && !listing.wg_suitable) return false;
  if (params.pets_allowed_only && listing.pets_allowed !== true) return false;
  if (params.verified_only && !listing.verified) return false;

  return true;
}

/**
 * The real radius filter. Only runs when the city geocoded (fail-open design):
 *   * listings WITH coordinates must lie within `radius_km` (haversine);
 *   * listings WITHOUT coordinates fall back to the city-name match already
 *     done in {@link matchesParams} (absence of coordinates is not exclusion).
 */
function withinRadius(
  listing: HousingListing,
  center: { lat: number; lon: number },
  radiusKm: number,
): boolean {
  if (listing.latitude == null || listing.longitude == null) return true;
  return haversineKm(center, { lat: listing.latitude, lon: listing.longitude }) <= radiusKm;
}

function sortValue(listing: HousingListing, key: "newest" | "price"): number {
  if (key === "newest") {
    const ts = Date.parse(listing.provider_updated_at ?? "");
    return Number.isNaN(ts) ? Number.NEGATIVE_INFINITY : ts;
  }
  return listing.rent_warm_eur ?? Number.POSITIVE_INFINITY;
}

function sortListings(
  listings: HousingListing[],
  sort: HousingSearchParams["sort"],
): HousingListing[] {
  const copy = [...listings];
  copy.sort((a, b) => {
    if (sort === "price_asc") return sortValue(a, "price") - sortValue(b, "price");
    if (sort === "price_desc") return sortValue(b, "price") - sortValue(a, "price");
    // newest (default)
    return sortValue(b, "newest") - sortValue(a, "newest");
  });
  return copy;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * Run a housing search across all ENABLED + LICENSED providers, plus the
 * labeled demo fixtures, with failure isolation, dedupe, an honest radius
 * filter, and pagination.
 */
export async function searchHousing(
  params: HousingSearchParams,
  options: HousingSearchOptions = {},
): Promise<HousingSearchResult> {
  const limit = clampInt(options.pagination?.limit, 30, 1, 100);
  const offset = clampInt(options.pagination?.offset, 0, 0, 10000);
  const adapters = options.adapters ?? PROVIDER_ADAPTERS;
  // `undefined` → default geocoder; `null` → disabled (tests / kill switch).
  const geocode: GeocodeFn | null =
    options.geocode === undefined ? geocodePlace : options.geocode;
  const adapterTimeoutMs =
    options.adapterTimeoutMs === undefined
      ? ADAPTER_TIMEOUT_MS
      : Math.max(1, Math.round(options.adapterTimeoutMs));

  // 1) Live adapters — isolated, bounded, re-stamped "live" defensively.
  const live: HousingListing[] = [];
  await Promise.all(
    adapters.map(async (adapter) => {
      if (!providerEnabled(adapter.id)) return;
      if (!adapter.isLicensed()) return; // hard gate — unlicensed sources never run
      try {
        const results = await withTimeout(adapter.search(params), adapterTimeoutMs);
        for (const item of results) {
          live.push(normalizeListing({ ...item, data_status: "live" }));
        }
      } catch {
        // A single failing/timing-out provider must not break the search.
      }
    }),
  );

  // 2) Candidate pool: live first (dedupe gives live priority over demo).
  const candidates = dedupeByProviderSource([...live, ...demoListings()]);

  // 3) Expired listings are dropped; unknown state (null) is kept.
  const active = candidates.filter((listing) => listing.listing_active !== false);

  // 4) Filters (city/PLZ/type/rent/rooms/area/flags).
  let filtered = active.filter((listing) => matchesParams(listing, params));

  // 5) Honest radius: applied only when the city actually geocoded.
  let radiusApplied = false;
  const city = params.city.trim();
  if (city && params.radius_km > 0 && geocode !== null) {
    let center: { lat: number; lon: number } | null = null;
    try {
      const place = await geocode(city);
      center = place ?? null;
    } catch {
      center = null; // fail open — geocoders must not take the search down
    }
    if (center) {
      radiusApplied = true;
      filtered = filtered.filter((listing) => withinRadius(listing, center, params.radius_km));
    }
  }

  // 6) Sort + paginate on a STABLE pre-pagination total.
  const sorted = sortListings(filtered, params.sort);
  const total = sorted.length;
  const page = sorted.slice(offset, offset + limit);

  const isDemo = page.every((listing) => listing.data_status === "demo");
  return {
    listings: page,
    total,
    has_more: offset + limit < total,
    radius_applied: radiusApplied,
    is_demo: isDemo,
    data_status: isDemo ? "demo" : "live",
  };
}

/**
 * Resolve a single listing by provider identity (used by the save flow so the
 * snapshot is re-derived server-side, never trusted from the client).
 */
export function findListingById(
  provider: string,
  sourceId: string,
): HousingListing | null {
  const all = [...demoListings()];
  return (
    all.find((l) => l.provider === provider && l.source_id === sourceId) ?? null
  );
}

/**
 * The set of provider ids that can currently contribute data (enabled AND
 * licensed). Exposed for the UI/source badges and for tests. Empty today.
 */
export function activeProviderIds(): string[] {
  return PROVIDER_ADAPTERS.filter(
    (adapter) => providerEnabled(adapter.id) && adapter.isLicensed(),
  ).map((adapter) => adapter.id);
}
