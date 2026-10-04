/**
 * Company-level research confidence — the company as a whole, not just its
 * email.
 *
 * The email's own provenance score (accept.ts `confidenceScoreOf`) answers
 * "how solid is THIS address". This module answers the wider research
 * question: "how much of what we claim about THIS company is documented by a
 * page we actually opened?" — and it stays interpretable: the score is the
 * sum of the weights of the facts that are really present, every applied
 * weight is listed in `reasons`, and a contradiction between documented facts
 * is recorded as a conflict and penalized (never silently dropped).
 *
 * Hard rules (same discipline as the rest of the engine):
 *  - a fact only scores when it was MEASURED (a page opened in this run, an
 *    address literally read, a URL actually inspected) — never derived from
 *    a name, a domain, or a pattern;
 *  - deterministic: same facts → same score and same reasons;
 *  - the score is clamped to 0–100.
 */

// ---------------------------------------------------------------------------
// Evidence ledger
// ---------------------------------------------------------------------------

/** Where one evidence page lives (auditable vocabulary, additive). */
export type CompanyEvidenceSourceType =
  | "job_listing" // the counted offer page (portal / search result)
  | "search_result" // the page that identified the official website
  | "official_site" // a page on the company's own domain (contact/karriere/…)
  | "email_page" // the page the public address was literally read from
  | "application_page"; // the application/career page actually inspected

/**
 * One evidence item: a page the run actually opened (or the provider result
 * that pointed to it) and what that page documented. `quote` is the short
 * literal text the fact rests on — never a paraphrase.
 */
export interface CompanyEvidenceItem {
  url: string;
  sourceType: CompanyEvidenceSourceType;
  /** What this page documented (machine-stable wording, de-DE). */
  fact: string;
  /** Short literal text the fact rests on (≤ 200 chars), when one exists. */
  quote?: string;
  /** When the page was checked (UTC ISO). */
  checkedAt: string;
}

/** The measured facts of one company as of its acceptance (all nullable —
 *  an absent fact is scored as absent, never guessed). */
export interface CompanyFacts {
  /** The counted offer page (always present for a recorded company). */
  offerUrl: string | null;
  /** The occupation documented on the counted offer. */
  role: string | null;
  /** The city documented on the counted offer. */
  city: string | null;
  /** The state documented on the counted offer. */
  state: string | null;
  /** The documented start of the counted offer (ISO date). */
  beginn: string | null;
  /** The company's identified official website. */
  websiteUrl: string | null;
  /** The page that proved the website belongs to the company. */
  websiteSourceUrl: string | null;
  /** The verified public address, or null. */
  email: string | null;
  /** Every page the address was literally found on (primary first). */
  emailSourceUrls: string[];
  /** The application/career page actually inspected, or null. */
  applicationUrl: string | null;
  /** The moment the evidence was compiled (UTC ISO) — one stamp per ledger. */
  checkedAt: string;
}

/**
 * Build the company's evidence ledger from the facts the run MEASURED.
 * Only pages that actually exist in the facts are listed — nothing is
 * reconstructed, nothing is invented. An empty fact set yields an empty
 * ledger (the company row then carries no evidence and a low score).
 */
export function buildCompanyEvidence(
  facts: CompanyFacts,
): CompanyEvidenceItem[] {
  const items: CompanyEvidenceItem[] = [];
  const push = (
    url: string | null,
    sourceType: CompanyEvidenceSourceType,
    fact: string,
    quote?: string,
  ): void => {
    const cleanUrl = (url ?? "").trim();
    if (!cleanUrl) return;
    items.push({
      url: cleanUrl,
      sourceType,
      fact,
      ...(quote ? { quote: quote.slice(0, 200) } : {}),
      checkedAt: facts.checkedAt,
    });
  };

  // The counted offer page documents the training placement itself.
  if (facts.offerUrl) {
    const bits: string[] = [];
    if (facts.role) bits.push(`Ausbildungs-/Jobangebot: ${facts.role}`);
    if (facts.city || facts.state) {
      bits.push(`Standort: ${[facts.city, facts.state].filter(Boolean).join(", ")}`);
    }
    if (facts.beginn) bits.push(`Beginn: ${facts.beginn.slice(0, 4)}`);
    push(
      facts.offerUrl,
      "job_listing",
      bits.length > 0
        ? `Angebot dokumentiert — ${bits.join(" · ")}`
        : "Angebot dokumentiert (ohne weitere Details)",
    );
  }

  // The page that identified the official website.
  push(
    facts.websiteSourceUrl,
    "search_result",
    "Offizielle Website der Firma identifiziert",
  );

  // The public address, on every page it was literally read from.
  for (const sourceUrl of facts.emailSourceUrls) {
    push(sourceUrl, "email_page", `Publizierte E-Mail: ${facts.email ?? "—"}`);
  }

  // The application page that was actually inspected.
  push(
    facts.applicationUrl,
    "application_page",
    "Antrags-/Karriereseite geöffnet und geprüft",
  );

  return items;
}

