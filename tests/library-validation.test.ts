import { describe, expect, it } from "vitest";
import {
  COVER_MAX_BYTES,
  coverObjectPath,
  coverMimeType,
  detectCoverImage,
  sanitizeBookFields,
  validateCoverFile,
  validateDownloadUrl,
} from "@/lib/book-library";
import {
  BOOK_CATEGORIES,
  BOOK_CATEGORY_SLUGS,
  categoryLabel,
  isBookCategorySlug,
} from "@/lib/book-categories";

/**
 * Deutsch Bibliothek — pure validation contracts.
 *
 * These are the server-side rules a direct (un-UI) POST must satisfy; the
 * client re-implements them for UX but never as the gate. The cover bytes
 * are the source of truth (magic bytes), never the browser metadata.
 */

// ---------------------------------------------------------------------------
// Cover image detection (magic bytes)
// ---------------------------------------------------------------------------

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 0x00),
]);
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(64, 0x00),
]);
const WEBP = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from("WEBP"),
  Buffer.alloc(64, 0x00),
]);
const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(64, 0x20)]);
const DOCX = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from("word/document.xml"),
  Buffer.alloc(64, 0x00),
]);
const TEXT = Buffer.from("Sehr geehrte Damen und Herren, das ist kein Bild.\n".repeat(10), "utf8");
const GIF = Buffer.concat([
  Buffer.from("GIF89a"),
  Buffer.alloc(64, 0x00),
]);

describe("detectCoverImage (content-based)", () => {
  it("recognises JPEG, PNG and WebP by their magic bytes", () => {
    expect(detectCoverImage(JPEG)).toBe("jpeg");
    expect(detectCoverImage(PNG)).toBe("png");
    expect(detectCoverImage(WEBP)).toBe("webp");
  });

  it("rejects documents, other image formats, text and truncated input", () => {
    expect(detectCoverImage(PDF)).toBeNull();
    expect(detectCoverImage(DOCX)).toBeNull();
    expect(detectCoverImage(TEXT)).toBeNull();
    expect(detectCoverImage(GIF)).toBeNull();
    expect(detectCoverImage(Buffer.from([0x89]))).toBeNull();
    expect(detectCoverImage(Buffer.alloc(0))).toBeNull();
  });

  it("maps each type to its concrete MIME", () => {
    expect(coverMimeType("jpeg")).toBe("image/jpeg");
    expect(coverMimeType("png")).toBe("image/png");
    expect(coverMimeType("webp")).toBe("image/webp");
  });
});

// ---------------------------------------------------------------------------
// Cover file validation (size + content + metadata agreement)
// ---------------------------------------------------------------------------

const file = (buffer: Buffer, name: string, type: string) =>
  new File([new Uint8Array(buffer)], name, { type });

