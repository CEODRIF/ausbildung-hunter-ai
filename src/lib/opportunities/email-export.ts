import type { Opportunity } from "./types";

/**
 * Email-export eligibility for the AI Search Excel export.
 *
 * The export exists for OUTREACH: an opportunity qualifies only when the
 * source actually published a real, non-empty, non-placeholder email
 * address in its contact block. The email itself comes exclusively from
 * `opportunity.contact.email`, which is only populated from the source's
 * published description — it is never fabricated or inferred here.
 *
 * Pure module: imported by BOTH the client (count + button state) and the
 * export route (filter + dedupe), so the number shown to the user is
 * computed with exactly the same rules as the workbook content.
 */

/** Values a source sometimes publishes instead of a real address. */
const EMAIL_PLACEHOLDERS = new Set([
  "n/a",
  "n.a.",
  "na",
  "none",
  "null",
  "nil",
  "not available",
  "not-available",
  "no email",
  "no e-mail",
  "email not available",
  "e-mail not available",
  "keine",
  "keine angabe",
  "keine email",
  "keine e-mail",
  "nichts",
  "unbekannt",
  "unknown",
  "pending",
  "tbd",
  "to be determined",
  "—",
  "–",
  "-",
]);

/** Minimal structural email check (local@domain.tld) — no inference. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Normalize a raw contact email. Returns the trimmed address when it is a
 * real, non-empty, non-placeholder email; null otherwise. Whitespace runs
 * inside the value are collapsed (OCR/parsing artifacts), the result must
 * stay ≤ 254 characters (RFC 5321).
 */
export function normalizeOpportunityEmail(
  raw: string | null | undefined,
): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.replace(/\s+/g, " ").trim();
  if (trimmed.length === 0 || trimmed.length > 254) return null;
  if (EMAIL_PLACEHOLDERS.has(trimmed.toLowerCase())) return null;
  if (!EMAIL_PATTERN.test(trimmed)) return null;
  return trimmed;
}

/** The exportable email of an opportunity, or null when not qualified. */
export function opportunityEmail(
  opportunity: Pick<Opportunity, "contact">,
): string | null {
  return normalizeOpportunityEmail(opportunity.contact?.email);
}

/** Dedupe key: case- and whitespace-insensitive (same contact address). */
export function emailDedupeKey(email: string): string {
  return email.replace(/\s+/g, "").toLowerCase();
}

/**
 * Filter to opportunities with a valid email and remove duplicate emails,
 * keeping the FIRST (highest-ranked) occurrence of each address in stable
 * order. Never invents or reorders data.
 */
export function exportableOpportunities(
  opportunities: Opportunity[],
): Opportunity[] {
  const seen = new Set<string>();
  const out: Opportunity[] = [];
  for (const opportunity of opportunities) {
    const email = opportunityEmail(opportunity);
    if (email === null) continue;
    const key = emailDedupeKey(email);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(opportunity);
  }
  return out;
}

/**
 * How many results contain a valid (non-placeholder) email — the number
 * shown in the export summary ("N von M Angeboten …"). Counts every
 * qualifying result, before duplicate removal.
 */
export function resultsWithEmailCount(
  opportunities: Opportunity[],
): number {
  let count = 0;
  for (const opportunity of opportunities) {
    if (opportunityEmail(opportunity) !== null) count += 1;
  }
  return count;
}
