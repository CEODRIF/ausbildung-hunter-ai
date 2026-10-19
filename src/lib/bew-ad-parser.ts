/**
 * Bewerbung Automation — deterministic German advertisement parser (smart input).
 *
 * Pure module: no React, no I/O, no randomness — the SAME function runs in the
 * client (live "Detected information" preview) and on the server (the single
 * extraction source for the Auto-organize action), so what the user previews
 * is exactly what gets persisted. No AI, no external API.
 *
 * What it extracts (only fields the existing data model supports):
 *   - companyName    (bew_applications.company_name)
 *   - companyEmail   (bew_applications.company_email)
 *   - contactName    (bew_applications.contact_name, optional)
 *   - companyAddress (bew_applications.company_address, optional)
 *   - positionTitle  (bew_applications.position_title, optional, ≤ 160)
 *   - positionBrief  (bew_applications.position_brief, optional, ≤ 4000)
 *
 * The schema has NO columns for phone / start date / location / employment
 * type / school degree, so those are deliberately NOT extracted fields (they
 * remain part of the original text and, when they appear inside the
 * description section, stay inside the preserved brief).
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
  BEW_POSITION_BRIEF_MAX,
  BEW_POSITION_TITLE_MAX,
  isValidEmail,
} from "@/lib/bewerbung-automation";

/**
 * Hard cap for the pasted text. Longer pastes are rejected with an actionable
 * error (INVALID_PAYLOAD server-side, the same code the existing import paths
 * use for oversized payloads) instead of being parsed silently.
 */
export const BEW_AD_INPUT_MAX = 20_000;

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
  positionTitle: ParsedAdField;
  positionBrief: ParsedAdField;
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

/** Closing/contact sections — END the preserved brief (after it has started). */
const STOP_HEADINGS = [
  /^bewerb(?:en|ung|ungen)? an\b/i,
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

/** Phone-like lines (the schema has no phone column — skipped as a field). */
const PHONE_LINE = /^(\+|00|0\d|tel\.?\s|telefon\s|phone\s)/i;

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
const LABEL_COMPANY =
  /^(firma|unternehmen|arbeitgeber|company|employer|unternehmensdarstellung|unternehmensbeschreibung|unternehmensprofil|firmenprofil|firmenbeschreibung)\s*[:\-–]\s*(.+)$/i;
const LABEL_CONTACT = /^(ansprechpartner(?:in)?|kontaktperson)\s*[:\-–]\s*(.+)$/i;
const LABEL_ADDRESS = /^(adresse|anschrift|address)\s*[:\-–]\s*(.+)$/i;
const LABEL_TITLE =
  /^(ausbildung(?:splatz|sberuf|sangebot)?|praktikum|stelle|position|job|rolle|stellentitel|beruf)\s*[:\-–]\s*(.+)$/i;
const LABEL_PHONE = /^(telefon|tel\.?|phone|fax)\s*[:\-–]\s*.+$/i;
/** "Ausbildung als Mechatroniker …" / "Praktikum bei …" style title lines. */
const TITLE_AS = /^(ausbildung(?:splatz)?|praktikum|stelle)\s+(als|zu|für|bei)\s+(.+)$/i;

/**
 * Known short metadata labels (Beginn, Ort, Anstellungsart, Schulabschluss,
 * Referenz, …). The schema has no columns for these, so in an unstructured
 * paste they are kept out of the residual brief — UNLESS the value is long,
 * which marks it as real advertisement content (then the whole line is
 * preserved).
 */
const META_LABELS =
  /^(beginn|start(?:datum)?|arbeitsbeginn|ausbildungsbeginn|ort|standort|arbeitsort|anstellungsart|beschäftigungsart|ausmaß|arbeitszeit|schulabschluss|abschluss|qualifikation|referenz(?:nummer)?|verdienst|gehalt|vergütung|dauer|vertragsart|job-?id|stellen-?id|id)\s*[:\-–]\s*(.*)$/i;

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
    positionTitle: missing(),
    positionBrief: missing(),
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
  let title: ParsedAdField = missing();

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

    // 1) explicit e-mail label
    const mEmail = t.match(LABEL_EMAIL);
    if (mEmail) {
      const rest = mEmail[2].trim();
      const token = findEmailToken(rest);
      if (token) {
        if (overwriteLabels || email.status === "missing") {
          email = isValidEmail(token)
            ? fieldFrom(token, "extracted")
            : { value: token, status: "invalid" };
        }
      } else if (rest && (NAME_PREFIX.test(rest) || NAME_WORDS.test(rest))) {
        // "Kontakt: Frau Müller" — a labelled contact person, not an e-mail.
        if (contact.status === "missing") contact = fieldFrom(rest, "extracted", 120);
      } else if (rest) {
        // Labelled but not a parseable address → flag it, never invent one.
        if (overwriteLabels || email.status === "missing") {
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

    // 7) phone label — recognized so it is never mistaken for other fields
    if (LABEL_PHONE.test(t)) {
      consumed[i] = true;
      return;
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

    // 9) bare e-mail token (header region)
    const token = findEmailToken(t);
    if (token) {
      if (email.status === "missing") {
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
    const h = classifyHeading(t);
    if (h && h.kind === "stop") {
      const rest = h.inline ?? "";
      const stopEmail = findEmailToken(rest) ?? findEmailToken(t);
      if (email.status === "missing" && stopEmail) {
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
        // "Bewerbung an: bewerbung@firma.de" — capture the e-mail first.
        if (email.status === "missing") {
          const stopEmail = findEmailToken(h.inline ?? "") ?? findEmailToken(t);
          if (stopEmail) {
            email = isValidEmail(stopEmail)
              ? fieldFrom(stopEmail, "suggested")
              : { value: stopEmail, status: "invalid" };
          }
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
      if (PHONE_LINE.test(t)) continue; // phone has no column — do not mix in
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

  /* --- last-ditch e-mail: first token anywhere in the text */
  if (email.status === "missing") {
    const anyLine = rawLines.find((l) => findEmailToken(l));
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
  result.positionTitle = title;
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
