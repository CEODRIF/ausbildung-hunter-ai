/**
 * AI Bewerbung Studio — parsing of STORED studio documents (pure, isomorphic).
 *
 * The batch completion model (./completion) runs in both server and client
 * code, so the stored-document parsers live here instead of the server-only
 * engine. src/lib/studio.ts re-exports these for the existing server call
 * sites.
 */

import {
  sanitizeCvDocument,
  type CvDocument,
} from "@/lib/templates/cv";
import type { StudioDocumentRow } from "./schema";

/** Parse a stored CV document row into a valid CvDocument (or null). */
export function parseStoredCv(doc: StudioDocumentRow | null): CvDocument | null {
  if (!doc) return null;
  return sanitizeCvDocument(doc.content);
}

/** Parse a stored cover-letter document row (or null). */
export function parseStoredLetter(
  doc: StudioDocumentRow | null,
): { text: string; tone: string } | null {
  if (!doc) return null;
  const c = doc.content as { text?: unknown; tone?: unknown };
  if (typeof c?.text !== "string" || !c.text.trim()) return null;
  return {
    text: c.text.slice(0, 16_000),
    tone: typeof c?.tone === "string" ? c.tone : "professional",
  };
}

/** Parse a stored email document row (or null). */
export function parseStoredEmail(
  doc: StudioDocumentRow | null,
): { subject: string; body: string; attachmentIds: string[] } | null {
  if (!doc) return null;
  const c = doc.content as { subject?: unknown; body?: unknown; attachmentIds?: unknown };
  if (typeof c?.subject !== "string" || typeof c?.body !== "string") return null;
  return {
    subject: c.subject.slice(0, 200),
    body: c.body.slice(0, 6000),
    attachmentIds: Array.isArray(c.attachmentIds)
      ? (c.attachmentIds as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 10)
      : [],
  };
}
