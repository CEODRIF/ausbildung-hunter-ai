import { describe, expect, it, vi } from "vitest";

// Regression guard for the /dashboard DOMMatrix SSR failure: pdf-parse (v2)
// runs `new DOMMatrix()` at module scope in its ESM build, so it must NOT be a
// static top-level import of a module that server-rendered pages transitively
// load (dashboard → ai-service → ai-file-context). It must be imported lazily,
// only when a PDF is actually parsed in the server action/route context.
const imported = vi.hoisted(() => ({ pdfParseLoaded: false }));

vi.mock("pdf-parse", () => {
  imported.pdfParseLoaded = true;
  return {
    PDFParse: class {
      async getText() {
        return { text: "cv-body" };
      }
      async destroy() {}
    },
  };
});
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/ai-provider", () => ({
  createAIProvider: vi.fn(() => ({
    analyzeFile: async () => "file-analysis",
    analyzeImage: async () => "image-analysis",
  })),
}));

describe("ai-file-context pdf-parse lazy loading (DOMMatrix SSR fix)", () => {
  it("does not import pdf-parse when the module loads", async () => {
    imported.pdfParseLoaded = false;
    await import("@/lib/ai-file-context");
    expect(imported.pdfParseLoaded).toBe(false);
  });

  it("lazily imports pdf-parse only when a PDF is parsed, and parses it", async () => {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const admin = createAdminClient as unknown as ReturnType<typeof vi.fn>;
    admin.mockReturnValue({
      storage: {
        from: () => ({
          download: async () => ({
            data: new Blob([new Uint8Array(4)]),
            error: null,
          }),
        }),
      },
    } as never);

    imported.pdfParseLoaded = false;
    const { buildFileContext } = await import("@/lib/ai-file-context");
    const out = await buildFileContext([
      {
        filename: "cv.pdf",
        mime_type: "application/pdf",
        storage_path: "u/cv.pdf",
      },
    ]);

    expect(imported.pdfParseLoaded).toBe(true);
    expect(out).toContain("cv-body");
  });

  it("does not import pdf-parse for non-PDF files (e.g. plain text)", async () => {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const admin = createAdminClient as unknown as ReturnType<typeof vi.fn>;
    admin.mockReturnValue({
      storage: {
        from: () => ({
          download: async () => ({
            data: new Blob(["hello world"]),
            error: null,
          }),
        }),
      },
    } as never);

    imported.pdfParseLoaded = false;
    const { buildFileContext } = await import("@/lib/ai-file-context");
    const out = await buildFileContext([
      {
        filename: "note.txt",
        mime_type: "text/plain",
        storage_path: "u/note.txt",
      },
    ]);

    expect(imported.pdfParseLoaded).toBe(false);
    expect(out).toContain("hello world");
  });
});
