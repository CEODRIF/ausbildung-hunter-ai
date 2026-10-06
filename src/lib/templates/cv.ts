/**
 * CV Builder data model — pure, isomorphic (client + tests).
 *
 * Design notes:
 *  - This is the document the "Professional Classic" template renders.
 *    It is deliberately a SUPERSET of the scanner's CandidateProfile:
 *    the CV adds fields the scanner does not capture (photo, website,
 *    nationality, date of birth, availability, projects, interests,
 *    free-text descriptions) and uses free-text dates ("2024", "03/2024",
 *    "2024–2026") because users type them.
 *  - Import compatibility (see importCandidateProfileToCv) maps the
 *    existing scanner profile INTO this model without inventing anything:
 *    fields the profile does not have stay empty.
 *  - Persistence is per-user localStorage (see cv-builder.tsx); this
 *    module never touches the DOM or Supabase.
 */

import type { CandidateProfile } from "@/lib/bewerbung-schema";
import {
  defaultCvCustomization,
  sanitizeCvCustomization,
  type CvCustomizationSettings,
} from "./cv-customization";

export interface CvPersonal {
  fullName: string;
  professionalTitle: string;
  email: string;
  phone: string;
  location: string;
  linkedin: string;
  website: string;
  nationality: string;
  dateOfBirth: string;
  availability: string;
  /** Photo as a data URL (kept small by the uploader) or null. */
  photo: string | null;
}

export interface CvEducation {
  id: string;
  degree: string;
  institution: string;
  location: string;
  start: string;
  end: string;
  description: string;
}

export interface CvExperience {
  id: string;
  jobTitle: string;
  company: string;
  location: string;
  start: string;
  end: string;
  isCurrent: boolean;
  responsibilities: string[];
  achievements: string[];
}

export interface CvLanguage {
  id: string;
  language: string;
  level: string;
}

export interface CvCertificate {
  id: string;
  name: string;
  issuer: string;
  date: string;
  description: string;
}

export interface CvProject {
  id: string;
  name: string;
  role: string;
  date: string;
  description: string;
  technologies: string;
}

/**
 * The selectable CV template (presentation only — the content data model is
 * identical for every template).
 *  - classic:      the original "Editorial Serif" design (default)
 *  - executive:    centered header, refined rules, premium corporate look
 *  - modern:       steel-blue accents, contact icons, modern corporate look
 *  - professional: strong black-and-white type, compact inline lists
 */
export const CV_TEMPLATE_IDS = [
  "classic",
  "executive",
  "modern",
  "professional",
] as const;

export type CvTemplateId = (typeof CV_TEMPLATE_IDS)[number];

export function resolveCvTemplateId(value: unknown): CvTemplateId {
  return typeof value === "string" &&
    (CV_TEMPLATE_IDS as readonly string[]).includes(value)
    ? (value as CvTemplateId)
    : "classic";
}

export interface CvDocument {
  version: 1;
  /** Presentation template. Absent in pre-rebrand storage → "classic". */
  templateId: CvTemplateId;
  personal: CvPersonal;
  summary: string;
  education: CvEducation[];
  experience: CvExperience[];
  skills: string[];
  languages: CvLanguage[];
  certificates: CvCertificate[];
  projects: CvProject[];
  interests: string[];
  /**
   * Optional appearance/style settings (font, sizes, spacing, colors, photo,
   * header, sections, footer). Persisted in the SAME per-user key as the
   * content; `sanitizeCvDocument` always fills it with valid defaults. When
   * absent (older storage) the renderer falls back to the defaults, so the
   * document looks identical to the current template.
   */
  customization?: CvCustomizationSettings;
}

export type CvListSection =
  | "education"
  | "experience"
  | "languages"
  | "certificates"
  | "projects";

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

