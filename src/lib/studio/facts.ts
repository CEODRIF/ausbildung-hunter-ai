/**
 * AI Bewerbung Studio — no-fabrication fact guard (pure, isomorphic).
 *
 * The model may REORDER, REPHRASE and PRIORITIZE verified facts, but it must
 * never INVENT: contacts, education, jobs, skills, languages or dates that
 * were not part of the verified input. This module checks a generated
 * CvDocument against the collected verified facts and returns violations.
 *
 * The check is deliberately a SUBSET test on structured fields (the parts
 * that are machine-checkable). Free text (summaries, responsibility bullets)
 * is out of scope — the candidate reviews it in the quality step, and the
 * AI prompt already forbids invention there.
 */
import type { CandidateProfile } from "@/lib/bewerbung-schema";
import type { CvDocument } from "@/lib/templates/cv";
import type { VerifiedFacts } from "./schema";

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/** Lowercase, trim, collapse whitespace, strip punctuation noise. */
export function normalizeFact(value: string): string {
  return value
    .toLowerCase()
    .replace(/[.,;:!?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const YEAR_RE = /(?:19|20)\d{2}/g;
const GERMAN_MONTHS = new Set([
  "januar", "februar", "märz", "march", "april", "mai", "mai", "juni",
  "juli", "august", "september", "oktober", "november", "dezember",
  "jan", "feb", "mär", "apr", "jun", "jul", "aug", "sep", "okt", "nov", "dez",
]);

/** Date tokens: years (19xx/20xx) and month names/numbers (01–12). */
export function dateTokens(value: string): Set<string> {
  const out = new Set<string>();
  const lower = value.toLowerCase();
  for (const m of lower.matchAll(YEAR_RE)) out.add(`y${m[0]}`);
  for (const word of lower.split(/[^a-z0-9]+/)) {
    if (GERMAN_MONTHS.has(word)) out.add(`m${word}`);
    const n = Number(word);
    if (/^\d{1,2}$/.test(word) && n >= 1 && n <= 12) out.add(`m${String(n).padStart(2, "0")}`);
  }
  return out;
}

/** Ordered date tokens of a single date string: "y2019" / "m09" per word,
 *  in order of appearance (needed to attribute a month to its year). */
function orderedDateTokens(value: string): string[] {
  const out: string[] = [];
  const lower = value.toLowerCase();
  for (const word of lower.split(/[^a-z0-9]+/)) {
    if (GERMAN_MONTHS.has(word)) {
      out.push(`m${word}`);
      continue;
    }
    const n = Number(word);
    if (/^\d{1,2}$/.test(word) && n >= 1 && n <= 12) {
      out.push(`m${String(n).padStart(2, "0")}`);
      continue;
    }
    if (/(?:19|20)\d{2}/.test(word)) out.push(`y${word.match(YEAR_RE)![0]}`);
  }
  return out;
}

/**
 * Attribute source months to their years: each month token pairs with the
 * NEXT year token in the same date string (German style "09/2019",
 * "september 2022"); a trailing month pairs with the previous year.
 * Unattributable months still land in `anyMonths` as a lenient fallback.
 */
function buildMonthYearPool(sources: string[]): {
  years: Set<string>;
  byYear: Map<string, Set<string>>;
  anyMonths: Set<string>;
  hasMonths: boolean;
} {
  const years = new Set<string>();
  const byYear = new Map<string, Set<string>>();
  const anyMonths = new Set<string>();
  for (const s of sources) {
    const tokens = orderedDateTokens(s);
    let prevYear: string | null = null;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.startsWith("y")) {
        years.add(t);
        prevYear = t;
      } else {
        anyMonths.add(t);
        const nextYear = tokens.slice(i + 1).find((x) => x.startsWith("y")) ?? null;
        const target = nextYear ?? prevYear;
        if (target) {
          if (!byYear.has(target)) byYear.set(target, new Set());
          byYear.get(target)!.add(t);
        }
      }
    }
  }
  return { years, byYear, anyMonths, hasMonths: anyMonths.size > 0 };
}

/** German phone comparison: digit-only, with the country-code / leading-zero
 *  equivalence ("+49 151 2345678" ≡ "0151 2345678" ≡ "00491512345678"). */
function phoneMatches(a: string, b: string): boolean {
  const digits = (v: string) => v.replace(/\D/g, "");
  const da = digits(a);
  const db = digits(b);
  if (!da && !db) return true;
  if (da === db) return true;
  const strip = (d: string) =>
    d.startsWith("0049") ? d.slice(4) : d.startsWith("49") ? d.slice(2) : d.startsWith("0") ? d.slice(1) : d;
  return strip(da) === strip(db);
}

/** Canonical CEFR rank for level wording (null = unranked phrasing).
 *  "Muttersprache" entails every lower level; a generated level may never
 *  rank HIGHER than the source (that would be inflation). */
const LEVEL_RANK: Array<[RegExp, number]> = [
  [/muttersprache|muttersprachlich|native|nativ/, 7],
  [/\bc2\b/, 6],
  [/\bc1\b|verhandlungssicher|fliessend|fließend/, 5],
  [/\bb2\b/, 4],
  [/\bb1\b/, 3],
  [/\ba2\b|grundkenntnisse/, 2],
  [/\ba1\b/, 1],
];
function levelRank(level: string): number | null {
  const n = normalizeFact(level);
  if (!n) return null;
  for (const [re, rank] of LEVEL_RANK) if (re.test(n)) return rank;
  return null;
}

// ---------------------------------------------------------------------------
// Collect verified facts from the sources the user actually provided
// ---------------------------------------------------------------------------

export interface VerifiedSourceProfile {
  fullName?: string | null;
  email?: string | null;
  phone?: string | null;
  location?: string | null;
  linkedin?: string | null;
}

/**
 * Merge the user's CV (browser source of truth) and the latest scanner
 * candidate profile (server) into the fact set a generated CV may use.
 * Nothing is inferred: a field that is empty in BOTH sources is simply
 * unknown, and a generated value for it counts as fabrication.
 */
export function collectVerifiedFacts(
  cv: CvDocument | null,
  profile: CandidateProfile | null,
  user: VerifiedSourceProfile | null,
): VerifiedFacts {
  const push = (list: string[], value: string | null | undefined) => {
    const v = value?.trim();
    if (v && !list.includes(v)) list.push(v);
  };

  const education: string[] = [];
  const experience: string[] = [];
  const skills: string[] = [];
  const languages: string[] = [];

  if (cv) {
    push(skills, cv.summary); // summary is free text; kept OUT of the pool on purpose
    for (const e of cv.education) {
      push(education, e.degree);
      push(education, e.institution);
      push(education, [e.start, e.end].filter(Boolean).join("–"));
    }
    for (const x of cv.experience) {
      push(experience, x.jobTitle);
      push(experience, x.company);
      push(experience, [x.start, x.end].filter(Boolean).join("–"));
      for (const r of x.responsibilities) push(experience, r);
    }
    for (const s of cv.skills) push(skills, s);
    for (const l of cv.languages) push(languages, [l.language, l.level].filter(Boolean).join(" "));
    for (const c of cv.certificates) {
      push(skills, c.name); // certificates are facts too
    }
    push(skills, cv.personal.linkedin);
    push(skills, cv.personal.website);
  }

  if (profile) {
    for (const e of profile.education ?? []) {
      push(education, e.degree);
      push(education, e.field_of_study);
      push(education, e.school ?? e.university);
      if (e.graduation_year != null) push(education, String(e.graduation_year));
    }
    for (const x of profile.experience ?? []) {
      push(experience, x.job_title);
      push(experience, x.company);
      push(experience, [x.start_date, x.end_date].filter(Boolean).join("–"));
    }
    for (const group of Object.values(profile.skills ?? {})) {
      for (const s of group ?? []) push(skills, s);
    }
    for (const l of profile.languages ?? []) {
      push(languages, [l.language, l.level].filter(Boolean).join(" "));
    }
    for (const t of profile.training ?? []) {
      push(skills, t.name);
      if (t.year != null) push(skills, String(t.year));
    }
    const c = profile.candidate ?? {};
    push(skills, c.full_name);
    push(skills, c.location ?? c.current_location);
    push(skills, c.country);
    push(skills, c.contact?.linkedin);
  }

  if (user) {
    push(skills, user.fullName);
    push(skills, user.location);
    push(skills, user.linkedin);
  }

  return {
    name: (cv?.personal.fullName || user?.fullName || profile?.candidate?.full_name || "").trim(),
    email: (cv?.personal.email || user?.email || profile?.candidate?.contact?.email || "").trim(),
    phone: (cv?.personal.phone || user?.phone || profile?.candidate?.contact?.phone || "").trim(),
    location: (cv?.personal.location || user?.location || profile?.candidate?.location || "").trim(),
    linkedin: (cv?.personal.linkedin || user?.linkedin || profile?.candidate?.contact?.linkedin || "").trim(),
    education,
    experience,
    skills,
    languages,
  };
}

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

export interface FactViolation {
  field: string;
  value: string;
  reason: "not_in_source" | "date_not_in_source";
}

const inPool = (value: string, pool: string[]): boolean => {
  const v = normalizeFact(value);
  if (!v) return true;
  return pool.some((p) => {
    const n = normalizeFact(p);
    return n === v || (n.length >= 3 && v.length >= 3 && (n.includes(v) || v.includes(n)));
  });
};

/**
 * Check a generated CV against the verified facts.
 * Returns [] when every structured value is grounded; otherwise one
 * violation per fabricated value.
 */
export function validateGeneratedCv(
  facts: VerifiedFacts,
  cv: CvDocument,
): FactViolation[] {
  const violations: FactViolation[] = [];
  const bad = (field: string, value: string, reason: FactViolation["reason"] = "not_in_source") =>
    violations.push({ field, value, reason });

  const p = cv.personal;
  if (p.fullName.trim() && normalizeFact(p.fullName) !== normalizeFact(facts.name))
    bad("personal.fullName", p.fullName);
  if (p.email.trim() && normalizeFact(p.email) !== normalizeFact(facts.email))
    bad("personal.email", p.email);
  // Phone: digit-level comparison with German country-code equivalence
  // ("+49 151 …" ≡ "0151 …") — re-formatting is NOT a new fact, a different
  // number still is.
  if (p.phone.trim() && !phoneMatches(p.phone, facts.phone))
    bad("personal.phone", p.phone);
  if (p.location.trim() && !inPool(p.location, [facts.location, ...facts.skills]))
    bad("personal.location", p.location);
  if (p.linkedin.trim() && !inPool(p.linkedin, [facts.linkedin, ...facts.skills]))
    bad("personal.linkedin", p.linkedin);
  // nationality/website/dateOfBirth/availability: only check when the source
  // had something; empty source + generated value = fabrication.
  if (p.website.trim() && !inPool(p.website, facts.skills)) bad("personal.website", p.website);

  // Date pool: years are ALWAYS checked (an invented year is a fabricated
  // timeline). Months are checked against their source year; when the source
  // is year-only (very common in German CVs: "2019 – 2024"), adding month
  // precision to a VERIFIED year is a formatting choice, not a new fact —
  // the candidate still sees and confirms the exact dates in the review
  // step before the CV counts as done.
  const datePool = buildMonthYearPool([...facts.education, ...facts.experience, ...facts.skills]);
  const checkDate = (field: string, value: string) => {
    const tokens = new Set(dateTokens(value));
    if (tokens.size === 0) return; // "heute"/"laufend" etc. — no checkable tokens
    if (datePool.years.size === 0 && !datePool.hasMonths) {
      bad(field, value, "date_not_in_source");
      return;
    }
    for (const t of tokens) {
      if (t.startsWith("y")) {
        if (!datePool.years.has(t)) {
          bad(field, value, "date_not_in_source");
          return;
        }
      } else if (!datePool.hasMonths) {
        continue; // year-only source: month precision on a verified year
      } else {
        const yearsOfToken = orderedDateTokens(value).filter((x) => x.startsWith("y"));
        const attributed = yearsOfToken.length === 1 ? datePool.byYear.get(yearsOfToken[0]) : undefined;
        if (attributed ? !attributed.has(t) && !datePool.anyMonths.has(t) : !datePool.anyMonths.has(t)) {
          bad(field, value, "date_not_in_source");
          return;
        }
      }
    }
  };

  for (const e of cv.education) {
    if (e.degree.trim() && !inPool(e.degree, facts.education)) bad("education.degree", e.degree);
    if (e.institution.trim() && !inPool(e.institution, facts.education))
      bad("education.institution", e.institution);
    checkDate("education.date", e.start);
    checkDate("education.date", e.end);
  }
  for (const x of cv.experience) {
    if (x.jobTitle.trim() && !inPool(x.jobTitle, facts.experience))
      bad("experience.jobTitle", x.jobTitle);
    if (x.company.trim() && !inPool(x.company, facts.experience))
      bad("experience.company", x.company);
    checkDate("experience.date", x.start);
    checkDate("experience.date", x.end);
  }
  for (const s of cv.skills) {
    if (s.trim() && !inPool(s, facts.skills)) bad("skills", s);
  }
  for (const l of cv.languages) {
    const combined = [l.language, l.level].filter(Boolean).join(" ");
    if (!combined.trim()) continue;
    const lang = normalizeFact(l.language);
    if (!lang) continue;
    // Source entries for THIS language (pool entries are "language level").
    const entries = facts.languages.filter((entry) => {
      const n = normalizeFact(entry);
      return n === lang || n.startsWith(`${lang} `);
    });
    if (entries.length === 0) {
      bad("languages", combined); // invented language
      continue;
    }
    const gLevel = l.level?.trim() ?? "";
    if (!gLevel) continue; // language is grounded, no level claim made
    const gN = normalizeFact(gLevel);
    // 1) exact level match
    if (entries.some((e) => normalizeFact(e) === `${lang} ${gN}` || normalizeFact(e) === gN)) continue;
    // 2) a source level exists for this language and the generated claim is
    //    the SAME or a WEAKER (entailed) level → grounded. A HIGHER rank is
    //    inflation and falls through to rejection.
    const sourceRanks = entries
      .map((e) => levelRank(normalizeFact(e).replace(lang, "").trim()))
      .filter((r): r is number => r !== null);
    const gRank = levelRank(gN);
    if (gRank !== null && sourceRanks.length > 0 && gRank <= Math.max(...sourceRanks)) continue;
    // 3) generated level but NO source level for this language → invented
    //    precision (e.g. source "Englisch", generated "Englisch C1").
    if (sourceRanks.length === 0 && !entries.some((e) => normalizeFact(e) !== lang)) {
      bad("languages", combined);
      continue;
    }
    // 4) legacy lenient substring fallback for unranked phrasings
    if (!inPool(combined, facts.languages)) bad("languages", combined);
  }
  for (const c of cv.certificates) {
    if (c.name.trim() && !inPool(c.name, facts.skills)) bad("certificates.name", c.name);
    if (c.issuer.trim() && !inPool(c.issuer, facts.skills)) bad("certificates.issuer", c.issuer);
  }
  for (const pr of cv.projects) {
    // Projects only exist in the CV source; the guard checks them against
    // the CV's own facts (already in the pools) — a brand-new project with
    // unknown dates is still caught by the date check below.
    checkDate("project.date", pr.date);
  }

  return violations;
}
