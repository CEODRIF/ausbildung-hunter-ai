/**
 * AUTO BEWERB — Step 4: the CONTROLLED TRANSFORMATION of the tailored CV.
 *
 * The tailoring model may only improve the four content sections of a
 * German CV that carry the "fit" for a specific job:
 *
 *   PROFIL            → CvDocument.summary
 *   KENNTNISSE        → CvDocument.skills  (KENNTNISSE and
 *   EDV-KENNTNISSE    → EDV-KENNTNISSE map to the model's single
 *                        `skills` list)
 *   HOBBYS            → CvDocument.interests
 *
 * EVERY other field — personal data + contact details, education,
 * employment history, dates, languages, certificates, projects, template,
 * appearance settings — is platform-owned and copied 1:1 from the
 * candidate's ORIGINAL CV (the deterministic importCandidateProfileToCv
 * mapping of the parsed upload), no matter what the model outputs. This
 * is enforced in CODE, not in the prompt: mergeTailoredCvDocument() builds
 * the result from the original document and writes only the whitelisted
 * fields (TAILORABLE_CV_FIELDS).
 *
 * Inside the whitelist, the merge additionally enforces:
 *  - GROUNDING: a skill/interest the model adds must be traceable to the
 *    candidate's own CV — every significant word of the term must appear
 *    in the formatted profile text (the only candidate facts the model
 *    ever sees). Terms without such a basis are dropped, so unsupported
 *    qualifications, skills or hobbies can never reach the document, no
 *    matter what the model returns;
 *  - COMPLETENESS: every verified skill/interest of the original CV stays
 *    in the document even if the model omits it (appended after the
 *    model's relevance-ordered list);
 *  - NO DUPLICATES: normalized de-duplication (case/diacritic/punctuation
 *    insensitive), so a re-phrased equivalent is counted once;
 *  - LAYOUT SAFETY: the PROFIL (summary) is capped in length.
 *
 * Pure and isomorphic (client + tests), like the rest of the CV model
 * layer — no DOM, no network, no Supabase.
 */
import { sanitizeCvDocument, type CvDocument } from "@/lib/templates/cv";

/** The ONLY content fields the tailoring model may change. */
export const TAILORABLE_CV_FIELDS = ["summary", "skills", "interests"] as const;

/** Hard layout cap for the PROFIL section (keeps the one-page fit honest). */
export const TAILORED_SUMMARY_MAX_CHARS = 900;

/**
 * Normalization for skill/hobby matching: case-, diacritic- and
 * punctuation-insensitive, ß→ss, whitespace collapsed
 * ("MS Excel" ≡ "ms excel", "Team-Arbeit" ≡ "team arbeit").
 */
export function normalizeSkillTerm(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * True when EVERY significant word of `term` (≥ 2 chars) appears in the
 * candidate's CV text — the deterministic "no invented facts" rule. Word
 * order and combination are free (the model may re-order or surface a
 * term from a different CV section), but new vocabulary is not.
 */
export function isGroundedTerm(term: string, profileText: string): boolean {
  const t = normalizeSkillTerm(term);
  if (t.length < 3) return false;
  const p = normalizeSkillTerm(profileText);
  if (!p) return false;
  const words = t.split(" ").filter((w) => w.length >= 2);
  if (words.length === 0) return false;
  return words.every((w) => p === w || p.includes(w));
}

/**
 * De-duplication key: the normalized term WITHOUT spaces, so German
 * compound variants count as one skill ("Netzwerktechnik" ≡
 * "Netzwerk-Technik" ≡ "Netzwerk Technik").
 */
const dedupeKey = (value: string): string => normalizeSkillTerm(value).replace(/ /g, "");

/**
 * Relevance-ordered merge of one list section (skills or interests):
 * the model's GROUNDED items first (its order = its relevance ranking
 * for THIS job), then every verified original item the model did not
 * surface. De-duplicated by the space-stripped normalized term.
 */
function mergeGroundedList(
  originalItems: string[],
  generatedItems: string[],
  profileText: string,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (value: string): void => {
    const v = value.trim();
    if (!v) return;
    const key = dedupeKey(v);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(v);
  };
  for (const item of generatedItems) {
    if (isGroundedTerm(item, profileText)) push(item);
  }
  for (const item of originalItems) push(item);
  return out;
}

/**
 * The controlled transformation (see module header).
 *
 * @param original    the candidate's original CV as CvDocument (the
 *                    deterministic `importCandidateProfileToCv` of the
 *                    parsed upload) — the base the result is built from.
 * @param generated   the RAW model output (already JSON-parsed; untrusted
 *                    shape). Must parse into a valid CvDocument or the
 *                    result is null (the route maps that to its existing
 *                    `invalid_ai_output` error).
 * @param profileText the formatted candidate profile the model saw — the
 *                    only allowed source for new skills/hobbies.
 */
export function mergeTailoredCvDocument(input: {
  original: CvDocument;
  generated: unknown;
  profileText: string;
}): CvDocument | null {
  const generated = sanitizeCvDocument(input.generated);
  if (!generated) return null;

  // A fresh normalized copy of the ORIGINAL document is the base — every
  // field starts from the candidate's verified data (sanitizeCvDocument
  // rebuilds all nested objects, so nothing is shared with the input).
  const merged = sanitizeCvDocument(input.original);
  if (!merged) return null;

  // 1) PROFIL — free text, grounded by the prompt, length-capped here.
  const summary = generated.summary.trim();
  if (summary) merged.summary = summary.slice(0, TAILORED_SUMMARY_MAX_CHARS);

  // 2) KENNTNISSE + EDV-KENNTNISSE (the model's single skills list).
  merged.skills = mergeGroundedList(input.original.skills, generated.skills, input.profileText);

  // 3) HOBBYS.
  merged.interests = mergeGroundedList(
    input.original.interests,
    generated.interests,
    input.profileText,
  );

  // Everything else (personal incl. photo, education, experience,
  // languages, certificates, projects, templateId, customization) is the
  // candidate's original data — untouched by design.
  return merged;
}
