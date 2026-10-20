/**
 * Bewerbung Automation — deterministic German advertisement parser (smart input).
 *
 * Pure module: no React, no I/O, no randomness — the SAME function runs on the
 * server (the deterministic floor of the smart-input "Text analysieren" step)
 * and in the client tests, so what is extracted is exactly what is offered.
 * No AI, no external API (the AI enhancement lives in `@/lib/bew-ad-ai`).
 *
 * What it extracts (only fields the existing data model supports):
 *   - companyName    (bew_applications.company_name)
 *   - companyEmail   (bew_applications.company_email)
 *   - contactName    (bew_applications.contact_name, optional)
 *   - companyAddress (bew_applications.company_address, optional)
 *   - companyPhone   (bew_applications.company_phone, optional, verbatim, ≤ 80)
 *   - positionTitle  (bew_applications.position_title, optional, ≤ 160)
 *   - positionBrief  (bew_applications.position_brief, optional, ≤ 4000)
 *   - startDate      (bew_applications.start_date, optional, verbatim, ≤ 40)
 *   - endDate        (bew_applications.end_date, optional, verbatim, ≤ 40)
 *   - deadline       (bew_applications.application_deadline, optional, verbatim, ≤ 40)
 *
 * company_industry (bew_applications, optional) is NOT a deterministic
 * field: it is only ever filled by the AI extraction layer (server-side,
 * `@/lib/bew-ad-ai`) from the advertisement's context. In this module it is
 * always "missing" — the deterministic path never classifies, never guesses.
 *
 * The dates are ONLY extracted from EXPLICITLY LABELED lines (Bewerbungs-
 * schluss, Beginn, Ende der Ausbildung, …) that carry a parseable date token —
 * a bare date elsewhere is never assigned (that would be guessing). The
 * schema has still NO columns for location / employment type / school degree,
 * so those are deliberately NOT extracted fields (they remain part of the
 * original text and, when they appear inside the description section, stay
 * inside the preserved brief).
 *
 * Honesty contract (mirrors the rest of the feature: "never invented"):
 *   - Every stored value is a verbatim substring (or line-join) of the pasted
 *     text. Nothing is completed, guessed or translated.
 *   - `extracted`   = the text explicitly labels/contains the value.
 *   - `suggested`   = a conservative heuristic (e.g. a "Frau …" line, the
 *                     first header line) — shown as "needs review".
 *   - `missing`     = not found; stays empty.
 *   - `invalid`     = found but fails an existing rule (e.g. e-mail does not
 *                     match isValidEmail, or a field exceeds the DB limit).
 *                     The FULL value is kept for display; nothing is
 *                     silently truncated.
 */

import {
  BEW_MAX_COUNT,
  BEW_POSITION_BRIEF_MAX,
  BEW_POSITION_TITLE_MAX,
  isValidEmail,
  normalizeEmail,
} from "@/lib/bewerbung-automation";

/**
 * Hard cap for the pasted text. Longer pastes are rejected with an actionable
 * error (INVALID_PAYLOAD server-side, the same code the existing import paths
 * use for oversized payloads) instead of being parsed silently.
 */
export const BEW_AD_INPUT_MAX = 20_000;

/** Hard cap for a stored phone number (column limit, migration 20261117000000). */
export const BEW_PHONE_MAX = 80;

/** Hard cap for a stored advertisement date (column limit, migration 20261121000000). */
export const BEW_DATE_MAX = 40;

/** Hard cap for a stored industry classification (column limit). */
export const BEW_INDUSTRY_MAX = 120;

/**
 * Whitespace/zero-width/comma normalization shared by the anti-fabrication
 * "grounding" checks (the AI layer and the reviewed-fields validation use
 * the SAME normalization so a value that grounds on the server also grounds
 * on the client and vice versa). Commas are treated as whitespace because
 * extracted values JOIN source lines (e.g. a two-line address becomes
 * "Str. 15, 92224 Amberg") — content (letters/digits) is never relaxed.
 */
