import "server-only";

import type { OpportunitySearchParams } from "@/lib/opportunities/types";
import type { AdapterResult, OfferSourceAdapter } from "../adapter";
import { guardedFetch, type FetchContext } from "../fetch-guard";
import { parseListingPage } from "../listing";
import { enabledSources, isSourceEnabled, sourceById, type SourceId } from "../sources";

/**
 * The adapters that exist for `enabled_*` sources (§3.5).
 *
 * One adapter is implemented: Ausbildung.de, the single portal the Phase-1
 * access audit could clear (robots.txt allows the paths, the terms are
 * readable and contain no automation prohibition). The other fourteen are
 * registered as `restricted`/`unverified` in the source registry and are never
 * requested — they are reported as `skipped_by_policy` instead.
 *
 * Every adapter obeys the same contract: it goes through the guarded fetcher
 * (SSRF, robots, pacing, per-host circuit breaker, central classifier) and it
 * returns a value, never a throw. An unexpected page shape yields ZERO offers:
 * inventing one would be worse than finding none.
 */

/**
 * The search endpoint of the portal. Confirmed by the owner once; until then
 * the adapter runs fail-closed (see `ENDPOINT_CONFIRMED`). The value is a
 * literal here — never assembled from a company name or a guess about a
 * company's identity.
 */
const AUSBILDUNG_DE_SEARCH = "https://www.ausbildung.de/suche/";

/**
 * Whether the search endpoint above was verified against a live page during
 * implementation. The Phase-1 network budget covers robots.txt and terms only
 * (§3.4), so this is `false` today: the adapter is wired, policy-gated and
 * fixture-tested, and the owner confirms the endpoint once before relying on
 * its yield.
 */
export const ENDPOINT_CONFIRMED: Partial<Record<SourceId, boolean>> = {
  "ausbildung-de": false,
};

function targetGoal(criteria: OpportunitySearchParams): "ausbildung" | "arbeit" {
  return criteria.goal === "arbeit" ? "arbeit" : "ausbildung";
}

const ausbildungDe: OfferSourceAdapter = {
  id: "ausbildung-de",
  displayName: "Ausbildung.de",
  category: "ausbildung",
  policy: "enabled_public",
  async searchOffers(criteria, ctx): Promise<AdapterResult> {
    const context = ctx as FetchContext;
    const query = [criteria.role, criteria.keyword]
      .map((part) => (part ?? "").trim())
      .filter(Boolean)
      .join(" ")
      .trim();
    // Without a query there is nothing to look for — and no page to fetch.
    if (!query) return { status: "ok", offers: [] };

    const url = `${AUSBILDUNG_DE_SEARCH}?q=${encodeURIComponent(query)}`;
    const result = await guardedFetch(context, url, { textBudget: 20_000 });
    if (!result.ok) {
      if (result.kind === "blocked") {
        return { status: "blocked", reason: result.reason };
      }
      return {
        status: "error",
        message: result.kind === "unsafe" ? `unsafe_url` : result.message,
      };
    }

    const offers = parseListingPage({
      html: result.page.html,
      pageUrl: result.page.finalUrl,
      offerSource: "Ausbildung.de",
      sourceId: "ausbildung-de",
      field: criteria.keyword ?? null,
      goal: targetGoal(criteria),
    });
    return { status: "ok", offers };
  },
};

/** Every implemented adapter, keyed by source id. */
const IMPLEMENTED: Partial<Record<SourceId, OfferSourceAdapter>> = {
  "ausbildung-de": ausbildungDe,
};

/**
 * The adapter for a source — `null` for a `restricted`/`unverified` source, an
 * unregistered source, or an enabled source whose adapter is not written yet.
 * Callers report the latter as `error`, never as an empty success.
 */
export function adapterFor(sourceId: string): OfferSourceAdapter | null {
  const source = sourceById(sourceId);
  if (!source || !isSourceEnabled(source)) return null;
  return IMPLEMENTED[source.id] ?? null;
}

/** All adapters of the run, in registry order. */
export function enabledAdapters(): OfferSourceAdapter[] {
  return enabledSources()
    .map((source) => IMPLEMENTED[source.id])
    .filter((adapter): adapter is OfferSourceAdapter => adapter !== undefined);
}

/** Enabled sources that still have no adapter implementation. */
export function enabledSourcesWithoutAdapter(): SourceId[] {
  return enabledSources()
    .filter((source) => IMPLEMENTED[source.id] === undefined)
    .map((source) => source.id);
}
