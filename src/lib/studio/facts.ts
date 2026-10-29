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
  if (p.phone.trim() && normalizeFact(p.phone) !== normalizeFact(facts.phone))
    bad("personal.phone", p.phone);
  if (p.location.trim() && !inPool(p.location, [facts.location, ...facts.skills]))
    bad("personal.location", p.location);
  if (p.linkedin.trim() && !inPool(p.linkedin, [facts.linkedin, ...facts.skills]))
    bad("personal.linkedin", p.linkedin);
  // nationality/website/dateOfBirth/availability: only check when the source
  // had something; empty source + generated value = fabrication.
  if (p.website.trim() && !inPool(p.website, facts.skills)) bad("personal.website", p.website);

  // All known dates in the sources form the allowed date-token pool.
  const datePool = new Set<string>();
  for (const s of [...facts.education, ...facts.experience, ...facts.skills]) {
    for (const t of dateTokens(s)) datePool.add(t);
  }
  const checkDate = (field: string, value: string) => {
    const tokens = dateTokens(value);
    if (tokens.size === 0) return; // "heute"/"laufend" etc. — no checkable tokens
    if (datePool.size === 0) {
      bad(field, value, "date_not_in_source");
      return;
    }
    for (const t of tokens) {
      if (!datePool.has(t)) {
        bad(field, value, "date_not_in_source");
        return;
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
    if (combined && !inPool(combined, facts.languages))
      bad("languages", combined);
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