export function normalizeForGrounding(text: string): string {
  return text
    .replace(/[\u200b\u200c\u200d\u2060\ufeff]/g, "")
    .replace(/,/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function countDigits(value: string): number {
  return (value.match(/\d/g) ?? []).length;
}

/**
 * A phone value is plausible when it is short (≤ BEW_PHONE_MAX), carries at
 * least 5 digits, starts with "+" (international) or "0" (national), and uses
 * only phone characters. This is FORMAT plausibility — never reachability —
 * and never a reason to "fix" the value: the number is stored verbatim.
 */
export function isPlausiblePhone(value: string): boolean {
  const t = value.trim();
  if (t.length < 5 || t.length > BEW_PHONE_MAX) return false;
  if (!/^[+\d]/.test(t)) return false;
  if (countDigits(t) < 5) return false;
  return !/[^\d+\s\-./()]/.test(t);
}

export type ParsedAdFieldStatus = "extracted" | "suggested" | "missing" | "invalid";

export interface ParsedAdField {
  /** Verbatim (or line-joined) value from the pasted text — or "". */
  value: string;
  status: ParsedAdFieldStatus;
  /** Set when the value exceeds the DB column limit (value is NOT truncated). */
  problem?: "too_long";
}

export interface ParsedAdvertisement {
  companyName: ParsedAdField;
  companyEmail: ParsedAdField;
  contactName: ParsedAdField;
  companyAddress: ParsedAdField;
  /**
   * Verbatim phone number (original formatting, international country code
   * included when present — never completed or invented). "missing" when no
   * reliable number is found.
   */
  companyPhone: ParsedAdField;
  /**
   * Industry classification — ONLY ever filled by the AI extraction layer
   * (server-side). This deterministic module always returns "missing".
   */
  companyIndustry: ParsedAdField;
  positionTitle: ParsedAdField;
  positionBrief: ParsedAdField;
  /**
   * Advertisement dates (verbatim, never normalized or invented):
   * Ausbildungsbeginn, Ausbildungsende, Bewerbungsschluss.
   * "missing" when no reliable, LABELED date is found.
   */
  startDate: ParsedAdField;
  endDate: ParsedAdField;
  deadline: ParsedAdField;
  /** true when the pasted text exceeds BEW_AD_INPUT_MAX (rejected upstream). */
  tooLongInput: boolean;
}

export type AdGateCode =
  | "PARSE_NO_COMPANY"
  | "PARSE_NO_EMAIL"
  | "PARSE_INVALID_EMAIL"
  | "POSITION_TOO_LONG";

/** The Auto-organize gate: only these stable, user-actionable failure codes. */
export type AdGateResult = { ok: true } | { ok: false; code: AdGateCode };

/* ------------------------------------------------------------------ *
 * Shared check rules (client "Check information" AND server check action)
 * ------------------------------------------------------------------ */

/**
 * The stable blocking-issue codes a smart-input check can report (a subset of
 * the smart-input-state `SmartAddFailCode` union — EMPTY_INPUT is the only
 * code that applies before any parse exists).
 */
export type SmartAddIssueCode =
  | "INVALID_PAYLOAD"
  | "PARSE_NO_COMPANY"
  | "PARSE_NO_EMAIL"
  | "PARSE_INVALID_EMAIL"
  | "DUPLICATE_COMPANY"
  | "COUNT_EXCEEDED"
  | "POSITION_TOO_LONG";

/**
 * The FULL blocking-issue list for a parsed advertisement — ONE rule set,
 * shared by the client's "Check information" (deterministic pre-analysis)
 * and the SERVER check action (AI-enhanced parse against the campaign's DB
 * rows), so what the user reviews and what the server persists can never
 * drift apart.
 *
 * Order: field rules first (mirroring `adAutoAddGate` one-to-one, but ALL of
 * them reported — not just the first), then the duplicate / 100-row-cap
 * checks — and only when the field rules pass.
 */
export function smartAddIssues(
  parsed: ParsedAdvertisement,
  applications: Array<{ status: string; company_email: string | null }>,
): SmartAddIssueCode[] {
  const issues: SmartAddIssueCode[] = [];
  if (parsed.tooLongInput) issues.push("INVALID_PAYLOAD");
  if (!parsed.companyName.value.trim()) issues.push("PARSE_NO_COMPANY");
  const email = parsed.companyEmail.value.trim();
  if (!email) issues.push("PARSE_NO_EMAIL");
  else if (!isValidEmail(email)) issues.push("PARSE_INVALID_EMAIL");
  if (
    parsed.positionTitle.problem === "too_long" ||
    parsed.positionBrief.problem === "too_long"
  ) {
    issues.push("POSITION_TOO_LONG");
  }
  if (issues.length === 0) {
    const active = applications.filter(
      (a) => a.status !== "excluded" && a.status !== "cancelled",
    );
    const normalized = normalizeEmail(email);
    if (active.some((a) => normalizeEmail(a.company_email ?? "") === normalized)) {
      issues.push("DUPLICATE_COMPANY");
    } else if (active.length >= BEW_MAX_COUNT) {
      issues.push("COUNT_EXCEEDED");
    }
  }
  return issues;
}

/* ------------------------------------------------------------------ *
 * Pattern sets (German-first, conservative)
 * ------------------------------------------------------------------ */

/** E-mail token finder (validation is done with the existing isValidEmail). */
const EMAIL_FIND = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/** Short interface-noise lines that never carry field data (exact match). */
const NOISE_LINES = new Set([
  "impressum",
  "datenschutz",
  "datenschutzerklärung",
  "datenschutzbestimmungen",
  "agb",
  "cookie",
  "cookies",
  "cookie-richtlinie",
  "login",
  "logout",
  "anmelden",
  "abmelden",
  "registrieren",
  "zurück",
  "zurück zur liste",
  "zurück zu den ergebnissen",
  "weiter",
  "mehr anzeigen",
  "weniger anzeigen",
  "anzeige schließen",
  "schließen",
  "teilen",
  "drucken",
  "speichern",
  "merken",
  "bewerben",
  "jetzt bewerben",
  "hier bewerben",
  "online bewerben",
  "onlinbewerbung",
  "bewerbungsformular",
  "karriere",
  "jobs",
  "alle stellenangebote",
  "mehr stellenangebote",
  "mehr jobs",
  "veröffentlicht am",
  "veröffentlicht",
  "aktualisiert am",
  "nächste seite",
  "vorherige seite",
  "seite 1 von 1",
  /* Portal navigation / link lists (Seco Kältetechnik regression — the
     "Alle Stellen anzeigen … Webseiten / Webpage / Homepage" tail). */
  "alle stellen anzeigen",
  "alle stellen anzeigen in neuem tab öffnen",
  "im neuen tab öffnen",
  "webseiten",
  "webpage",
  "homepage",
  "social media seiten",
  "social media links",
  "collapse",
  "ausklappen",
  "zuklappen",
  /* Standalone company-profile section labels — the VALUE follows on the
     next lines; the label itself is structure, not content. */
  "unternehmensdarstellung",
  "unternehmensbeschreibung",
  "unternehmensprofil",
  "firmenprofil",
  "firmenbeschreibung",
  "über das unternehmen",
  "über die firma",
  "über uns",
]);

/** Description sections — the first of these starts the preserved brief. */
const DESC_HEADINGS = [
  /^stellenbeschreibung\b/i,
  /^beschreibung\b/i,
  /^aufgaben\b/i,
  /^(deine|ihre|eure) aufgaben\b/i,
  /^aufgabengebiete\b/i,
  /^t?ätigkeiten\b/i,
  /^ausbildungsinhalte\b/i,
  /^jobbeschreibung\b/i,
];

/** Requirements/profile sections — part of the preserved brief as well. */
const REQ_HEADINGS = [
  /^(ihr|dein|euer) profil\b/i,
  /^profil\b/i,
  /^anforderungen\b/i,
  /^voraussetzungen\b/i,
  /^qualifikationen\b/i,
  /^sie bringen mit\b/i,
  /^du bringst mit\b/i,
  /^dafür bringst du mit\b/i,
  /^dafür bringst ihr mit\b/i,
  /^wir erwarten\b/i,
];

/** Benefits sections — part of the preserved brief as well. */
const BENEFIT_HEADINGS = [
  /^wir bieten\b/i,
  /^dafür bieten wir\b/i,
  /^das bieten wir\b/i,
  /^was wir bieten\b/i,
  /^vorteile\b/i,
  /^benefits?\b/i,
];

/** A stop heading that is itself an APPLICATION directive (strong e-mail). */
const APPLY_STOP = /^(?:bewerb(?:en|ung|ungen)?\s+(?:bitte\s+)?an|apply\s+(?:to|via))\b/i;

/** Closing/contact sections — END the preserved brief (after it has started). */
const STOP_HEADINGS = [
  /^bewerb(?:en|ung|ungen)?\s+(?:bitte\s+)?an\b/i,
  /^bewerb(?:en)? dich\b/i,
  /^bewerbe dich\b/i,
  /^jetzt bewerben\b/i,
  /^wir freuen uns\b/i,
  /^informationen zur bewerbung\b/i,
  /^informationen zum bewerbungsverfahren\b/i,
  /^bewerbungsunterlagen\b/i,
  /^bewerbungsverfahren\b/i,
  /^senden sie\b/i,
  /^sendet uns\b/i,
  /^kontaktdaten\b/i,
  /^kontaktadresse\b/i,
  /^kontakt$/,
  /^ansprechpartner(?:in)?$/,
  /^apply\b/i,
];

/** Company legal forms — the strongest company-name signal. */
const LEGAL_FORM =
  /\b(gmbh|gmbh & ?co\.? ?kg|ag\b|kg\b|ug\b|ohg|gbr|e\.v\.?|se\b|sa\b|sag\b|b\.v\.?|ltd\.?|llc|sarl|sas\b|snc\b)\b/i;

/** Street-name hints for the address heuristic. */
const STREET_HINT =
  /\b(str\.?|straße|weg|platz|gasse|allee|ring|hof|damm|pfad|stieg|markt|kamp|heide|wiese|graben|feld|berg|dorf|campus|werk)\b/i;

/** A house number somewhere in a line (street heuristic fallback). */
const HOUSE_NO = /\b\d{1,4}[a-z]?\b/i;

/** German postal code line: "92224 Amberg, Oberpfalz". */
const PLZ_LINE = /^(\d{5})\s+(.+)$/;

/**
 * Phone-like lines (kept to EXCLUDE phone content from the preserved brief —
 * a number must never leak into the job description).
 */
const PHONE_LINE = /^(\+|00|0\d|tel\.?\s|telefon\s|phone\s)/i;

/** Dated lines that must never be mistaken for phone numbers. */
const DATE_LINE =
  /^(\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4}|\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2})$/;

