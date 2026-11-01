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
 *    (PROFIL);
 *  - COMPLETENESS: every verified skill/interest of the original CV
 *    stays in the document even if the model omits it (appended after
 *    the model's relevance-ordered list);
 *  - NO DUPLICATES: normalized de-duplication (case/diacritic/
 *    punctuation-insensitive, German-compound-aware);
 *  - LAYOUT SAFETY: the PROFIL (summary) is capped in length.
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

/** Pure function words / framing — never carry a verifiable claim. */
const STOPWORDS = new Set([
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
]);

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
  "orientiert", "bereit", "willig", "sicher", "fähig", "stark", "schwach", "klar", "voll", "frei",
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
export function checkSummaryGrounding(summary: string, profileText: string): SummaryGroundingResult {
  const vocab = buildProfileVocabulary(profileText);
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
  vocab: ProfileVocabulary,
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
    const words = normalizeSkillTerm(item).split(" ").filter(Boolean);
    if (words.length === 0) continue;
    if (words.every((w) => isTraceableWord(w, vocab))) push(item);
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
 *                    only allowed source for new content in the
 *                    whitelisted sections.
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

  const vocab = buildProfileVocabulary(input.profileText);

  // 1) PROFIL — verified per token (see checkSummaryGrounding): a
  //    generated statement that cannot be reliably traced back to the
  //    candidate's own profile is NEVER adopted — the original summary
  //    stays. The FULL text is checked (a mid-word cut could not hide a
  //    claim), then capped for the one-page layout.
  const summaryFull = generated.summary.trim();
  if (summaryFull && checkSummaryGrounding(summaryFull, input.profileText).grounded) {
    merged.summary = summaryFull.slice(0, TAILORED_SUMMARY_MAX_CHARS);
  }

  // 2) KENNTNISSE + EDV-KENNTNISSE (the model's single skills list).
  merged.skills = mergeGroundedList(input.original.skills, generated.skills, vocab);

  // 3) HOBBYS.
  merged.interests = mergeGroundedList(input.original.interests, generated.interests, vocab);

  // Everything else (personal incl. photo, education, experience,
  // languages, certificates, projects, templateId, customization) is the
  // candidate's original data — untouched by design.
  return merged;
}