export function newEntryId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `cv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function emptyPersonal(): CvPersonal {
  return {
    fullName: "",
    professionalTitle: "",
    email: "",
    phone: "",
    location: "",
    linkedin: "",
    website: "",
    nationality: "",
    dateOfBirth: "",
    availability: "",
    photo: null,
  };
}

export function emptyEducation(): CvEducation {
  return {
    id: newEntryId(),
    degree: "",
    institution: "",
    location: "",
    start: "",
    end: "",
    description: "",
  };
}

export function emptyExperience(): CvExperience {
  return {
    id: newEntryId(),
    jobTitle: "",
    company: "",
    location: "",
    start: "",
    end: "",
    isCurrent: false,
    responsibilities: [""],
    achievements: [],
  };
}

export function emptyLanguage(): CvLanguage {
  return { id: newEntryId(), language: "", level: "" };
}

export function emptyCertificate(): CvCertificate {
  return { id: newEntryId(), name: "", issuer: "", date: "", description: "" };
}

export function emptyProject(): CvProject {
  return {
    id: newEntryId(),
    name: "",
    role: "",
    date: "",
    description: "",
    technologies: "",
  };
}

export function cvEmpty(): CvDocument {
  return {
    version: 1,
    templateId: "classic",
    personal: emptyPersonal(),
    summary: "",
    education: [],
    experience: [],
    skills: [],
    languages: [],
    certificates: [],
    projects: [],
    interests: [],
    customization: defaultCvCustomization(),
  };
}

// ---------------------------------------------------------------------------
// Content checks & list helpers
// ---------------------------------------------------------------------------

const nonEmpty = (value: string | null | undefined): boolean =>
  typeof value === "string" && value.trim().length > 0;

/** True when the document carries any real content (for empty states). */
export function cvHasContent(cv: CvDocument): boolean {
  if (Object.values(cv.personal).some(nonEmpty)) return true;
  if (nonEmpty(cv.summary)) return true;
  if (cv.education.length > 0) return true;
  if (cv.experience.length > 0) return true;
  if (cv.skills.some(nonEmpty)) return true;
  if (cv.languages.some((l) => nonEmpty(l.language) || nonEmpty(l.level)))
    return true;
  if (
    cv.certificates.some(
      (c) => nonEmpty(c.name) || nonEmpty(c.issuer) || nonEmpty(c.description),
    )
  )
    return true;
  if (
    cv.projects.some(
      (p) => nonEmpty(p.name) || nonEmpty(p.role) || nonEmpty(p.description),
    )
  )
    return true;
  if (cv.interests.some(nonEmpty)) return true;
  return false;
}

/** Move an entry one step up/down (bounded, immutable). */
export function moveEntry<T>(list: T[], index: number, direction: -1 | 1): T[] {
  const target = index + direction;
  if (index < 0 || index >= list.length || target < 0 || target >= list.length) {
    return list;
  }
  const next = list.slice();
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item);
  return next;
}

export function removeEntry<T>(list: T[], index: number): T[] {
  if (index < 0 || index >= list.length) return list;
  const next = list.slice();
  next.splice(index, 1);
  return next;
}

/**
 * An entry counts as "visible in the document" when it carries at least
 * one meaningful value (empty scaffolding entries never render).
 */
export function educationVisible(e: CvEducation): boolean {
  return [e.degree, e.institution, e.location, e.start, e.end, e.description].some(
    nonEmpty,
  );
}
export function experienceVisible(x: CvExperience): boolean {
  return (
    [x.jobTitle, x.company, x.location, x.start, x.end].some(nonEmpty) ||
    x.responsibilities.some(nonEmpty) ||
    x.achievements.some(nonEmpty)
  );
}
export function certificateVisible(c: CvCertificate): boolean {
  return [c.name, c.issuer, c.date, c.description].some(nonEmpty);
}
export function projectVisible(p: CvProject): boolean {
  return [p.name, p.role, p.date, p.description, p.technologies].some(nonEmpty);
}
export function languageVisible(l: CvLanguage): boolean {
  return nonEmpty(l.language) || nonEmpty(l.level);
}

// ---------------------------------------------------------------------------
// Defensive parsing of the persisted document
// ---------------------------------------------------------------------------

type UnknownRecord = Record<string, unknown>;

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function strList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

function objList(value: unknown, revive: (item: UnknownRecord) => unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is UnknownRecord => typeof v === "object" && v !== null)
    .map(revive);
}

/**
 * Parse a persisted (untrusted-shape) document into a valid CvDocument,
 * filling missing fields with defaults. Returns null when the input is not
 * an object at all (corrupt storage).
 */
export function sanitizeCvDocument(raw: unknown): CvDocument | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const data = raw as UnknownRecord;
  const personal = (typeof data.personal === "object" && data.personal !== null
    ? data.personal
    : {}) as UnknownRecord;

  const education = objList(data.education, (e) => ({
    ...emptyEducation(),
    id: str(e.id) || newEntryId(),
    degree: str(e.degree),
    institution: str(e.institution),
    location: str(e.location),
    start: str(e.start),
    end: str(e.end),
    description: str(e.description),
  })) as CvEducation[];

  const experience = objList(data.experience, (x) => ({
    ...emptyExperience(),
    id: str(x.id) || newEntryId(),
    jobTitle: str(x.jobTitle),
    company: str(x.company),
    location: str(x.location),
    start: str(x.start),
    end: str(x.end),
    isCurrent: x.isCurrent === true,
    responsibilities: strList(x.responsibilities).length
      ? strList(x.responsibilities)
      : [""],
    achievements: strList(x.achievements),
  })) as CvExperience[];

  const languages = objList(data.languages, (l) => ({
    id: str(l.id) || newEntryId(),
    language: str(l.language),
    level: str(l.level),
  })) as CvLanguage[];

  const certificates = objList(data.certificates, (c) => ({
    ...emptyCertificate(),
    id: str(c.id) || newEntryId(),
    name: str(c.name),
    issuer: str(c.issuer),
    date: str(c.date),
    description: str(c.description),
  })) as CvCertificate[];

  const projects = objList(data.projects, (p) => ({
    ...emptyProject(),
    id: str(p.id) || newEntryId(),
    name: str(p.name),
    role: str(p.role),
    date: str(p.date),
    description: str(p.description),
    technologies: str(p.technologies),
  })) as CvProject[];

  return {
    version: 1,
    // Legacy documents (stored before the template system existed) and
    // corrupt values both resolve to the original "classic" design.
    templateId: resolveCvTemplateId(data.templateId),
    personal: {
      fullName: str(personal.fullName),
      professionalTitle: str(personal.professionalTitle),
      email: str(personal.email),
      phone: str(personal.phone),
      location: str(personal.location),
      linkedin: str(personal.linkedin),
      website: str(personal.website),
      nationality: str(personal.nationality),
      dateOfBirth: str(personal.dateOfBirth),
      availability: str(personal.availability),
      photo:
        typeof personal.photo === "string" && personal.photo.startsWith("data:image/")
          ? personal.photo
          : null,
    },
    summary: str(data.summary),
    education,
    experience,
    skills: strList(data.skills),
    languages,
    certificates,
    projects,
    interests: strList(data.interests),
    customization: sanitizeCvCustomization(data.customization),
  };
}

// ---------------------------------------------------------------------------
// Import: existing Bewerbung Scanner profile → CV document
// ---------------------------------------------------------------------------

/**
 * Map the user's latest scanner CandidateProfile into a CV document.
 * Only maps what EXISTS in the profile — nothing is invented:
 *  - candidate.*      → personal (name, location, email, phone, linkedin)
 *  - target_roles[0]  → professional title
 *  - education        → education (school/university → institution,
 *                       degree + field → degree, graduation year → end)
 *  - experience       → experience (responsibilities kept; achievements
 *                       empty — the profile has no such field)
 *  - skills (all groups) → skills (flattened, deduplicated)
 *  - languages        → languages
 *  - training         → certificates (Ausbildung/Weiterbildung entries)
 *  - summary/projects/interests → stay EMPTY (the profile does not store
 *    them; they are never fabricated).
 */
export function importCandidateProfileToCv(profile: CandidateProfile): CvDocument {
  const cv = cvEmpty();
  const c = profile.candidate ?? {};

  cv.personal.fullName = c.full_name ?? "";
  cv.personal.location = c.location ?? c.current_location ?? c.country ?? "";
  cv.personal.email = c.contact?.email ?? "";
  cv.personal.phone = c.contact?.phone ?? "";
  cv.personal.linkedin = c.contact?.linkedin ?? "";
  cv.personal.professionalTitle = profile.target_roles?.[0]?.role ?? "";

  cv.education = (profile.education ?? []).map((e) => ({
    id: newEntryId(),
    degree: [e.degree, e.field_of_study].filter((v): v is string => !!v).join(", "),
    institution: e.school ?? e.university ?? "",
    location: "",
    start: "",
    end:
      e.graduation_year === null || e.graduation_year === undefined
        ? ""
        : String(e.graduation_year),
    description: "",
  }));

  cv.experience = (profile.experience ?? []).map((x) => ({
    id: newEntryId(),
    jobTitle: x.job_title,
    company: x.company ?? "",
    location: "",
    start: x.start_date ?? "",
    end: x.end_date ?? "",
    // A job that has a start but no end is the profile's way of saying
    // "ongoing" — surface it as the current position, never guess more.
    isCurrent: Boolean(x.start_date) && !x.end_date,
    responsibilities:
      x.responsibilities?.length ? x.responsibilities : [""],
    achievements: [],
  }));

  const seen = new Set<string>();
  const skills: string[] = [];
  for (const group of Object.values(profile.skills ?? {})) {
    for (const skill of group ?? []) {
      const key = skill.trim().toLowerCase();
      if (!skill.trim() || seen.has(key)) continue;
      seen.add(key);
      skills.push(skill.trim());
    }
  }
  cv.skills = skills;

  cv.languages = (profile.languages ?? []).map((l) => ({
    id: newEntryId(),
    language: l.language,
    level: l.level ?? "",
  }));

  cv.certificates = (profile.training ?? []).map((t) => ({
    id: newEntryId(),
    name: t.name,
    issuer: t.provider ?? "",
    date: t.year ?? "",
    description: "",
  }));

  // summary / projects / interests: intentionally empty — the profile has
  // no source of truth for them and the CV must not invent content.
  return cv;
}