/**
 * A phone token: international ("+49 151 23456789", "0049 …") or national
 * ("030 123456", "0151 23456789") — with spaces, dashes, dots, slashes or
 * parentheses. The match is the token itself, so the ORIGINAL formatting is
 * preserved verbatim (no digits are added, none removed).
 */
const PHONE_CANDIDATE =
  /\+\d[\d\s\-./()]{3,24}|\b00\d[\d\s\-./()]{3,24}|\b0\d[\d\s\-./()]{3,24}\b/;

/**
 * Find the first plausible phone token in a line. Returns null when the line
 * carries no number, when the candidate is a date, or when the digit count is
 * implausible for its kind (international ≥ 8 digits, national ≥ 7).
 */
export function findPhoneToken(line: string): string | null {
  const m = line.match(PHONE_CANDIDATE);
  if (!m) return null;
  const token = m[0].replace(/[\s\-./()]+$/, "").trim();
  if (DATE_LINE.test(token)) return null;
  const digits = countDigits(token);
  const international = token.startsWith("+") || token.startsWith("00");
  if (digits < (international ? 8 : 7) || digits > 15) return null;
  return isPlausiblePhone(token) ? token : null;
}

/** Personal-name prefix (conservative contact heuristic). */
const NAME_PREFIX = /^(frau|herr|dr\.?|prof\.?|mag\.?|dipl\.?-?ing\.?)\s/i;

/** 2–4 fully-capitalized words without digits (conservative contact heuristic). */
const NAME_WORDS =
  /^([A-ZÄÖÜ][A-Za-zÄÖÜäöüß'’-]*(?:\s+[A-ZÄÖÜ][A-Za-zÄÖÜäöüß'’-]*){1,3})$/;

/** Words that mark a line as advertisement copy, not a company name. */
const AD_KEYWORDS =
  /ausbildung|bewerbung|stellenanzeige|stellenangebot|wir suchen|karriere|praktikum|anstellung|jobs?\b|jobangebote/i;

/* ------------------------------------------------------------------ *
 * Small line helpers
 * ------------------------------------------------------------------ */

/** Strip zero-width characters browsers inject when copying from portals. */
function cleanInput(text: string): string {
  return text.replace(/[\u200b\u200c\u200d\u2060\ufeff]/g, "").replace(/\r\n?/g, "\n");
}

/**
 * Heading detection for a single line. The label part is the text before the
 * first colon (so "Beschreibung: Als Mechatroniker …" is recognized AND its
 * inline content is kept); short standalone headings ("Aufgaben", "Profil")
 * have no inline content.
 */
