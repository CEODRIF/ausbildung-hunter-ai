"use client";

import { useCallback, useState } from "react";
import { HousingFilters } from "./housing-filters";
import { HousingWebSearch } from "./housing-web-search";
import {
  DEFAULT_HOUSING_SEARCH,
  type HousingSearchParams,
} from "@/lib/housing/types";

interface Props {
  /** Preset filters (e.g. WG rooms or furnished) for the themed sub-pages. */
  preset?: Partial<HousingSearchParams>;
  /**
   * A shared/saved search passed as a JSON string (the `?q=` URL param, read
   * server-side by the page and forwarded as a prop — no client URL parsing,
   * so SSR and hydration always agree).
   */
  initialQuery?: string;
  /** When true (default) the filter panel is shown. */
  showFilters?: boolean;
}

const QUERY_KEYS: (keyof HousingSearchParams)[] = [
  "city",
  "postal_code",
  "radius_km",
  "accommodation_type",
  "max_warm_rent",
  "rooms",
  "available_before",
  "min_area_sqm",
  "furnished_only",
  "wg_suitable_only",
  "pets_allowed_only",
  "verified_only",
  "sort",
];

/** Pick only known, typed keys from a parsed `?q=` payload (never trust the URL). */
function sanitizeQuery(q: unknown): Partial<HousingSearchParams> {
  if (!q || typeof q !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const key of QUERY_KEYS) {
    if (key in (q as Record<string, unknown>)) {
      out[key] = (q as Record<string, unknown>)[key];
    }
  }
  return out as Partial<HousingSearchParams>;
}

/**
 * The core Wohnen search experience: filters → on-demand LIVE web search.
 *
 * There is NO demo/sample listing data on this surface (removed 2026-10-10):
 * the only listings shown are the genuine live results of the Azure web
 * search, each with its original source URL. When a search finds nothing,
 * the web-search card shows its clean empty state — never fallback data.
 */
export function HousingSearch({ preset, initialQuery, showFilters = true }: Props) {
  const [params, setParams] = useState<HousingSearchParams>(() => {
    // A shared/saved search (`?q=` JSON) wins over the preset. Sanitized so
    // only known, typed keys are applied — the URL is never trusted wholesale.
    if (initialQuery) {
      try {
        return {
          ...DEFAULT_HOUSING_SEARCH,
          ...(preset ?? {}),
          ...sanitizeQuery(JSON.parse(initialQuery)),
        };
      } catch {
        /* malformed q — fall back to the preset */
      }
    }
    return { ...DEFAULT_HOUSING_SEARCH, ...(preset ?? {}) };
  });

  const patch = useCallback((p: Partial<HousingSearchParams>) => {
    setParams((prev) => ({ ...prev, ...p }));
  }, []);
  const reset = useCallback(() => {
    setParams({ ...DEFAULT_HOUSING_SEARCH, ...(preset ?? {}) });
  }, [preset]);

  return (
    <div className="space-y-5">
      {showFilters && <HousingFilters params={params} onChange={patch} onReset={reset} />}

      {/* On-demand LIVE web search (Azure AI Foundry `web_search`) — the ONLY
          listing source on this surface: explicit trigger, per-user quota,
          verification badges, source citations and the required Bing
          attribution line. Reuses the current filter values. */}
      <HousingWebSearch params={params} />
    </div>
  );
}
