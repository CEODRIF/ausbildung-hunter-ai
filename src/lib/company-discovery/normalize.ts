/**
 * Company Discovery — mapping from run parameters to the EXISTING
 * Opportunities/BA search engine, plus the discovery-only gates.
 *
 * Reuse contract (no second search engine):
 *   - goal         → the engine's goal (BA angebotsart) + goal-consistency
 *                    matcher — one pass per concrete goal;
 *   - field        → the engine's `keyword` (BA full-text `was`);
 *   - role         → the engine's server-side role matcher (all foldNorm
 *                    tokens present in the source's documented occupation
 *                    fields) — relevance by DOCUMENTED data, never by the
 *                    per-user match score (which is display-only and is not
 *                    requested here: match=false);
 *   - beginn       → "from_now" → engine "now"; "month" → engine "YYYY-MM";
 *                    "date"/"year" → the discovery gate below (the engine
 *                    has no date/year buckets and is not extended for this);
 *   - normalization → the shared `normalizeSearchParams` (whitespace
 *                    collapsing, cross-parameter rules).
 */

import {
  normalizeSearchParams,
  type Opportunity,
  type OpportunitySearchParams,
} from "@/lib/opportunities/types";
import type {
  DiscoveryBeginn,
  DiscoveryRunParams,
} from "./types";

/** The concrete goal passes a run executes ("both" = two independent passes). */
export function goalPasses(goal: DiscoveryRunParams["goal"]): Array<"ausbildung" | "arbeit"> {
  switch (goal) {
    case "ausbildung":
      return ["ausbildung"];
    case "arbeit":
      return ["arbeit"];
    case "both":
      return ["ausbildung", "arbeit"];
  }
}

/**
 * One discovery pass → a normalized Opportunities search query.
 * National search (no location/cities/freshness/sort changes): the BA
 * relevance order is the candidate order.
 */
export function mapToSearchParams(
  params: DiscoveryRunParams,
  goal: "ausbildung" | "arbeit",
): OpportunitySearchParams {
  const beginn: OpportunitySearchParams["beginn"] =
    params.beginn.mode === "from_now"
      ? "now"
      : params.beginn.mode === "month"
        ? params.beginn.month
        : "any"; // date/year are enforced by discoveryBeginnGate
  return normalizeSearchParams({
    goal,
    keyword: params.field,
    role: params.role,
    company: "",
    location: "",
    cities: [],
    beginn,
    freshness: "any",
    sort: "relevance",
    employment: "any",
    training_type: "any",
    home_office: "any",
    salary: "any",
    contact_email: "any",
    page: 1,
    pageSize: 50,
    match: false,
  });
}

/**
 * Discovery beginn gate for the modes the engine cannot express.
 * Documented `valid_from` only — a missing start NEVER matches a concrete
 * constraint (no guessing). "from_now"/"month" return true here because the
 * engine's own beginn matcher already enforces them on the window.
 */
export function discoveryBeginnGate(
  item: { valid_from: string | null },
  beginn: DiscoveryBeginn,
): boolean {
  if (beginn.mode === "from_now" || beginn.mode === "month") return true;
  const start = item.valid_from ? item.valid_from.slice(0, 10) : null;
  if (!start) return false;
  if (beginn.mode === "date") return start === beginn.date;
  return start.slice(0, 4) === String(beginn.year);
}

/** The raw candidate facts stored per offer (compact, no PII). */
export function candidateFromOpportunity(
  opp: Opportunity,
): {
  candidateRef: string;
  title: string | null;
  companyName: string | null;
  city: string | null;
  goal: "ausbildung" | "arbeit";
  beginn: string | null;
  salaryLabel: string | null;
  url: string | null;
} {
  return {
    // The stable provider key (e.g. "arbeitsagentur:123…") is the ref.
    candidateRef: opp.id,
    title: opp.title,
    companyName: opp.company_name,
    city: opp.location_detail?.city ?? null,
    goal: opp.goal,
    beginn: opp.valid_from ? opp.valid_from.slice(0, 10) : null,
    salaryLabel: opp.salary?.label ?? null,
    url: opp.source_url,
  };
}

/** The counting facts of ONE company from the offer that proved it. */
export function companyFactsFromOpportunity(
  opp: Opportunity,
  params: DiscoveryRunParams,
  companyKey: string,
): {
  companyKey: string;
  companyName: string;
  role: string | null;
  field: string;
  offerType: "ausbildung" | "arbeit";
  city: string | null;
  state: string | null;
  beginn: string | null;
  salaryLabel: string | null;
  offerSource: string | null;
  offerUrl: string | null;
} {
  return {
    companyKey,
    companyName: opp.company_name as string,
    role: params.role,
    field: params.field,
    offerType: opp.goal,
    city: opp.location_detail?.city ?? null,
    // BA documents `region` (Bundesland-equivalent) — mapped to "state".
    state: opp.location_detail?.region ?? null,
    beginn: opp.valid_from ? opp.valid_from.slice(0, 10) : null,
    salaryLabel: opp.salary?.label ?? null,
    offerSource: opp.source_name,
    offerUrl: opp.source_url,
  };
}