function classifyHeading(
  line: string,
): { kind: "desc" | "req" | "benefit" | "stop"; inline: string | null } | null {
  const t = line.trim().replace(/\s+/g, " ");
  if (!t) return null;
  const colonIdx = t.indexOf(":");
  const labelPart = colonIdx >= 0 ? t.slice(0, colonIdx) : t;
  const inline = colonIdx >= 0 ? t.slice(colonIdx + 1).trim() : null;
  const low = labelPart.trim().toLowerCase().replace(/[\-–—]\s*$/, "");
  if (!low || low.length > 80) return null;
  if (DESC_HEADINGS.some((re) => re.test(low))) return { kind: "desc", inline };
  if (REQ_HEADINGS.some((re) => re.test(low))) return { kind: "req", inline };
  if (BENEFIT_HEADINGS.some((re) => re.test(low))) return { kind: "benefit", inline };
  if (STOP_HEADINGS.some((re) => re.test(low))) return { kind: "stop", inline };
  return null;
}

function isNoise(line: string): boolean {
  const t = line.trim().toLowerCase().replace(/[\-–—]\s*$/, "");
  return t.length <= 60 && NOISE_LINES.has(t);
}

function wordCount(line: string): number {
  return line.trim().split(/\s+/).filter(Boolean).length;
}

function findEmailToken(line: string): string | null {
  const m = line.match(EMAIL_FIND);
  return m ? m[0] : null;
}

/* ------------------------------------------------------------------ *
 * Label rules (explicit "Label: value" lines — highest confidence)
 * ------------------------------------------------------------------ */

const LABEL_EMAIL = /^(e-?mail|email|mail|kontakte?)\s*[:\-–]\s*(.*)$/i;
/**
 * Explicit APPLICATION directives ("Bewerbungen (bitte) an: …", "Bewerbung
 * an: …", "apply to/via …") — the STRONGEST e-mail signal in an
 * advertisement: it outranks every generic "E-Mail:" label regardless of
 * line order (production repro 2026-10-20: a "Bewerbungen bitte an:
 * ausbildung@…" ad yielded the generic info@ because the label pass
 * first-wins/overwrite semantics had no notion of "application address").
 */
const LABEL_APPLY_EMAIL =
  /^(?:bewerb(?:en|ung|ungen)?\s+(?:bitte\s+)?an|apply\s+(?:to|via))\s*[:\-–]\s*(.+)$/i;

/**
 * Lines that mark an e-mail as belonging to a (FORMER) APPLICANT or another
 * unrelated person — such an e-mail is NEVER a company contact, whatever it
 * looks like (production repro 2026-10-20: "Hinweis: Daniel Fischer
 * [daniel.fischer@…] ist ein ehemaliger Bewerber …"). Conservative
 * keyword set (no pronouns — "mein" would over-block legitimate lines).
 */
const APPLICANT_LINE_HINT =
  /\b(?:ehemalig\w*|bewerber\w*|kandidat\w*|antragstell\w*|lebenslauf|curriculum\s+vitae|cv\b|applicant|former|ex-?mitarbeiter)\b/i;
const LABEL_COMPANY =
  /^(firma|unternehmen|arbeitgeber|company|employer|unternehmensdarstellung|unternehmensbeschreibung|unternehmensprofil|firmenprofil|firmenbeschreibung)\s*[:\-–]\s*(.+)$/i;
const LABEL_CONTACT = /^(ansprechpartner(?:in)?|kontaktperson)\s*[:\-–]\s*(.+)$/i;
const LABEL_ADDRESS = /^(adresse|anschrift|address)\s*[:\-–]\s*(.+)$/i;
const LABEL_TITLE =
  /^(ausbildung(?:splatz|sberuf|sangebot)?|praktikum|stelle|position|job|rolle|stellentitel|beruf)\s*[:\-–]\s*(.+)$/i;
const LABEL_PHONE = /^(telefon|tel\.?|telephone|phone)\s*[:\-–]\s*(.+)$/i;
/** FAX lines are consumed (never leaked to other fields) but never captured. */
const LABEL_FAX = /^fax\s*[:\-–]\s*.+$/i;
/** "Tel 030 123456" / "Telefon: +49 …" without a colon — still a phone label. */
const LABEL_PHONE_NOCOLON = /^(tel\.?|telefon|telephone|phone|t\.)\s+(\S.*)$/i;
/** "Ausbildung als Mechatroniker …" / "Praktikum bei …" style title lines. */
const TITLE_AS = /^(ausbildung(?:splatz)?|praktikum|stelle)\s+(als|zu|für|bei)\s+(.+)$/i;

/* --- advertisement dates (labeled lines only — never an unlabeled date) --- */

/**
 * Date token finders, tried in order (most specific first). The token is kept
 * VERBATIM (original spacing/case) — nothing is completed or normalized.
 */
const DATE_TOKENS: RegExp[] = [
  // 01.09.2027 / 1.9.27
  /\b(\d{1,2}\.\s*\d{1,2}\.\s*\d{2,4})\b/,
  // 01. September 2027 / 1. Sep. 2027 (German month name)
  /\b(\d{1,2}\.\s*[A-Za-zÄÖÜäöüß]{3,9}\.?\s*\d{4})\b/,
  // 1 September 2027 (English month name)
  /\b(\d{1,2}\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{4})\b/i,
  // 30.06. (year omitted — verbatim, the review form is the disambiguation)
  /\b(\d{1,2}\.\s*\d{1,2}\.)(?!\d)/,
];

/** The first (or last, for "… bis X" end-date phrases) date token in `value`. */
function findDateToken(value: string, pick: "first" | "last"): string | null {
  for (const base of DATE_TOKENS) {
    const re = new RegExp(base.source, "g");
    const matches: RegExpMatchArray[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(value)) !== null) {
      matches.push(m);
      if (m.index === re.lastIndex) re.lastIndex += 1; // zero-length guard
    }
    if (matches.length === 0) continue;
    const hit = pick === "first" ? matches[0] : matches[matches.length - 1];
    return (hit[1] ?? "").replace(/\s+/g, " ").trim() || null;
  }
  return null;
}