describe("validateCoverFile", () => {
  it("accepts a well-formed upload", () => {
    expect(validateCoverFile(file(JPEG, "cover.jpg", "image/jpeg"), JPEG)).toBe(
      "jpeg",
    );
    expect(validateCoverFile(file(PNG, "cover.png", "image/png"), PNG)).toBe(
      "png",
    );
    expect(validateCoverFile(file(WEBP, "cover.webp", "image/webp"), WEBP)).toBe(
      "webp",
    );
  });

  it("accepts an empty or generic browser hint (very common in practice)", () => {
    for (const hint of ["", "application/octet-stream"]) {
      expect(validateCoverFile(file(PNG, "c.png", hint), PNG)).toBe("png");
    }
  });

  it("rejects a renamed non-image (content beats metadata)", () => {
    expect(validateCoverFile(file(PDF, "buch.png", "image/png"), PDF)).toBeNull();
    expect(validateCoverFile(file(TEXT, "bild.jpg", "image/jpeg"), TEXT)).toBeNull();
  });

  it("rejects a contradicting MIME hint", () => {
    expect(validateCoverFile(file(JPEG, "c.png", "image/png"), JPEG)).toBeNull();
  });

  it("enforces the size ceiling", () => {
    const big = Buffer.concat([JPEG, Buffer.alloc(COVER_MAX_BYTES - JPEG.length + 1, 0x00)]);
    expect(big.length).toBeGreaterThan(COVER_MAX_BYTES);
    expect(validateCoverFile(file(big, "c.jpg", "image/jpeg"), big)).toBeNull();
  });

  it("rejects an empty file", () => {
    expect(validateCoverFile(file(Buffer.alloc(0), "c.png", "image/png"), Buffer.alloc(0))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// External download URL (http/https only)
// ---------------------------------------------------------------------------

describe("validateDownloadUrl", () => {
  it("accepts http and https URLs and canonicalises them", () => {
    expect(validateDownloadUrl("https://example.com/buch.pdf")).toBe(
      "https://example.com/buch.pdf",
    );
    expect(validateDownloadUrl("  https://example.com/a?b=c  ")).toBe(
      "https://example.com/a?b=c",
    );
    expect(validateDownloadUrl("http://example.org/x.pdf")).toBe(
      "http://example.org/x.pdf",
    );
  });

  it("rejects unsafe schemes (javascript/data/file/vbscript)", () => {
    expect(validateDownloadUrl("javascript:alert(1)")).toBeNull();
    expect(validateDownloadUrl("JavaScript:alert(1)")).toBeNull();
    expect(validateDownloadUrl("data:text/html,<script>1</script>")).toBeNull();
    expect(validateDownloadUrl("file:///etc/passwd")).toBeNull();
    expect(validateDownloadUrl("vbscript:msgbox(1)")).toBeNull();
    expect(validateDownloadUrl("ftp://example.com/x")).toBeNull();
  });

  it("rejects malformed, empty, too-short, too-long and control-character input", () => {
    expect(validateDownloadUrl("not a url")).toBeNull();
    expect(validateDownloadUrl("")).toBeNull();
    expect(validateDownloadUrl("http://x")).toBeNull(); // < 10 chars
    expect(
      validateDownloadUrl(`https://example.com/${"a".repeat(2000)}.pdf`),
    ).toBeNull();
    expect(validateDownloadUrl("https://example.com/a\nb")).toBeNull();
    expect(validateDownloadUrl(null)).toBeNull();
    expect(validateDownloadUrl(42)).toBeNull();
  });

  it("rejects credential-bearing URLs", () => {
    expect(validateDownloadUrl("https://user:pass@example.com/x.pdf")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Field sanitisation (stable error codes)
// ---------------------------------------------------------------------------

describe("sanitizeBookFields", () => {
  const valid = {
    title: "  Mittelstufenwortschatz Band 2 ",
    category: "wortschatz",
    description: "Übungsbuch für B1",
    downloadUrl: "https://example.com/wortschatz.pdf",
  };

  it("accepts a valid input and trims (empty description → null)", () => {
    const result = sanitizeBookFields(valid);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.title).toBe("Mittelstufenwortschatz Band 2");
      expect(result.value.description).toBe("Übungsbuch für B1");
    }
    const emptyDesc = sanitizeBookFields({ ...valid, description: "   " });
    expect(emptyDesc.ok).toBe(true);
    if (emptyDesc.ok) expect(emptyDesc.value.description).toBeNull();
  });

  it("rejects invalid titles with the stable code", () => {
    for (const title of ["", "   ", "x".repeat(201)]) {
      const r = sanitizeBookFields({ ...valid, title });
      expect(r).toEqual({ ok: false, error: "invalid_title" });
    }
  });

  it("rejects unknown categories (the allowlist is the source)", () => {
    for (const category of ["", "roman", "LEHRBUCH"]) {
      const r = sanitizeBookFields({ ...valid, category });
      expect(r).toEqual({ ok: false, error: "invalid_category" });
    }
    // Whitespace around a valid slug trims to valid (consistent with title).
    const trimmed = sanitizeBookFields({ ...valid, category: " wortschatz " });
    expect(trimmed.ok).toBe(true);
    expect(isBookCategorySlug("wortschatz")).toBe(true);
    expect(isBookCategorySlug("roman")).toBe(false);
  });

  it("rejects an overlong description", () => {
    const r = sanitizeBookFields({ ...valid, description: "x".repeat(2001) });
    expect(r).toEqual({ ok: false, error: "invalid_description" });
  });

  it("rejects a non-http(s) download URL", () => {
    const r = sanitizeBookFields({ ...valid, downloadUrl: "javascript:alert(1)" });
    expect(r).toEqual({ ok: false, error: "invalid_url" });
  });
});

// ---------------------------------------------------------------------------
// Category catalogue
// ---------------------------------------------------------------------------

describe("book categories", () => {
  it("ships the eight required defaults, in stable order", () => {
    expect(BOOK_CATEGORY_SLUGS).toEqual([
      "lehrbuch",
      "grammatik",
      "wortschatz",
      "pruefungsvorbereitung",
      "arbeitsbuch",
      "hoeren",
      "lesen",
      "sonstiges",
    ]);
    // Every slug is ASCII (URL/DB-safe) and has a label key.
    for (const category of BOOK_CATEGORIES) {
      expect(category.slug).toMatch(/^[a-z0-9]+$/);
      expect(category.labelKey).toBe(`library.categories.${category.slug}`);
    }
  });

  it("labels unknown slugs as themselves (never blank)", () => {
    const t = (key: string) => key; // identity: the fallback path returns the slug
    expect(categoryLabel("wortschatz", t)).toBe("library.categories.wortschatz");
    expect(categoryLabel("neue-kategorie", t)).toBe("neue-kategorie");
  });
});

// ---------------------------------------------------------------------------
// Cover object paths (collision resistance)
// ---------------------------------------------------------------------------

describe("coverObjectPath", () => {
  it("produces a covers/ object with a unique UUID per call", () => {
    const a = coverObjectPath("jpeg");
    const b = coverObjectPath("jpeg");
    expect(a).toMatch(/^covers\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/);
    expect(b).toMatch(/^covers\/[0-9a-f-]{36}\.jpg$/);
    expect(a).not.toBe(b);
  });

  it("uses the correct extension per content type", () => {
    expect(coverObjectPath("png")).toMatch(/\.png$/);
    expect(coverObjectPath("webp")).toMatch(/\.webp$/);
  });
});
