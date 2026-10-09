import "server-only";

/**
 * Housing / "Wohnen" — city geocoding for REAL radius search.
 *
 * Data source: OpenStreetMap Nominatim (https://nominatim.org/usage-policy/).
 * It is free and requires no credentials, but its usage policy is a contract:
 *   * max 1 request per second   → we space requests by ≥1000 ms
 *   * a valid User-Agent         → we send the public app URL
 *   * caching results            → in-process LRU cache (500 entries)
 *
 * Fail-open by design: any network error, timeout, non-200, or empty answer
 * yields `null` (and that `null` is cached, so one unresolvable city cannot
 * hammer the endpoint). The search then falls back to city-name matching and
 * reports `radius_applied: false` — never a fake radius.
 *
 * `fetchImpl` is injectable so tests run fully offline.
 */

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const MIN_INTERVAL_MS = 1000;
const REQUEST_TIMEOUT_MS = 5000;
const CACHE_MAX_ENTRIES = 500;
/** Restrict results to Germany — the product's scope. */
const COUNTRY_CODES = "de";

export interface GeocodedPlace {
  lat: number;
  lon: number;
  /** Nominatim `display_name` (e.g. "Köln, Nordrhein-Westfalen, Deutschland"). */
  label: string;
}

type CacheValue = GeocodedPlace | null;

// In-process LRU cache: Map iteration order = insertion order, so deleting +
// re-setting a key on access moves it to the "newest" end.
const cache = new Map<string, CacheValue>();
let lastRequestAt = 0;

/** User-Agent per the Nominatim policy: a valid contact identifier. */
export function geocodeUserAgent(): string {
  const base = process.env.APP_URL || "https://ausbildungsweg.net";
  return `AusbildungsWeg/1.0 (${base}; housing radius search)`;
}

function cacheKey(query: string): string {
  return query.trim().toLowerCase();
}

function cacheSet(key: string, value: CacheValue): CacheValue {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return value;
}

/** Test/ops hook: drop all cached places and reset the request spacing. */
export function clearGeocodeCache(): void {
  cache.clear();
  lastRequestAt = 0;
}

async function respectRateLimit(): Promise<void> {
  // Claim the slot SYNCHRONOUSLY before yielding: two back-to-back calls in
  // the same tick must still serialize to 1 req/s, not slip through.
  const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
  lastRequestAt = Date.now() + Math.max(0, wait);
  if (wait > 0) {
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

/**
 * Geocode a city/place name (German focus). Returns `null` on ANY failure —
 * callers treat null as "cannot apply a radius", never as "no results".
 */
export async function geocodePlace(
  query: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<GeocodedPlace | null> {
  const key = cacheKey(query);
  if (!key) return null;

  const cached = cache.get(key);
  if (cached !== undefined) {
    // LRU touch: move to newest.
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }

  await respectRateLimit();

  const fetchImpl = options.fetchImpl ?? fetch;
  const url =
    `${NOMINATIM_URL}?format=jsonv2&limit=1&countrycodes=${COUNTRY_CODES}` +
    `&q=${encodeURIComponent(query.trim())}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      headers: {
        "User-Agent": geocodeUserAgent(),
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!res.ok) return cacheSet(key, null);
    const json = (await res.json()) as Array<{
      lat?: string;
      lon?: string;
      display_name?: string;
    }>;
    const first = json[0];
    const lat = Number(first?.lat);
    const lon = Number(first?.lon);
    const value: GeocodedPlace | null =
      Number.isFinite(lat) && Number.isFinite(lon)
        ? { lat, lon, label: first?.display_name ?? query.trim() }
        : null;
    return cacheSet(key, value);
  } catch {
    // Network error / timeout / abort / bad JSON → fail open.
    return cacheSet(key, null);
  } finally {
    clearTimeout(timer);
  }
}