/**
 * Labeled date lines (German-first, conservative). Only EXPLICIT labels are
 * accepted — a bare date anywhere else is never assigned to a field (that
 * would be guessing). The labels are SEARCHED in the line (not anchored): one
 * line may carry several labeled dates (portals render
 * "Start: 01.09.2027, Bewerbung bis: 30.06.2027" on a single line), and the
 * token is always taken from the text AFTER the label that claimed it.
 */
const DATE_LABEL_RULES: Array<{
  field: "deadline" | "start" | "end";
  re: RegExp;
  /** "first" = the date right after the label; "last" = "… bis X" ranges. */
  pick: "first" | "last";
}> = [
  {
    field: "deadline",
    re: /(?:bewerbungsschluss|bewerbungsfrist|frist|stichtag|deadline|apply\s+by|bewerbung(?:en)?\s+(?:bitte\s+)?bis(?:\s+zum)?)\s*[:\-–]?\s+/i,
    pick: "first",
  },
  {
    field: "start",
    re: /(?:ausbildungsbeginn|arbeitsbeginn|beginn(?:\s+(?:der\s+ausbildung|zum|ab))?|start(?:datum)?(?:\s+(?:zum|ab))?)\s*[:\-–]?\s+/i,
    pick: "first",
  },
  {
    field: "end",
    re: /(?:ausbildungsende|ende\s+(?:der\s+ausbildung|zum)|dauer)\s*[:\-–]?\s+/i,
    pick: "last",
  },
];

/**
 * Known short metadata labels (Beginn, Ort, Anstellungsart, Schulabschluss,
 * Referenz, …). These carry no extracted field, so in an unstructured paste
 * they are kept out of the residual brief — UNLESS the value is long, which
 * marks it as real advertisement content (then the whole line is preserved).
 * (Labeled DATE lines are consumed earlier by the date rules when they carry
 * a parseable token; this list keeps the remaining label lines out of the
 * brief.)
 */
const META_LABELS =
  /^(beginn|start(?:datum)?|arbeitsbeginn|ausbildungsbeginn|ausbildungsende|bewerbungsschluss|bewerbungsfrist|stichtag|ort|standort|arbeitsort|anstellungsart|beschäftigungsart|ausmaß|arbeitszeit|schulabschluss|abschluss|qualifikation|referenz(?:nummer)?|verdienst|gehalt|vergütung|dauer|vertragsart|job-?id|stellen-?id|id)\s*[:\-–]\s*(.*)$/i;

/* ------------------------------------------------------------------ *
 * Field assembly
 * ------------------------------------------------------------------ */

function missing(): ParsedAdField {
  return { value: "", status: "missing" };
}

function fieldFrom(
  value: string,
  status: ParsedAdFieldStatus,
  max?: number,
): ParsedAdField {
  const trimmed = value.trim();
  if (!trimmed) return missing();
  if (max !== undefined && trimmed.length > max) {
    // Keep the FULL value — the error must be actionable, not a silent cut.
    return { value: trimmed, status: "invalid", problem: "too_long" };
  }
  return { value: trimmed, status };
}

/**
 * Parse a pasted company block / complete German job advertisement.
 *
 * The text is split into a HEADER region (up to the first description /
 * requirements / benefits heading), a BRIEF region (from that heading on,
 * until a closing/contact heading) and — when the contact block sits at the
 * END of the ad, as most German portals render it — a trailing CONTACT
 * section (from the last closing/contact heading on). Header and contact
 * lines feed the company fields (header findings win); the brief region is
 * preserved VERBATIM (paragraph breaks and bullets intact) as the job
 * description, portal navigation text excluded.
 */
