/**
 * Cover Letter / Anschreiben Builder — data model. Pure, isomorphic
 * (client + server + tests); no DOM, no Supabase, no React.
 *
 * Design notes (mirrors the CV model in ./cv):
 *  - ONE document type: the German Anschreiben. No selectors, no
 *    Deckblatt, no marketplace.
 *  - The letter is a German business letter: sender (right), date (right),
 *    recipient (left), subject, greeting, body paragraphs, closing,
 *    signature (text and/or image).
 *  - Greeting/closing carry conventional German defaults (they are format,
 *    not facts); everything factual (addresses, names, jobs, dates) stays
 *    empty until the user or a verified import provides it.
 *  - Persistence is per-user localStorage (see cover-letter-builder.tsx);
 *    this module never reads or writes it directly.
 */

import type { CandidateProfile } from "@/lib/bewerbung-schema";
import {
  certificateVisible,
  educationVisible,
  experienceVisible,
  languageVisible,
  projectVisible,
  type CvDocument,
} from "./cv";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClSender {
  fullName: string;
  street: string;
  postalCode: string;
  city: string;
  country: string;
  email: string;
  phone: string;
  linkedin: string;
  website: string;
}

export interface ClRecipient {
  company: string;
  contactPerson: string;
  department: string;
  street: string;
  postalCode: string;
  city: string;
  country: string;
}

export type ClSignatureKind = "none" | "text" | "image";

export interface ClSignature {
  kind: ClSignatureKind;
  text: string;
  /** Data URL (validated by the uploader) or null. */
  image: string | null;
}

export type ClTone = "professional" | "formal" | "engaged";
export type ClAiLanguage = "de" | "en";

export interface ClAiSettings {
  position: string;
  company: string;
  jobDescription: string;
  tone: ClTone;
  language: ClAiLanguage;
}

export interface ClDocument {
  version: 1;
  sender: ClSender;
  /** ISO date (yyyy-mm-dd), defaults to today; rendered in German long
   *  format ("30. September 2026"). */
  date: string;
  recipient: ClRecipient;
  subject: string;
  greeting: string;
  /** Letter body as paragraphs (blank-line separated in the document). */
  body: string[];
  closing: string;
  signature: ClSignature;
  ai: ClAiSettings;
}

// ---------------------------------------------------------------------------
// Conventional defaults (format, not facts)
// ---------------------------------------------------------------------------

export const GREETING_DEFAULT = "Sehr geehrte Damen und Herren,";
export const CLOSING_DEFAULT = "Mit freundlichen Grüßen";

/** Preset greetings offered in the editor (the letter stays German). */
export const GREETING_PRESETS: readonly string[] = [
  "Sehr geehrte Frau ...",
  "Sehr geehrter Herr ...",
  GREETING_DEFAULT,
];

// ---------------------------------------------------------------------------
// Date helpers (deterministic — no Intl, so tests are stable)
// ---------------------------------------------------------------------------

const GERMAN_MONTHS = [
  "Januar",
  "Februar",
  "März",
  "April",
  "Mai",
  "Juni",
  "Juli",
  "August",
  "September",
  "Oktober",
  "November",
  "Dezember",
];

