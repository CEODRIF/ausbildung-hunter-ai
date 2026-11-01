/**
 * AUTO BEWERB — Step 4 PDF preview regression suite (blank preview +
 * unwanted download fix).
 *
 * ROOT CAUSE pinned here: the preview iframe pointed at
 * /api/auto-bewerb/export-pdf, which answered EVERY request with
 * `Content-Disposition: attachment`. Browsers refuse to render an
 * attachment response inside an iframe — they download the file (the
 * unwanted PDF download) and leave the frame blank (the white document).
 *
 * The fix: the same endpoint serves `Content-Disposition: inline` for
 * `&preview=1` and keeps `attachment` by default (explicit Export only).
 * The Step 4 viewer fetches the inline response through the session,
 * verifies it (HTTP status + application/pdf + the %PDF- signature) and
 * renders it via a blob URL with explicit loading/error/retry states.
 *
 * This suite proves:
 *  1. preview → application/pdf,  2. preview → inline,  3. preview URL is
 *     never a download trigger,  4. export → attachment,  5. preview and
 *     export are byte-identical for the same saved CV version,  6. valid
 *     %PDF- signature,  7. the REAL renderer output contains actual CV
 *     content (non-blank),  8. auth + ownership enforced,  9. failures are
 *     JSON errors the UI surfaces (never a blank frame), 10. the viewer
 *     contract (per-company isolation, no download anchor/window.open).
 */
import { inflateSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import { createStudioDb, type StudioDb } from "./helpers-studio";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/email-providers", () => ({ createEmailProvider: vi.fn() }));
// Controllable renderer: deterministic bytes (identity tests) + the REAL
// renderer kept reachable for the content test.
vi.mock("@/lib/auto-bewerb/cv-pdf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auto-bewerb/cv-pdf")>();
  return {
    ...actual,
    generateCvPdf: vi.fn(),
    realGenerateCvPdf: actual.generateCvPdf,
  };
});

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import * as cvPdfModule from "@/lib/auto-bewerb/cv-pdf";
const { generateCvPdf } = cvPdfModule;
/** The REAL renderer (the mock factory keeps it reachable under this name). */
const realGenerateCvPdf = (
  cvPdfModule as unknown as { realGenerateCvPdf: typeof cvPdfModule.generateCvPdf }
).realGenerateCvPdf;
import { GET } from "@/app/api/auto-bewerb/export-pdf/route";
import { AUTO_BEWERB_TABLES } from "@/lib/auto-bewerb/schema";
import { cvEmpty, type CvDocument } from "@/lib/templates/cv";
import { streamItems } from "./helpers-letter-content-stream";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative: string) => readFileSync(resolve(root, relative), "utf8");
const BASE = "http://localhost/api/auto-bewerb/export-pdf";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "99999999-9999-4999-8999-999999999999";

