/**
 * Bewerbung Automation — PURE domain logic.
 *
 * No I/O, no `server-only` imports: every function here runs identically in
 * unit tests, in server actions and (where safe) in the browser. The I/O
 * orchestration (Supabase, storage, AI, the send engine) lives in
 * `src/lib/bewerbung-engine.ts`, which imports this module.
 *
 * Isolation contract: this module does not read or write any existing
 * table, service or protected feature. It only models the feature's own
 * data (companies, import rows, send plan, letter text).
 */

import {
  GREETING_FALLBACK,
  htmlEscape,
  renderGreeting,
} from "@/lib/personalization";

/* ------------------------------------------------------------------ *
 * Limits
 * ------------------------------------------------------------------ */

/** Minimum applications the user may request per campaign. */
export const BEW_MIN_COUNT = 1;
/**
 * Maximum applications the user may request per campaign AND the
 * platform-wide daily cap for this feature. This is a REQUEST cap, not a
 * permission to exceed the effective daily sending quota — the actual send
 * batch is always `min(requested, remaining quota, platform cap)`.
 */
export const BEW_MAX_COUNT = 100;
/** Platform-wide daily cap for this feature (see BEW_MAX_COUNT). */
export const BEW_PLATFORM_DAILY_CAP = 100;

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

export type BewPurpose = "ausbildung" | "arbeit" | "praktikum";

export const BEW_PURPOSES: readonly BewPurpose[] = [
  "ausbildung",
  "arbeit",
  "praktikum",
];

export function isBewPurpose(value: unknown): value is BewPurpose {
  return (
    value === "ausbildung" || value === "arbeit" || value === "praktikum"
  );
}

/** A single company record prepared by the user (step 1). */
export interface BewCompanyInput {
  /** Employer / company name — required for reliable personalization. */
  companyName: string;
  /** Company e-mail address — required (the recipient). */
  companyEmail: string;
  /** Optional contact person (trusted source; drives the salutation). */
  contactName?: string | null;
  /** Optional company address (display only, never a "fact" to invent). */
  companyAddress?: string | null;
}

/** A normalized, sequence-numbered company row. */
export interface BewCompanyRow {
  seq: number;
  companyName: string;
  companyEmail: string;
  contactName: string | null;
  companyAddress: string | null;
  /** True when the row is complete and send-ready (valid email + name). */
  valid: boolean;
  /** Human-readable per-field problems (empty when valid). */
  problems: string[];
}

export interface BewImportError {
  /** 1-based data-row number (header row is row 0). */
  row: number;
  field: string;
  message: string;
}

export interface BewImportResult {
  /** ALL rows, preserved (never silently discarded), normalized. */
  rows: BewCompanyRow[];
  /** Per-row problems. */
  errors: BewImportError[];
  /** Normalized e-mails that appear two or more times. */
  duplicateEmails: string[];
  /** Rows whose e-mail failed validation (count). */
  invalidEmailCount: number;
  /** Rows that are complete and send-ready (count). */
  validCount: number;
}

/* ------------------------------------------------------------------ *
 * Count validation
 * ------------------------------------------------------------------ */

export type CountCheck =
  | { ok: true; value: number }
  | { ok: false; error: "not-integer" | "too-small" | "too-large" | "empty" };

/**
 * Validate the requested application count. Accepts a number or a numeric
 * string (the browser sends form values as strings). Returns a stable
 * machine-readable error code (the UI localizes it).
 */
export function validateCompanyCount(n: unknown): CountCheck {
  if (n === null || n === undefined || n === "") return { ok: false, error: "empty" };
  const asNumber =
    typeof n === "number"
      ? n
      : typeof n === "string"
        ? Number(n.trim())
        : NaN;
  if (!Number.isFinite(asNumber) || !Number.isInteger(asNumber))
    return { ok: false, error: "not-integer" };
  if (asNumber < BEW_MIN_COUNT) return { ok: false, error: "too-small" };
  if (asNumber > BEW_MAX_COUNT) return { ok: false, error: "too-large" };
  return { ok: true, value: asNumber };
}

