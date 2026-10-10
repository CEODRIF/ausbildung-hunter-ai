import "server-only";

import { PROVIDER_LIMITS } from "./config";
import {
  ALL_TYPE_FAMILIES,
  TYPE_DE,
  TYPE_DE_ALT,
  buildDeRawQuery,
  type QueryParams,
} from "./queries";

/**
 * Multi-round Query Planner (2026-10-10 high-coverage engine task).
 *
 * One city search runs up to THREE bounded rounds instead of one shot:
 *
 *   Round 1 — BREADTH: the three strongest Google query families (core
 *               rental, WG/rooms, student/furnished/Azubi) PLUS the
 *               classic Azure complementary calls.
 *   Round 2 — DEEP DIVE (only while unique candidates < 30): availability
 *               phrasing ("frei ab …"), budget phrasing ("günstig",
 *               "Wohnungsanzeige … Miete"), Zwischenmiete, and the
 *               remaining Azure families.
 *   Round 3 — GAP FILLING (only while unique candidates < 15): `site:`
 *               queries for the major German housing portals that did NOT
 *               surface candidates yet, plus Studentenwerk coverage.
 *
 * Rules:
 *   - Deterministic (same params → same plan) so tests and diagnostics are
 *     reproducible.
 *   - Every raw query carries the user's city/postcode + their constraints
 *     (budget, rooms, move-in, radius) — built with the SAME wording
 *     function the classic pipeline uses.
 *   - De-duplicated on normalized text; hard caps per round
 *     (3+3+3 Google raw queries, ≤4 Azure total) — a round never issues
 *     duplicate or near-duplicate phrasings without new constraints.
 *   - `site:` operators are Google-side discovery of ALLOWED portals only
 *     (the reviewed allowlist from ./config) — we discover listing pages
 *     through the search engine and never fetch/scrape outside policy.
 */

export interface PlannerQuery {
  /** Raw German query (pre-wrap). */
  query: string;
  /** Family label for diagnostics (never user data). */
  family: string;
}

export interface RoundPlan {
  round: 1 | 2 | 3;
  google: PlannerQuery[];
  azure: PlannerQuery[];
}

/** Major German housing portals eligible for `site:` gap-filling.
 *  Same domains the reviewed allowlist covers (search_only policy). */
const SITE_DISCOVERY_DOMAINS = [
  "wg-gesucht.de",
  "immobilienscout24.de",
  "immowelt.de",
  "kleinanzeigen.de",
  "immonet.de",
  "housinganywhere.com",
  "wunderflats.com",
] as const;

function locationOf(p: QueryParams): string {
  const city = p.city.trim();
  return city !== "" ? city : p.postal_code.trim();
}

function norm(q: string): string {
  return q.trim().replace(/\s+/g, " ").toLowerCase();
}

/** German short month names for the "frei ab" phrasing. */
const MONTHS_DE = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
] as const;

/**
 * Plan ONE round.
 *
 * @param params user search params (city etc.)
 * @param round 1..3
 * @param existingDomains hosts that ALREADY yielded ≥1 candidate (round 3
 *   only queries portals that are still missing).
 */
