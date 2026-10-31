/**
 * AUTO BEWERB — Step 5: deterministic template matching.
 *
 * Evaluates ALL 50 original cover-letter templates against a company's
 * verified ad data + the candidate's verified profile, and ranks them.
 * Pure function (no AI, no I/O) → fully testable and reproducible: the same
 * inputs always select the same original template (tie-break: PDF page).
 *
 * Scoring (documented weights):
 *   context:      the ad's context (Ausbildung/Praktikum vs. work experience)
 *                 is a HARD filter — an Ausbildungsstelle never gets a
 *                 work-experience letter and vice versa (no context signal →
 *                 "ausbildung", the flow's default population).
 *   profession:   exact +30 · prefix/suffix containment +18 · shared content
 *                 tokens +6 each (capped)
 *   field:        field terms contained in the ad text +8 each (capped)
 *   salutation:   named templates only fit when the ad names a contact person
 *                 (otherwise the AI would have to rewrite the salutation, a
 *                 structural change)
 *   internship:   templates referencing a [Praktikum] fit only when the
 *                 verified profile actually contains internship experience
 */
import { COVER_LETTER_TEMPLATES, type CoverLetterTemplate, type LetterContext } from "./letter-templates";

export interface TemplateMatchInput {
  /** Ad: advertised role title (verbatim). */
  jobTitle: string;
  /** Ad: occupation / Ausbildungsgang. */
  occupation: string;
  /** Ad: raw text (for context + field signals). */
  adRaw: string;
  /** Ad: explicitly named contact person ("" = none). */
  contactPerson: string;
  /** Profile: verified internship/practical-experience entries. */
  hasInternshipExperience: boolean;
}

export interface TemplateMatch {
  template: CoverLetterTemplate;
  score: number;
  reasons: string[];
}

/** Strip diacritics + non-alphanumerics for content token comparison. */
const norm = (s: string) =>
  (s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Function words that must not count as profession tokens. */
const STOP = new Set([
  "als", "fur", "und", "der", "die", "das", "im", "in", "auf", "zu", "einen", "eine",
  "einem", "einer", "dem", "den", "des", "ein", "eine:r", "auszubildende", "auszubildender",
  "ausbildung", "ausbildungsplatz", "ausbildungsstelle", "bewerbung", "stelle", "arbeitsstelle",
  "praktikum", "an", "von", "mit", "bei", "ihren", "ihrer", "ihr", "zum", "zur", "sich",
]);

const tokens = (s: string) => norm(s).split(" ").filter((t) => t.length >= 3 && !STOP.has(t));

/** The ad's context. Hard signal in jobTitle/occupation first, then adRaw. */
export function adLetterContext(jobTitle: string, occupation: string, adRaw: string): LetterContext {
  const strong = `${jobTitle} ${occupation}`;
  if (/(ausbildung|auszubildend|praktikum)/i.test(strong)) return "ausbildung";
  if (/(ausbildung|auszubildend)/i.test(adRaw)) return "ausbildung";
  if (/(berufserfahrung|jahre Erfahrung|mehrjährige)/i.test(adRaw)) return "erfahrung";
  return "ausbildung"; // the AUTO BEWERB flow's default population
}

function professionScore(template: CoverLetterTemplate, jobTitle: string, occupation: string): { pts: number; reasons: string[] } {
  const reasons: string[] = [];
  const tProf = norm(template.profession);
  const titles = [norm(jobTitle), norm(occupation)].filter(Boolean);
  let pts = 0;
  if (tProf && titles.some((t) => t === tProf)) {
    pts += 30;
    reasons.push("profession exact");
  } else if (titles.some((t) => (t.length >= 4 && tProf.length >= 4 && (t.includes(tProf) || tProf.includes(t))))) {
    pts += 18;
    reasons.push("profession contained");
  } else {
    const tTokens = new Set(tokens(template.profession));
    const shared = new Set<string>();
    for (const t of titles) for (const tok of tokens(t)) if (tTokens.has(tok)) shared.add(tok);
    // "Elektroniker fur Betriebstechnik" vs. "Elektroniker" style overlap:
    if (shared.size > 0) {
      pts += Math.min(18, shared.size * 6);
      reasons.push(`profession tokens: ${[...shared].join(", ")}`);
    }
  }
  return { pts, reasons };
}

function fieldScore(template: CoverLetterTemplate, adRaw: string, jobTitle: string, occupation: string): { pts: number; reasons: string[] } {
  const reasons: string[] = [];
  const hay = norm(`${jobTitle} ${occupation} ${adRaw}`);
  const fieldTerms = tokens(template.field);
  let pts = 0;
  const hits: string[] = [];
  for (const term of fieldTerms) {
    if (hay.includes(term)) {
      hits.push(term);
      pts += 8;
    }
  }
  pts = Math.min(16, pts);
  if (hits.length) reasons.push(`field: ${hits.join(", ")}`);
  return { pts, reasons };
}

/** Rank ALL templates for the input; the first entry is the auto-selection. */
export function matchCoverLetterTemplates(
  input: TemplateMatchInput,
  templates: CoverLetterTemplate[] = COVER_LETTER_TEMPLATES,
): TemplateMatch[] {
  const context = adLetterContext(input.jobTitle, input.occupation, input.adRaw);
  const ranked: TemplateMatch[] = [];
  for (const template of templates) {
    // HARD filter: context. A template of the wrong context never wins.
    if (template.context !== context) continue;
    const reasons: string[] = [
      `context=${context}`,
      `salutation=${template.salutationStyle}`,
    ];
    let score = 0;

    const prof = professionScore(template, input.jobTitle, input.occupation);
    score += prof.pts;
    reasons.push(...prof.reasons);

    const fld = fieldScore(template, input.adRaw, input.jobTitle, input.occupation);
    score += fld.pts;
    reasons.push(...fld.reasons);

    // Salutation fit: "named" templates need a verified contact person.
    if (template.salutationStyle === "named") {
      if (input.contactPerson.trim()) {
        score += 4;
        reasons.push("named salutation fits (contact person verified)");
      } else {
        score -= 12;
        reasons.push("named salutation without contact person (weaker fit)");
      }
    }

    // Internship paragraph: only fits with verified internship experience.
    if (template.hasInternship) {
      if (input.hasInternshipExperience) {
        score += 4;
        reasons.push("internship paragraph fits (verified in profile)");
      } else {
        score -= 6;
        reasons.push("internship paragraph would need rewriting (no verified internship)");
      }
    }

    ranked.push({ template, score, reasons });
  }
  // Deterministic order: score desc, then PDF page asc.
  ranked.sort((a, b) => b.score - a.score || a.template.page - b.template.page);
  return ranked;
}

/** The auto-selected template (top of the ranking). Never null for the
 *  shipped library: every context has candidates. */
export function selectBestCoverLetterTemplate(
  input: TemplateMatchInput,
  templates: CoverLetterTemplate[] = COVER_LETTER_TEMPLATES,
): { template: CoverLetterTemplate; score: number; reasons: string[] } {
  const ranked = matchCoverLetterTemplates(input, templates);
  const top = ranked[0];
  if (!top) throw new Error("template library is empty");
  return top;
}
