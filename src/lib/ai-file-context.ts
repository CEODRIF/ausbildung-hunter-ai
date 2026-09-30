import "server-only";

import mammoth from "mammoth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createAIProvider } from "@/lib/ai-provider";
import { extractPdfText } from "@/lib/pdf-extract";

export type ContextFile = {
  filename: string;
  mime_type: string;
  storage_path: string;
};
/**
 * Build the combined text context for AI analysis.
 * @param files the uploaded files to include (ownership-checked upstream).
 * @param maxFiles safety cap on how many files are read. Default 5 (chat).
 *        The Bewerbung Scanner passes 10 — its own upload limit — so a
 *        multi-page application set is never silently dropped.
 */
export async function buildFileContext(files: ContextFile[], maxFiles = 5) {
  const admin = createAdminClient();
  const parts: string[] = [];
  for (const file of files.slice(0, maxFiles)) {
    const { data, error } = await admin.storage
      .from("ai-files")
      .download(file.storage_path);
    if (error || !data) continue;
    const buffer = Buffer.from(await data.arrayBuffer());
    if (file.mime_type === "application/pdf") {
      // Server-safe extraction (see src/lib/pdf-extract.ts): the parser is
      // lazy-loaded for this real parse call only, real errors are logged
      // server-side, and callers receive the stable PDF_PARSE_FAILED code.
      const text = await extractPdfText(buffer);
      parts.push(`FILE ${file.filename}\n${text.slice(0, 50000)}`);
    } else if (
      file.mime_type ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ) {
      const parsed = await mammoth.extractRawText({ buffer });
      parts.push(`FILE ${file.filename}\n${parsed.value.slice(0, 50000)}`);
    } else if (file.mime_type === "text/plain") {
      parts.push(
        `FILE ${file.filename}\n${buffer.toString("utf8").slice(0, 50000)}`,
      );
    } else if (file.mime_type.startsWith("image/")) {
      parts.push(
        `IMAGE ANALYSIS ${file.filename}\n${await createAIProvider().analyzeImage({ filename: file.filename, mimeType: file.mime_type, content: buffer })}`,
      );
    } else {
      parts.push(
        `FILE ${file.filename}\n${await createAIProvider().analyzeFile({ filename: file.filename, mimeType: file.mime_type, content: buffer })}`,
      );
    }
  }
  return parts.join("\n\n");
}
