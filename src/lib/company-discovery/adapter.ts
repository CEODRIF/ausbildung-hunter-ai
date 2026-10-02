/**
 * The offer-source adapter contract (§3.5).
 *
 * Adapters exist ONLY for sources the registry classified `enabled_*`. They
 * map exactly what a listing states and leave everything else `null` — no
 * salary, no start date, no state is ever inferred (§3.5). An adapter never
 * throws into the orchestrator: every outcome is a value, because one
 * unreachable portal must never take down a run (§4.7).
 */

import type { OpportunitySearchParams } from "@/lib/opportunities/types";
import type { SourceCategory, SourceId, SourcePolicy } from "./sources";

/** One offer as a listing actually published it. */
export interface NormalizedOffer {
  companyName: string;
  /** Only when the listing links the company's own site. */
  companyWebsite: string | null;
  role: string | null;
  field: string | null;
  city: string | null;
  state: string | null;
  offerType: "ausbildung" | "arbeit" | null;
  /** Documented planned start (YYYY-MM-DD), or null — never guessed. */
  beginn: string | null;
  salary: string | null;
  /** Portal display name, exactly as in the registry. */
  offerSource: string;
  offerUrl: string;
  /**
   * The address printed IN the listing (the only case a portal may contribute
   * one, §3.1). Everything else is discovered later from the company's own
   * public pages.
   */
  publishedEmail: { email: string; evidence: string } | null;
  /** The listing's own visible text — the literal-presence base for §4.2a. */
  listingText: string;
  /** Stable identity for the candidate row. */
  candidateRef: string;
}

export type AdapterResult =
  | { status: "ok"; offers: NormalizedOffer[] }
  | { status: "blocked"; reason: string }
  | { status: "error"; message: string };

export interface AdapterFetchContext {
  /** Requests already issued in this run (budget accounting). */
  readonly requests: number;
}

export interface OfferSourceAdapter {
  id: SourceId;
  /** Exactly as in the registry / §3.2. */
  displayName: string;
  category: SourceCategory;
  policy: Extract<SourcePolicy, "enabled_public" | "enabled_official_api">;
  /**
   * Collect the Ausbildung/Azubi offers matching the criteria. Must never
   * throw; a block is `blocked`, a technical failure is `error`.
   */
  searchOffers(
    criteria: OpportunitySearchParams,
    ctx: unknown,
  ): Promise<AdapterResult>;
}

/** The adapter for a registry entry, or null when the source is not enabled. */
export interface AdapterRegistration {
  adapter: OfferSourceAdapter;
  /**
   * False when the source's search endpoint could not be confirmed against a
   * live page during the implementation (the audit's network budget is limited
   * to robots.txt and terms, §3.4). The owner confirms it once; until then the
   * adapter runs fail-closed: an unexpected page yields ZERO offers, never
   * invented ones.
   */
  endpointConfirmed: boolean;
}