/* ------------------------------------------------------------------ *
 * E-mail validation
 * ------------------------------------------------------------------ */

/** Pragmatic structural e-mail check (the real gate is the provider). */
export const BEW_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function normalizeEmail(email: string): string {
  return (email ?? "").trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  return BEW_EMAIL_RE.test(normalizeEmail(email));
}

/* ------------------------------------------------------------------ *
 * Column mapping (import)
 * ------------------------------------------------------------------ */

export type CompanyField =
  | "companyName"
  | "companyEmail"
  | "contactName"
  | "companyAddress";

export const COMPANY_FIELDS: readonly CompanyField[] = [
  "companyName",
  "companyEmail",
  "contactName",
  "companyAddress",
];

/** Lower-cased header aliases for each field (auto-detection). */
export const COMPANY_FIELD_ALIASES: Record<CompanyField, readonly string[]> = {
  companyName: [
    "company_name", "company name", "company", "employer", "employer name",
    "firma", "firmenname", "unternehmen", "unternehmensname", "name",
  ],
  companyEmail: [
    "company_email", "company email", "email", "e-mail", "mail",
    "email address", "e-mail address", "kontaktadresse", "kontakt", "adresse",
  ],
  contactName: [
    "contact_name", "contact name", "contact person", "ansprechpartner",
    "ansprechpartnerin", "person", "kontakt person",
  ],
  companyAddress: [
    "company_address", "company address", "address", "adresse", "street",
    "strasse", "straße", "stadt", "city", "ort",
  ],
};

/**
 * Auto-detect a header→field mapping. Matching is case/whitespace-insensitive
 * and only the FIRST matching column wins per field (later duplicates are
 * ignored). Returns the detected index for each field that has a header.
 */
export function autoMapColumns(
  headers: readonly string[],
): Partial<Record<CompanyField, number>> {
  const normalized = headers.map((h) => h.trim().toLowerCase());
  const mapping: Partial<Record<CompanyField, number>> = {};
  const used = new Set<number>();
  for (const field of COMPANY_FIELDS) {
    const aliases = COMPANY_FIELD_ALIASES[field];
    for (let i = 0; i < normalized.length; i++) {
      if (used.has(i)) continue;
      if (aliases.includes(normalized[i])) {
        mapping[field] = i;
        used.add(i);
        break;
      }
    }
  }
  return mapping;
}

/** Merge an auto-detected mapping with an explicit user override. */
export function mergeColumnMapping(
  auto: Partial<Record<CompanyField, number>>,
  explicit: Partial<Record<CompanyField, number>> | null | undefined,
): Partial<Record<CompanyField, number>> {
  const merged: Partial<Record<CompanyField, number>> = { ...auto };
  if (explicit) {
    for (const field of COMPANY_FIELDS) {
      const v = explicit[field];
      if (v === undefined || v === null) continue;
      if (Number.isInteger(v) && v >= 0) merged[field] = v;
    }
  }
  return merged;
}

/* ------------------------------------------------------------------ *
 * CSV parsing (RFC-4180-ish)
 * ------------------------------------------------------------------ */

/**
 * Parse CSV text into a matrix of cells. Handles quoted fields, embedded
 * commas, embedded newlines and doubled-quote escapes. Returns an empty
 * array for empty input. The first row is conventionally the header.
 */
