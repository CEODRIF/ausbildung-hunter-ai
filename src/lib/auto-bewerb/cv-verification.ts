/**
 * AUTO BEWERB — exhaustive requirement coverage: job ad ↔ final CV.
 *
 * This is the deterministic, no-LLM layer behind two user-facing
 * guarantees:
 *
 *  1. EVERY requirement of the advertisement is accounted for.
 *     `collectAdRequirements` walks all requirement dimensions of the
 *     stored, zod-validated AdExtract (technical skills, soft skills,
 *     required + preferred qualifications, language requirements,
 *     education requirement, requested documents) — nothing is sampled,
 *     nothing is dropped, there is NO per-list count cap.
 *
 *  2. EVERY requirement is checked against the FINAL tailored CV,
 *     section by section (Kenntnisse, Profil, Sprachen, Zertifikate,
 *     Ausbildung & Studium, Berufserfahrung). `verifyCvAgainstAd`
 *     produces the report the Step-4 preview shows BEFORE the user
 *     exports: per requirement — what is required, whether it is
 *     present, and in which section it appeared.
 *
 * Honesty contract: this module only READS and MATCHES. It never adds,
 * removes or rewords CV content (that is the tailoring merge's job).
 * A language level gap ("Anzeige C1, CV B2") is reported as `partial`,
 * never silently "covered", and never resolved by inventing a level.
 *
 * Matching is word-based and German-compound-aware (the same
 * prefix/suffix edge idea as the tailored-CV grounding, but in the
 * verification direction): a requirement word counts as present when it
 * is a full word of the section text or an edge (≥ 4 chars) of a section
 * word ("Netzwerk" ⊂ "Netzwerktechnik"). A full requirement word that is
 * longer than 12 chars can only match a full word — conservative by
 * design (no false coverage).
 *
 * Pure and isomorphic (client + server + tests): no DOM, no network,
 * no Supabase.
 */
import type { AdExtract } from "@/lib/studio/schema";
import type { CvDocument } from "@/lib/templates/cv";

// ---------------------------------------------------------------------------
// Requirement collection (exhaustive, no caps)
// ---------------------------------------------------------------------------

export type AdRequirementCategory =
  | "technical"
  | "soft"
  | "qualification"
  | "language"
  | "education"
  | "document";

export interface AdRequirement {
  requirement: string;
  category: AdRequirementCategory;
  /** true = "von Vorteil" (preferredQualifications) — never part of the
   *  hard coverage gate, always shown in the report. */
  preferred: boolean;
}

/** German section labels (identical to the PDF renderer's headings). */
export const CV_SECTION_LABELS: Record<
  "summary" | "experience" | "education" | "skills" | "languages" | "certificates" | "projects" | "interests",
  string
> = {
  summary: "Profil",
  experience: "Berufserfahrung",
  education: "Ausbildung & Studium",
  skills: "Kenntnisse",
  languages: "Sprachen",
  certificates: "Zertifikate",
  projects: "Projekte",
  interests: "Interessen",
};

/**
 * EVERY requirement dimension of the stored extraction, in report order.
 * Empty values are skipped (they are not requirements); there is no
 * per-list limit anywhere in this function.
 */
export function collectAdRequirements(extract: AdExtract): AdRequirement[] {
  const out: AdRequirement[] = [];
  const push = (category: AdRequirementCategory, values: string[], preferred = false): void => {
    for (const value of values) {
      const v = value.trim();
      if (v) out.push({ requirement: v, category, preferred });
    }
  };
  push("technical", extract.technicalSkills);
  push("soft", extract.softSkills);
  push("qualification", extract.requiredQualifications);
  push("qualification", extract.preferredQualifications, true);
  push("language", extract.languageRequirements);
  if (extract.educationRequirement.trim()) {
    out.push({ requirement: extract.educationRequirement.trim(), category: "education", preferred: false });
  }
  push("document", extract.requestedDocuments);
  return out;
}

// ---------------------------------------------------------------------------
// Term normalization (symbol-aware)
// ---------------------------------------------------------------------------

/**
 * Normalization for MATCHING (not grounding): case-, diacritic- and
 * whitespace-insensitive, ß→ss — but SYMBOLS are kept, so distinct
 * professional terms that differ only in symbols never collide:
 * "C" ≠ "C++" ≠ "C#", while "Netzwerktechnik" ≡ "Netzwerk-Technik" ≡
 * "Netzwerk Technik".
 */
export function normalizeTerm(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9+#.&%\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** De-duplication key: the normalized term without spaces (German
 *  compounds count as one skill), symbols intact. */
