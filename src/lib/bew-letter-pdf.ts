import "server-only";

/**
 * Bewerbung Automation — the generated Anschreiben PDF (per application).
 *
 * Visual & structural reference: the uploaded `AusbildungsWeg.pdf` —
 * right-aligned sender block (name, contact lines) + bold date at the top,
 * left-aligned recipient block, bold subject line, formal greeting,
 * justified body paragraphs, formal closing + name/signature area.
 *
 * Ground rules:
 *  - A4 (595.28 × 841.89 pt), Helvetica (WinAnsi — German umlauts correct),
 *    consistent 65 pt side margins, justified body, page-break handling
 *    (no split greeting/closing; keep closing + name together).
 *  - NO invented data: the sender block uses only what the profile carries
 *    (name + e-mail; address/phone fields do not exist → cleanly omitted),
 *    the recipient block only the stored company fields, the body the stored
 *    (sanitized, edited) letter text.
 *  - Deterministic storage: `<userId>/bew-anschreiben/<applicationId>.pdf`
 *    in the EXISTING private `application-attachments` bucket (the send path
 *    already downloads from there — no new bucket, no new table column).
 *    Regeneration UPSERTs the same object → no duplicates, no orphans.
 */

import { PDFDocument, PDFFont, StandardFonts, rgb, type Color } from "pdf-lib";
import { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;
import {
  applicantAddressLines,
  formatGermanDate,
  htmlToParagraphs,
  letterPdfFilename,
  splitAddressLines,
  splitLetterParagraphs,
  validateApplicantProfile,
} from "@/lib/bewerbung-automation";

export const BEW_LETTER_PDF_MIME = "application/pdf";
export const BEW_ATTACHMENT_BUCKET = "application-attachments";

/** A4 in points (the reference document's paper size). */
export const A4_WIDTH = 595.28;
export const A4_HEIGHT = 841.89;

const MARGIN_X = 65;
const MARGIN_TOP = 56;
const MARGIN_BOTTOM = 64;
const CONTENT_WIDTH = A4_WIDTH - MARGIN_X * 2;
const RIGHT = A4_WIDTH - MARGIN_X;

const INK = rgb(0.13, 0.13, 0.13);
const MUTED = rgb(0.3, 0.3, 0.3);

/* ------------------------------------------------------------------ *
 * Pure building blocks (unit-tested without I/O)
 * ------------------------------------------------------------------ */

/** Re-exported so the UI and the PDF share ONE date format. */
export { formatGermanDate };

/**
 * The applicant profile as handed to the PDF pipeline (engine reads it from
 * `profiles`, scoped to the authenticated user). All fields nullable —
 * NEW PDF generation requires all seven to be valid (see ensureLetterPdf);
 * historical folios may legitimately carry only name+email.
 */
export interface ApplicantFacts {
  name?: string | null;
  email?: string | null;
  street?: string | null;
  postalCode?: string | null;
  city?: string | null;
  country?: string | null;
  phone?: string | null;
}

export interface LetterFolio {
  senderName: string;
  /**
   * Applicant header lines in the FIXED order (only non-empty values):
   * street / "postal code + city" (one line) / country / e-mail / phone.
   * Historical folios may carry fewer (e-mail only) — never invented.
   */
  senderLines: string[];
  dateText: string;
  companyName: string;
  companyContactName: string | null;
  companyAddressLines: string[];
  subject: string;
  greeting: string;
  bodyParagraphs: string[];
  closing: string;
  signature: string;
}

/**
 * Build the render-ready folio from the stored application row + applicant
 * facts. Missing optional fields are omitted — never invented.
 */
export function buildLetterFolio(input: {
  applicantName?: string | null;
  applicantEmail?: string | null;
  applicantStreet?: string | null;
  applicantPostalCode?: string | null;
  applicantCity?: string | null;
  applicantCountry?: string | null;
  applicantPhone?: string | null;
  companyName: string;
  companyContactName?: string | null;
  companyAddress?: string | null;
  subject: string;
  bodyHtml: string;
  date?: Date;
}): LetterFolio {
  const paragraphs = htmlToParagraphs(input.bodyHtml);
  const parts = splitLetterParagraphs(paragraphs, input.applicantName ?? "");
  const senderLines = applicantAddressLines({
    fullName: input.applicantName ?? "",
    street: input.applicantStreet ?? "",
    postalCode: input.applicantPostalCode ?? "",
    city: input.applicantCity ?? "",
    country: input.applicantCountry ?? "",
    email: input.applicantEmail ?? "",
    phone: input.applicantPhone ?? "",
  });
  return {
    senderName: (input.applicantName ?? "").trim(),
    senderLines,
    dateText: formatGermanDate(input.date ?? new Date()),
    companyName: (input.companyName ?? "").trim(),
    companyContactName: (input.companyContactName ?? "").trim() || null,
    companyAddressLines: splitAddressLines(input.companyAddress),
    subject: (input.subject ?? "").trim(),
    greeting: parts.greeting,
    bodyParagraphs: parts.body,
    closing: parts.closing,
    signature: parts.signature,
  };
}

/** Deterministic owner-scoped storage path (no migration, no new bucket). */
export function letterPdfStoragePath(userId: string, applicationId: string): string {
  return `${userId}/bew-anschreiben/${applicationId}.pdf`;
}

/** `Anschreiben_Muster-Tech_GmbH.pdf` — re-exported for the server flows. */
export { letterPdfFilename };

function looksLikePdf(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 8));
  return head.startsWith("%PDF-");
}

