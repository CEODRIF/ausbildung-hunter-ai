/**
 * Regression tests for the production bug "Bewerbung Scanner rejects a valid
 * PDF with 'Upload between 1 and 10 supported files.'"
 *
 * Root cause: /api/bewerbung-scanner/files returns the full upload row
 * (id, filename, mime_type, size_bytes); the scanner UI stored that object
 * and forwarded it verbatim to POST /api/bewerbung-scanner/scan, whose
 * schema is .strict() and accepts only id/filename/mime_type — so EVERY scan
 * request with at least one file failed the parse. These tests pin the
 * client-output ↔ server-schema contract in both directions, plus the
 * count boundaries and the client-side type/size validation.
 */
import { describe, expect, it } from "vitest";
import {
  buildScanRequestBody,
  isAllowedScanFile,
  MAX_SCAN_FILE_BYTES,
  SCAN_FILE_MIME_TYPES,
} from "@/lib/bewerbung-scan-request";
import { scanRequestBodySchema } from "@/lib/bewerbung-schema";

/** Exactly what uploadAIFile() returns today: .select("id, filename, mime_type, size_bytes"). */
const uploadResponse1 = {
  id: "3f1c1a2e-0000-4c0e-9b3a-000000000001",
  filename: "LEBENSLAUF.pdf",
  mime_type: "application/pdf",
  size_bytes: 102_400,
};

const withIds = (n: number, offset = 100) =>
  Array.from({ length: n }, (_, i) => ({
    ...uploadResponse1,
    id: `3f1c1a2e-0000-4c0e-9b3a-${String(offset + i).padStart(12, "0")}`,
    filename: `doc-${offset + i}.pdf`,
  }));

describe("client ↔ server scan request contract (the regression)", () => {
  it("accepts ONE valid PDF: helper output parses against the server schema", () => {
    const body = buildScanRequestBody("ausbildung", [uploadResponse1]);
    const parsed = scanRequestBodySchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({
        goal: "ausbildung",
        files: [
          {
            id: uploadResponse1.id,
            filename: "LEBENSLAUF.pdf",
            mime_type: "application/pdf",
          },
        ],
      });
    }
  });

  it("accepts up to 10 files", () => {
    const parsed = scanRequestBodySchema.safeParse(
      buildScanRequestBody("arbeit", withIds(10)),
    );
    expect(parsed.success).toBe(true);
  });

  it("the helper strips UI-only fields — every file has exactly the 3 contract keys", () => {
    const body = buildScanRequestBody("ausbildung", withIds(3));
    for (const file of body.files) {
      expect(Object.keys(file).sort()).toEqual(["filename", "id", "mime_type"]);
    }
  });

  it("pins the server strictness: the RAW upload response (with size_bytes) is rejected", () => {
    // If this test ever starts PASSING, the schema was loosened to tolerate
    // unknown keys — that removes the .strict() injection protection.
    // Re-fail it on purpose and review.
    expect(
      scanRequestBodySchema.safeParse({
        goal: "ausbildung",
        files: [uploadResponse1],
      }).success,
    ).toBe(false);
  });

  it("rejects a zero-file body (the UI shows its own clear hint instead)", () => {
    expect(
      scanRequestBodySchema.safeParse(buildScanRequestBody("ausbildung", [])).success,
    ).toBe(false);
  });

  it("rejects 11 files (count cap stays enforced server-side)", () => {
    expect(
      scanRequestBodySchema.safeParse(buildScanRequestBody("ausbildung", withIds(11, 200)))
        .success,
    ).toBe(false);
  });

  it("rejects a non-uuid file id (server never trusts client-supplied ids)", () => {
    expect(
      scanRequestBodySchema.safeParse({
        goal: "ausbildung",
        files: [
          { id: "not-a-uuid", filename: "x.pdf", mime_type: "application/pdf" },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("client-side upload validation (shared with the component)", () => {
  it("accepts the advertised types, including one PDF", () => {
    for (const mime of SCAN_FILE_MIME_TYPES) {
      expect(isAllowedScanFile({ type: mime, size: 1 }), mime).toBe(true);
    }
  });

  it("the advertised types are exactly PDF, DOC, DOCX, PNG, JPG", () => {
    expect([...SCAN_FILE_MIME_TYPES].sort()).toEqual([
      "application/msword",
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "image/jpeg",
      "image/png",
    ]);
  });

  it("rejects unsupported types", () => {
    for (const type of ["text/plain", "video/mp4", "application/zip", ""]) {
      expect(isAllowedScanFile({ type, size: 1024 }), type || "<empty>").toBe(false);
    }
  });

  it("enforces the 10 MB cap (boundary accepted, one byte over rejected)", () => {
    expect(isAllowedScanFile({ type: "application/pdf", size: MAX_SCAN_FILE_BYTES })).toBe(
      true,
    );
    expect(
      isAllowedScanFile({ type: "application/pdf", size: MAX_SCAN_FILE_BYTES + 1 }),
    ).toBe(false);
  });
});