export function termDedupeKey(value: string): string {
  return normalizeTerm(value).replace(/ /g, "");
}

/**
 * True when a requirement word occurs in the section text:
 *  1. full word (exact),
 *  2. German compounds — a prefix/suffix edge (≥ 4 chars, ≤ 12 chars) of
 *     a full word ("Netzwerk" ⊂ "Netzwerktechnik"),
 *  3. inflection-tolerant stem — both words ≥ 7 chars share a common
 *     prefix of ≥ 6 chars ("analytisches" ≡ "analytischem",
 *     "Kommunikationsfähigkeit" ≡ "Kommunikation") — shorter words
 *     ("Team-" family: teamfaehigkeit vs. teamarbeit, common prefix 4)
 *     never match this way (no false coverage of distinct traits).
 */
function wordInTextWords(w: string, textWords: string[], edges: Set<string>): boolean {
  if (textWords.includes(w)) return true;
  if (w.length >= 4 && edges.has(w)) return true;
  if (w.length >= 7) {
    for (const t of textWords) {
      if (t.length < 7) continue;
      const min = Math.min(w.length, t.length);
      let i = 0;
      while (i < min - 1 && w[i] === t[i]) i += 1;
      if (i >= 6) return true;
    }
  }
  return false;
}

/**
 * Matching normalization: like normalizeTerm, but HYPHEN-JOINED
 * ("Datei-Organisation" → "dateiorganisation"). A hyphenated CV term is ONE
 * German compound word — a requirement may match it as a whole-compound
 * edge/prefix, but never through a coincidental tail word:
 * "Organisationstalent" must NOT count as covered by "Datei-Organisation",
 * while the requirement "Organisation" still is (suffix edge of the
 * compound).
 */
function matchNormalize(value: string): string {
  return normalizeTerm(value.replace(/-/g, ""));
}

/**
 * True when EVERY word of `term` occurs in `text` (rules above). Order is
 * free; a requirement word longer than 12 chars can only match a full word
 * or the stem rule — conservative by design (no false coverage).
 */
export function termInText(term: string, text: string): boolean {
  const words = matchNormalize(term).split(" ").filter(Boolean);
  if (words.length === 0) return false;
  const textWords = matchNormalize(text).split(" ").filter(Boolean);
  if (textWords.length === 0) return false;
  const edges = new Set<string>();
  for (const w of textWords) {
    const max = Math.min(12, w.length - 1);
    for (let len = 4; len <= max; len += 1) {
      edges.add(w.slice(0, len));
      edges.add(w.slice(w.length - len));
    }
  }
  return words.every((w) => wordInTextWords(w, textWords, edges));
}

// ---------------------------------------------------------------------------
// CV section texts (what the matcher sees per section)
// ---------------------------------------------------------------------------

interface CvSectionTexts {
  summary: string;
  skills: string;
  languages: string;
  certificates: string;
  education: string;
  experience: string;
}

function buildSectionTexts(cv: CvDocument): CvSectionTexts {
  return {
    summary: cv.summary,
    skills: cv.skills.join(" | "),
    languages: cv.languages.map((l) => [l.language, l.level].filter(Boolean).join(" ")).join(" | "),
    certificates: cv.certificates.map((c) => [c.name, c.issuer, c.description].filter(Boolean).join(" ")).join(" | "),
    education: cv.education.map((e) => [e.degree, e.institution, e.description].filter(Boolean).join(" ")).join(" | "),
    experience: cv.experience
      .map((x) =>
        [x.jobTitle, x.company, ...x.responsibilities, ...x.achievements].filter(Boolean).join(" "),
      )
      .join(" | "),
  };
}

/** The sections a skill-like requirement is searched in, in priority order
 *  (the section reported for a covered requirement is the FIRST match).
 *  The PROFIL (summary) is DERIVED text — it is checked LAST, so a concrete
 *  section (Kenntnisse / Zertifikate / Ausbildung & Studium /
 *  Berufserfahrung) always wins the report over a passing mention in the
 *  profile paragraph. */
const SKILL_SECTION_ORDER: Array<{ key: keyof CvSectionTexts; label: string }> = [
  { key: "skills", label: CV_SECTION_LABELS.skills },
  { key: "certificates", label: CV_SECTION_LABELS.certificates },
  { key: "education", label: CV_SECTION_LABELS.education },
  { key: "experience", label: CV_SECTION_LABELS.experience },
  { key: "summary", label: CV_SECTION_LABELS.summary },
];

/**
 * True when the requirement is present ANYWHERE in the CV (skill-like
 * categories). Used by the tailoring merge to decide whether an ad
 * requirement must be ADDED to the skills list or is already covered.
 */