export function todayISO(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

/** "2026-09-30" → "30. September 2026" (German business-letter format). */
export function formatGermanDate(iso: string): string {
  if (!isValidIsoDate(iso)) return "";
  const [y, m, d] = iso.split("-").map(Number);
  return `${d}. ${GERMAN_MONTHS[m - 1]} ${y}`;
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

export function emptySender(): ClSender {
  return {
    fullName: "",
    street: "",
    postalCode: "",
    city: "",
    country: "",
    email: "",
    phone: "",
    linkedin: "",
    website: "",
  };
}

export function emptyRecipient(): ClRecipient {
  return {
    company: "",
    contactPerson: "",
    department: "",
    street: "",
    postalCode: "",
    city: "",
    country: "",
  };
}

export function clEmpty(now?: Date): ClDocument {
  return {
    version: 1,
    sender: emptySender(),
    date: todayISO(now),
    recipient: emptyRecipient(),
    subject: "",
    greeting: GREETING_DEFAULT,
    body: [],
    closing: CLOSING_DEFAULT,
    signature: { kind: "none", text: "", image: null },
    ai: {
      position: "",
      company: "",
      jobDescription: "",
      tone: "professional",
      language: "de",
    },
  };
}

// ---------------------------------------------------------------------------
// Content detection & document lines
// ---------------------------------------------------------------------------

const nonEmpty = (value: string | null | undefined): boolean =>
  typeof value === "string" && value.trim().length > 0;

/**
 * True when the letter carries user-provided content. Conventional
 * defaults (greeting, closing, today's date) do NOT count — an untouched
 * document stays in the empty state.
 */
export function clHasContent(doc: ClDocument): boolean {
  if (Object.values(doc.sender).some(nonEmpty)) return true;
  if (Object.values(doc.recipient).some(nonEmpty)) return true;
  if (nonEmpty(doc.subject)) return true;
  if (doc.body.some(nonEmpty)) return true;
  if (nonEmpty(doc.signature.text)) return true;
  if (doc.signature.image) return true;
  return false;
}

/**
 * Address lines for the sender block (right side of the letter),
 * DIN 5008 order, empty values skipped. Contact lines are separated so
 * the document can style them distinctly.
 */
export function senderLines(s: ClSender): {
  address: string[];
  contact: string[];
} {
  const address: string[] = [];
  if (s.street.trim()) address.push(s.street.trim());
  const place = [s.postalCode.trim(), s.city.trim()].filter(Boolean).join(" ");
  if (place) address.push(place);
  if (s.country.trim()) address.push(s.country.trim());
  const contact = [s.email, s.phone, s.linkedin, s.website]
    .map((v) => v.trim())
    .filter(Boolean);
  return { address, contact };
}

/** Address lines for the recipient block (left side), empty values skipped. */
export function recipientLines(r: ClRecipient): string[] {
  const lines: string[] = [];
  if (r.company.trim()) lines.push(r.company.trim());
  if (r.contactPerson.trim()) lines.push(r.contactPerson.trim());
  if (r.department.trim()) lines.push(r.department.trim());
  if (r.street.trim()) lines.push(r.street.trim());
  const place = [r.postalCode.trim(), r.city.trim()].filter(Boolean).join(" ");
  if (place) lines.push(place);
  if (r.country.trim()) lines.push(r.country.trim());
  return lines;
}

/** Collapsed-card summaries (the editor shows "not added" when empty). */
export function senderSummary(doc: ClDocument): string {
  const name = doc.sender.fullName.trim();
  const place = [doc.sender.postalCode.trim(), doc.sender.city.trim()]
    .filter(Boolean)
    .join(" ");
  return [name, place].filter(Boolean).join(" · ");
}

export function recipientSummary(doc: ClDocument): string {
  const company = doc.recipient.company.trim();
  const place = doc.recipient.city.trim() || doc.recipient.postalCode.trim();
  return [company, place].filter(Boolean).join(" · ");
}

/** Non-empty body paragraphs, in order. */
export function bodyParagraphs(doc: ClDocument): string[] {
  return doc.body.map((p) => p.trim()).filter(Boolean);
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

function rec(value: unknown): UnknownRecord {
  return typeof value === "object" && value !== null
    ? (value as UnknownRecord)
    : {};
}

const SIGNATURE_KINDS: readonly ClSignatureKind[] = ["none", "text", "image"];
const TONES: readonly ClTone[] = ["professional", "formal", "engaged"];
const AI_LANGUAGES: readonly ClAiLanguage[] = ["de", "en"];

/**
 * Parse a persisted (untrusted-shape) document into a valid ClDocument,
 * filling missing fields with defaults. Returns null when the input is not
 * an object at all (corrupt storage) — the caller falls back to clEmpty().
 */
export function sanitizeClDocument(raw: unknown): ClDocument | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const d = raw as UnknownRecord;
  const sender = rec(d.sender);
  const recipient = rec(d.recipient);
  const signature = rec(d.signature);
  const ai = rec(d.ai);
  const base = clEmpty();

  const date = str(d.date);
  const image = str(signature.image);

  return {
    version: 1,
    sender: {
      fullName: str(sender.fullName),
      street: str(sender.street),
      postalCode: str(sender.postalCode),
      city: str(sender.city),
      country: str(sender.country),
      email: str(sender.email),
      phone: str(sender.phone),
      linkedin: str(sender.linkedin),
      website: str(sender.website),
    },
    date: isValidIsoDate(date) ? date : base.date,
    recipient: {
      company: str(recipient.company),
      contactPerson: str(recipient.contactPerson),
      department: str(recipient.department),
      street: str(recipient.street),
      postalCode: str(recipient.postalCode),
      city: str(recipient.city),
      country: str(recipient.country),
    },
    subject: str(d.subject),
    greeting: nonEmpty(str(d.greeting)) ? str(d.greeting) : base.greeting,
    body: strList(d.body),
    closing: nonEmpty(str(d.closing)) ? str(d.closing) : base.closing,
    signature: {
      kind: SIGNATURE_KINDS.includes(signature.kind as ClSignatureKind)
        ? (signature.kind as ClSignatureKind)
        : "none",
      text: str(signature.text),
      // Only small data-URL images are accepted (same contract as the CV
      // photo) — everything else is dropped, never crashed on.
      image:
        image.startsWith("data:image/") && image.length <= 2_000_000
          ? image
          : null,
    },
    ai: {
      position: str(ai.position),
      company: str(ai.company),
      jobDescription: str(ai.jobDescription),
      tone: TONES.includes(ai.tone as ClTone) ? (ai.tone as ClTone) : "professional",
      language: AI_LANGUAGES.includes(ai.language as ClAiLanguage)
        ? (ai.language as ClAiLanguage)
        : "de",
    },
  };
}

// ---------------------------------------------------------------------------
// Imports (no-invention contract: map what EXISTS, never fabricate)
// ---------------------------------------------------------------------------

/**
 * Fill the sender from the user's latest scanner CandidateProfile.
 * Only fills fields that are still EMPTY (never overwrites user edits) and
 * only from fields the profile actually stores — the profile has no
 * street/PLZ/website, so those stay empty. Recipient/subject/body are
 * application-specific and are never touched.
 */
export function importCandidateProfileToCl(
  profile: CandidateProfile,
  doc?: ClDocument,
): ClDocument {
  const base = doc ?? clEmpty();
  const c = profile.candidate ?? {};
  const fill = (current: string, next: string): string =>
    current.trim() ? current : next.trim() ? next : current;
  const s = base.sender;
  return {
    ...base,
    sender: {
      ...s,
      fullName: fill(s.fullName, c.full_name ?? ""),
      city: fill(s.city, c.location ?? c.current_location ?? ""),
      country: fill(s.country, c.country ?? ""),
      email: fill(s.email, c.contact?.email ?? ""),
      phone: fill(s.phone, c.contact?.phone ?? ""),
      linkedin: fill(s.linkedin, c.contact?.linkedin ?? ""),
      street: s.street,
      postalCode: s.postalCode,
      website: s.website,
    },
  };
}

/**
 * Copy sender data from the user's CV into EMPTY sender fields only.
 * The CV has no street/PLZ/country — those are never invented.
 */
export function copyCvToCl(cv: CvDocument, doc?: ClDocument): ClDocument {
  const base = doc ?? clEmpty();
  const p = cv.personal;
  const fill = (current: string, next: string): string =>
    current.trim() ? current : next.trim() ? next : current;
  const s = base.sender;
  return {
    ...base,
    sender: {
      ...s,
      fullName: fill(s.fullName, p.fullName),
      email: fill(s.email, p.email),
      phone: fill(s.phone, p.phone),
      linkedin: fill(s.linkedin, p.linkedin),
      website: fill(s.website, p.website),
      city: fill(s.city, p.location),
      street: s.street,
      postalCode: s.postalCode,
      country: s.country,
    },
  };
}

// ---------------------------------------------------------------------------
// AI helpers
// ---------------------------------------------------------------------------

/**
 * Split AI output into paragraphs: blank line(s) separate paragraphs,
 * single newlines inside a paragraph collapse to spaces.
 */
export function parseAiBody(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((p) =>
      p
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .join(" "),
    )
    .filter((p) => p.length > 0);
}

function promptLine(lines: string[], label: string, value?: string | null): void {
  if (value && value.trim()) lines.push(`- ${label}: ${value.trim()}`);
}

/**
 * Factual context for the AI: the candidate profile, rendered as explicit
 * fact lines. Empty sections are omitted entirely — the model must see an
 * absence as "not available", never as a hint to invent content.
 */
export function formatProfileForPrompt(profile: CandidateProfile | null): string {
  if (!profile) {
    return "KANDIDATENPROFIL: nicht verfügbar. Erfinde KEINE Kandidatenangaben.";
  }
  const lines: string[] = ["KANDIDATENPROFIL (reale, geprüfte Daten):"];
  const c = profile.candidate ?? {};
  promptLine(lines, "Name", c.full_name);
  promptLine(lines, "Ort", c.location ?? c.current_location);
  promptLine(lines, "Land", c.country);
  promptLine(lines, "E-Mail", c.contact?.email);
  promptLine(lines, "Telefon", c.contact?.phone);
  promptLine(lines, "LinkedIn", c.contact?.linkedin);
  const targets = (profile.target_roles ?? [])
    .map((r) => r.role)
    .filter((r) => r.trim());
  promptLine(lines, "Zielerwartungen", targets.join(", "));
  for (const e of profile.education ?? []) {
    promptLine(
      lines,
      "Bildung",
      [e.degree, e.field_of_study, e.school ?? e.university, e.graduation_year ? `Abschluss ${e.graduation_year}` : ""]
        .filter(Boolean)
        .join(", "),
    );
  }
  for (const t of profile.training ?? []) {
    promptLine(lines, "Ausbildung/Weiterbildung", [t.name, t.provider, t.year].filter(Boolean).join(", "));
  }
  for (const x of profile.experience ?? []) {
    const head = [x.job_title, x.company, x.start_date, x.end_date].filter(Boolean).join(", ");
    const resp = (x.responsibilities ?? []).filter((r) => r.trim()).join("; ");
    promptLine(lines, "Berufserfahrung", [head, resp].filter(Boolean).join(" — "));
  }
  const skills: string[] = [];
  for (const group of Object.values(profile.skills ?? {})) {
    for (const s of group ?? []) if (s.trim()) skills.push(s.trim());
  }
  promptLine(lines, "Fähigkeiten", [...new Set(skills)].join(", "));
  promptLine(
    lines,
    "Sprachen",
    (profile.languages ?? [])
      .map((l) => [l.language, l.level].filter(Boolean).join(" "))
      .filter(Boolean)
      .join(", "),
  );
  return lines.length > 1 ? lines.join("\n") : formatProfileForPrompt(null);
}

/**
 * Factual context for the AI: the user's own CV (the browser is the
 * source of truth — it is sanitized before use, on the server).
 */
export function formatCvForPrompt(cv: CvDocument | null): string {
  if (!cv) {
    return "LEBENSLAUF: nicht verfügbar. Erfinde KEINE Lebenslaufangaben.";
  }
  const lines: string[] = ["LEBENSLAUF (vom Nutzer gepflegte Daten):"];
  promptLine(lines, "Profil", cv.summary);
  promptLine(lines, "Berufsbezeichnung", cv.personal.professionalTitle);
  for (const e of cv.education.filter(educationVisible)) {
    promptLine(
      lines,
      "Ausbildung/Studium",
      [e.degree, e.institution, e.start && e.end ? `${e.start}–${e.end}` : e.start || e.end]
        .filter(Boolean)
        .join(", "),
    );
  }
  for (const x of cv.experience.filter(experienceVisible)) {
    const head = [x.jobTitle, x.company, x.start && (x.end || x.isCurrent) ? `${x.start}–${x.end || "heute"}` : x.start || x.end].filter(Boolean).join(", ");
    promptLine(lines, "Berufserfahrung", [head, x.responsibilities.filter((r) => r.trim()).join("; ")].filter(Boolean).join(" — "));
  }
  promptLine(lines, "Fähigkeiten", cv.skills.filter((s) => s.trim()).join(", "));
  promptLine(
    lines,
    "Sprachen",
    cv.languages.filter(languageVisible).map((l) => [l.language, l.level].filter(Boolean).join(" ")).join(", "),
  );
  for (const c of cv.certificates.filter(certificateVisible)) {
    promptLine(lines, "Zertifikat", [c.name, c.issuer, c.date].filter(Boolean).join(", "));
  }
  for (const p of cv.projects.filter(projectVisible)) {
    promptLine(lines, "Projekt", [p.name, p.role, p.technologies].filter(Boolean).join(", "));
  }
  return lines.length > 1 ? lines.join("\n") : "LEBENSLAUF: ohne Inhalt. Erfinde KEINE Lebenslaufangaben.";
}
