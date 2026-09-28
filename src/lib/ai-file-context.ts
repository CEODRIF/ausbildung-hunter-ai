import "server-only";

import { PDFParse } from "pdf-parse";
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