export function parseCompaniesCsv(text: string): string[][] {
  if (!text) return [];
  // Strip a leading UTF-8 BOM if present.
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };
  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      pushField();
      i += 1;
      continue;
    }
    if (ch === "\r") {
      // Treat CRLF as one line break.
      if (src[i + 1] === "\n") i += 1;
      pushRow();
      i += 1;
      continue;
    }
    if (ch === "\n") {
      pushRow();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  // Flush the last field/row if the input does not end with a newline.
  if (field.length > 0 || row.length > 0) pushRow();
  // Drop fully-empty trailing rows.
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/**
 * Convert a parsed CSV matrix (header + data) into per-row field records
 * using the given mapping. Rows with no mapped data at all are skipped
 * (they are blank rows, not silently dropped records).
 */
export function recordsFromCsvMatrix(
  matrix: string[][],
  mapping: Partial<Record<CompanyField, number>>,
): Array<Record<CompanyField, string>> {
  if (matrix.length < 2) return [];
  const records: Array<Record<CompanyField, string>> = [];
  for (let r = 1; r < matrix.length; r++) {
    const cells = matrix[r];
    const record: Record<CompanyField, string> = {
      companyName: "",
      companyEmail: "",
      contactName: "",
      companyAddress: "",
    };
    let hasData = false;
    for (const field of COMPANY_FIELDS) {
      const idx = mapping[field];
      if (idx === undefined) continue;
      const value = (cells[idx] ?? "").trim();
      record[field] = value;
      if (value) hasData = true;
    }
    if (hasData) records.push(record);
  }
  return records;
}

/* ------------------------------------------------------------------ *
 * Company row building + import result
 * ------------------------------------------------------------------ */

/**
 * Suggest a company display name from an e-mail domain (best-effort ONLY —
 * for the import preview). This is NEVER treated as a verified fact: the
 * caller must show it as a suggestion the user confirms. A plain domain
 * local-part is returned (e.g. "example-gmbh.de" → "Example-Gmbh"); when the
 * domain is a well-known free-mail provider no suggestion is made (returns
 * null) so we never present "gmail" as a company.
 */
export function suggestCompanyNameFromEmail(email: string): string | null {
  const at = normalizeEmail(email).split("@");
  const domain = at[1] ?? "";
  if (!domain) return null;
  const freeMail = new Set([
    "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com",
    "web.de", "gmx.de", "gmx.net", "yahoo.de", "yahoo.com", "icloud.com",
    "mail.com", "t-online.de", "arcor.de", "freenet.de", "gmx.at",
  ]);
  if (freeMail.has(domain.split(".")[0] === domain ? domain : domain)) return null;
  const label = domain.split(".")[0] ?? "";
  if (!label || label.length < 2) return null;
  return label
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

interface RawCompanyRecord {
  companyName?: string | null;
  companyEmail?: string | null;
  contactName?: string | null;
  companyAddress?: string | null;
}

function trimOrNull(v: string | null | undefined): string | null {
  const t = (v ?? "").trim();
  return t ? t : null;
}

/**
 * Build a normalized, validated company row. The company name is required
 * for reliable personalization: when it is missing we FILL IT with a clear
 * suggestion from the e-mail domain ONLY if one is available, and still flag
 * the row as needing confirmation. We never invent facts.
 */
export function buildCompanyRow(
  seq: number,
  record: RawCompanyRecord,
  options: { allowSuggestedName?: boolean } = {},
): BewCompanyRow {
  const problems: string[] = [];
  const email = trimOrNull(record.companyEmail) ?? "";
  const contactName = trimOrNull(record.contactName);
  const companyAddress = trimOrNull(record.companyAddress);
  let companyName = trimOrNull(record.companyName) ?? "";

  const emailOk = isValidEmail(email);
  if (!emailOk) {
    problems.push(
      email
        ? "company_email: invalid e-mail address"
        : "company_email: missing e-mail address",
    );
  }

  if (!companyName) {
    const suggested = emailOk
      ? suggestCompanyNameFromEmail(email)
      : null;
    if (suggested && options.allowSuggestedName !== false) {
      companyName = suggested;
      problems.push(
        "company_name: confirmed suggestion from e-mail domain (please verify)",
      );
    } else {
      problems.push("company_name: missing company name");
    }
  }

  return {
    seq,
    companyName,
    companyEmail: email,
    contactName,
    companyAddress,
    valid: problems.length === 0,
    problems,
  };
}

/**
 * Build the full import result from raw records. Preserves EVERY row that
 * carries any data (never silently discards), detects duplicates and
 * invalid e-mails, and numbers rows sequentially from `startSeq`.
 */
export function buildImportResult(
  records: readonly RawCompanyRecord[],
  startSeq: number,
  options: { allowSuggestedName?: boolean } = {},
): BewImportResult {
  const rows: BewCompanyRow[] = [];
  const errors: BewImportError[] = [];
  const emailCounts = new Map<string, number>();
  let seq = startSeq;

  for (const record of records) {
    const row = buildCompanyRow(seq, record, options);
    rows.push(row);
    if (row.companyEmail) {
      const key = normalizeEmail(row.companyEmail);
      emailCounts.set(key, (emailCounts.get(key) ?? 0) + 1);
    }
    for (const problem of row.problems) {
      const [field, ...rest] = problem.split(": ");
      errors.push({ row: seq, field: field ?? "row", message: rest.join(": ") || problem });
    }
    seq += 1;
  }

  const duplicateEmails = [...emailCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([email]) => email);

  return {
    rows,
    errors,
    duplicateEmails,
    invalidEmailCount: rows.filter((r) => r.problems.some((p) => p.startsWith("company_email"))).length,
    validCount: rows.filter((r) => r.valid).length,
  };
}

/* ------------------------------------------------------------------ *
 * Sample template
 * ------------------------------------------------------------------ */

/** A downloadable CSV template with the expected columns + one example row. */
export function buildSampleCsvTemplate(): string {
  return [
    "company_name,company_email,contact_name,company_address",
    '"Example GmbH","jobs@example-gmbh.de","Herr Mustermann","Musterstr. 1, 10115 Berlin"',
    '"Test AG","personal@test-ag.de","",""',
  ].join("\n") + "\n";
}

/* ------------------------------------------------------------------ *
 * PDF import — best-effort candidate extraction
 * ------------------------------------------------------------------ */

export interface PdfCompanyCandidate {
  email: string;
  companyName: string;
}

const PDF_EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]{2,}/g;

/**
 * BEST-EFFORT company extraction from raw PDF text. A line that contains at
 * least one e-mail address yields ONE candidate: the first (normalized)
 * address plus the text left of it as a NAME PROPOSAL (bullets, numbering and
 * separators stripped).
 *
 * Contract (mirrors the CSV import):
 *  - the result is ALWAYS only a preview: the caller shows it to the user
 *    and nothing is stored without explicit confirmation;
 *  - duplicates (same normalized e-mail) are collapsed, first wins;
 *  - an empty name proposal is fine (the shared row builder then flags or
 *    suggests from the domain — the user decides);
 *  - output is capped at the campaign maximum (100).
 */
export function parsePdfCompanyCandidates(
  text: string,
): PdfCompanyCandidate[] {
  const seen = new Set<string>();
  const out: PdfCompanyCandidate[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    if (out.length >= BEW_MAX_COUNT) break;
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!line) continue;
    const emails = line.match(PDF_EMAIL_RE);
    if (!emails || emails.length === 0) continue;
    const email = normalizeEmail(emails[0]);
    if (!isValidEmail(email) || seen.has(email)) continue;
    seen.add(email);
    let name = line.split(emails[0])[0];
    name = name
      .replace(/^[|,;:\t.\s]*/, "")
      .replace(/^\d+[.)]\s*/, "")
      .replace(/^[-–—•*]\s*/, "")
      .replace(/[|,;:\t]+\s*$/, "")
      .trim();
    if (name.length > 120) name = name.slice(0, 120).trim();
    out.push({ email, companyName: name });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Send plan (quota)
 * ------------------------------------------------------------------ */

export interface SendPlanInput {
  /** Number of valid, selected applications the user wants to send now. */
  requested: number;
  /** Remaining effective daily quota (from get_daily_usage_snapshot). */
  remaining: number;
  /** Platform feature cap (defaults to BEW_PLATFORM_DAILY_CAP). */
  platformCap?: number;
}

export interface SendPlan {
  /** How many may be sent now = min(requested, remaining, platformCap). */
  batch: number;
  /** requested - batch (must be rescheduled or dropped by the user). */
  deferred: number;
  /** True when the user asked for more than is currently allowed. */
  overLimit: boolean;
  platformCap: number;
  remaining: number;
  /** The binding limit that produced `batch` (for the explanation copy). */
  binding: "requested" | "quota" | "platform";
}

/**
 * Compute how many of the requested applications can actually be sent now.
 * The effective limit is the LOWEST of the platform cap and the user's
 * remaining daily quota (the Gmail provider limit is enforced reactively at
 * send time — Google reports 429s, which the engine treats as retryable).
 */
export function computeSendPlan(input: SendPlanInput): SendPlan {
  const platformCap = input.platformCap ?? BEW_PLATFORM_DAILY_CAP;
  const remaining = Math.max(0, Math.floor(input.remaining));
  const requested = Math.max(0, Math.floor(input.requested));
  const effective = Math.min(platformCap, remaining);
  const batch = Math.min(requested, effective);
  let binding: SendPlan["binding"] = "requested";
  if (requested > effective) {
    binding = platformCap < remaining ? "platform" : "quota";
  }
  return {
    batch,
    deferred: requested - batch,
    overLimit: requested > effective,
    platformCap,
    remaining,
    binding,
  };
}

/* ------------------------------------------------------------------ *
 * Letter subject (deterministic — no AI, no invention)
 * ------------------------------------------------------------------ */

/**
 * Build the e-mail subject from purpose + company name. Deterministic and
 * matches the existing application-template subjects. Falls back to a
 * neutral "Ihrem Unternehmen" when no company name is present.
 */
export function buildSubject(purpose: BewPurpose, companyName: string): string {
  const name = (companyName ?? "").trim() || "Ihrem Unternehmen";
  switch (purpose) {
    case "arbeit":
      return `Bewerbung bei ${name}`;
    case "praktikum":
      return `Bewerbung um ein Praktikum bei ${name}`;
    case "ausbildung":
    default:
      return `Bewerbung um einen Ausbildungsplatz bei ${name}`;
  }
}

/* ------------------------------------------------------------------ *
 * Letter prompt (pure string building — the AI call happens in the engine)
 * ------------------------------------------------------------------ */

export interface LetterPromptInput {
  purpose: BewPurpose;
  companyName: string;
  contactName?: string | null;
  companyAddress?: string | null;
  /** The applicant's display name (from the profile; used for nothing here
   *  except so the model knows the applicant — signature is added later). */
  applicantName: string;
  /** Extracted text of the applicant's CV (the single source of facts). */
  cvText: string;
  /** Optional extracted text of certificates / diplomas. */
  certificatesText?: string;
}

/**
 * Hard no-invention rules shared by every generated Anschreiben. The model
 * may only use facts present in the supplied CV/certificates and the
 * verified company fields — never a role, qualification, experience or
 * company-specific fact that is not there.
 */
export const BEW_NO_INVENT_RULES = [
  "Schreibe ein deutsches Anschreiben (Bewerbungsschreiben).",
  "Nutze AUSSCHLIESSLICH Fakten, die in dem bereitgestellten Lebenslauf (CV) und den Zeugnissen stehen.",
  "Erfinde NIEMALS eine Position, ein Unternehmen-Fakt, eine Qualifikation, eine Erfahrung, ein Datum oder eine Zahl, die nicht im Lebenslauf/Zeugnis enthalten ist.",
  "Falls eine Information fehlt, formuliere neutral und ohne Erfindung — lücke nicht mit Fantasie auf.",
  "Verwende den Firmennamen des Unternehmens: " ,
  "Adressiere das Anschreiben direkt an dieses konkrete Unternehmen.",
  "Lieber 3-5 prägnante Absätze. Kein Betreff, keine Anrede, keine Grußformel und keine Signatur — nur der FLIESSENDE HAUPTTEXT.",
  "Schreibe in der Ich-Form, professionell und höflich.",
].join("\n");

/**
 * Build the user-message prompt for ONE company's Anschreiben. The greeting,
 * closing and signature are NOT asked of the model (they are added
 * deterministically in `assembleLetter`) so the salutation always uses the
 * verified/neutral rule and the signature always matches the profile.
 */
export function buildLetterPrompt(input: LetterPromptInput): string {
  const parts: string[] = [];
  parts.push(BEW_NO_INVENT_RULES.replace("Verwende den Firmennamen des Unternehmens: ", ""));
  parts.push(
    `FIRMENNAME: ${input.companyName.trim() || "Ihrem Unternehmen"}`,
  );
  if (input.companyAddress?.trim()) {
    parts.push(`FIRMA ADRESSE (nur Kontext, nicht erfinden): ${input.companyAddress.trim()}`);
  }
  if (input.contactName?.trim()) {
    parts.push(
      `ANSPRECHPARTNER: ${input.contactName.trim()} (die Anrede wird automatisch gesetzt — nenne sie im Text nicht)`,
    );
  }
  parts.push(`BEWERBUNG ART: ${purposeLabel(input.purpose)}`);
  parts.push(`BEWERBER: ${input.applicantName}`);
  parts.push("");
  parts.push("LEBENSLAUF (Quelltext der Fakten):");
  parts.push(truncateForPrompt(input.cvText, 12000));
  if (input.certificatesText?.trim()) {
    parts.push("");
    parts.push("ZEUGNISSE / DIPLOME (zusätzliche Fakten):");
    parts.push(truncateForPrompt(input.certificatesText, 6000));
  }
  parts.push("");
  parts.push(
    "Erstelle JETZT den fließenden Haupttext des Anschreibens für genau dieses Unternehmen.",
  );
  return parts.join("\n");
}

function purposeLabel(purpose: BewPurpose): string {
  switch (purpose) {
    case "arbeit":
      return "Stelle (Arbeit)";
    case "praktikum":
      return "Praktikum";
    case "ausbildung":
    default:
      return "Ausbildungsplatz";
  }
}

function truncateForPrompt(text: string, max: number): string {
  const clean = (text ?? "").replace(/\r\n/g, "\n").trim();
  if (clean.length <= max) return clean || "(leer)";
  return `${clean.slice(0, max)}\n[… abgeschnitten …]`;
}

/* ------------------------------------------------------------------ *
 * Letter assembly (deterministic greeting/closing/signature + AI body)
 * ------------------------------------------------------------------ */

export interface AssembledLetter {
  greeting: string;
  /** Sanitize-able HTML (the engine runs sanitizeEmailHtml on it). */
  bodyHtml: string;
  /** Plain text version (the engine can also derive it via htmlToText). */
  bodyText: string;
}

/**
 * Assemble the full letter from the AI body + deterministic envelope.
 *
 *  - The greeting ALWAYS comes from `renderGreeting(contactName)` — an
 *    explicit "Herr/Frau …" personalizes it; anything else (missing,
 *    unparseable, generic) falls back to the neutral
 *    "Sehr geehrte Damen und Herren,". Gender is never inferred.
 *  - The AI body is escaped and split into <p> paragraphs.
 *  - The closing + signature are added from the profile name.
 *
 * The caller (engine) sanitizes `bodyHtml` with the existing
 * `sanitizeEmailHtml` and derives `bodyText` with `htmlToText`.
 */
export function assembleLetter(opts: {
  aiBody: string;
  contactName?: string | null;
  signature: string;
  closing?: string;
}): AssembledLetter {
  const greeting = renderGreeting(opts.contactName ?? null);
  const signature = (opts.signature ?? "").trim() || "Mit freundlichen Grüßen";
  const closing = (opts.closing ?? "Mit freundlichen Grüßen").trim();
  const paragraphs = (opts.aiBody ?? "")
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+\n/g, " ").trim())
    .filter(Boolean);

  const parasHtml = paragraphs
    .map((p) => `<p>${htmlEscape(p)}</p>`)
    .join("");
  const bodyHtml = [
    `<p>${htmlEscape(greeting)}</p>`,
    parasHtml,
    `<p>${htmlEscape(closing)}</p>`,
    `<p>${htmlEscape(signature)}</p>`,
  ]
    .filter(Boolean)
    .join("");

  const bodyText = [greeting, ...paragraphs, closing, signature].join("\n\n");

  return { greeting, bodyHtml, bodyText };
}

