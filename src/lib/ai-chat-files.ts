/**
 * Client-side file handling for the AI chat composer (pure functions).
 *
 * These helpers provide instant, friendly UX feedback BEFORE upload. The
 * server (uploadAIFile / validateAIFile) remains the authoritative
 * validator — it re-checks size and sniffs the actual content, so nothing
 * here can be trusted to do security work on its own.
 */

export const AI_CHAT_MAX_FILE_SIZE = 10 * 1024 * 1024;
export const AI_CHAT_ACCEPTED_EXTENSIONS = [
  "pdf",
  "doc",
  "docx",
  "txt",
  "png",
  "jpg",
  "jpeg",
  "webp",
] as const;
export const AI_CHAT_ACCEPT_ATTR = ".pdf,.doc,.docx,.txt,.png,.jpg,.jpeg,.webp";

export function fileExtension(filename: string): string {
  const base = filename.split("/").pop() ?? filename;
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

/** Short badge for the attachment chip ("PDF", "DOCX", "JPG", …). */
export function fileBadge(filename: string): string {
  const ext = fileExtension(filename);
  if (ext === "jpeg") return "JPG";
  return ext ? ext.toUpperCase() : "DATEI";
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
}

export function isImageMime(mime: string | undefined): boolean {
  return !!mime?.toLowerCase().startsWith("image/");
}

export type ClientFileCheck =
  | { ok: true }
  | { ok: false; reason: string };

/** Pre-upload check with user-friendly German messages. */
export function checkClientFile(file: {
  name: string;
  size: number;
}): ClientFileCheck {
  if (!file.name) return { ok: false, reason: "Unbekannte Datei." };
  if (file.size <= 0)
    return { ok: false, reason: `„${file.name}“ ist eine leere Datei.` };
  if (file.size > AI_CHAT_MAX_FILE_SIZE)
    return {
      ok: false,
      reason: `„${file.name}“ ist größer als 10 MB (max. 10 MB pro Datei).`,
    };
  if (!(AI_CHAT_ACCEPTED_EXTENSIONS as readonly string[]).includes(fileExtension(file.name)))
    return {
      ok: false,
      reason: `„${file.name}“: Dateityp nicht unterstützt. Erlaubt: PDF, DOC, DOCX, TXT, JPG, PNG.`,
    };
  return { ok: true };
}

/** Dedupe key for the composer queue (same name + size = duplicate). */
export function composerFileKey(
  filename: string,
  sizeBytes: number,
): string {
  return `${filename}::${sizeBytes}`;
}

/** The composer's send button is active only with text or ready
 *  attachments — and never while an upload or a generation is running. */
export function canSendWith(
  hasText: boolean,
  readyFiles: number,
  uploading: boolean,
  streaming: boolean,
): boolean {
  return (hasText || readyFiles > 0) && !uploading && !streaming;
}
