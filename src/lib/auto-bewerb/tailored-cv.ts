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
 * Inside the whitelist, the merge additionally enforces (deterministic,
 * no LLM in the loop):
 *  - GROUNDING: every term/token the model writes must be traceable to
 *    the candidate's own profile text (the only candidate facts the
 *    model ever sees) — see the traceability rules below. Anything
 *    unverifiable is dropped (lists) or the ORIGINAL section is kept
 *    (PROFIL). For the free-text PROFIL the grounding corpus is extended
 *    with the AD CONTEXT (exact job title / occupation / company of
 *    THIS ad) — mentioning the applied-for position is ad-grounded,
 *    not an invention;
 *  - COMPLETENESS: every verified skill/interest of the original CV
 *    stays in the document even if the model omits it (appended after
 *    the model's relevance-ordered list);
 *  - AD COVERAGE: every skill-like requirement of the ad (technical,
 *    soft, skill-like qualification) that is not present ANYWHERE in
 *    the CV yet is appended to the skills list and flagged in
 *    `tailoring.addedFromAd` — the user sees it explicitly and can
 *    remove it in the editor if it does not apply (see
 *    cv-verification.ts). Education/experience claims and language
 *    levels are NEVER auto-added (they would be fabricated facts);
 *    they are reported by the verification instead;
 *  - NO DUPLICATES: symbol-aware normalized de-duplication
 *    (case/diacritic/punctuation-insensitive, German-compound-aware;
 *    "C" ≠ "C++" ≠ "C#");
 *  - LAYOUT SAFETY: the generated PROFIL (summary) is capped at the
 *    last sentence boundary below the limit (the original summary is
 *    NEVER capped or cut — it is the candidate's own data).
 *  - PROFIL FALLBACK: when the original CV has no profile paragraph at
 *    all, a minimal deterministic summary is constructed from verified
 *    facts + the ad context — the section is never left empty.
 *
 * GROUNDING MODEL — deliberately stricter than substring matching:
 *  A token is "traceable" when it is
 *   1. a WHOLE word of the profile text, or
 *   2. a compound EDGE of a profile word (prefix/suffix of ≥ 4 chars —
 *      German compounds: "netzwerk" ⊂ "netzwerktechnik", "technik" ⊂ …),
 *      or
 *   3. a profile word plus a short inflection (≤ 4 extra chars:
 *      "supporte" ⊃ "support", "kenntnisse" ⊃ "kenntnis"), or
 *   4. a concatenation of 2–3 traceable parts (compound decomposition:
 *      "kubernetesadministration" = kubernetes + administration).
 *  NEVER an arbitrary inner substring — "py" is not grounded by
 *  "python", and "azure" has no basis in a profile without it.
 *  For the free-text PROFIL, framing vocabulary (function words,
 *  inflected adjectives, generic CV nouns, common verbs) is exempt, but
 *  fact-carrying terms (every other noun, proper name, technical term —
 *  and ALWAYS degree/certificate words like "Master" or "Zertifikat")
 *  must be traceable, and EVERY number in the PROFIL (years, dates,
 *  counts) must occur in the profile text — so "10 Jahre Erfahrung" or
 *  "C2-Niveau" without basis are rejected, while a legitimate
 *  paraphrase of the candidate's own facts is accepted.
 *
 * Pure and isomorphic (client + tests), like the rest of the CV model
 * layer — no DOM, no network, no Supabase.
 */
import { sanitizeCvDocument, type CvDocument } from "@/lib/templates/cv";
import { isTermCoveredInCv, termDedupeKey } from "./cv-verification";

/** The ONLY content fields the tailoring model may change. */
export const TAILORABLE_CV_FIELDS = ["summary", "skills", "interests"] as const;

/** Hard layout cap for the GENERATED PROFIL (summary) — the candidate's
 *  own original summary is never capped (their data is rendered in
 *  full; the renderer's overflow policy handles very long documents). */
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

/* ------------------------------------------------------------------ */
/* Profile vocabulary (the grounding corpus: what the model saw)       */
/* ------------------------------------------------------------------ */

export interface ProfileVocabulary {
  /** All (alphabetic) normalized words of the profile text. */
  words: Set<string>;
  /** All numeric words of the profile text (years, dates, counts). */
  numbers: Set<string>;
  /** Compound edges: every prefix/suffix of a profile word (5..12 chars). */
  edges: Set<string>;
}

export function buildProfileVocabulary(profileText: string): ProfileVocabulary {
  const words = new Set<string>();
  const numbers = new Set<string>();
  const wordList: string[] = [];
  for (const w of normalizeSkillTerm(profileText).split(" ")) {
    if (!w) continue;
    if (/^[0-9]+$/.test(w)) {
      numbers.add(w);
    } else {
      words.add(w);
      wordList.push(w);
    }
  }
  const edges = new Set<string>();
  for (const w of wordList) {
    const max = Math.min(12, w.length - 1);
    for (let len = 5; len <= max; len += 1) {
      edges.add(w.slice(0, len));
      edges.add(w.slice(w.length - len));
    }
  }
  return { words, numbers, edges };
}

/* ------------------------------------------------------------------ */
/* Exempt vocabulary for the free-text PROFIL                          */
/* ------------------------------------------------------------------ */

/** Pure function words / framing — never carry a verifiable claim.
 *  Stored NORMALIZED (NFD-stripped, lowercase, punctuation-free) — the
 *  tokens checked against this set are always normalized too, so umlaut
 *  entries ("für", "außerdem", …) must be added in their normalized form
 *  ("fur", "außerdem" → "außerhalb", …) or they can never match. */
const STOPWORDS = new Set(
  [
    "der", "die", "das", "den", "dem", "des", "ein", "eine", "einen", "einem", "einer", "eines",
    "man", "ich", "du", "er", "sie", "es", "wir", "mein", "meine", "meinem", "meinen", "meiner",
    "unser", "unsere", "ihr", "ihre", "seine", "seiner", "seines", "seinen", "euer", "eure",
    "und", "oder", "aber", "sowie", "als", "auch", "nur", "wenn", "weil", "dass", "damit",
    "durch", "per", "via", "mit", "ohne", "für", "bei", "nach", "aus", "in", "an", "auf",
    "über", "unter", "vor", "von", "zu", "um", "im", "am", "vom", "zum", "zur", "beim", "bis",
    "ab", "seit", "gegen", "innerhalb", "außerhalb", "während", "trotz", "wegen", "laut", "gemäß",
    "ins", "dieses", "diese", "dieser", "diesen", "diesem", "solche", "solcher", "solchen", "solches",
    "andere", "anderer", "anderen", "anderes", "alle", "aller", "allen", "genau", "einfach",
    "eigentlich", "entsprechend", "entsprechende", "entsprechenden", "entsprechendes", "teilweise",
    "sehr", "ganz", "noch", "schon", "immer", "oft", "häufig", "manchmal", "gelegentlich", "gerne",
    "heute", "jetzt", "dort", "hier", "dann", "deshalb", "darum", "somit", "daher", "also", "zudem",
    "außerdem", "insbesondere", "besonders", "vorneweg", "trotzdem", "dennoch", "wieder", "weiter",
    "neu", "neue", "neuen", "neues",
    "gut", "gute", "guten", "gutes", "guter", "besser", "bessere", "besseren", "besseres", "beste", "besten",
    "bin", "war", "wäre", "werde", "wird", "wurde", "werden", "will", "wollen", "wollte", "kann",
    "können", "konnte", "mag", "mochte", "muss", "müssen", "musste", "soll", "sollen", "sollte",
    "darf", "dürfen", "dürfte", "habe", "haben", "hatte", "hat", "bekomme", "bekommen", "bekam",
    "ja", "nein", "bitte", "danke",
  ].map(normalizeSkillTerm).filter(Boolean),
);

/**
 * Generic CV framing vocabulary (normalized stems): words that structure a
 * profile but carry no verifiable claim about the candidate's facts.
 * Matching: exact stem, or a token starting with the stem (min. 5 chars,
 * to cover inflections like "Arbeitsweisen").
 */
const GENERIC_CV_STEMS = [
  "erfahr", // Erfahrung, Erfahrungen, ...
  "kenntn", // Kenntnis, Kenntnisse(n)
  "fahigk", // Fähigkeit(en)
  "team", "teams", "teamwork",
  "zusammenarbeit", "zusammenhang",
  "arbeitsweise", "arbeit", // Arbeit, arbeiten, ...
  "losung", "struktur", "verantwortung", "aufgab", "karriere",
  "motiv", "ziel", "plan", "unterstutzung", "bewerb",
  "ausbildung", "weiterbildung", "dokumentation",
];

/** Common profile-summary verbs (stems, normalized). */
const GENERIC_VERB_STEMS = [
  "bring", "einbring", "mocht", "will", "woll", "konn", "mach", "lern",
  "unterstutz", "betreu", "dokumentier", "umsetz", "verwend", "entwickel",
  "ausbau", "gewohnt", "verstand", "erledig",
];

/**
 * Adjectival endings: an inflected adjective frames the profile; the FACT
 * it applies to is a separate token that still has to be grounded.
 * (The simple -er/-en/-e/-es/-em inflection only exempts LONG stems, so
 * job-family nouns stay grounded.)
 */
const ADJ_ENDINGS = [
  "isch", "lich", "bar", "sam", "los", "ig", "haft", "iert", "isiert",
  // normalized form ("fahig" — tokens are NFD-stripped before matching)
  "orientiert", "bereit", "willig", "sicher", "fahig", "stark", "schwach", "klar", "voll", "frei",
];

/**
 * Fact-carrying word stems that are NEVER exempt (they override the
 * adjective / generic rules): degrees, certifications, concrete work
 * terms. If the model uses one — in any inflection or compound
 * ("Master-Abschluss", "zertifizierter", "Zertifikats") — it must be
 * traceable to the profile.
 */
const MUST_BE_GROUNDED_STEMS = [
  "master", "bachelor", "diplom", "stud", "promotion", "doktor",
  "zertifik", "zeugnis", "abschluss", "examen", "praktik", "praxis",
  "referenz", "auszeichnung", "urkunde", "titel",
];

function isGenericStem(w: string, stems: readonly string[]): boolean {
  return stems.some((s) => w === s || (w.length >= 5 && w.startsWith(s)));
}

/**
 * True when a PROFIL token is pure framing (no fact claim) and therefore
 * exempt from traceability.
 */
function isExemptWord(w: string): boolean {
  if (STOPWORDS.has(w)) return true;
  if (isGenericStem(w, GENERIC_CV_STEMS)) return true;
  if (isGenericStem(w, GENERIC_VERB_STEMS)) return true;
  if (ADJ_ENDINGS.some((e) => w.length >= e.length + 3 && w.endsWith(e))) return true;
  if (w.length >= 6 && /(er|em|en|es|e)$/.test(w)) return true;
  return false;
}

/* ------------------------------------------------------------------ */
/* Token traceability (the "no invented facts" rule)                   */
/* ------------------------------------------------------------------ */

function inflectedFromProfileWord(word: string, vocab: ProfileVocabulary): boolean {
  for (const w of vocab.words) {
    if (w.length >= 3 && word.startsWith(w) && word.length - w.length <= 4) return true;
  }
  return false;
}

type PartKind = "profile" | "generic" | null;

const partKind = (part: string, vocab: ProfileVocabulary): PartKind => {
  if (part.length < 3) return null;
  if (vocab.words.has(part) || vocab.edges.has(part)) return "profile";
  if (isGenericStem(part, GENERIC_CV_STEMS)) return "generic";
  return null;
};

/**
 * German compound decomposition: `word` is a concatenation of 2–3 parts,
 * each part itself grounded (profile word / compound edge / generic stem)
 * — "kubernetesadministration" = kubernetes + administration. At least
 * ONE part must be profile-based, so a pure generic+generic compound
 * ("Teamarbeit" = team + arbeit) can never self-ground from an empty
 * profile.
 */
function isCompoundDecomposable(word: string, vocab: ProfileVocabulary): boolean {
  if (word.length < 6) return false;
  for (let i = 3; i < word.length - 2; i += 1) {
    const ka = partKind(word.slice(0, i), vocab);
    if (!ka) continue;
    const b = word.slice(i);
    const kb = partKind(b, vocab);
    if (kb && (ka === "profile" || kb === "profile")) return true;
    for (let j = 3; j < b.length - 2; j += 1) {
      const kc = partKind(b.slice(0, j), vocab);
      const kd = partKind(b.slice(j), vocab);
      if (kc && kd && (ka === "profile" || kc === "profile" || kd === "profile")) return true;
    }
  }
  return false;
}

/**
 * True when `word` (normalized) is traceable to the profile text under the
 * strict rules from the module header — whole word, compound edge, short
 * inflection of a profile word, or compound decomposition. Never an
 * arbitrary inner substring.
 */
export function isTraceableWord(word: string, vocab: ProfileVocabulary): boolean {
  if (!word) return false;
  if (vocab.words.has(word)) return true; // 1) whole word (any length)
  if (word.length < 3) return false;
  if (vocab.edges.has(word)) return true; // 2) compound edge
  if (inflectedFromProfileWord(word, vocab)) return true; // 3) inflection
  return isCompoundDecomposable(word, vocab); // 4) decomposition
}

/**
 * True when EVERY word of the term is traceable to the candidate's own
 * profile text — the deterministic "no invented facts" rule for the
 * KENNTNISSE/EDV-KENNTNISSE/HOBBYS lists. Word order and combination are
 * free (the model may re-order or surface a term from a different CV
 * section), but new vocabulary is not.
 */
export function isGroundedTerm(term: string, profileText: string): boolean {
  const t = normalizeSkillTerm(term);
  if (t.length < 3) return false;
  const words = t.split(" ").filter(Boolean);
  if (words.length === 0) return false;
  const vocab = buildProfileVocabulary(profileText);
  return words.every((w) => isTraceableWord(w, vocab));
}

/* ------------------------------------------------------------------ */
/* PROFIL (summary) verification                                       */
/* ------------------------------------------------------------------ */

export interface SummaryGroundingResult {
  grounded: boolean;
  /** The first token without a basis in the profile (null when grounded). */
  ungroundedToken: string | null;
}

/**
 * Verifies a generated PROFIL sentence-by-sentence in the only
 * deterministic way that is reliable for natural language: every token
 * that can carry a fact (all nouns, proper names, technical terms, degree
 * / certificate words) must be traceable to the profile, and EVERY number
 * (years, dates, counts) must occur in the profile — so invented
 * qualifications ("Azure-Architekt"), invented years of experience ("10
 * Jahre") and unsupported language levels ("C2-Niveau") are rejected,
 * while a legitimate paraphrase of the candidate's own facts (function
 * words, inflected adjectives, generic framing, re-worded compounds)
 * passes. When in doubt: NOT grounded → the original summary is kept.
 */
export function checkSummaryGrounding(
  summary: string,
  profileText: string,
  /**
   * Optional AD-CONTEXT text (this ad's exact job title, occupation,
   * company, location, start). Fact-carrying tokens from it are grounded
   * by the AD, not the profile — a tailored PROFIL may and should name
   * the applied-for position and company; candidate facts still must
   * come from the profile.
   */
  adContextText?: string,
): SummaryGroundingResult {
  const corpus = [profileText, adContextText ?? ""].filter(Boolean).join(" ");
  const vocab = buildProfileVocabulary(corpus);
  for (const tok of normalizeSkillTerm(summary).split(" ")) {
    if (!tok) continue;
    if (/^[0-9]+$/.test(tok)) {
      if (!vocab.numbers.has(tok)) return { grounded: false, ungroundedToken: tok };
      continue;
    }
    if (STOPWORDS.has(tok)) continue;
    if (isGenericStem(tok, MUST_BE_GROUNDED_STEMS) || !isExemptWord(tok)) {
      if (!isTraceableWord(tok, vocab)) return { grounded: false, ungroundedToken: tok };
    }
  }
  return { grounded: true, ungroundedToken: null };
}

export function isSummaryGrounded(summary: string, profileText: string): boolean {
  return checkSummaryGrounding(summary, profileText).grounded;
}

/* ------------------------------------------------------------------ */
/* The controlled transformation                                       */
/* ------------------------------------------------------------------ */

/**
 * Relevance-ordered merge of one list section (skills or interests):
 * the model's GROUNDED items first (its order = its relevance ranking
 * for THIS job), then every verified original item the model did not
 * surface. De-duplicated by the symbol-aware, space-stripped normalized
 * term (German compounds count as one skill: "Netzwerktechnik" ≡
 * "Netzwerk-Technik" — while distinct terms that differ only in symbols
 * never collide: "C" ≠ "C++" ≠ "C#").
 */
function mergeGroundedList(
  originalItems: string[],
  generatedItems: string[],
  vocab: ProfileVocabulary,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (value: string): void => {
    const v = value.trim();
    if (!v) return;
    const key = termDedupeKey(v);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(v);
  };
  for (const item of generatedItems) {
    const words = normalizeSkillTerm(item).split(" ").filter(Boolean);
    if (words.length === 0) continue;
    if (words.every((w) => isTraceableWord(w, vocab))) push(item);
  }
  for (const item of originalItems) push(item);
  return out;
}

/**
 * Cap a GENERATED summary at the layout-safe length, cut at the LAST
 * sentence boundary below the cap (never mid-word; a single run-on
 * sentence is cut at the cap). The candidate's ORIGINAL summary is never
 * passed through here.
 */
function capSummaryAtSentenceBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastEnd = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  if (lastEnd > maxChars * 0.4) return cut.slice(0, lastEnd + 1);
  return cut.replace(/[.,;:\s]+$/, "");
}

/** The exact position-identity facts of THIS ad (never requirements):
 *  naming the applied-for position/company in the PROFIL is ad-grounded. */
export interface AdSummaryContext {
  jobTitle?: string;
  occupation?: string;
  company?: string;
  location?: string;
  startDate?: string;
}

/**
 * Deterministic PROFIL fallback: constructed ONLY from verified CV data
 * (original skills / experience / education) and the ad's position
 * identity — no claim, number, level or credential is ever invented.
 * Returns "" when the candidate data is empty enough that even a
 * minimal sentence would not be truthful.
 */
export function buildFallbackSummary(cv: CvDocument, ctx: AdSummaryContext): string {
  const target = (ctx.occupation ?? "").trim() || (ctx.jobTitle ?? "").trim();
  const company = (ctx.company ?? "").trim();
  const parts: string[] = [];

  if (target) {
    const name = cv.personal.fullName.trim();
    const what = ctx.occupation?.trim() ? `eine Ausbildung als ${ctx.occupation.trim()}` : `eine Stelle als ${ctx.jobTitle?.trim()}`;
    parts.push(`Motivierte:r Bewerber:in${name ? ` (${name})` : ""} für ${what}${company ? ` bei ${company}` : ""}.`);
  }

  const expTitles = cv.experience.map((x) => x.jobTitle.trim()).filter(Boolean);
  const topSkills = cv.skills.map((s) => s.trim()).filter(Boolean).slice(0, 3);
  const bits: string[] = [];
  if (expTitles.length > 0) bits.push(`praktischer Erfahrung als ${expTitles[0]}`);
  if (topSkills.length > 0) bits.push(`Fähigkeiten in ${topSkills.join(", ")}`);
  if (bits.length > 0) {
    parts.push(`Mit ${bits.join(" und ")} bringe ich solide Voraussetzungen für diese Position mit.`);
  }

  const edu = cv.education.find((e) => e.degree.trim());
  if (edu) {
    parts.push(`Wesentlicher Abschluss: ${edu.degree.trim()}${edu.end.trim() ? ` (${edu.end.trim()})` : ""}.`);
  }

  return parts.join(" ");
}

/**
 * The ad-side tailoring input (all values come from the stored,
 * zod-validated AdExtract of THIS company's ad — never from the model):
 *  - `skillTerms`: the skill-like requirements (technical, soft,
 *    skill-like qualifications; education/experience/language claims are
 *    filtered out by collectAddableSkillTerms). Every term that is not
 *    present anywhere in the CV yet is appended to the skills list and
 *    flagged in `tailoring.addedFromAd` (surfaced to the user for
 *    confirmation — never presented as original candidate data).
 *  - `summaryContext`: the ad's position identity (job title, occupation,
 *    company, location, start) — the ONLY ad content the PROFIL may
 *    mention (a tailored profile names the applied-for position).
 */
export interface AdTailoringInput {
  skillTerms: string[];
  summaryContext: AdSummaryContext;
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
 *                    only allowed source for candidate FACTS in the
 *                    whitelisted sections.
 * @param ad          the ad-side requirements (optional: omitted = the
 *                    legacy profile-only behavior, used by pre-feature
 *                    callers and tests).
 */
export function mergeTailoredCvDocument(input: {
  original: CvDocument;
  generated: unknown;
  profileText: string;
  ad?: AdTailoringInput;
}): CvDocument | null {
  const generated = sanitizeCvDocument(input.generated);
  if (!generated) return null;

  // A fresh normalized copy of the ORIGINAL document is the base — every
  // field starts from the candidate's verified data (sanitizeCvDocument
  // rebuilds all nested objects, so nothing is shared with the input).
  const merged = sanitizeCvDocument(input.original);
  if (!merged) return null;

  const vocab = buildProfileVocabulary(input.profileText);
  const ctx = input.ad?.summaryContext;
  const contextText = ctx
    ? [ctx.jobTitle, ctx.occupation, ctx.company, ctx.location, ctx.startDate]
        .map((v) => (v ?? "").trim())
        .filter(Boolean)
        .join(" ")
    : "";

  // 1) PROFIL — verified per token (see checkSummaryGrounding): a
  //    generated statement that cannot be reliably traced back to the
  //    candidate's own profile (plus the ad's position identity) is NEVER
  //    adopted — the original summary stays. The FULL text is checked (a
  //    mid-word cut could not hide a claim), then capped at the last
  //    sentence boundary (layout safety).
  const summaryFull = generated.summary.trim();
  if (summaryFull && checkSummaryGrounding(summaryFull, input.profileText, contextText || undefined).grounded) {
    merged.summary = capSummaryAtSentenceBoundary(summaryFull, TAILORED_SUMMARY_MAX_CHARS);
  }

  // 1b) PROFIL FALLBACK — the candidate's original CV has no profile
  //     paragraph (the scanner profile does not store one) and no
  //     grounded generated text: construct a minimal, fully verifiable
  //     summary from original CV data + the ad's position identity, so
  //     the section is never left empty.
  if (!merged.summary.trim() && ctx && ((ctx.occupation ?? "").trim() || (ctx.jobTitle ?? "").trim())) {
    merged.summary = buildFallbackSummary(merged, ctx).trim();
  }

  // 2) KENNTNISSE + EDV-KENNTNISSE (the model's single skills list).
  merged.skills = mergeGroundedList(input.original.skills, generated.skills, vocab);

  // 3) AD COVERAGE — every skill-like requirement of THIS ad that is not
  //    present anywhere in the CV yet (skills, PROFIL, languages,
  //    certificates, education, experience) is appended to the skills
  //    list and flagged for the user. Terms already covered elsewhere are
  //    NOT duplicated into the list.
  const addedFromAd: string[] = [];
  const addedKeys = new Set<string>();
  for (const term of input.ad?.skillTerms ?? []) {
    const t = term.trim();
    if (!t) continue;
    const key = termDedupeKey(t);
    if (!key || addedKeys.has(key)) continue;
    if (isTermCoveredInCv(t, merged)) continue; // already in the CV — no duplicate
    merged.skills.push(t);
    addedFromAd.push(t);
    addedKeys.add(key);
  }

  // 4) HOBBYS.
  merged.interests = mergeGroundedList(input.original.interests, generated.interests, vocab);

  // The tailoring trace (platform-owned metadata, never model output):
  // which skills were auto-added from the ad (the UI flags them so the
  // user confirms or removes them — honesty stays visible).
  merged.tailoring = addedFromAd.length > 0 ? { addedFromAd } : undefined;

  // Everything else (personal incl. photo, education, experience,
  // languages, certificates, projects, templateId, customization) is the
  // candidate's original data — untouched by design.
  return merged;
}
