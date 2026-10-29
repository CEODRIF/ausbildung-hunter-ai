/**
 * AI Bewerbung Studio — deterministic application quality review (pure).
 *
 * Runs BEFORE any AI pass: fast, testable, zero cost. The optional AI
 * grammar pass (studio-quality-ai route) is layered on top and its issues
 * are merged in by the UI. Blocking issues prevent approval; optional
 * issues are advisory and never block export (per the product contract).
 */
import { cvHasContent } from "@/lib/templates/cv";
import type { CvDocument } from "@/lib/templates/cv";
import {
  isValidEmail,
  type AdAnalysis,
  type AdExtract,
  type QualityIssue,
  type StudioAttachmentRow,
  type StudioEmailContent,
  type StudioLetterContent,
} from "./schema";

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

export interface QualityInput {
  extract: AdExtract | null;
  analysis: AdAnalysis | null;
  cv: CvDocument | null;
  letter: StudioLetterContent | null;
  email: StudioEmailContent | null;
  recipientEmail: string | null;
  attachments: StudioAttachmentRow[];
  /** Planned schedule (UTC ms) — checked against the ad deadline. */
  scheduledAtMs?: number | null;
  nowMs?: number;
}

/** Parse the ad deadline into a UTC timestamp when it is a real date.
 *  Returns null for relative phrasings ("zum nächstmöglichen Zeitpunkt") —
 *  those are surfaced as missing info, never guessed. */
export function parseAdDeadline(value: string | null | undefined): number | null {
  if (!value) return null;
  const v = value.trim();
  // dd.mm.yyyy / dd.mm.yy
  let m = v.match(/(\d{1,2})\.(\d{1,2})\.(?:(\d{4})|(\d{2}))\b/);
  if (m) {
    const day = Number(m[1]);
    const month = Number(m[2]);
    let year = Number(m[3] ?? m[4]);
    if (year < 100) year += year >= 50 ? 1900 : 2000;
    const ts = Date.UTC(year, month - 1, day, 23, 59, 59);
    return month >= 1 && month <= 12 && day >= 1 && day <= 31 ? ts : null;
  }
  // yyyy-mm-dd
  m = v.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (m) {
    const ts = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59);
    return Number.isFinite(ts) ? ts : null;
  }
  return null;
}

/** Obvious sensitive-data leak patterns (advisory — a false positive is a
 *  nudge to double-check, never a silent data change). */
const PII_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/i, label: "IBAN" },
  { pattern: /\b(?:Kontonummer|IBAN|BIC|SWIFT|Kreditkarte|Passnummer|Reisekosten|Steuernummer|Versicherungsnummer)\b/i, label: "Bank-/Steuerangaben" },
  { pattern: /\b(?:Geburtsdatum|Geboren am)\b/i, label: "Geburtsdatum" },
  { pattern: /\b(?:Eltern|Vater|Mutter|Familienstand|Kinder)\b/i, label: "Private familiäre Angaben" },
];

export function piiLeakLabels(text: string): string[] {
  return PII_PATTERNS.filter((p) => p.pattern.test(text)).map((p) => p.label);
}