function seedWorkspace(cv: CvDocument) {
  const seed: Record<string, Record<string, unknown>[]> = {
    ...Object.fromEntries(AUTO_BEWERB_TABLES.map((t) => [t, []])),
    profiles: [],
    activity_logs: [],
    auto_bewerb_companies: [
      {
        id: "comp-a",
        user_id: USER_A,
        slot_no: 1,
        company: "Kältebau Nord GmbH",
        company_key: "kaltebau-nord-gmbh",
        ad_raw: "Anlagenmechaniker SHK — Anzeige text.",
        ad_extracted: null,
        ad_analysis: null,
        ad_confirmed_at: new Date().toISOString(),
        email_subject: null,
        recipient_email: null,
        reply_to_email: null,
        cv_reviewed_at: null,
        letter_reviewed_at: null,
        approved: false,
        status: "draft",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ],
    auto_bewerb_documents: [
      {
        id: "doc-cv",
        user_id: USER_A,
        company_id: "comp-a",
        doc_type: "cv",
        version: 1,
        content: cv,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ],
  };
  return createStudioDb(seed);
}

function mockAuth(userId: string | null) {
  (createClient as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    auth: { getUser: async () => ({ data: { user: userId ? { id: userId } : null } }) },
  });
}

/** The rendered text of a page (pdf-lib writes Flate-compressed content
 *  streams with hex-string text runs). */
function pageText(pdf: PDFDocument, pageIndex: number): string {
  const node = pdf.getPage(pageIndex).node as unknown as { Contents: () => unknown };
  const arr = node.Contents() as unknown as { size: () => number; get: (i: number) => unknown };
  const ctx = (pdf as unknown as { context: { lookup: (r: unknown) => unknown } }).context;
  let stream = "";
  for (let i = 0; i < arr.size(); i += 1) {
    const item = arr.get(i);
    const s =
      item && typeof item === "object" && (item as { constructor?: { name?: string } }).constructor?.name === "PDFRef"
        ? ctx.lookup(item)
        : item;
    const raw = (s as { getContents: () => Uint8Array }).getContents();
    try {
      stream += inflateSync(raw).toString("latin1");
    } catch {
      stream += Buffer.from(raw).toString("latin1");
    }
  }
  return [...stream.matchAll(/<([0-9A-Fa-f]+)>/g)].map((m) => Buffer.from(m[1], "hex").toString("latin1")).join("\n");
}

let db: StudioDb;

beforeEach(() => {
  vi.clearAllMocks();
  db = seedWorkspace(sampleCv());
  (createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);
  mockAuth(USER_A);
  // Deterministic renderer: identical bytes for identical input (no
  // metadata timestamps), so preview-vs-export identity is testable.
  (generateCvPdf as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    async (cv: CvDocument) => Buffer.from(`%PDF-1.7 deterministic-bytes-for-${cv.personal.fullName}`),
  );
});

function sampleCv(): CvDocument {
  const cv = cvEmpty();
  cv.personal = {
    ...cv.personal,
    fullName: "Mustapha Drif",
    professionalTitle: "Auszubildende:r Anlagenmechaniker SHK",
    email: "mustapha.drif@example.de",
    location: "Hamburg",
  };
  cv.summary = "Praktikum im Anlagenbau (Kältetechnik), strukturiert und zuverlässig.";
  cv.skills = ["Schaltpläne lesen", "Montage"];
  return cv;
}

const pdfBody = async (res: Response): Promise<Buffer> => Buffer.from(await res.arrayBuffer());
const isPdfBytes = (b: Buffer) => b.length > 5 && b.subarray(0, 5).toString("latin1") === "%PDF-";

describe("export-pdf route — disposition separates preview from export", () => {
  it("preview (?preview=1) returns application/pdf with Content-Disposition: INLINE", async () => {
    const res = await GET(new Request(`${BASE}?companyId=comp-a&doc=cv&preview=1`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    const disp = res.headers.get("content-disposition") ?? "";
    expect(disp.startsWith("inline; filename=")).toBe(true);
    expect(disp).not.toContain("attachment");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await pdfBody(res);
    // The COMPLETE document arrives (no truncation): the body length equals
    // exactly what the renderer produced for this CV. (content-length itself
    // is added by the HTTP layer and not exposed on in-process Responses.)
    expect(body.length).toBe(Buffer.from(`%PDF-1.7 deterministic-bytes-for-${sampleCv().personal.fullName}`).length);
    expect(isPdfBytes(body)).toBe(true);
  });

  it("export (default, no preview param) returns Content-Disposition: ATTACHMENT (explicit download only)", async () => {
    const res = await GET(new Request(`${BASE}?companyId=comp-a&doc=cv`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    const disp = res.headers.get("content-disposition") ?? "";
    expect(disp.startsWith("attachment; filename=")).toBe(true);
    expect(isPdfBytes(await pdfBody(res))).toBe(true);
  });

  it("preview and export return the SAME bytes for the same saved CV version", async () => {
    const preview = await pdfBody(await GET(new Request(`${BASE}?companyId=comp-a&doc=cv&preview=1`)));
    const exportRes = await pdfBody(await GET(new Request(`${BASE}?companyId=comp-a&doc=cv`)));
    expect(preview.equals(exportRes)).toBe(true);
  });
});

describe("export-pdf route — real renderer output is a valid, NON-BLANK PDF", () => {
  it("the generated document starts with %PDF-, has a page, and contains the CV content", async () => {
    const cv = sampleCv();
    const bytes = Buffer.from(await realGenerateCvPdf(cv));
    expect(isPdfBytes(bytes)).toBe(true);
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(1);
    const all = Array.from({ length: pdf.getPageCount() }, (_, i) => pageText(pdf, i)).join("\n")
      .replace(/[\s\u00ad]+/g, " ");
    // The document is NOT blank: name, title, sections and content render.
    // (The redesign renders the name in normal case, per the reference.)
    expect(all).toContain("Mustapha Drif");
    expect(all).toContain("Auszubildende:r Anlagenmechaniker SHK");
    expect(all).toContain("Profil");
    expect(all).toContain("Kenntnisse");
  });
});

describe("export-pdf route — the letter carries the owner's CURRENT signature (live from storage)", () => {
  /** A VALID 1×1 PNG — pdf-lib must actually decode it to embed it. */
  const VALID_PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const hasImageBytes = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1").includes("/Subtype /Image");

  function seedWithLetter(cv: CvDocument) {
    const db = seedWorkspace(cv);
    db.tables.auto_bewerb_documents.push({
      id: "doc-letter",
      user_id: USER_A,
      company_id: "comp-a",
      doc_type: "cover_letter",
      version: 1,
      content: {
        text:
          "Sehr geehrte Damen und Herren,\n\n" +
          "hiermit bewerbe ich mich um den Ausbildungsplatz. Ich bringe Erfahrung im Anlagenbau mit.\n\n" +
          "Mit freundlichen Grüßen\n" +
          "Mustapha Drif",
        tone: "professional",
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    return db;
  }

  it("no signature yet → text-only PDF; after the upload → the SAME route embeds it (live read)", async () => {
    const db = seedWithLetter(sampleCv());
    mockAuth(USER_A);
    (createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);

    const getLetter = async () => {
      const res = await GET(new Request(`${BASE}?companyId=comp-a&doc=letter&preview=1`));
      expect(res.status).toBe(200);
      return new Uint8Array(await res.arrayBuffer());
    };

    // Before any signature exists: a valid one-page letter, NO embedded image.
    const before = await getLetter();
    expect(hasImageBytes(before)).toBe(false);
    const pdfBefore = await PDFDocument.load(before);
    expect(pdfBefore.getPageCount()).toBe(1);

    // The user uploads the global signature (Step 1) at the fixed owner path:
    const { error: upErr } = await db.admin.storage
      .from("application-attachments")
      .upload(`${USER_A}/auto-bewerb/signature/signature.png`, VALID_PNG, {
        contentType: "image/png",
        upsert: true,
      });
    expect(upErr).toBeNull();

    // The SAME route now embeds the owner's current signature — nothing to
    // restart, no second upload flow, never a fabricated image.
    const after = await getLetter();
    expect(hasImageBytes(after)).toBe(true);
    const pdfAfter = await PDFDocument.load(after);
    expect(pdfAfter.getPageCount()).toBe(1);
  });
});

describe("export-pdf route — the LETTER PREVIEW shows the signature at the enlarged size (preview == export)", () => {
  /** The SAME 480 × 140 wide fixture the PDF layout suite uses. */
  const WIDE_PNG = new Uint8Array(readFileSync(resolve(root, "tests", "fixtures", "signature-wide.png")));
  const NAME = "Mustapha Drif";
  const CLOSING = "Mit freundlichen Grüßen";
  /** The new display box (src/lib/bew-letter-pdf.ts) — a uniform ×1.35 over 130 × 44 pt. */
  const NEW_MAX_WIDTH = 175.5;
  const NEW_MAX_HEIGHT = 59.4;

  const LETTER_TEXT =
    "Sehr geehrte Frau Schneider,\n\n" +
    "hiermit bewerbe ich mich um den Ausbildungsplatz als Anlagenmechaniker. Ich bringe Erfahrung im Anlagenbau mit.\n\n" +
    "Über eine Einladung zu einem persönlichen Gespräch würde ich mich sehr freuen.\n\n" +
    "Mit freundlichen Grüßen\n\n" +
    "Mustapha Drif";

  it("preview=1 → inline PDF whose signature is BELOW the name at 175.5 × 51.19 pt, byte-identical to the export", async () => {
    const db = seedWorkspace(sampleCv());
    db.tables.auto_bewerb_documents.push({
      id: "doc-letter",
      user_id: USER_A,
      company_id: "comp-a",
      doc_type: "cover_letter",
      version: 1,
      content: { text: LETTER_TEXT, tone: "professional" },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    (createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(db.admin);

    // The owner's GENUINE uploaded signature (the fixed owner path).
    const { error: upErr } = await db.admin.storage
      .from("application-attachments")
      .upload(`${USER_A}/auto-bewerb/signature/signature.png`, WIDE_PNG, {
        contentType: "image/png",
        upsert: true,
      });
    expect(upErr).toBeNull();

    const previewRes = await GET(new Request(`${BASE}?companyId=comp-a&doc=letter&preview=1`));
    expect(previewRes.status).toBe(200);
    expect(previewRes.headers.get("content-type")).toBe("application/pdf");
    expect((previewRes.headers.get("content-disposition") ?? "").startsWith("inline;")).toBe(true);
    const previewBytes = new Uint8Array(await previewRes.arrayBuffer());
    expect(isPdfBytes(Buffer.from(previewBytes))).toBe(true);

    // The PREVIEW document itself carries the enlarged signature: exactly
    // one image, the 480 × 140 source fitted by the width cap →
    // 175.5 × (140/480) = 175.5 × 51.19 pt, aspect ratio intact, BELOW the
    // printed name (which is below the closing), left-aligned with it.
    const items = await streamItems(previewBytes);
    const closing = items.find((i) => i.kind === "text" && i.text === CLOSING);
    const name = items.find((i) => i.kind === "text" && i.text === NAME);
    const images = items.filter((i) => i.kind === "image");
    expect(closing, "closing line").toBeTruthy();
    expect(name, "printed name line").toBeTruthy();
    expect(images, "exactly one embedded image (the signature)").toHaveLength(1);
    const img = images[0];
    expect(img.width).toBeCloseTo(NEW_MAX_WIDTH, 2);
    expect(img.height).toBeCloseTo(NEW_MAX_WIDTH * 140 / 480, 2);
    expect(img.width).toBeLessThanOrEqual(NEW_MAX_WIDTH + 1e-6);
    expect(img.height).toBeLessThanOrEqual(NEW_MAX_HEIGHT + 1e-6);
    expect(img.width / img.height).toBeCloseTo(480 / 140, 4);
    expect(img.y + img.height).toBeLessThan(name!.y);
    expect(name!.y).toBeLessThan(closing!.y);
    expect(img.x).toBeCloseTo(name!.x, 6);

    // The preview and the explicit export are the SAME document (only the
    // disposition differs) — the employer's PDF shows the same size.
    const exportRes = await GET(new Request(`${BASE}?companyId=comp-a&doc=letter`));
    expect(exportRes.status).toBe(200);
    expect((exportRes.headers.get("content-disposition") ?? "").startsWith("attachment;")).toBe(true);
    const exportBytes = new Uint8Array(await exportRes.arrayBuffer());
    expect(Buffer.from(previewBytes).equals(Buffer.from(exportBytes))).toBe(true);
  }, 20000);
});

describe("export-pdf route — authentication + ownership stay enforced", () => {
  it("unauthenticated → 401 JSON (never a PDF)", async () => {
    mockAuth(null);
    const res = await GET(new Request(`${BASE}?companyId=comp-a&doc=cv&preview=1`));
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
  });

  it("another user's company → 404 JSON (owner-scoped read)", async () => {
    mockAuth(USER_B);
    const res = await GET(new Request(`${BASE}?companyId=comp-a&doc=cv&preview=1`));
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
  });

  it("missing/invalid parameters → 400 JSON", async () => {
    const res = await GET(new Request(`${BASE}?doc=cv&preview=1`));
    expect(res.status).toBe(400);
    const res2 = await GET(new Request(`${BASE}?companyId=comp-a&doc=letter2`));
    expect(res2.status).toBe(400);
  });
});

describe("export-pdf route — failures are JSON errors the UI can surface", () => {
  it("company without a saved CV → 404 with code no_document (no blank frame, no fake PDF)", async () => {
    db.tables.auto_bewerb_documents = [];
    const res = await GET(new Request(`${BASE}?companyId=comp-a&doc=cv&preview=1`));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code?: string; error?: string };
    expect(body.code).toBe("no_document");
    expect(body.error).toBeTruthy();
  });
});

describe("Step 4 viewer — pdf.js canvas rendering; preview never downloads", () => {
  const step4 = read("src/components/auto-bewerb/step4-cv-generation.tsx");

  it("the preview fetches the INLINE variant through the session and verifies %PDF- + completeness before rendering", () => {
    expect(step4).toContain("&doc=cv&preview=1");
    expect(step4).toContain('startsWith("application/pdf")');
    // The %PDF- signature check (bytes 0x25 0x50 0x44 0x46).
    expect(step4).toContain("bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46");
    // Truncation guard: Content-Length vs. actually received byte count.
    expect(step4).toContain("bytes.byteLength !== Number(contentLength)");
  });

  it("renders the bytes itself with pdf.js onto canvases (no native-viewer blob URL, no iframe)", () => {
    // Main-thread worker module (registers globalThis.pdfjsWorker) + the
    // pdf.js API + canvas rendering of the verified bytes.
    expect(step4).toContain('import("pdfjs-dist/build/pdf.worker.min.mjs")');
    expect(step4).toContain('import("pdfjs-dist")');
    expect(step4).toContain("getDocument({ data: bytes, isEvalSupported: false })");
    expect(step4).toContain("page.render({");
    expect(step4).toContain("canvas,");
    // The broken-iframe class of failure is gone by construction: no
    // iframe, no blob URL, no object-URL lifecycle to race the viewer.
    expect(step4).not.toContain("<iframe");
    expect(step4).not.toContain("URL.createObjectURL");
    expect(step4).not.toContain("URL.revokeObjectURL");
  });

  it("supports all pages, vertical scroll, zoom, loading, error and retry", () => {
    expect(step4).toContain("doc.numPages"); // every page, not just the first
    expect(step4).toContain("overflow-auto"); // vertical page scroll
    expect(step4).toContain("cvPreviewZoomIn");
    expect(step4).toContain("cvPreviewZoomOut");
    expect(step4).toContain("cvPreviewFit");
    expect(step4).toContain("cvPreviewFullscreen");
    expect(step4).toContain("cvPreviewLoading");
    expect(step4).toContain("cvPreviewError");
    expect(step4).toContain("previewSessionError");
    expect(step4).toContain("cvPreviewParseError");
    expect(step4).toContain("setAttempt((a) => a + 1)");
  });

  it("integrated sticky toolbar INSIDE the viewer: page position, zoom, fit, fullscreen", () => {
    // The toolbar is the first child of the scroll stage and sticks to its
    // top — it stays visible while the document scrolls beneath it.
    expect(step4).toContain("sticky top-0 z-10");
    expect(step4).toContain("backdrop-blur");
    // Page position in "current / total" form (e.g. 1 / 3), derived from
    // the scroll position (rAF-throttled stage scroll handler).
    expect(step4).toContain("{currentPage} / {doc.numPages}");
    expect(step4).toContain("onScroll={handleStageScroll}");
    expect(step4).toContain("requestAnimationFrame(() => {");
    // Browser fullscreen toggle (no extra dependency) on the viewer box.
    expect(step4).toContain("el.requestFullscreen?.()");
    expect(step4).toContain("document.exitFullscreen()");
    expect(step4).toContain("fullscreenchange");
    // Toolbar buttons carry tooltips (title) + accessible names.
    expect(step4).toContain("title={t(\"autoBewerb.cvPreviewZoomIn\")}");
  });

  it("fit-to-width is computed from the measured stage width and never overflows horizontally at 100%", () => {
    // Fit base = (measured stage width − page-row horizontal padding) /
    // widest page width in pt — subtracting the padding is what keeps the
    // default zoom inside the stage (no horizontal scrollbar).
    expect(step4).toContain("const STAGE_PAD_X = 24;");
    expect(step4).toContain("Math.max(0, containerWidth - STAGE_PAD_X)");
    // The stage reserves scrollbar space so the measured width — and thus
    // the fit scale — is stable while the document scrolls.
    expect(step4).toContain("[scrollbar-gutter:stable]");
    // Pages stay centered, A4 aspect preserved (each canvas keeps the
    // page's exact width:height ratio from getViewport).
    expect(step4).toContain("mx-auto flex w-max min-w-full flex-col items-center gap-4 p-3");
    // Fit recalculates live on resize (ResizeObserver on the stage).
    expect(step4).toContain("new ResizeObserver(");
  });

  it("the document view opens in the wide workspace modal (≈80vw × 90vh, max 1200px)", () => {
    const ui = read("src/components/ui.tsx");
    // The saved-CV document view uses the wide workspace; the EDIT view
    // uses the centered scrollable "form" dialog.
    expect(step4).toContain('size={showDocWorkspace ? "wide" : "form"}');
    expect(step4).toContain('const showDocWorkspace = Boolean(previewView?.cv && previewDoc && viewMode === "doc" && !previewDraft)');
    // Wide modal: 96vw on mobile (near full-screen), 82vw on desktop with
    // a 1200px cap and ~90vh max height; the viewer fills the remaining
    // panel height (flex column chain).
    expect(ui).toContain("w-[96vw]");
    expect(ui).toContain("sm:w-[82vw]");
    expect(ui).toContain("max-w-[1200px]");
    expect(ui).toContain("sm:max-h-[90vh]");
    expect(step4).toContain("flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl bg-ink/70 p-2 sm:p-3");
  });

  it("the edit modal is a centered dialog capped at 90dvh with an internally scrolling body", () => {
    const ui = read("src/components/ui.tsx");
    // Form size: 94vw on mobile (near full-screen) / 90vw with a 768px cap
    // on desktop; height capped at 90vh with the 90dvh value applied via
    // @supports where the dynamic viewport unit is available — the modal
    // can never extend beyond the visible viewport.
    expect(ui).toContain("w-[94vw]");
    expect(ui).toContain("sm:w-[90vw]");
    expect(ui).toContain("sm:max-w-3xl");
    expect(ui).toContain("max-h-[90vh]");
    expect(ui).toContain("supports-[height:100dvh]:max-h-[90dvh]");
    // Centered by flex (fixed inset-0 + items/justify-center) — no
    // absolute top/left positioning to drift.
    expect(ui).toContain("fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-5");
    // Panel is a flex column with a STABLE header row (never scrolls
    // away); children build the fill chain.
    expect(ui).toContain("flex-col overflow-hidden rounded-2xl border border-line bg-surface p-4 shadow-2xl");
    expect(ui).toContain("mb-3 flex shrink-0 items-center justify-between gap-4");
    // The CV form scrolls INSIDE the dialog; the toolbar row (Document /
    // Edit / Export / Save / Mark as reviewed) stays fixed above it.
    expect(step4).toContain("min-h-0 flex-1 overflow-y-auto overscroll-contain");
    expect(step4).toContain("flex shrink-0 flex-wrap items-center gap-2");
    // The background page never scrolls while the modal is open.
    expect(ui).toContain('document.body.style.overflow = "hidden"');
  });

  it("the preview does NOT use window.open or a download anchor (export only does)", () => {
    // The inline preview URL must appear exactly ONCE in the whole component
    // — inside the viewer's fetch. Any window.open / anchor with it would
    // re-introduce the download bug.
    expect(step4.split("&doc=cv&preview=1").length - 1).toBe(1);
    // The export buttons stay plain window.open (default → attachment).
    const opens = step4.match(/window\.open\(/g);
    expect(opens?.length).toBeGreaterThanOrEqual(2);
    expect(step4).not.toContain('download=');
  });

  it("isolates per company: aborts the stale request + destroys the stale document on change", () => {
    expect(step4).toContain("new AbortController()");
    expect(step4).toContain("controller.abort()");
    expect(step4).toContain("pdf.destroy()");
    // The load effect re-runs per company + version + attempt; the canvas
    // view remounts per key; in-flight page renders are cancelled.
    expect(step4).toContain("[companyId, version, attempt, t]");
    expect(step4).toContain("<CvPdfCanvasView key={key}");
    expect(step4).toContain("task?.cancel()");
  });

  it("keeps the derived-loading pattern (no synchronous setState before the first await)", () => {
    // Loading is derived (no completed load for the current key yet);
    // success and failure are explicit terminal states of the load.
    expect(step4).toContain("const current = done && done.key === key ? done : null");
    expect(step4).toContain("if (!current) {"); // loading branch
    expect(step4).toContain("if (!current.ok) {"); // error branch
    expect(step4).toContain("ok: true, pdf");
    expect(step4).toContain("ok: false,");
    // No synchronous setState at the top of the load effect (React
    // Compiler rule): the first setDone must come after an await.
    const effectStart = step4.indexOf("useEffect(() => {");
    const firstSetDone = step4.indexOf("setDone", effectStart);
    const firstAwait = step4.indexOf("await", effectStart);
    expect(effectStart).toBeGreaterThanOrEqual(0);
    expect(firstAwait).toBeGreaterThan(effectStart);
    expect(firstSetDone).toBeGreaterThan(firstAwait);
  });

  it("i18n keys exist in all four languages", () => {
    const dict = read("src/lib/i18n/dictionaries.ts");
    for (const key of [
      "cvPreviewLoading:",
      "cvPreviewError:",
      "previewSessionError:",
      "cvPreviewParseError:",
      "cvPreviewPageLabel:",
      "cvPreviewZoomIn:",
      "cvPreviewZoomOut:",
      "cvPreviewFit:",
      "cvPreviewFullscreen:",
      "cvPreviewExitFullscreen:",
    ]) {
      const count = dict.split(key).length - 1;
      expect(count, `i18n key "${key}" must exist in de+en+fr+ar (found ${count})`).toBeGreaterThanOrEqual(4);
    }
    expect(dict).toContain('cvPreviewLoading: "CV-Vorschau wird geladen …"');
  });
});
