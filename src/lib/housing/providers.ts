import "server-only";

import type { HousingListing, HousingProviderAdapter } from "./types";

/**
 * Housing / "Wohnen" — provider layer.
 *
 * The product ships NO demo/sample listing data (removed 2026-10-10). The
 * only listings the Wohnen surface displays are the genuine LIVE results of
 * the Azure AI Foundry web search (src/lib/housing/web-search) — each with
 * its original source URL and citation.
 *
 * The listing surface is a provider-ADAPTER abstraction for the future: a
 * licensed adapter implements {@link HousingProviderAdapter} and is
 * registered in {@link PROVIDER_ADAPTERS}; it must be `isLicensed()` (with a
 * citable `termsRef`). Until such an adapter exists, no listing can be
 * resolved by id (`findListingById` → null, so the save/application routes
 * answer 404 "Listing not found.") and no adapter data is served.
 */

/** Re-export so existing imports (`from "./providers"`) keep working. */
export type { HousingProviderAdapter } from "./types";

/** A single adapter may not hold the whole search hostage. */
export const ADAPTER_TIMEOUT_MS = 8000;
const EARTH_RADIUS_KM = 6371;

/** Registered live adapters. Intentionally EMPTY — there is no licensed free
 *  German rental API. Adding a licensed source here (isLicensed() true, with
 *  a real `termsRef`) is the ONLY way live provider data can enter the
 *  product (alongside the Azure web search). */
export const PROVIDER_ADAPTERS: readonly HousingProviderAdapter[] = [];

/**
 * Per-provider kill switches. A provider id present here with `false` is
 * excluded from results even if licensed. Absent ids default to enabled.
 */
const PROVIDER_KILL_SWITCHES: Record<string, boolean> = {};

function providerEnabled(providerId: string): boolean {
  return PROVIDER_KILL_SWITCHES[providerId] !== false;
}

/** Normalize a partial provider row into a complete, null-safe listing. */
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

/** Pure great-circle distance in km (exported for tests). */
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

/**
 * Resolve a single listing by provider identity (used by the save flow so
 * the snapshot is re-derived server-side, never trusted from the client).
 *
 * Listings exist only via licensed, registered adapters. With
 * PROVIDER_ADAPTERS empty (the current state) every lookup misses — the
 * save/application routes answer 404 "Listing not found." (The demo
 * fixtures that used to back this lookup were removed; previously saved
 * rows keep working because their snapshot is stored in the database.)
 */
export function findListingById(provider: string, sourceId: string): HousingListing | null {
  const adapter = PROVIDER_ADAPTERS.find((a) => a.id === provider);
  if (!adapter || !providerEnabled(adapter.id) || !adapter.isLicensed()) return null;
  if (sourceId === "") return null;
  // The adapter contract is search-based (no synchronous id index) — nothing
  // to resolve until an id-indexed licensed adapter is registered.
  return null;
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