/** Convenience: the neutral greeting used when no contact name is available. */
export const BEW_NEUTRAL_GREETING = GREETING_FALLBACK;

/* ------------------------------------------------------------------ *
 * Document (CV / certificates) upload validation
 * ------------------------------------------------------------------ */

/** Kinds of personal document a campaign can carry. */
export type DocumentKind = "cv" | "certificate" | "supporting";
export const DOCUMENT_KINDS: readonly DocumentKind[] = [
  "cv",
  "certificate",
  "supporting",
];
export function isDocumentKind(v: unknown): v is DocumentKind {
  return v === "cv" || v === "certificate" || v === "supporting";
}

/**
 * The MIME types a CV/certificate upload may have. This is the INTERSECTION
 * of what the existing private `application-attachments` bucket allows and
 * what the send path can embed — so documents store in that bucket and are
 * attachable WITHOUT changing `fetchAttachmentContents`.
 */
export const BEW_ALLOWED_DOCUMENT_MIMES = new Set<string>([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/png",
  "image/jpeg",
]);

/** Same 10 MB ceiling as every existing attachment path. */
export const BEW_MAX_DOCUMENT_SIZE = 10 * 1024 * 1024;

export type DocumentCheck =
  | { ok: true }
  | { ok: false; error: "empty" | "too-large" | "unsupported" };

