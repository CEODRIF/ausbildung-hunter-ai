/**
 * Housing / "Wohnen" MVP — shared domain types.
 *
 * These types describe the NORMALIZED listing shape that every provider
 * (demo fixtures today, licensed adapters tomorrow) must map onto. The
 * normalization is intentionally flat and null-tolerant: a real-world listing
 * almost never has every field, and the UI must degrade gracefully (never
 * fabricate a missing price or area).
 *
 * The persistence columns in supabase/migrations/20261106000000_housing_mvp.sql
 * mirror this shape field-for-field (see the migration-schema regression test).
 */

export type AccommodationType = "apartment" | "wg_room" | "furnished" | "studio";

/** Where the data came from. The MVP only ever produces "demo". */
export type DataStatus = "demo" | "live";

export type RentSort = "newest" | "price_asc" | "price_desc";

export interface HousingListing {
  /** Provider id (e.g. "demo", later "immobilienscout24"). */
  provider: string;
  /** Provider-internal listing id (dedupe key, together with provider). */
  source_id: string;
  title: string;
  /** External deep link — the only way out to the source. Never scraped. */
  listing_url: string;
  city: string;
  postal_code: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  rent_cold_eur: number | null;
  additional_costs_eur: number | null;
  rent_warm_eur: number | null;
  deposit_eur: number | null;
  rooms: number | null;
  living_area_sqm: number | null;
  /** ISO date (yyyy-mm-dd) or null when unspecified. */
  available_from: string | null;
  furnished: boolean;
  balcony: boolean;
  pets_allowed: boolean | null;
  wg_suitable: boolean;
  /** True when the source marks the listing as verified/professional. */
  verified: boolean;
  accommodation_type: AccommodationType;
  images: string[];
  /** Feature chips shown on the card (localized elsewhere). */
  features: string[];
  description: string | null;
  provider_updated_at: string | null;
  last_checked_at: string | null;
  source_terms_version: string | null;
  /** "demo" for fixture data, "live" for licensed adapters. */
  data_status: DataStatus;
  /**
   * Whether the provider still lists this offering as available.
   * `false` = the source marks it expired/removed (excluded from results);
   * `null` = unknown (kept — absence of evidence is not evidence of expiry).
   */
  listing_active: boolean | null;
  /**
   * Web-discovery provenance (set by the web-search provider only):
   * `web_search` = discovered via search-engine index (link + title +
   * snippet-level facts), `page_fetch` = we fetched and parsed the page
   * (fetchable-policy domains only). Undefined for portal/demo data.
   */
  source_type?: "web_search" | "page_fetch";
  /**
   * Web-discovery only: floor as stated by the source (e.g. "1. OG"),
   * null when unknown. Optional so saved snapshots written before this
   * field exists keep validating (stored as JSONB, no schema change).
   */
  floor?: string | null;
  /**
   * Web-discovery only: portal name as reported by the search result
   * (e.g. "ImmoScout24"); null → the UI derives the label from the URL
   * hostname. Optional for the same snapshot-compatibility reason.
   */
  source_label?: string | null;
  /**
   * Web-discovery only: true when the location evidence does NOT confirm
   * the requested city (unknown location). `city` then carries the
   * evidence-based name (if any) — never the requested city. The UI shows
   * "Standort unbestätigt" so the user is never misled about the location.
   * 2026-10-10 fix: results used to be labelled with the searched city.
   */
  city_unverified?: boolean;
  /**
   * Web-discovery only: true when `title` is the neutral derived label
   * ("Anzeige auf <hostname>") because no title was obtained from the
   * search result — NOT a provider title.
   */
  title_is_fallback?: boolean;
  /**
   * Web-discovery only: which channel each key field came through —
   * "page" (fetched + parsed) or "search" (cited search result / model
   * JSON). Absent key = value unknown. Lets the UI show per-field
   * provenance instead of one global impression.
   */
  field_provenance?: Partial<
    Record<
      | "rent_cold_eur"
      | "rent_warm_eur"
      | "additional_costs_eur"
      | "rooms"
      | "living_area_sqm"
      | "available_from"
      | "city"
      | "floor"
      | "furnished"
      | "images",
      "page" | "search"
    >
  >;
  /**
   * Web-discovery only: machine-readable reason for the verification level
   * (localized by the UI): page fetched / fetched but unstructured /
   * portal ToS forbid fetching / robots blocked / fetch failed.
   */
  verification_notes?:
    | "page_fetched"
    | "page_unstructured"
    | "tos_no_fetch"
    | "robots_blocked"
    | "fetch_failed"
    | null;
  /**
   * How far WE verified this result — independent of the provider's own
   * `verified` badge:
   *  - `verified`           — fields parsed from the fetched page (JSON-LD or
   *                           unambiguous explicit text);
   *  - `partially_verified` — stated in a search result/snippet with a
   *                           citation, not confirmed by a page fetch;
   *  - `unverified`         — discovered, details unknown.
   * AI extraction alone NEVER yields `verified`.
   */
  verification_status?: "unverified" | "partially_verified" | "verified";
}

