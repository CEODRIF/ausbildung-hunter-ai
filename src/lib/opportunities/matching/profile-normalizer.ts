import type { CandidateProfile } from "@/lib/bewerbung-schema";
import {
  EDUCATION_RANK,
  canonicalLanguageName,
  normalizeText,
  parseCefrLevel,
  parseDateMs,
  parseEducationLevel,
  type CefrLevel,
  type EducationLevel,
} from "./text";

/**
 * Normalizes a VALIDATED candidate profile (output of the Bewerbung
 * Scanner's `candidateProfileSchema`) into the shape the dimensions
 * consume. Provenance is preserved field by field.
 *
 * Provenance rules (documented, deterministic):
 * - Fields with an explicit `source` attribute (education, training,
 *   experience, target_roles, languages): `user_provided` → explicit,
 *   `ai_extracted` → inferred.
 * - Languages additionally: `level_is_inferred === true` → inferred
 *   regardless of source (the scanner's distinction is preserved).
 * - Structural facts without a source attribute (goal, city/location,
 *   relocation flag) → explicit: they are the user's own stated facts.
 * - Skills and the free-text remote preference carry no per-item source
 *   marker in the schema (scanner-parsed) → inferred.
 * - Empty/undetermined → missing (never guessed).
 */

export type CandidateQuality = "explicit" | "inferred";

export interface NormalizedCandidate {
  goal: "ausbildung" | "arbeit";
  /** Documented target roles / job titles (deduped, original casing kept
   *  for evidence; matching is done on normalized tokens). */
  roles: Array<{ text: string; quality: CandidateQuality }>;
  /** Highest documented school-leaving/education level. */
  education: {
    level: EducationLevel;
    raw: string;
    quality: CandidateQuality;
  } | null;
  /** All documented skills (normalized+folded, deduped). Quality is always
   *  "inferred" (see module docs) — the flag is kept for symmetry. */
  skills: string[];
  skillsQuality: CandidateQuality;
  experience: Array<{
    title: string;
    startMs: number | null;
    /** null = documented as ongoing (open-ended). */
    endMs: number | null;
    quality: CandidateQuality;
  }>;
  languages: Array<{
    name: string;
    raw: string;
    cefr: CefrLevel | null;
    quality: CandidateQuality;
  }>;
  /** Documented candidate locations (current + target + preferences). */
  locations: string[];
  /** null = not documented. Never assumed. */
  relocation: boolean | null;
  remotePreference: "remote" | "hybrid" | "onsite" | null;
  /** Documented industry preferences (normalized, deduped). */
  industries: string[];
}

function roleQuality(source: string): CandidateQuality {
  return source === "user_provided" ? "explicit" : "inferred";
}

function highestEducation(profile: CandidateProfile) {
  let best: {
    level: EducationLevel;
    raw: string;
    quality: CandidateQuality;
  } | null = null;
  for (const entry of profile.education) {
    const level =
      parseEducationLevel(entry.education_level) ??
      parseEducationLevel(entry.degree) ??
      (entry.university ? "university" : null);
    if (!level) continue;
    const quality: CandidateQuality =
      entry.source === "user_provided" ? "explicit" : "inferred";
    const raw = entry.education_level || entry.degree || entry.university || "";
    const rank = EDUCATION_RANK[level];
    if (
      !best ||
      rank > EDUCATION_RANK[best.level] ||
      (rank === EDUCATION_RANK[best.level] &&
        best.quality === "inferred" &&
        quality === "explicit")
    ) {
      best = { level, raw, quality };
    }
  }
  return best;
}

export function normalizeCandidate(
  profile: CandidateProfile,
): NormalizedCandidate {
  const seenRoles = new Set<string>();
  const roles: NormalizedCandidate["roles"] = [];
  for (const source of [
    ...profile.target_roles.map((r) => ({
      text: r.role,
      quality: roleQuality(r.source),
    })),
    ...profile.preferences.preferred_job_titles.map((text) => ({
      text,
      // preferred_job_titles has no per-item source marker (scanner-parsed)
      quality: "inferred" as const,
    })),
  ]) {
    const key = normalizeText(source.text);
    if (!key || seenRoles.has(key)) continue;
    seenRoles.add(key);
    roles.push(source);
  }

  const seenSkills = new Set<string>();
  const skills: string[] = [];
  for (const list of Object.values(profile.skills)) {
    for (const item of list) {
      const key = normalizeText(item);
      if (!key || seenSkills.has(key)) continue;
      seenSkills.add(key);
      skills.push(key);
    }
  }

  const experience = profile.experience.map((item) => ({
    title: item.job_title,
    startMs: parseDateMs(item.start_date),
    endMs: item.end_date ? parseDateMs(item.end_date) : null,
    quality: roleQuality(item.source),
  }));

  const seenLanguages = new Set<string>();
  const languages: NormalizedCandidate["languages"] = [];
  for (const item of profile.languages) {
    const name = canonicalLanguageName(item.language);
    if (!name || seenLanguages.has(name)) continue;
    seenLanguages.add(name);
    const cefr = parseCefrLevel(item.level);
    const quality: CandidateQuality =
      item.level_is_inferred || item.source === "ai_extracted"
        ? "inferred"
        : "explicit";
    languages.push({
      name,
      raw: `${item.language}${item.level ? ` ${item.level}` : ""}`,
      cefr,
      quality,
    });
  }

  const locations = [
    profile.candidate.location,
    profile.candidate.current_location,
    ...profile.candidate.target_location,
    ...profile.preferences.preferred_locations,
  ]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => value.length > 0);

  const rawPreference =
    profile.preferences.remote_hybrid_preference?.trim().toLowerCase() ?? "";
  let remotePreference: NormalizedCandidate["remotePreference"] = null;
  if (rawPreference) {
    // Deterministic free-text heuristic (documented): negations win, then
    // hybrid, then remote, then on-site; anything else stays unknown.
    if (/kein|nicht|ohne|never/.test(rawPreference))
      remotePreference = "onsite";
    else if (/hybrid/.test(rawPreference)) remotePreference = "hybrid";
    else if (/remote|home ?office/.test(rawPreference))
      remotePreference = "remote";
    else if (/vor ?ort|on ?site|buero/.test(rawPreference))
      remotePreference = "onsite";
  }

  const seenIndustries = new Set<string>();
  const industries: string[] = [];
  for (const item of profile.preferences.preferred_industries) {
    const key = normalizeText(item);
    if (!key || seenIndustries.has(key)) continue;
    seenIndustries.add(key);
    industries.push(key);
  }

  return {
    goal: profile.goal,
    roles,
    education: highestEducation(profile),
    skills,
    skillsQuality: "inferred",
    experience,
    languages,
    locations,
    relocation: profile.preferences.willing_to_relocate,
    remotePreference,
    industries,
  };
}