export function parseAdvertisement(text: string): ParsedAdvertisement {
  const result: ParsedAdvertisement = {
    companyName: missing(),
    companyEmail: missing(),
    contactName: missing(),
    companyAddress: missing(),
    companyPhone: missing(),
    companyIndustry: missing(),
    positionTitle: missing(),
    positionBrief: missing(),
    startDate: missing(),
    endDate: missing(),
    deadline: missing(),
    tooLongInput: text.length > BEW_AD_INPUT_MAX,
  };

  if (!text || !text.trim()) return result;

  const rawLines = cleanInput(text).split("\n");
  // Track which header lines were consumed by a field (for the residual rule
  // and the heuristics). null = not yet assigned.
  const consumed: Array<boolean> = rawLines.map(() => false);

  let company: ParsedAdField = missing();
  let email: ParsedAdField = missing();
  let contact: ParsedAdField = missing();
  let address: ParsedAdField = missing();
  let phone: ParsedAdField = missing();
  let title: ParsedAdField = missing();
  let startDate: ParsedAdField = missing();
  let endDate: ParsedAdField = missing();
  let deadline: ParsedAdField = missing();
  /**
   * Set once an EXPLICIT application directive ("Bewerbungen (bitte) an: …")
   * captured the e-mail: from then on no generic label / bare token may
   * replace it — the directive is the strongest e-mail signal in the ad.
   */
  let applyEmailSet = false;

  /* --- pass 1: locate the first description/requirements/benefit heading */
  let headerEnd = -1; // index of the first "brief" heading line
  let briefInline: string | null = null;
  for (let i = 0; i < rawLines.length; i++) {
    if (isNoise(rawLines[i])) continue;
    const h = classifyHeading(rawLines[i]);
    if (h && h.kind !== "stop") {
      headerEnd = i;
      briefInline = h.inline;
      break;
    }
  }
  const headerStop = headerEnd >= 0 ? headerEnd : rawLines.length;

  /* --- pass 2: header region → company fields (explicit labels win) ---
     The same rules are reused for the trailing contact section (pass 2b).
     `overwriteLabels` keeps the header-pass semantics (an explicit label
     replaces an earlier value of the same field) while the contact pass
     only fills fields that are still missing — findings from the header
     region always take precedence (first-wins, nothing re-guessed). */
  function applyLineRules(i: number, overwriteLabels: boolean): void {
    const line = rawLines[i];
    if (isNoise(line)) {
      consumed[i] = true;
      return;
    }
    const t = line.trim();
    if (!t) return;

    // 0) explicit APPLICATION e-mail directive — the strongest e-mail
    //    signal (outranks generic "E-Mail:" labels in ANY line order);
    //    first-wins among directives.
    const mApply = t.match(LABEL_APPLY_EMAIL);
    if (mApply) {
      const rest = mApply[1].trim();
      const token = findEmailToken(rest);
      if (token && !applyEmailSet) {
        email = isValidEmail(token)
          ? fieldFrom(token, "extracted")
          : { value: token, status: "invalid" };
        applyEmailSet = true;
      }
      consumed[i] = true;
      return;
    }

    // 1) explicit e-mail label (generic — a captured application directive
    //    is NEVER displaced by it)
    const mEmail = t.match(LABEL_EMAIL);
    if (mEmail) {
      const rest = mEmail[2].trim();
      const token = findEmailToken(rest);
      if (token) {
        if (!applyEmailSet && (overwriteLabels || email.status === "missing")) {
          email = isValidEmail(token)
            ? fieldFrom(token, "extracted")
            : { value: token, status: "invalid" };
        }
      } else if (rest && (NAME_PREFIX.test(rest) || NAME_WORDS.test(rest))) {
        // "Kontakt: Frau Müller" — a labelled contact person, not an e-mail.
        if (contact.status === "missing") contact = fieldFrom(rest, "extracted", 120);
      } else if (rest) {
        // Labelled but not a parseable address → flag it, never invent one.
        if (!applyEmailSet && (overwriteLabels || email.status === "missing")) {
          email = { value: rest, status: "invalid" };
        }
      }
      consumed[i] = true;
      return;
    }

    // 2) explicit company label
    const mCompany = t.match(LABEL_COMPANY);
    if (mCompany) {
      if (overwriteLabels || company.status === "missing") {
        company = fieldFrom(mCompany[2], "extracted", 200);
      }
      consumed[i] = true;
      return;
    }

    // 3) explicit contact label
    const mContact = t.match(LABEL_CONTACT);
    if (mContact) {
      if (overwriteLabels || contact.status === "missing") {
        contact = fieldFrom(mContact[2], "extracted", 120);
      }
      consumed[i] = true;
      return;
    }

    // 4) explicit address label
    const mAddress = t.match(LABEL_ADDRESS);
    if (mAddress) {
      if (overwriteLabels || address.status === "missing") {
        address = fieldFrom(mAddress[2], "extracted", 200);
      }
      consumed[i] = true;
      return;
    }

    // 5) explicit position-title label ("Ausbildung: Mechatroniker/in …")
    const mTitle = t.match(LABEL_TITLE);
    if (mTitle) {
      if (overwriteLabels || title.status === "missing") {
        title = fieldFrom(mTitle[2], "extracted", BEW_POSITION_TITLE_MAX);
      }
      consumed[i] = true;
      return;
    }

    // 6) "Ausbildung als …" / "Praktikum bei …" style title line
    const mAs = t.match(TITLE_AS);
    if (mAs && wordCount(t) <= 10) {
      if (overwriteLabels || title.status === "missing") {
        title = fieldFrom(t, "extracted", BEW_POSITION_TITLE_MAX);
      }
      consumed[i] = true;
      return;
    }

    // 7) phone — recognized so it is never mistaken for other fields, and
    //    extracted VERBATIM (original formatting, country code included when
    //    present). FAX is consumed but never captured.
    if (LABEL_FAX.test(t)) {
      consumed[i] = true;
      return;
    }
    const mPhone = t.match(LABEL_PHONE) ?? t.match(LABEL_PHONE_NOCOLON);
    if (mPhone) {
      const token = findPhoneToken(mPhone[2] ?? t);
      if (token) {
        if (overwriteLabels || phone.status === "missing") {
          phone = fieldFrom(token, "extracted", BEW_PHONE_MAX);
        }
      }
      consumed[i] = true;
      return;
    }
    // 7b) a bare phone-number line (header / trailing contact region only —
    //     the same passes as every other field). Conservative: the whole line
    //     is short and number-like, and the token passes plausibility + the
    //     date guard. Marked "suggested" (no explicit label) — the review
    //     step is the disambiguation for ambiguous contact blocks.
    if (
      phone.status === "missing" &&
      t.length <= 40 &&
      (PHONE_LINE.test(t) || /^[+0]/.test(t))
    ) {
      const token = findPhoneToken(t);
      if (token) {
        phone = fieldFrom(token, "suggested", BEW_PHONE_MAX);
        consumed[i] = true;
        return;
      }
    }

    // 7c) labeled advertisement dates — the ONLY dates this parser assigns:
    //     an explicit label (Bewerbungsschluss / Beginn / Ende / Dauer, …)
    //     plus a parseable date token on the SAME line. Verbatim, first-wins
    //     per field. A line WITHOUT a parseable date ("Beginn: ab sofort")
    //     is deliberately NOT consumed here — META_LABELS keeps it out of
    //     the residual brief instead.
    if (
      deadline.status === "missing" ||
      startDate.status === "missing" ||
      endDate.status === "missing"
    ) {
      let dateFound = false;
      for (const rule of DATE_LABEL_RULES) {
        const target =
          rule.field === "deadline" ? deadline : rule.field === "start" ? startDate : endDate;
        if (target.status !== "missing") continue;
        const m = t.match(rule.re); // first (unanchored) occurrence
        if (!m || m.index === undefined) continue;
        const rest = t.slice(m.index + m[0].length);
        const token = findDateToken(rest, rule.pick);
        if (!token) continue;
        const field = fieldFrom(token, "extracted", BEW_DATE_MAX);
        if (rule.field === "deadline") deadline = field;
        else if (rule.field === "start") startDate = field;
        else endDate = field;
        dateFound = true;
      }
      if (dateFound) consumed[i] = true;
    }

    // 8) postal-code line → address (street line above it, when present)
    const mPlz = t.match(PLZ_LINE);
    if (mPlz) {
      const prev = i > 0 ? rawLines[i - 1] : null;
      const prevT = prev ? prev.trim() : "";
      const prevIsStreet =
        !!prevT &&
        !consumed[i - 1] &&
        !isNoise(prevT) &&
        prevT.length <= 60 &&
        !findEmailToken(prevT) &&
        !PHONE_LINE.test(prevT) &&
        !PLZ_LINE.test(prevT) &&
        (STREET_HINT.test(prevT) || HOUSE_NO.test(prevT));
      if (overwriteLabels || address.status === "missing") {
        address = fieldFrom(
          prevIsStreet ? `${prevT}, ${t}` : t,
          "suggested",
          200,
        );
      }
      consumed[i] = true;
      if (prevIsStreet && i > 0) consumed[i - 1] = true;
      return;
    }

    // 9) bare e-mail token (header region) — never one the line itself
    //    marks as a (former) applicant's address.
    const token = findEmailToken(t);
    if (token) {
      if (email.status === "missing" && !APPLICANT_LINE_HINT.test(t)) {
        email = isValidEmail(token)
          ? fieldFrom(token, "suggested")
          : { value: token, status: "invalid" };
      }
      consumed[i] = true;
      return;
    }

    // 10) legal form → company name (the line is company metadata either way)
    if (LEGAL_FORM.test(t) && t.length <= 80 && wordCount(t) <= 12) {
      if (company.status === "missing") company = fieldFrom(t, "extracted", 200);
      consumed[i] = true;
      return;
    }

    // 11) "Frau …" / "Herr …" / "Dr. …" → contact person (name metadata
    //     either way). A bare capitalized line is NOT treated as a person —
    //     companies look exactly like that, and ambiguity means "leave empty".
    if (
      NAME_PREFIX.test(t) &&
      t.length <= 120 &&
      !LEGAL_FORM.test(t) &&
      !STREET_HINT.test(t) &&
      !/\d/.test(t)
    ) {
      if (contact.status === "missing") contact = fieldFrom(t, "suggested", 120);
      consumed[i] = true;
      return;
    }

    // 12) STOP heading (e.g. "Kontaktdaten", "Kontaktadresse") — its inline
    //     content may carry the e-mail; the heading line itself is consumed.
    //     An APPLICATION-directive stop ("Bewerbungen bitte an: X") is the
    //     strong signal: it displaces a generic finding (unless another
    //     directive already won).
    const h = classifyHeading(t);
    if (h && h.kind === "stop") {
      const isApplyStop = APPLY_STOP.test(h.inline ?? "") || APPLY_STOP.test(t);
      const rest = h.inline ?? "";
      const stopEmail = findEmailToken(rest) ?? findEmailToken(t);
      if (isApplyStop && stopEmail && !applyEmailSet) {
        email = isValidEmail(stopEmail)
          ? fieldFrom(stopEmail, "extracted")
          : { value: stopEmail, status: "invalid" };
        applyEmailSet = true;
      } else if (email.status === "missing" && stopEmail && !APPLICANT_LINE_HINT.test(t)) {
        email = isValidEmail(stopEmail)
          ? fieldFrom(stopEmail, "suggested")
          : { value: stopEmail, status: "invalid" };
      }
      consumed[i] = true;
    }
  }

  for (let i = 0; i < headerStop; i++) applyLineRules(i, true);

  /* --- pass 2b: the trailing contact section → still-missing fields ---
     German portals frequently put the contact block (company, contact
     person, street, postal code, phone, e-mail) AFTER the description —
     below the last closing/contact heading ("Kontaktadresse", "Kontaktdaten",
     …). Pass 2 only sees the header region, so that block was silently lost
     (the Seco Kältetechnik regression: contact + address "not found"). Run
     the SAME conservative rules over the final contact section, first-wins:
     header findings are never overwritten. A stop heading that lies BEFORE
     the description is already covered by pass 2, so this only applies when
     the last stop heading is at/after the end of the header region. */
  let contactStart = -1;
  for (let i = rawLines.length - 1; i >= 0; i--) {
    if (isNoise(rawLines[i])) continue;
    const h = classifyHeading(rawLines[i]);
    if (h && h.kind === "stop") {
      contactStart = i;
      break;
    }
  }
  if (contactStart >= headerStop) {
    for (let i = contactStart; i < rawLines.length; i++) applyLineRules(i, false);
  }

  /* --- pass 3: conservative company heuristic (only if still missing) */
  if (company.status === "missing") {
    for (let i = 0; i < headerStop; i++) {
      if (consumed[i]) continue;
      const t = rawLines[i].trim();
      if (!t || t.length > 80) continue;
      const words = wordCount(t);
      if (words < 1 || words > 10) continue;
      if (findEmailToken(t) || PHONE_LINE.test(t) || PLZ_LINE.test(t)) continue;
      if (STREET_HINT.test(t) && HOUSE_NO.test(t)) continue; // address fragment
      if (AD_KEYWORDS.test(t)) continue; // advertisement copy, not a company
      if (classifyHeading(t)) continue; // a heading, not a name
      company = fieldFrom(t, "suggested", 200);
      consumed[i] = true;
      break;
    }
  }

  /* --- pass 4: all-caps role heading (only if title still missing) */
  if (title.status === "missing") {
    for (let i = 0; i < headerStop; i++) {
      if (consumed[i]) continue;
      const t = rawLines[i].trim();
      if (!t || t.length > 80) continue;
      if (t !== t.toUpperCase() || !/[A-ZÄÖÜ]{2}/.test(t)) continue;
      const words = wordCount(t);
      if (words < 2 || words > 6) continue;
      if (LEGAL_FORM.test(t) || AD_KEYWORDS.test(t)) continue;
      if (findEmailToken(t) || PLZ_LINE.test(t)) continue;
      title = fieldFrom(t, "suggested", BEW_POSITION_TITLE_MAX);
      consumed[i] = true;
      break;
    }
  }

  /* --- pass 5: the job description (preserved verbatim) */
  const briefLines: string[] = [];
  let residualBrief = false;

  if (headerEnd >= 0) {
    // Heading-driven: everything from the first description heading until a
    // closing/contact heading, including sub-sections ("Aufgaben", "Profil",
    // "Wir bieten", …) — they are part of the description, not noise.
    const firstHeadingLine = rawLines[headerEnd].trim();
    if (briefInline) {
      briefLines.push(briefInline); // "Beschreibung: …" → keep the content
    } else if (firstHeadingLine) {
      briefLines.push(firstHeadingLine); // bare section word, keep structure
    }
    for (let i = headerEnd + 1; i < rawLines.length; i++) {
      const line = rawLines[i];
      if (isNoise(line)) continue; // interface text never reaches the brief
      const t = line.trim();
      const h = t ? classifyHeading(t) : null;
      if (h && h.kind === "stop") {
        // "Bewerbungen (bitte) an: ausbildung@firma.de" — the application
        // directive ends the brief AND is the strong e-mail signal (it
        // displaces a generic finding); other stops only fill when missing
        // and never for an applicant-marked line.
        const stopEmail = findEmailToken(h.inline ?? "") ?? findEmailToken(t);
        const isApplyStop = APPLY_STOP.test(h.inline ?? "") || APPLY_STOP.test(t);
        if (isApplyStop && stopEmail && !applyEmailSet) {
          email = isValidEmail(stopEmail)
            ? fieldFrom(stopEmail, "extracted")
            : { value: stopEmail, status: "invalid" };
          applyEmailSet = true;
        } else if (email.status === "missing" && stopEmail && !APPLICANT_LINE_HINT.test(t)) {
          email = isValidEmail(stopEmail)
            ? fieldFrom(stopEmail, "suggested")
            : { value: stopEmail, status: "invalid" };
        }
        break;
      }
      briefLines.push(t);
    }
  } else {
    // No description heading at all (plain company block or unstructured ad):
    // residual lines that no field consumed become the brief — they are the
    // user's own pasted text, so keeping them is preservation, not guessing.
    // A few leftover words ("HR") are NOT a description, though.
    residualBrief = true;
    for (let i = 0; i < rawLines.length; i++) {
      if (consumed[i]) continue;
      const t = rawLines[i].trim();
      if (!t || isNoise(t)) continue;
      if (PHONE_LINE.test(t)) continue; // phone has its own field — do not mix in
      const meta = t.match(META_LABELS);
      if (meta) {
        if ((meta[2] ?? "").trim().length >= 20) briefLines.push(t); // content
        continue; // short "Beginn: 01.08.2027" metadata stays out
      }
      briefLines.push(t);
    }
  }

  // Preserve paragraph breaks (one blank line) and bullets; collapse only
  // runs of 2+ blank lines down to a single blank line.
  const collapsed: string[] = [];
  for (const line of briefLines) {
    if (line === "" && collapsed[collapsed.length - 1] === "") continue;
    collapsed.push(line);
  }
  const briefValue = collapsed.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (residualBrief && briefValue.length < 40) {
    result.positionBrief = missing(); // a few words left over is no description
  } else {
    result.positionBrief = briefValue
      ? fieldFrom(briefValue, "extracted", BEW_POSITION_BRIEF_MAX)
      : missing();
  }

  /* --- last-ditch e-mail: first token anywhere in the text — but never one
     the line itself marks as a (former) applicant's address (that would
     file the application to the wrong person). */
  if (email.status === "missing") {
    const anyLine = rawLines.find((l) => findEmailToken(l) && !APPLICANT_LINE_HINT.test(l));
    const token = anyLine ? findEmailToken(anyLine) : null;
    if (token) {
      email = isValidEmail(token)
        ? fieldFrom(token, "suggested")
        : { value: token, status: "invalid" };
    }
  }

  result.companyName = company;
  result.companyEmail = email;
  result.contactName = contact;
  result.companyAddress = address;
  result.companyPhone = phone;
  // Industry is AI-layer only (see module header) — the deterministic parser
  // never classifies, so this stays "missing" here.
  result.positionTitle = title;
  result.startDate = startDate;
  result.endDate = endDate;
  result.deadline = deadline;
  return result;
}

/* ------------------------------------------------------------------ *
 * Auto-organize gate
 * ------------------------------------------------------------------ */

/**
 * Whether the parsed result may be added as a new row. Mirrors the existing
 * readiness contract (company name + valid e-mail) plus the DB-limit rules.
 * Returns STABLE codes the client maps to localized messages (never a
 * generic "something went wrong").
 */
export function adAutoAddGate(parsed: ParsedAdvertisement): AdGateResult {
  if (!parsed.companyName.value.trim()) {
    return { ok: false, code: "PARSE_NO_COMPANY" };
  }
  const email = parsed.companyEmail.value.trim();
  if (!email) return { ok: false, code: "PARSE_NO_EMAIL" };
  if (!isValidEmail(email)) return { ok: false, code: "PARSE_INVALID_EMAIL" };
  if (
    parsed.positionTitle.problem === "too_long" ||
    parsed.positionBrief.problem === "too_long"
  ) {
    return { ok: false, code: "POSITION_TOO_LONG" };
  }
  return { ok: true };
}