// ---------------------------------------------------------------------------
// Confidence scoring
// ---------------------------------------------------------------------------

/** The weights of the interpretable confidence model (spec §15). */
export const CONFIDENCE_WEIGHTS = {
  /** The company's own official domain was identified (highest trust). */
  officialDomain: 30,
  /** A training placement for the target role was documented. */
  training: 20,
  /** The concrete role is documented on the counted offer. */
  role: 15,
  /** A location (city or Bundesland) is documented. */
  location: 10,
  /** A public email was verified from a page that prints it. */
  email: 10,
  /** The application/career page was actually inspected. */
  application: 10,
  /** A second independent source page corroborates the email. */
  secondSource: 5,
  /** Documented facts CONTRADICT each other (e.g. start year differs). */
  conflict: -10,
} as const;

export interface CompanyConfidenceInput {
  /** The official website was identified for this company. */
  officialDomain: boolean;
  /** The counted offer documents a training placement (always true for an
   *  accepted company — it IS the offer that counted it). */
  training: boolean;
  /** The counted offer documents the role. */
  role: boolean;
  /** A city or a state is documented. */
  location: boolean;
  /** A public email was verified from page evidence. */
  email: boolean;
  /** The application/career page was actually inspected. */
  application: boolean;
  /** The email appears on a second independent page. */
  secondSource: boolean;
  /** Documented facts contradict (start year documented but different). */
  conflict: boolean;
}

export interface CompanyConfidenceResult {
  /** 0–100, the sum of the weights of the present facts (clamped). */
  score: number;
  /** One human-readable reason per applied weight — the score is readable. */
  reasons: string[];
  /** True when documented facts contradict each other. */
  conflict: boolean;
}

/**
 * The company's research confidence: the sum of the weights of the facts the
 * run actually MEASURED. Every applied weight leaves a reason, so the number
 * is interpretable — never a decorative digit. Deterministic.
 */
export function companyConfidence(
  input: CompanyConfidenceInput,
): CompanyConfidenceResult {
  let score = 0;
  const reasons: string[] = [];
  const add = (weight: number, reason: string): void => {
    if (weight === 0) return;
    score += weight;
    reasons.push(reason);
  };

  if (input.officialDomain) {
    add(CONFIDENCE_WEIGHTS.officialDomain, "Offizielle Domain identifiziert");
  }
  if (input.training) {
    add(CONFIDENCE_WEIGHTS.training, "Ausbildungs-/Jobangebot dokumentiert");
  }
  if (input.role) {
    add(CONFIDENCE_WEIGHTS.role, "Konkrete Rolle dokumentiert");
  }
  if (input.location) {
    add(CONFIDENCE_WEIGHTS.location, "Standort (Stadt/Bundesland) dokumentiert");
  }
  if (input.email) {
    add(CONFIDENCE_WEIGHTS.email, "Öffentliche E-Mail aus Seitenevidenz verifiziert");
  }
  if (input.application) {
    add(CONFIDENCE_WEIGHTS.application, "Antrags-/Karriereseite geöffnet und geprüft");
  }
  if (input.secondSource) {
    add(CONFIDENCE_WEIGHTS.secondSource, "Zweite unabhängige Quelle bestätigt");
  }
  if (input.conflict) {
    add(CONFIDENCE_WEIGHTS.conflict, "Widerspruch in dokumentierten Fakten (Jahr)");
  }

  return {
    score: Math.max(0, Math.min(score, 100)),
    reasons,
    conflict: input.conflict,
  };
}