/* ------------------------------------------------------------------ *
 * Layout helpers
 * ------------------------------------------------------------------ */

function breakLongWord(font: PDFFont, word: string, size: number, maxWidth: number): string[] {
  const out: string[] = [];
  let current = "";
  for (const ch of word) {
    if (current && font.widthOfTextAtSize(current + ch, size) > maxWidth) {
      out.push(current);
      current = ch;
    } else {
      current += ch;
    }
  }
  if (current) out.push(current);
  return out;
}

/** Greedy word wrap (a word longer than the line is hard-broken). */
function wrapLine(font: PDFFont, text: string, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (font.widthOfTextAtSize(word, size) > maxWidth) {
      if (current) {
        lines.push(current);
        current = "";
      }
      const pieces = breakLongWord(font, word, size, maxWidth);
      lines.push(...pieces.slice(0, -1));
      current = pieces[pieces.length - 1] ?? "";
      continue;
    }
    const trial = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(trial, size) <= maxWidth) {
      current = trial;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/* ------------------------------------------------------------------ *
 * Renderer
 * ------------------------------------------------------------------ */

export async function generateLetterPdf(folio: LetterFolio): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(folio.subject || "Anschreiben");
  if (folio.senderName) doc.setAuthor(folio.senderName);

  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let page = doc.addPage([A4_WIDTH, A4_HEIGHT]);
  let y = A4_HEIGHT - MARGIN_TOP;
  const newPage = () => {
    page = doc.addPage([A4_WIDTH, A4_HEIGHT]);
    y = A4_HEIGHT - MARGIN_TOP;
  };
  /** Ensure room for `height` pt starting at the current baseline. */
  const ensure = (height: number) => {
    if (y - height < MARGIN_BOTTOM) newPage();
  };

  const drawLine = (
    text: string,
    font: PDFFont,
    size: number,
    opts: { right?: boolean; color?: Color; spaceAfter?: number } = {},
  ) => {
    ensure(size + 4);
    const width = font.widthOfTextAtSize(text, size);
    page.drawText(text, {
      x: opts.right ? RIGHT - width : MARGIN_X,
      y,
      size,
      font,
      color: opts.color ?? INK,
    });
    y -= size + 4;
    if (opts.spaceAfter) y -= opts.spaceAfter;
  };

  /**
   * Right-aligned line(s): long content (names, streets, e-mails) wraps to
   * the content width instead of flowing past the left margin — every
   * wrapped line stays right-aligned at the same right edge.
   */
  const drawRight = (text: string, font: PDFFont, size: number, color: Color = INK) => {
    for (const line of wrapLine(font, text, size, CONTENT_WIDTH)) {
      drawLine(line, font, size, { right: true, color });
    }
  };

  // ---- sender block (top right) — only facts we actually have -----------
  if (folio.senderName) drawRight(folio.senderName.toUpperCase(), bold, 11);
  for (const line of folio.senderLines) drawRight(line, regular, 10, MUTED);
  if (folio.dateText) {
    if (folio.senderName || folio.senderLines.length) y -= 6;
    drawRight(folio.dateText, bold, 10.5, INK);
  }

  // ---- gap, then the recipient block (kept together) --------------------
  const recipientLines: Array<{ text: string; bold: boolean; size: number; color: Color }> = [
    { text: folio.companyName, bold: true, size: 11, color: INK },
    ...(folio.companyContactName
      ? [{ text: folio.companyContactName, bold: false, size: 10.5, color: INK }]
      : []),
    ...folio.companyAddressLines.map((text) => ({
      text,
      bold: false,
      size: 10.5,
      color: MUTED,
    })),
  ];
  if (recipientLines.length) {
    const blockHeight = recipientLines.reduce((sum, l) => sum + l.size + 3.5, 0) + 26;
    y -= 74; // the reference's clear separation between date and recipient
    ensure(blockHeight);
    for (const line of recipientLines) {
      page.drawText(line.text, { x: MARGIN_X, y, size: line.size, font: line.bold ? bold : regular, color: line.color });
      y -= line.size + 3.5;
    }
  }

  // ---- subject (bold, may wrap; kept with the greeting below) -----------
  if (folio.subject) {
    const subjectLines = wrapLine(bold, folio.subject, 11, CONTENT_WIDTH);
    const greetingLines = wrapLine(regular, folio.greeting, 11, CONTENT_WIDTH);
    ensure(subjectLines.length * 15.5 + 30 + greetingLines.length * 15.5 + 20);
    y -= 30;
    for (const line of subjectLines) {
      page.drawText(line, { x: MARGIN_X, y, size: 11, font: bold, color: INK });
      y -= 15.5;
    }
  }

  // ---- greeting -----------------------------------------------------------
  const greetingLines = wrapLine(regular, folio.greeting, 11, CONTENT_WIDTH);
  y -= 24;
  for (const line of greetingLines) {
    page.drawText(line, { x: MARGIN_X, y, size: 11, font: regular, color: INK });
    y -= 15.5;
  }

  // ---- body (justified paragraphs, normal line breaks) --------------------
  const drawJustified = (paragraph: string) => {
    const lines = wrapLine(regular, paragraph, 11, CONTENT_WIDTH);
    lines.forEach((line, index) => {
      const isLast = index === lines.length - 1;
      ensure(15.5);
      const words = line.split(" ").filter(Boolean);
      if (words.length <= 1 || isLast) {
        page.drawText(words.join(" "), { x: MARGIN_X, y, size: 11, font: regular, color: INK });
      } else {
        const space = regular.widthOfTextAtSize(" ", 11);
        const textWidth = words.reduce((sum, w) => sum + regular.widthOfTextAtSize(w, 11), 0);
        const gap = (CONTENT_WIDTH - textWidth) / (words.length - 1);
        let x = MARGIN_X;
        for (const w of words) {
          page.drawText(w, { x, y, size: 11, font: regular, color: INK });
          x += regular.widthOfTextAtSize(w, 11) + (isLast ? space : gap);
        }
      }
      y -= 15.5;
    });
    y -= 8; // paragraph spacing
  };
  for (const paragraph of folio.bodyParagraphs) drawJustified(paragraph);

  // ---- closing + name (kept together — the reference's awkward page split
  //      is deliberately not reproduced) ------------------------------------
  const closingLines = wrapLine(regular, folio.closing, 11, CONTENT_WIDTH);
  const sigLines = folio.signature ? wrapLine(regular, folio.signature, 11, CONTENT_WIDTH) : [];
  const closingHeight = closingLines.length * 15.5 + 34 + sigLines.length * 15.5;
  ensure(closingHeight);
  y -= 10;
  for (const line of closingLines) {
    page.drawText(line, { x: MARGIN_X, y, size: 11, font: regular, color: INK });
    y -= 15.5;
  }
  y -= 34; // signature space
  for (const line of sigLines) {
    page.drawText(line, { x: MARGIN_X, y, size: 11, font: regular, color: INK });
    y -= 15.5;
  }

  return await doc.save();
}