export interface HousingSearchParams {
  /** Free-text city name (matched case-insensitively). */
  city: string;
  /** Postal code prefix match. */
  postal_code: string;
  /** Search radius in km (informational for the MVP; demo data has no geo). */
  radius_km: number;
  accommodation_type: AccommodationType | "all";
  /** Cap on the warm rent (EUR/month), null = no cap. */
  max_warm_rent: number | null;
  /** Exact room count, or "all". */
  rooms: number | "all";
  /** Earliest move-in date (yyyy-mm-dd), null = any. */
  available_before: string | null;
  /** Minimum living area in m², null = any. */
  min_area_sqm: number | null;
  furnished_only: boolean;
  wg_suitable_only: boolean;
  pets_allowed_only: boolean;
  verified_only: boolean;
  sort: RentSort;
}

export const DEFAULT_HOUSING_SEARCH: HousingSearchParams = {
  city: "",
  postal_code: "",
  radius_km: 10,
  accommodation_type: "all",
  max_warm_rent: null,
  rooms: "all",
  available_before: null,
  min_area_sqm: null,
  furnished_only: false,
  wg_suitable_only: false,
  pets_allowed_only: false,
  verified_only: false,
  sort: "newest",
};

// NOTE: the demo listing pipeline (fixtures + demo search route) was
// removed on 2026-10-10 — the only listing source is now the live web
// search (`src/lib/housing/web-search/`). `tests/housing/no-demo-data.test.ts`
// guarantees the demo data cannot reappear.

// --- Provider adapters --------------------------------------------------------

/**
 * A licensed source of rental listings.
 *
 * Contract (honesty-by-design): an adapter may only be registered when
 * `isLicensed()` is backed by a verifiable agreement — and that agreement
 * must be citable via `termsRef` (URL or document reference). `supportedFilters`
 * declares which search filters the source genuinely applies; filters outside
 * that list are not silently faked, they are simply not supported by the source.
 */
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
   * Search-filter keys (`HousingSearchParams` field names) this source
   * genuinely supports. Documented, not assumed.
   */
  supportedFilters: readonly string[];
  /**
   * Human-readable reference (URL or document name) to the license/terms that
   * justify `isLicensed()` — the audit trail for where the data comes from.
   */
  termsRef: string;
  search(params: HousingSearchParams): Promise<HousingListing[]>;
}

/**
 * Geocode callback used to turn a city name into coordinates for radius
 * search. `null` result = "could not resolve" (fail-open: the search falls
 * back to city-name matching and reports `radius_applied: false`).
 */
export type GeocodeFn = (
  query: string,
) => Promise<{ lat: number; lon: number; label: string } | null>;

export interface HousingSearchPagination {
  /** Page size (1..100, default 30). */
  limit: number;
  /** Zero-based offset of the first result (0..10000, default 0). */
  offset: number;
}