export function isTermCoveredInCv(term: string, cv: CvDocument): boolean {
  const texts = buildSectionTexts(cv);
  return SKILL_SECTION_ORDER.some(({ key }) => termInText(term, texts[key]));
}

// ---------------------------------------------------------------------------
// Language requirements (language + level, parsed deterministically)
// ---------------------------------------------------------------------------

const CEFR_LEVELS = ["c2", "c1", "b2", "b1", "a2", "a1"] as const;
const LEVEL_PHRASES = [
  "muttersprachlich",
  "muttersprache",
  "verhandlungssicher",
  "sehr gute kenntnisse",
  "gute kenntnisse",
  "solide kenntnisse",
  "grundkenntnisse",
  "fluent",
  "native",
] as const;

export interface ParsedLanguageRequirement {
  language: string;
  level: string | null;
}

/** Parse "Deutsch C1", "Englisch (mind. B1)", "Französisch Grundkenntnisse"
 *  → { language, level }. Unknown level wording → level null (the
 *  requirement is then matched on the language name only). */
export function parseLanguageRequirement(term: string): ParsedLanguageRequirement {
  // Letters/digits only (parentheses, dots, slashes dropped) so the
  // language name can never carry a stray symbol.
  const t = normalizeTerm(term)
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  let level: string | null = null;
  const cefr = t.match(/\b(c2|c1|b2|b1|a2|a1)\b/);
  if (cefr) {
    level = cefr[1].toUpperCase();
  } else {
    for (const phrase of LEVEL_PHRASES) {
      if (t.includes(phrase)) {
        level = phrase;
        break;
      }
    }
  }
  const language = t
    .replace(/\b(c2|c1|b2|b1|a2|a1)\b/g, " ")
    .replace(
      /\b(muttersprachlich|muttersprache|verhandlungssicher|grundkenntnisse|sehr|solide|gute?|kenntnisse|fluent|native|mindestens|mind|niveau|auf|oder)\b/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
  return { language, level };
}

interface LanguageMatch {
  status: "covered" | "partial" | "missing";
  detail: string;
}

function matchLanguageRequirement(req: string, cv: CvDocument): LanguageMatch {
  const { language, level } = parseLanguageRequirement(req);
  const langs = cv.languages.filter((l) => l.language.trim());
  const wanted = language || normalizeTerm(req);
  const found = langs.find((l) => {
    const a = normalizeTerm(l.language);
    if (!a || !wanted) return false;
    return a === wanted || (a.length >= 4 && (wanted.startsWith(a) || a.startsWith(wanted)));
  });
  if (!found) return { status: "missing", detail: "" };
  if (!level) return { status: "covered", detail: "" };
  const have = normalizeTerm(found.level ?? "");
  if (!have) {
    return { status: "partial", detail: "Niveau im Lebenslauf nicht angegeben" };
  }
  if (have.includes(level.toLowerCase())) return { status: "covered", detail: "" };
  const haveCefr = have.match(/\b(c2|c1|b2|b1|a2|a1)\b/)?.[1]?.toUpperCase() ?? null;
  if ((CEFR_LEVELS as readonly string[]).includes(level.toLowerCase()) && haveCefr) {
    return { status: "partial", detail: `Niveauunterschied: Anzeige ${level}, Lebenslauf ${haveCefr}` };
  }
  return { status: "partial", detail: "Niveau weicht von der Anzeige ab" };
}

// ---------------------------------------------------------------------------
// Requirement classification (what the tailoring merge may auto-add)
// ---------------------------------------------------------------------------

/**
 * Qualification terms that are EDUCATION claims (degree/school words):
 * these live in the education section — the merge never adds them to the
 * skills list (a fabricated degree would be dishonest); they are reported
 * instead.
 */
const EDUCATION_MARKERS = [
  "abschluss", "abitur", "realschul", "hauptschul", "berufsschul", "schule",
  "bachelor", "master", "diplom", "studium", "zeugnis", "note", "notendurchschnitt", "reife",
  "meister",
] as const;

/** Experience-claim terms (years/months of experience, or a leading
 *  number): never added to the skills list (a numeric claim), reported
 *  against the experience section. */
function looksLikeExperienceClaim(term: string): boolean {
  const t = normalizeTerm(term);
  return (
    /^\d/.test(t) ||
    /\b(jahre|jahren|monate|monaten|erfahrung|experience|praxis)\b/.test(t)
  );
}

export function looksLikeEducationClaim(term: string): boolean {
  const t = normalizeTerm(term);
  return EDUCATION_MARKERS.some((m) => t.includes(m));
}

/** The ad requirements the tailoring merge is ALLOWED to add to the CV's
 *  skills list when missing: technical + soft + skill-like qualification
 *  terms (education claims, experience claims, languages and document
 *  requirements are reported, never auto-added). */
export function collectAddableSkillTerms(extract: AdExtract): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const consider = (value: string): void => {
    const v = value.trim();
    if (!v) return;
    if (looksLikeEducationClaim(v) || looksLikeExperienceClaim(v)) return;
    const key = termDedupeKey(v);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(v);
  };
  for (const value of extract.technicalSkills) consider(value);
  for (const value of extract.softSkills) consider(value);
  for (const value of extract.requiredQualifications) consider(value);
  for (const value of extract.preferredQualifications) consider(value);
  return out;
}

