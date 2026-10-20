/**
 * Shared, idempotent normalization for a German contact-person name.
 *
 * This application has NO gender source other than an EXPLICIT "Herr"/"Frau"
 * in the name itself: there is no gender column, and gender is deliberately
 * never inferred from a first name (see `personalization.ts`). Accordingly
 * this function only ever:
 *
 *   - collapses an accidental leading run of "Herr"/"Frau" down to exactly
 *     ONE canonical form ("Herr Herr Max" -> "Herr Max"), so a name is never
 *     double-saluted no matter how many times it is processed;
 *   - canonicalizes the salutation word's casing ("herr max" -> "Herr Max");
 *   - capitalizes the first letter of the remaining name;
 *   - leaves the name untouched when no explicit salutation is present
 *     (it NEVER guesses gender from a first name);
 *   - preserves compound names, umlauts, hyphens and apostrophes.
 *
 * It is idempotent — applying it twice yields the same string — so it is safe
 * to run at parse time, store time and render time.
 */

/** A leading run of one or more "Herr"/"Frau" tokens plus the trailing space. */
const SALUTATION_RUN_RE = /^(?:Herr|Frau)\b(?:\s+(?:Herr|Frau)\b)*\s+/i;

export function normalizeGermanSalutation(
  raw: string | null | undefined,
): string {
  const cleaned = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  const match = cleaned.match(SALUTATION_RUN_RE);
  if (!match) return cleaned;
  // The first salutation determines the canonical form; any repeats are dropped.
  const first = match[0].trim().split(/\s+/)[0];
  const canonical = first.toLowerCase() === "herr" ? "Herr" : "Frau";
  const rest = cleaned.slice(match[0].length).trim();
  if (!rest) return cleaned; // a bare "Herr"/"Frau" with no name is left as-is
  const name = rest.charAt(0).toUpperCase() + rest.slice(1);
  return `${canonical} ${name}`;
}
