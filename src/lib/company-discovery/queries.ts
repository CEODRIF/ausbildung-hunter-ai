import type { OpportunitySearchParams } from "@/lib/opportunities/types";

/**
 * The controlled query generator for the search-engine OFFER-discovery layer
 * (§7, expanded §4). It turns the run's EXISTING search criteria into a
 * bounded, deterministic set of structured query FAMILIES.
 *
 * Hard rules:
 *  - NO random or free-form queries — every query is a fixed combination of
 *    the user's role / field / location / beginn and a closed set of German
 *    Ausbildung terminology, so the result set stays scoped to real
 *    Ausbildung offers;
 *  - NO bare (unanchored) queries: a profession or field WITHOUT an
 *    Ausbildung anchor is a generic job search and is never issued here —
 *    any result that is not a real (Ausbildung/Azubi) JobPosting is excluded
 *    downstream by the JobPosting normalization + the goal/beginn gates (§8);
 *  - location is only appended when the EXISTING criteria carry one
 *    (`location` / the first selected `cities` entry): city → 4 anchor
 *    families, Bundesland (recognized from the closed 16-state list) → 2;
 *  - identical queries are deduplicated; the output order is deterministic
 *    (no shuffling), so tests are stable.
 */
export interface SearchQueryMeta {
  /** The run's concrete beginn year, when the user chose a specific year. */
  beginnYear?: number;
  /** The run's concrete beginn month ("YYYY-MM"), when chosen. */
  beginnMonth?: string;
}

type QueryCriteria = Pick<
  OpportunitySearchParams,
  "role" | "keyword" | "goal" | "location" | "cities"
>;

/** The closed German Ausbildung terminology — the query FAMILY anchors. */
export const AUSBILDUNG_ANCHORS: readonly string[] = [
  "Ausbildung",
  "Ausbildungsplatz",
  "Ausbildungsstelle",
  "Ausbildungsbetrieb",
  "Azubi",
  "Lehrstelle",
  "duale Ausbildung",
  "Ausbildungsangebot",
  "Ausbildungsplätze",
  "Auszubildende",
];

/** The anchors used for a CITY (more specific, 4 families). */
export const CITY_ANCHORS: readonly string[] = [
  "Ausbildung",
  "Ausbildungsplatz",
  "Azubi",
  "Ausbildungsbetrieb",
];

/** The anchors used for a BUNDESAND (broader region, 2 families). */
export const STATE_ANCHORS: readonly string[] = ["Ausbildung", "Ausbildungsplatz"];

/** The 16 Bundesländer — the closed list that recognizes a state string. */
export const GERMAN_STATES: readonly string[] = [
  "Baden-Württemberg",
  "Bayern",
  "Berlin",
  "Brandenburg",
  "Bremen",
  "Hamburg",
  "Hessen",
  "Mecklenburg-Vorpommern",
  "Niedersachsen",
  "Nordrhein-Westfalen",
  "Rheinland-Pfalz",
  "Saarland",
  "Sachsen",
  "Sachsen-Anhalt",
  "Schleswig-Holstein",
  "Thüringen",
];

/** True when the location string names one of the 16 Bundesländer. */
export function isGermanState(location: string): boolean {
  const clean = location.trim().toLowerCase();
  if (!clean) return false;
  return GERMAN_STATES.some(
    (state) => state.toLowerCase() === clean || state.toLowerCase().startsWith(clean + "-"),
  );
}

/**
 * Structured queries for one goal pass, capped at `limit`. Returns [] when the
 * criteria carry no usable term (nothing to look for — and no page to fetch).
 */
export function generateSearchQueries(
  criteria: QueryCriteria,
  meta: SearchQueryMeta = {},
  limit = 12,
): string[] {
  const role = (criteria.role ?? "").replace(/\s+/g, " ").trim();
  const field = (criteria.keyword ?? "").replace(/\s+/g, " ").trim();
  const term = role || field;
  const location = (criteria.location ?? "").replace(/\s+/g, " ").trim();
  const city =
    !location && criteria.cities && criteria.cities.length > 0
      ? criteria.cities[0].replace(/\s+/g, " ").trim()
      : location;
  const year =
    typeof meta.beginnYear === "number" &&
    meta.beginnYear >= 2000 &&
    meta.beginnYear <= 2100
      ? String(meta.beginnYear)
      : null;
  const month =
    typeof meta.beginnMonth === "string" && /^\d{4}-\d{2}$/.test(meta.beginnMonth)
      ? meta.beginnMonth
      : null;

  // For the `arbeit` goal the existing anchors stay (jobs, not Ausbildung).
  const anchors: readonly string[] =
    criteria.goal === "arbeit"
      ? ["Ausbildung", "Ausbildungsplatz", "Job", "Berufseinstieg"]
      : AUSBILDUNG_ANCHORS;
  const cityAnchors: readonly string[] =
    criteria.goal === "arbeit" ? CITY_ANCHORS.slice(0, 2) : CITY_ANCHORS;
  const stateAnchors: readonly string[] =
    criteria.goal === "arbeit" ? STATE_ANCHORS.slice(0, 1) : STATE_ANCHORS;

  const terms: string[] = [];
  const push = (value: string): void => {
    const clean = value.replace(/\s+/g, " ").trim();
    // Too short to be a useful, scoped query — drop it.
    if (clean.length < 3) return;
    if (terms.includes(clean)) return; // deterministic dedupe
    terms.push(clean);
  };

  // 1. every anchor + the concrete term the user actually searched for.
  for (const anchor of anchors) {
    if (term) push(`${anchor} ${term}`);
  }
  // 2. the LOCATION dimension — only when the criteria carry one. A city
  //    gets the 4 specific anchors; a recognized BUNDESAND the 2 broader
  //    ones (the two dimensions are mutually exclusive per location value).
  if (city && term) {
    const locationAnchors = isGermanState(city) ? stateAnchors : cityAnchors;
    for (const anchor of locationAnchors) push(`${anchor} ${term} ${city}`);
  }
  // 4. a concrete beginn year/month narrows to the right intake.
  if (year && term) push(`${term} Ausbildung ${year}`);
  if (month && term) push(`${term} Ausbildung ${month}`);

  return terms.slice(0, Math.max(1, Math.min(limit, terms.length)));
}