export function runDeterministicQuality(input: QualityInput): QualityIssue[] {
  const issues: QualityIssue[] = [];
  const add = (key: string, severity: QualityIssue["severity"], section: QualityIssue["section"], detail: string) =>
    issues.push({ key, severity, section, detail });

  const { extract, analysis, cv, letter, email, recipientEmail, attachments } = input;

  // --- company & role -------------------------------------------------
  if (!extract?.company.trim()) {
    add("company-missing", "blocking", "general", "Unternehmen unbekannt — Anrede und Brief brauchen den Firmennamen.");
  } else if (letter && !normalize(letter.text).includes(normalize(extract.company))) {
    add("letter-company-missing", "blocking", "cover_letter", "Das Anschreiben nennt das Unternehmen nicht.");
  }
  const role = extract?.jobTitle.trim() || extract?.occupation.trim();
  if (!role) {
    add("role-missing", "blocking", "general", "Stellen-/Ausbildungstitel unbekannt — ohne Titel keine korrekte Bewerbung.");
  } else if (letter && role && !normalize(letter.text).includes(normalize(role.split(" ").slice(0, 3).join(" ")))) {
    // The first words of the title are enough (full titles vary in phrasing).
    add("letter-role-missing", "optional", "cover_letter", "Der Stellen-/Ausbildungstitel fehlt im Anschreiben.");
  }

  // --- documents -------------------------------------------------------
  if (!cv || !cvHasContent(cv)) {
    add("cv-missing", "blocking", "cv", "Kein Lebenslauf vorhanden — erst einen (angepassten) Lebenslauf erstellen.");
  }
  if (!letter || !letter.text.trim()) {
    add("letter-missing", "blocking", "cover_letter", "Kein Anschreiben vorhanden — erst eines erstellen.");
  }
  if (!email || !email.subject.trim() || !email.body.trim()) {
    add("email-missing", "blocking", "email", "Bewerbungs-E-Mail fehlt (Betreff + Text).");
  }

  // --- recipient & attachments -----------------------------------------
  if (email && recipientEmail) {
    if (!isValidEmail(recipientEmail)) {
      add("recipient-invalid", "blocking", "email", "Die E-Mail-Adresse des Empfängers ist ungültig.");
    }
  } else if (email) {
    add("recipient-missing", "blocking", "email", "Keine Empfänger-E-Mail festgelegt.");
  }
  if (email && email.attachmentIds.length === 0) {
    add("attachments-none", "optional", "attachments", "Keine Anhänge ausgewählt — Lebenslauf und Anschreiben sollten dabei sein.");
  }
  const requested = extract?.requestedDocuments ?? [];
  if (requested.length > 0 && attachments.length === 0) {
    add("requested-docs-none", "optional", "attachments",
      `Die Anzeige verlangt Unterlagen (${requested.slice(0, 3).join(", ")} …), aber es sind keine hochgeladen.`);
  }

  // --- missing qualifications -------------------------------------------
  const missingCount = analysis?.missing.length ?? 0;
  if (missingCount > 0) {
    add("missing-requirements", "optional", "general",
      `${missingCount} Anforderung(en) aus der Anzeige fehlen im Profil — im Anschreiben adressieren oder klären.`);
  }

  // --- deadline vs. schedule --------------------------------------------
  const deadline = parseAdDeadline(extract?.applicationDeadline);
  if (input.scheduledAtMs != null && deadline != null && input.scheduledAtMs > deadline) {
    add("schedule-after-deadline", "blocking", "general", "Der geplante Versand liegt NACH der Bewerbungsfrist der Anzeige.");
  }
  if (input.scheduledAtMs != null && input.nowMs != null && input.scheduledAtMs <= input.nowMs) {
    add("schedule-in-past", "blocking", "general", "Der geplante Versandzeitpunkt liegt in der Vergangenheit.");
  }

  // --- PII sweep (advisory) ----------------------------------------------
  const piiTargets: Array<[string, string]> = [
    ["cv-pii", cv ? `${cv.summary} ${cv.education.map((e) => `${e.degree} ${e.institution}`).join(" ")} ${cv.experience.map((x) => `${x.jobTitle} ${x.company} ${x.responsibilities.join(" ")}`).join(" ")}` : ""],
    ["letter-pii", letter?.text ?? ""],
    ["email-pii", email ? `${email.subject} ${email.body}` : ""],
  ];
  for (const [key, text] of piiTargets) {
    if (!text.trim()) continue;
    const labels = piiLeakLabels(text);
    if (labels.length > 0) {
      add(key, "optional", "general", `Möglicherweise sensible Angaben (${labels.join(", ")}) — prüfen, ob sie in der Bewerbung stehen sollen.`);
    }
  }

  return issues;
}