/* ------------------------------------------------------------------ *
 * Persistence (existing bucket, ownership-checked caller)
 * ------------------------------------------------------------------ */

export type LetterAttachmentRef = {
  filename: string;
  mimeType: string;
  storagePath: string;
};

/**
 * Make sure the application's Anschreiben PDF exists in storage and return
 * the attachment ref. Generates when missing; regenerates when the stored
 * object is gone/corrupt (orphan heal) or `force` is set (letter edited).
 *
 * Returns null ONLY when there is no letter to render (empty body) or PDF
 * generation/storage genuinely failed — the caller blocks sending.
 */
export async function ensureLetterPdf(
  input: {
    userId: string;
    app: {
      id: string;
      company_name: string;
      contact_name?: string | null;
      company_address?: string | null;
      subject: string;
      body_html: string;
    };
    applicant: ApplicantFacts;
    force?: boolean;
    /** Injectable for tests (defaults to the real admin client). */
    admin?: Admin;
  },
): Promise<LetterAttachmentRef | null> {
  if (!input.app.body_html || !input.app.body_html.trim()) return null;
  // The full applicant header (seven mandatory fields) is required for a
  // NEW PDF. Never fall back to the old name+email-only letter: the caller
  // blocks the application with a stable, retryable error until the
  // profile is complete. (Stored/historical PDFs are returned as-is above
  // or in the !force branch below — they are never rewritten.)
  const profileCheck = validateApplicantProfile({
    fullName: input.applicant.name,
    street: input.applicant.street,
    postalCode: input.applicant.postalCode,
    city: input.applicant.city,
    country: input.applicant.country,
    email: input.applicant.email,
    phone: input.applicant.phone,
  });
  if (!profileCheck.ok) {
    // Field NAMES only — never the (private) values — for diagnosis.
    console.error(
      "[bew] letter PDF blocked: applicant profile incomplete",
      JSON.stringify({ missing: profileCheck.missing, invalid: profileCheck.invalid }),
    );
    return null;
  }
  const admin = input.admin ?? createAdminClient();
  const path = letterPdfStoragePath(input.userId, input.app.id);
  const filename = letterPdfFilename(input.app.company_name);

  if (!input.force) {
    try {
      const { data, error } = await admin.storage.from(BEW_ATTACHMENT_BUCKET).download(path);
      if (!error && data) {
        const bytes = new Uint8Array(await data.arrayBuffer());
        if (looksLikePdf(bytes)) {
          return { filename, mimeType: BEW_LETTER_PDF_MIME, storagePath: path };
        }
      }
    } catch {
      // Download failure → treat as orphan; regenerate below.
    }
  }

  let bytes: Uint8Array;
  try {
    const folio = buildLetterFolio({
      applicantName: input.applicant.name,
      applicantEmail: input.applicant.email,
      applicantStreet: input.applicant.street,
      applicantPostalCode: input.applicant.postalCode,
      applicantCity: input.applicant.city,
      applicantCountry: input.applicant.country,
      applicantPhone: input.applicant.phone,
      companyName: input.app.company_name,
      companyContactName: input.app.contact_name,
      companyAddress: input.app.company_address,
      subject: input.app.subject,
      bodyHtml: input.app.body_html,
    });
    bytes = await generateLetterPdf(folio);
  } catch (error) {
    console.error("[bew] letter PDF generation failed", error);
    return null;
  }

  const { error: uploadError } = await admin.storage
    .from(BEW_ATTACHMENT_BUCKET)
    .upload(path, bytes, { contentType: BEW_LETTER_PDF_MIME, upsert: true });
  if (uploadError) {
    console.error("[bew] letter PDF storage failed", uploadError.message);
    return null;
  }
  return { filename, mimeType: BEW_LETTER_PDF_MIME, storagePath: path };
}

/**
 * Remove a generated PDF (safe cleanup). Only ever called with a path this
 * module computed for the SAME user (owner-scoped), never user input.
 *
 * Returns `true` when the object is gone afterwards (deleted now, or already
 * absent — callers pre-check with a download), `false` when the storage
 * operation failed (the orphan is retried by the next cleanup pass).
 * Non-throwing by contract: cleanup must never break a confirmed send.
 */
export async function deleteLetterPdf(
  userId: string,
  applicationId: string,
  admin?: Admin,
): Promise<boolean> {
  const a = admin ?? createAdminClient();
  const path = letterPdfStoragePath(userId, applicationId);
  const { error } = await a.storage.from(BEW_ATTACHMENT_BUCKET).remove([path]);
  if (error) {
    console.error(
      "[bew] letter PDF cleanup failed (orphan will be retried by the next cleanup pass)",
      path,
      error.message,
    );
    return false;
  }
  return true;
}