export interface HousingSearchOptions {
  pagination?: HousingSearchPagination;
  /**
   * Test/preview hook: override the registered adapters. Production code
   * never passes this — only PROVIDER_ADAPTERS applies.
   */
  adapters?: readonly HousingProviderAdapter[];
  /**
   * Injected geocoder. `undefined` = default (Nominatim), `null` = disabled
   * (radius is never applied). Used by tests to stay deterministic/offline.
   */
  geocode?: GeocodeFn | null;
  /** Per-adapter timeout in ms (default 8000). Injectable for tests. */
  adapterTimeoutMs?: number;
}

// --- Persisted, per-user rows ------------------------------------------------

export type SavedListingStatus = "saved" | "applied" | "viewing" | "rejected" | "closed";

export interface SavedHousingListing {
  id: string;
  user_id: string;
  provider: string;
  source_listing_id: string;
  url: string;
  /** The normalized listing captured at save time. */
  snapshot: HousingListing;
  notes: string | null;
  status: SavedListingStatus;
  saved_at: string;
}

export interface SavedHousingSearch {
  id: string;
  user_id: string;
  name: string | null;
  query: HousingSearchParams;
  last_run_at: string | null;
  last_count: number;
  created_at: string;
}

export type HousingApplicationStatus =
  | "draft"
  | "prepared"
  | "contacted"
  | "viewing"
  | "accepted"
  | "declined";

export interface HousingApplication {
  id: string;
  user_id: string;
  /** Small denormalized pointer: provider, source_id, title, url. */
  listing_ref: {
    provider: string;
    source_id: string;
    title: string | null;
    url: string | null;
  };
  title: string | null;
  message_draft: string | null;
  status: HousingApplicationStatus;
  timeline: Array<{ status: HousingApplicationStatus; at: string }>;
  created_at: string;
  updated_at: string;
}

// --- Scam check --------------------------------------------------------------

export type ScamRiskLevel = "low" | "medium" | "high";

export interface ScamFinding {
  /** Stable id, used as a React key and for i18n mapping. */
  id: string;
  severity: ScamRiskLevel;
  /** Human-readable German description (UI-facing). */
  message: string;
}

export interface ScamCheckResult {
  risk: ScamRiskLevel;
  findings: ScamFinding[];
  /** True when an AI pass contributed; false for the heuristic-only result. */
  ai_assisted: boolean;
  /** Optional free-text AI summary (null when no AI pass ran). Not legal advice. */
  ai_summary: string | null;
}

// --- Affordability -----------------------------------------------------------

export interface AffordabilityInput {
  /** Net monthly income in EUR. */
  net_monthly_income: number;
  /** Warm rent in EUR/month. */
  warm_rent: number;
  /** Other recurring monthly costs (electricity, internet, …) in EUR. */
  other_monthly_costs: number;
  /** Deposit expressed in warm-rent months (typical: 2–3). */
  deposit_months: number;
}

export interface AffordabilityResult {
  monthly_total: number;
  deposit_total: number;
  rent_share: number;
  affordable: boolean;
  guideline_share: number;
}

/**
 * Trust-badge gate (UI-facing, pure, client-safe).
 *
 * The green "verified source" badge may ONLY appear on LIVE data — i.e.
 * listings produced by a registered provider adapter, re-stamped
 * `data_status: "live"` by the provider pipeline. Anything stamped "demo"
 * is NEVER verified, no matter what its `verified` field says: in sample
 * data that flag is display metadata, not evidence of any real source
 * verification. (Demo data was removed from the housing surface on
 * 2026-10-10; the gate remains as defense in depth — e.g. for saved
 * snapshots written before the removal.) There is no live provider
 * contract yet (PROVIDER_ADAPTERS = []), so this gate currently returns
 * false for every listing the app can serve.
 */
export function isVerifiedListing(
  listing: Pick<HousingListing, "data_status" | "verified">,
): boolean {
  return listing.data_status === "live" && listing.verified;
}
