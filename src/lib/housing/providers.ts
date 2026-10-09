import "server-only";

import demoFixture from "./fixtures/demo-listings.json";
import type {
  HousingListing,
  HousingSearchParams,
  HousingSearchResult,
} from "./types";

/**
 * Housing / "Wohnen" — provider layer.
 *
 * The MVP ships ZERO live rental providers: there is no licensed, free German
 * rental data API, and scraping is explicitly out of scope. Instead:
 *
 *   1. The listing surface is a provider-ADAPTER abstraction. A future licensed
 *      adapter implements {@link HousingProviderAdapter} and is registered in
 *      {@link PROVIDER_ADAPTERS}; it must be `isLicensed()` and not kill-switched
 *      before its results are ever served.
 *   2. Until such an adapter exists, `searchHousing()` serves clearly-labeled
 *      DEMO fixtures (data_status = "demo") that link out to real portal
 *      homepages (never fabricated deep links) and never claim to be live data.
 *
 * Every result is normalized to {@link HousingListing} so the UI, the saved
 * list, and the DB snapshot all share one shape.
 */

/** A licensed source of rental listings. The MVP has none registered. */
export interface HousingProviderAdapter {
  /** Stable provider id (dedupe key, together with source_id). */
  id: string;
  /** Display name for the source badge. */
  displayName: string;
  /**
   * True only when we hold a valid license/contract for this source. This is a
   * HARD gate: an unlicensed adapter never contributes results, regardless of
   * the kill switch.
   */
  isLicensed(): boolean;
  /**
   * A per-provider kill switch. Flipping this off stops a single source's
   * results without touching the rest. Defaults to enabled.
   */
  search(params: HousingSearchParams): Promise<HousingListing[]>;
}

/**
 * Registered live adapters. Intentionally EMPTY in the MVP — there is no
 * licensed free German rental API. Adding a licensed source here (with
 * isLicensed() true) is the only way live data can enter the product.
 */
export const PROVIDER_ADAPTERS: HousingProviderAdapter[] = [];

/**
 * Per-provider kill switches. A provider id present here with `false` is
 * excluded from results even if licensed. Absent ids default to enabled.
 */
const PROVIDER_KILL_SWITCHES: Record<string, boolean> = {};

function providerEnabled(providerId: string): boolean {
  return PROVIDER_KILL_SWITCHES[providerId] !== false;
}

/** The demo fixture set — the only data source in the MVP. */
function demoListings(): HousingListing[] {
  const raw = demoFixture as unknown as {
    is_demo?: boolean;
    label?: string;
    listings?: Array<Partial<HousingListing>>;
  };
  return (raw.listings ?? []).map((item) => normalizeListing(item));
}

/** Normalize a partial fixture row into a complete, null-safe listing. */
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
  };
}

/** Label shown in the demo banner. Always non-empty in the MVP. */
export const DEMO_LABEL: string =
  (demoFixture as { label?: string }).label ??
  "Demo-Daten — keine echten Mietangebote";

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

/**
 * Run a housing search across all ENABLED + LICENSED providers, falling back
 * to (in the MVP, serving) the labeled demo fixtures.
 */
export async function searchHousing(
  params: HousingSearchParams,
): Promise<HousingSearchResult> {
  const live: HousingListing[] = [];
  for (const adapter of PROVIDER_ADAPTERS) {
    if (!providerEnabled(adapter.id)) continue;
    if (!adapter.isLicensed()) continue; // hard gate — unlicensed sources never run
    try {
      const results = await adapter.search(params);
      for (const item of results) {
        // Adapters must return live, licensed data; re-stamp defensively.
        live.push(normalizeListing({ ...item, data_status: "live" }));
      }
    } catch {
      // A single failing provider must not break the whole search.
      continue;
    }
  }

  const demo = demoListings();
  const candidates = [...live, ...demo];
  const filtered = candidates.filter((listing) => matchesParams(listing, params));
  const sorted = sortListings(filtered, params.sort);

  const isDemo = sorted.every((listing) => listing.data_status === "demo");
  return {
    listings: sorted,
    total: sorted.length,
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
 * licensed). Exposed for the UI/source badges and for tests. Empty in the MVP.
 */
export function activeProviderIds(): string[] {
  return PROVIDER_ADAPTERS.filter(
    (adapter) => providerEnabled(adapter.id) && adapter.isLicensed(),
  ).map((adapter) => adapter.id);
}