/** Validate a document upload by (declared) MIME + size, before storage. */
export function validateDocumentInput(
  mime: string,
  size: number,
): DocumentCheck {
  if (!Number.isFinite(size) || size <= 0) return { ok: false, error: "empty" };
  if (size > BEW_MAX_DOCUMENT_SIZE) return { ok: false, error: "too-large" };
  if (!BEW_ALLOWED_DOCUMENT_MIMES.has(mime ?? ""))
    return { ok: false, error: "unsupported" };
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * Provider send-outcome classification (idempotency / no-duplicate)
 * ------------------------------------------------------------------ */

export type SendOutcomeKind = "retry" | "failed" | "reconnect" | "uncertain";
export interface ClassifiedSendError {
  kind: SendOutcomeKind;
  code: string;
  message: string;
}

/**
 * Classify a rejected `sendEmail` into a safe, idempotent action:
 *
 *  - `retry`     a ProviderFailure marked temporary (rate limit / 5xx /
 *                token-invalid-with-refresh). Safe to retry later — the
 *                provider definitively did NOT accept the message.
 *  - `failed`    a definitive, non-temporary rejection. The provider told us
 *                it did not send; no retry, release the quota.
 *  - `reconnect` the grant/scope is dead (reconnect / missing scope). Stop
 *                the whole batch — every further send would fail the same.
 *  - `uncertain` ANYTHING that is not a recognizable ProviderFailure (a raw
 *                network error, a timeout, an abort). The message MAY have
 *                reached the provider. NEVER auto-retry (would risk a
 *                duplicate); the caller parks it as `needs_attention`.
 *
 * This is the guard that prevents duplicate sends on ambiguous outcomes.
 */
export function classifySendError(error: unknown): ClassifiedSendError {
  const info = error as
    | {
        code?: unknown;
        message?: unknown;
        temporary?: unknown;
        reconnect?: unknown;
      }
    | null;
  if (
    info &&
    typeof info === "object" &&
    typeof (info as { code?: unknown }).code === "string"
  ) {
    const code = (info as { code: string }).code;
    const message =
      typeof (info as { message?: unknown }).message === "string"
        ? (info as { message: string }).message
        : code;
    if ((info as { reconnect?: unknown }).reconnect === true)
      return { kind: "reconnect", code, message };
    if ((info as { temporary?: unknown }).temporary === true)
      return { kind: "retry", code, message };
    return { kind: "failed", code, message };
  }
  return {
    kind: "uncertain",
    code: "provider_uncertain",
    message:
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "The provider did not confirm the send.",
  };
}