// ---------------------------------------------------------------------------
// The verification report
// ---------------------------------------------------------------------------

export type CvVerificationStatus = "covered" | "partial" | "missing" | "info";

export interface CvVerificationItem {
  requirement: string;
  category: AdRequirementCategory;
  preferred: boolean;
  status: CvVerificationStatus;
  /** The German section label where the requirement appeared (null = not
   *  in the CV / not a CV section). */
  section: string | null;
  /** true = the requirement was missing from the original CV and the
   *  tailoring merge added it automatically from the ad (flagged in
   *  `cv.tailoring.addedFromAd` — the user is asked to confirm it). */
  addedFromAd: boolean;
  /** Short human note (level gaps, document hint, …). */
  detail: string;
}

export interface CvVerificationReport {
  items: CvVerificationItem[];
  /** All requirements of the ad (incl. preferred + documents). */
  total: number;
  covered: number;
  partial: number;
  missing: number;
  /** Requirements auto-added from the ad into this CV (⊆ items). */
  addedFromAd: string[];
  /**
   * The export gate: true when EVERY hard (non-preferred) CV-applicable
   * requirement is fully covered. Preferred ("von Vorteil"), document
   * (application papers, not CV content) items never block.
   */
  allCovered: boolean;
}

const INFO_DOCUMENT_DETAIL = "Angeforderte Bewerbungsunterlage (separat beizufügen — kein Lebenslauf-Abschnitt)";

/**
 * Compare the final tailored CV against EVERY requirement of the ad.
 * Deterministic; safe to call on every render of the Step-4 preview and
 * in the export path.
 */
export function verifyCvAgainstAd(input: { cv: CvDocument; extract: AdExtract | null | undefined }): CvVerificationReport {
  const cv = input.cv;
  const addedSet = new Set((cv.tailoring?.addedFromAd ?? []).map((s) => termDedupeKey(s)));
  const items: CvVerificationItem[] = [];

  if (input.extract) {
    const texts = buildSectionTexts(cv);
    for (const req of collectAdRequirements(input.extract)) {
      if (req.category === "document") {
        items.push({
          requirement: req.requirement,
          category: req.category,
          preferred: req.preferred,
          status: "info",
          section: null,
          addedFromAd: false,
          detail: INFO_DOCUMENT_DETAIL,
        });
        continue;
      }
      if (req.category === "language") {
        const m = matchLanguageRequirement(req.requirement, cv);
        items.push({
          requirement: req.requirement,
          category: req.category,
          preferred: req.preferred,
          status: m.status,
          section: m.status === "missing" ? null : CV_SECTION_LABELS.languages,
          addedFromAd: false,
          detail: m.detail,
        });
        continue;
      }
      const hit = SKILL_SECTION_ORDER.find(({ key }) => termInText(req.requirement, texts[key]));
      items.push({
        requirement: req.requirement,
        category: req.category,
        preferred: req.preferred,
        status: hit ? "covered" : "missing",
        section: hit ? hit.label : null,
        addedFromAd: hit ? addedSet.has(termDedupeKey(req.requirement)) : addedSet.has(termDedupeKey(req.requirement)),
        detail: "",
      });
    }
  }

  const covered = items.filter((i) => i.status === "covered").length;
  const partial = items.filter((i) => i.status === "partial").length;
  const missing = items.filter((i) => i.status === "missing").length;
  const addedFromAd = items.filter((i) => i.addedFromAd).map((i) => i.requirement);
  const allCovered = items.every((i) => {
    if (i.preferred || i.status === "info") return true;
    if (i.category === "technical" || i.category === "soft" || i.category === "qualification" || i.category === "education" || i.category === "language") {
      return i.status === "covered";
    }
    return true;
  });

  return { items, total: items.length, covered, partial, missing, addedFromAd, allCovered };
}
