import "server-only";

import { ALLOWED_DOMAINS, domainForHost } from "./config";

/**
 * Ranking Engine (2026-10-10 high-coverage engine task).
 *
 * Explicit, explainable signals — never keyword-match inflation. A card's
 * position comes from this score; the UI shows the top 2-3 `reasons` as
 * short translated chips ("Matches city and budget", "No price").
 *
 * Signals (points):
 *   +25 city confirmed (parsed/json/citation evidence, evidence-matched)
 *    +0 city unknown (kept + flagged, NOT boosted)
 *   +10 direct listing identity (portal offer ID or strong listing path)
 *   +10 rent known
 *   +10 warm rent within the user's budget (when a cap was set)
 *   -15 warm rent above the user's budget (when a cap was set)
 *   +10 accommodation type matches the explicit filter
 *    +5 rooms known   +5 area known   +5 floor/availability/furnished known
 *    +5 available_from within the next 60 days
 *   +10 reviewed housing portal   +5 open-data source
 *    +5 fields verified from the fetched page (JSON-LD/structured)
 *
 * Clamped 0..100. Pure function — deterministic and unit-tested.
 */

export interface RankInput {
  city: string | null;
  cityVerified: boolean;
  listingUrl: string;
  hasListingId: boolean;
  rentWarmEur: number | null;
  rentColdEur: number | null;
  rooms: number | null;
  livingAreaSqm: number | null;
  floor: string | null;
  availableFrom: string | null;
  furnished: boolean | null;
  accommodationType: string;
  requestedType: string; // "all" | specific
  maxWarmRent: number | null;
  sourceHost: string;
  pageVerified: boolean;
  /** Current date for freshness (injected for tests). */
  nowMs: number;
}

export interface RankResult {
  score: number;
  /** i18n key list (top reasons, most specific first). */
  reasons: string[];
}

const DAYS_60_MS = 60 * 24 * 60 * 60 * 1000;

export function rankListing(input: RankInput): RankResult {
  let score = 0;
  const reasons: string[] = [];

  // City — the single most important honesty signal.
  if (input.cityVerified) {
    score += 25;
    reasons.push("rank.cityMatch");
  } else {
    reasons.push("rank.cityUnknown");
  }

  // Direct listing identity.
  if (input.hasListingId) {
    score += 10;
    reasons.push("rank.directListing");
  }

  // Rent.
  const rent = input.rentWarmEur ?? input.rentColdEur;
  if (rent != null) {
    score += 10;
    reasons.push("rank.rentKnown");
    if (input.maxWarmRent != null) {
      if (rent <= input.maxWarmRent) {
        score += 10;
        reasons.push("rank.budgetFit");
      } else {
        score -= 15;
        reasons.push("rank.budgetOver");
      }
    }
  } else {
    reasons.push("rank.rentUnknown");
  }

  // Type match (only when the user picked a specific type).
  if (input.requestedType !== "all" && input.accommodationType === input.requestedType) {
    score += 10;
    reasons.push("rank.typeMatch");
  }

  // Completeness.
  if (input.rooms != null) {
    score += 5;
    reasons.push("rank.roomsArea");
  }
  if (input.livingAreaSqm != null) {
    score += 5;
  }
  if (input.floor != null || input.availableFrom != null || input.furnished != null) {
    score += 5;
  }

  // Freshness (only when the date is real).
  if (input.availableFrom) {
    const t = Date.parse(input.availableFrom);
    if (!Number.isNaN(t) && t >= input.nowMs - 7 * 24 * 3600 * 1000 && t <= input.nowMs + DAYS_60_MS) {
      score += 5;
      reasons.push("rank.fresh");
    }
  }

  // Source quality.
  const domain = domainForHost(input.sourceHost);
  if (domain) {
    score += domain.policy === "fetchable" ? 5 : 10;
    reasons.push("rank.sourceQuality");
  }

  // Page verification.
  if (input.pageVerified) {
    score += 5;
    reasons.push("rank.verified");
  }

  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  // Most specific reasons first; keep 3.
  const priority = [
    "rank.budgetFit",
    "rank.budgetOver",
    "rank.cityMatch",
    "rank.typeMatch",
    "rank.rentUnknown",
    "rank.directListing",
    "rank.fresh",
    "rank.rentKnown",
    "rank.roomsArea",
    "rank.sourceQuality",
    "rank.verified",
    "rank.cityUnknown",
  ];
  const ordered = priority.filter((k) => reasons.includes(k)).slice(0, 3);
  return { score: clamped, reasons: ordered };
}

/** Reviewed portal domains (for diagnostics / coverage reporting). */
export function reviewedPortalDomains(): string[] {
  return ALLOWED_DOMAINS.map((d) => d.domain);
}
