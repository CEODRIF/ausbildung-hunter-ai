import "server-only";

import mammoth from "mammoth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createAIProvider } from "@/lib/ai-provider";

export type ContextFile = {
  filename: string;
  mime_type: string;
  storage_path: string;
};
export async function buildFileContext(files: ContextFile[]) {
  const admin = createAdminClient();
  const parts: string[] = [];
  for (const file of files.slice(0, 5)) {
    const { data, error } = await admin.storage
      .from("ai-files")
      .download(file.storage_path);
    if (error || !data) continue;
    const buffer = Buffer.from(await data.arrayBuffer());
    if (file.mime_type === "application/pdf") {
      // Lazy-load pdf-parse only when a PDF is actually parsed. Its ESM build
      // runs `new DOMMatrix()` at module scope (a browser-only API); a static
      // top-level import would crash any server-rendered page that transitively
      // loads this module (e.g. /dashboard → ai-service → here) during SSR.
      // The dynamic import confines evaluation to this real parse call, which
      // only runs in the server action/route context.
      const { PDFParse } = await import("pdf-parse");
      const parser = new PDFParse({ data: buffer });
      const parsed = await parser.getText();
      await parser.destroy();
      parts.push(`FILE ${file.filename}\n${parsed.text.slice(0, 50000)}`);
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