export function planRound(
  params: QueryParams,
  round: 1 | 2 | 3,
  existingDomains: ReadonlySet<string> = new Set(),
): RoundPlan {
  const loc = locationOf(params);
  // Per-BUCKET dedup: the same raw query may legitimately run on BOTH
  // providers (different search index → different result slices); only
  // duplicates WITHIN one provider's plan are dropped.
  const used = new Map<"google" | "azure", Set<string>>();
  const google: PlannerQuery[] = [];
  const azure: PlannerQuery[] = [];

  const push = (bucket: "google" | "azure", family: string, raw: string): void => {
    if (raw.trim() === "") return;
    const n = norm(raw);
    let seen = used.get(bucket);
    if (!seen) {
      seen = new Set();
      used.set(bucket, seen);
    }
    if (seen.has(n)) return;
    seen.add(n);
    (bucket === "google" ? google : azure).push({ query: raw, family });
  };

  const q = (family: string, typeTerm: string): string => buildDeRawQuery(params, typeTerm);

  if (loc === "") return { round, google, azure };

  const monthTerm = (iso: string): string | null => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return `${MONTHS_DE[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  };

  if (round === 1) {
    // BREADTH — the three strongest families, distinct index rankings.
    push("google", "core", params.accommodation_type === "all" || params.accommodation_type === "apartment"
      ? q("core", "Mietwohnung")
      : q("core", TYPE_DE[params.accommodation_type]));
    push("google", "wg", q("wg", params.accommodation_type === "wg_room" ? "WG Zimmer mieten" : "WG Zimmer in " + loc));
    if (params.accommodation_type === "furnished" || params.accommodation_type === "studio") {
      push("google", "furnished", q("furnished", "möblierte Wohnung"));
    } else {
      push("google", "student", q("student", "Studentenwohnung oder Zimmer für Azubis"));
    }
    // Azure: the classic primary + one complementary family (the existing
    // bounded pool still owns its own early-stop logic). Specific types keep
    // the classic primary/alt phrasing of that type (behavior-compatible).
    if (params.accommodation_type === "all") {
      push("azure", "core", q("azure-core", "Mietwohnung"));
      push("azure", "wg", q("azure-complement", ALL_TYPE_FAMILIES[1]));
    } else {
      push("azure", "core", q("azure-core", TYPE_DE[params.accommodation_type]));
      push("azure", "alt", q("azure-complement", TYPE_DE_ALT[params.accommodation_type]));
    }
  } else if (round === 2) {
    // DEEP DIVE — phrasings that surface DIFFERENT index slices.
    if (params.available_before) {
      const m = monthTerm(params.available_before);
      if (m) push("google", "availability", `WG Zimmer frei ab ${m} ${loc}`);
    }
    if (params.max_warm_rent != null && params.rooms !== "all") {
      push(
        "google",
        "budget",
        `${params.rooms} Zimmer Wohnung ${loc} bis ${params.max_warm_rent.toLocaleString("de-DE")} Euro`,
      );
    }
    push("google", "anzeige", `Wohnungsanzeige ${loc} Miete privat`);
    push("google", "guenstig", `günstiges Zimmer mieten ${loc}`);
    if (params.accommodation_type === "all" || params.accommodation_type === "apartment") {
      push("google", "zwischenmiete", `Zwischenmiete ${loc} ab sofort`);
    }
    // Azure: the remaining classic families — "all" only (specific types
    // already had their primary+alt in round 1; no extra paid calls).
    if (params.accommodation_type === "all") {
      push("azure", "student", q("azure-complement-2", ALL_TYPE_FAMILIES[2]));
      push("azure", "privat", q("azure-complement-3", ALL_TYPE_FAMILIES[3]));
    }
  } else {
    // GAP FILLING — portals with no candidates yet + student housing.
    const missing = SITE_DISCOVERY_DOMAINS.filter((d) => !existingDomains.has(d));
    for (const d of missing) {
      if (google.length >= PROVIDER_LIMITS.googleRound3Calls - 1) break;
      push("google", `site:${d}`, `site:${d} ${loc} ${params.accommodation_type === "wg_room" ? "zimmer miete" : "wohnung miete"}`);
    }
    push("google", "studentenwerk", `Studentenwohnheim oder Studentenwerk Wohnen ${loc}`);
  }

  // Hard caps per round (env may lower via LIMITS overrides in the caller).
  const gCap =
    round === 1
      ? PROVIDER_LIMITS.googleRound1Calls
      : round === 2
        ? PROVIDER_LIMITS.googleRound2Calls
        : PROVIDER_LIMITS.googleRound3Calls;
  google.length = Math.min(google.length, gCap);
  azure.length = Math.min(azure.length, round === 1 ? 2 : round === 2 ? 2 : 0);
  return { round, google, azure };
}

/**
 * The maximum number of raw Google queries one whole run can ever issue
 * (round caps). Used for cost pre-estimation and diagnostics.
 */
export function maxGoogleQueriesPerRun(): number {
  return (
    PROVIDER_LIMITS.googleRound1Calls +
    PROVIDER_LIMITS.googleRound2Calls +
    PROVIDER_LIMITS.googleRound3Calls
  );
}
