/**
 * Builds the JSON body of POST /api/bewerbung-scanner/scan.
 *
 * WHY THIS HELPER EXISTS (regression guard):
 * The server contract (`scanFileReferenceSchema` in bewerbung-schema.ts) is
 * `.strict()` and accepts exactly `id`, `filename`, `mime_type` per file.
 * The upload endpoint, however, returns MORE fields for the UI list
 * (`size_bytes` since day one — used to render "0.1 MB" next to each file).
 * Forgetting to strip those extra fields makes the scan request fail the
 * strict parse and surface the misleading 400
 * "Upload between 1 and 10 supported files." even though one valid file was
 * selected. Every client that calls the scan API must build its body through
 * this function; tests/bewerbung-scanner-contract.test.ts pins the
 * client-output ↔ server-schema contract both ways.
 */

export type ScanGoal = "ausbildung" | "arbeit";

/**
 * Client-side pre-filter for the scanner upload (mirrors the doc text
 * "PDF, DOC, DOCX, PNG, JPG · bis zu 10 Dateien · je 10 MB"). The server
 * still re-validates everything (content sniffing in uploadAIFile + the
 * strict scan schema) — this list only keeps clearly bad files from hitting
 * the upload endpoint.
 */
export const SCAN_FILE_MIME_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/png",
  "image/jpeg",
] as const;

export const MAX_SCAN_FILE_BYTES = 10 * 1024 * 1024;

export function isAllowedScanFile(file: { type: string; size: number }): boolean {
  return (
    (SCAN_FILE_MIME_TYPES as readonly string[]).includes(file.type) &&
    file.size <= MAX_SCAN_FILE_BYTES
  );
}

/** The only per-file fields the scan API accepts (see the strict schema). */
export type ScanFileReference = {
  id: string;
  filename: string;
  mime_type: string;
};

export type ScanRequestBody = {
  goal: ScanGoal;
  files: ScanFileReference[];
};

/**
 * Projects any richer file record (e.g. the upload endpoint's full response)
 * down to the exact wire contract. The explicit destructure is the fix — it
 * must not become a spread.
 */
export function buildScanRequestBody(
  goal: ScanGoal,
  files: ReadonlyArray<ScanFileReference>,
): ScanRequestBody {
  return {
    goal,
    files: files.map(({ id, filename, mime_type }) => ({
      id,
      filename,
      mime_type,
    })),
  };
}
