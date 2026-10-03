import { describe, expect, it } from "vitest";
import {
  DETECTED_MIME,
  detectFileType,
  storagePath,
  validateAIFile,
} from "@/lib/ai-service";

/**
 * Upload-security contracts.
 *
 * Uploads are attacker-controlled bytes with attacker-controlled metadata, so
 * the stored type must come from the CONTENT (magic bytes), never from
 * `File.type`, and the storage key must be derived server-side inside the
 * user's own folder. These tests pin both, plus the size ceiling.
 */
const PDF = Buffer.concat([
  Buffer.from("%PDF-1.7\n"),
  Buffer.alloc(64, 0x20),
]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 0x00),
]);
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(64, 0x00),
]);
const OLE_DOC = Buffer.concat([
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0]),
  Buffer.alloc(64, 0x00),
]);
const WEBP = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from("WEBP"),
  Buffer.alloc(64, 0x00),
]);
const DOCX = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from("word/document.xml"),
  Buffer.alloc(64, 0x00),
]);
const PLAIN_ZIP = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from("some/other.bin"),
  Buffer.alloc(64, 0x00),
]);
const TEXT = Buffer.from("Sehr geehrte Damen und Herren,\n".repeat(20), "utf8");
/** ELF header + NUL-heavy body: a binary that is not an accepted type. */
const ELF = Buffer.concat([
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
  Buffer.alloc(256, 0x00),
  Buffer.from([0x01, 0x02, 0x03]),
]);

const file = (buffer: Buffer, name: string, type: string) =>
  new File([new Uint8Array(buffer)], name, { type });

describe("file type is detected from content, not from metadata", () => {
  it("recognises the accepted document and image formats", () => {
    expect(detectFileType(PDF)).toBe("pdf");
    expect(detectFileType(OLE_DOC)).toBe("doc");
    expect(detectFileType(DOCX)).toBe("docx");
    expect(detectFileType(PNG)).toBe("png");
    expect(detectFileType(JPEG)).toBe("jpeg");
    expect(detectFileType(WEBP)).toBe("webp");
    expect(detectFileType(TEXT)).toBe("txt");
  });

  it("rejects a plain ZIP that is not a Word document", () => {
    expect(detectFileType(PLAIN_ZIP)).toBeNull();
  });

  it("rejects binaries and truncated input", () => {
    expect(detectFileType(ELF)).toBeNull();
    expect(detectFileType(Buffer.from([0x25]))).toBeNull();
  });

  it("maps every detected type to a concrete MIME", () => {
    for (const type of ["pdf", "doc", "docx", "txt", "png", "jpeg", "webp"] as const) {
      expect(DETECTED_MIME[type]).toMatch(/^[a-z]+\/[a-z0-9.+-]+$/);
    }
  });
});

describe("validateAIFile enforces size, content and metadata agreement", () => {
  it("accepts a well-formed upload", () => {
    expect(validateAIFile(file(PDF, "lebenslauf.pdf", "application/pdf"), PDF)).toBe(
      "pdf",
    );
  });

  it("accepts an empty or generic browser hint (very common in practice)", () => {
    for (const hint of ["", "application/octet-stream"]) {
      expect(validateAIFile(file(PDF, "x.pdf", hint), PDF)).toBe("pdf");
    }
  });

  it("rejects a renamed executable", () => {
    expect(() =>
      validateAIFile(file(ELF, "harmlos.pdf", "application/pdf"), ELF),
    ).toThrow(/not supported/i);
  });

  it("rejects content that contradicts the declared type (polyglot / spoof)", () => {
    expect(() =>
      validateAIFile(file(PNG, "bewerbung.pdf", "application/pdf"), PNG),
    ).toThrow(/does not match/i);
  });

  it("rejects empty and oversized bodies", () => {
    expect(() => validateAIFile(file(Buffer.alloc(0), "x.pdf", "application/pdf"), Buffer.alloc(0))).toThrow(
      /10 MB or smaller/i,
    );
    const tooBig = Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024 + 1, 0x20)]);
    expect(() => validateAIFile(file(tooBig, "x.pdf", "application/pdf"), tooBig)).toThrow(
      /10 MB or smaller/i,
    );
  });
});

describe("storage keys are server-derived and folder-isolated", () => {
  const userId = "11111111-2222-3333-4444-555555555555";

  it("always lives under the user's own folder", () => {
    const path = storagePath(userId, "bewerbung.pdf");
    expect(path.startsWith(`${userId}/`)).toBe(true);
    expect(path.split("/")).toHaveLength(2);
  });

  it("strips path separators from an attacker-chosen filename", () => {
    for (const name of [
      "../../etc/passwd",
      "..\\..\\windows\\system32\\config",
      "a/b/c.pdf",
      "/absolute/path.pdf",
    ]) {
      const path = storagePath(userId, name);
      expect(path.split("/")).toHaveLength(2);
      expect(path.split("/")[1]).not.toBe("..");
      expect(path.startsWith(`${userId}/`)).toBe(true);
    }
  });

  it("keeps the key bounded even for an enormous filename", () => {
    const path = storagePath(userId, `${"a".repeat(5000)}.pdf`);
    expect(path.length).toBeLessThan(userId.length + 200);
  });

  it("never makes the key start or end with a traversal segment", () => {
    const segment = storagePath(userId, "../../../x").split("/")[1];
    expect(segment).not.toBe("..");
    expect(segment).toMatch(/^[0-9a-f-]{36}-/);
  });
});
