/**
 * Supplementary note page for the CV PDF export (cv.hiddenInformation).
 *
 * This is the ONLY place the private note enters the printed document: one
 * clearly labeled A4 page appended AFTER the CV sheet inside the print root
 * (cv-builder.tsx). It is
 *   - never rendered by any of the four CV templates (the sheet markup is
 *     byte-identical with or without a note),
 *   - never visible on screen (the print root is display:none outside
 *     @media print),
 *   - never rendered when the note is empty (the builder gates it on
 *     cv.hiddenInformation.trim() !== ""), so an empty field produces an
 *     unchanged PDF.
 *
 * Deliberately inspectable design — no hidden-text techniques:
 *   - real, visible dark text on a white background,
 *   - its own page (page-break-before in globals.css), so the ordinary
 *     visible CV pages are untouched,
 *   - white-space: pre-wrap, so the user's line breaks survive the PDF,
 *   - the same user-configurable margins as the sheet, exposed through the
 *     same --cv-pad-block / --cv-pad-inline vars (set inline here, consumed
 *     by the print rules in globals.css, identical fallbacks).
 * The caption states honestly that the note is plain, extractable PDF text
 * readable by ordinary PDF readers — there is no AI-specific promise.
 */
import type { CSSProperties } from "react";

interface CvNotePageProps {
  /** The note text exactly as the user entered it (≤ 2000 chars). */
  text: string;
  /** Localized page heading. */
  title: string;
  /** Localized honest caption (extractable-text disclaimer). */
  caption: string;
  /** Document direction — "rtl" for Arabic. */
  dir: "ltr" | "rtl";
  /** User-configurable top/bottom margin in mm (same as the CV sheet). */
  topMm: number;
  /** User-configurable left/right margin in mm (same as the CV sheet). */
  leftMm: number;
}

export function CvNotePage({
  text,
  title,
  caption,
  dir,
  topMm,
  leftMm,
}: CvNotePageProps) {
  const padVars = {
    "--cv-pad-block": `${topMm}mm`,
    "--cv-pad-inline": `${leftMm}mm`,
  } as CSSProperties;
  return (
    <section className="cv-note-page" dir={dir} style={padVars}>
      <h2>{title}</h2>
      <p className="cv-note-page-text">{text}</p>
      <p className="cv-note-page-caption">{caption}</p>
    </section>
  );
}
