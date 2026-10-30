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
    expect(all).toContain("MUSTAPHA DRIF");
    expect(all).toContain("Auszubildende:r Anlagenmechaniker SHK");
    expect(all).toContain("PROFIL");
    expect(all).toContain("KENNTNISSE");
  });
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

describe("Step 4 viewer — preview never downloads; errors are explicit", () => {
  const step4 = read("src/components/auto-bewerb/step4-cv-generation.tsx");

  it("the preview fetches the INLINE variant through the session and verifies %PDF- before rendering", () => {
    expect(step4).toContain("&doc=cv&preview=1");
    expect(step4).toContain('startsWith("application/pdf")');
    // The %PDF- signature check (bytes 0x25 0x50 0x44 0x46).
    expect(step4).toContain("bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46");
    expect(step4).toContain("URL.createObjectURL");
    expect(step4).toContain('new Blob([bytes], { type: "application/pdf" })');
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

  it("has explicit loading / error / retry states (no indefinite blank document)", () => {
    // Loading is derived (no completed load for the current key yet);
    // success and failure are explicit terminal states of the load.
    expect(step4).toContain("const current = done && done.key === key ? done : null");
    expect(step4).toContain("if (!current) {"); // loading branch
    expect(step4).toContain("if (!current.ok) {"); // error branch
    expect(step4).toContain("ok: true, url: objectUrl");
    expect(step4).toContain("ok: false,");
    expect(step4).toContain("cvPreviewLoading");
    expect(step4).toContain("cvPreviewError");
    expect(step4).toContain("previewSessionError");
    expect(step4).toContain("setAttempt((a) => a + 1)");
    // No synchronous setState at the top of the effect (React Compiler rule).
    const effectStart = step4.indexOf("useEffect(() => {");
    const firstSetDone = step4.indexOf("setDone", effectStart);
    const firstAwait = step4.indexOf("await", effectStart);
    expect(effectStart).toBeGreaterThanOrEqual(0);
    expect(firstAwait).toBeGreaterThan(effectStart);
    expect(firstSetDone).toBeGreaterThan(firstAwait);
  });

  it("isolates per company: aborts the stale request + revokes the blob URL on change", () => {
    expect(step4).toContain("new AbortController()");
    expect(step4).toContain("controller.abort()");
    expect(step4).toContain("URL.revokeObjectURL(objectUrl)");
    // The effect re-runs per company + version + attempt.
    expect(step4).toContain("[companyId, version, attempt, t]");
  });

  it("new i18n keys exist in all four languages", () => {
    const dict = read("src/lib/i18n/dictionaries.ts");
    for (const key of ["cvPreviewLoading:", "cvPreviewError:", "previewSessionError:"]) {
      const count = dict.split(key).length - 1;
      expect(count, `i18n key "${key}" must exist in de+en+fr+ar (found ${count})`).toBeGreaterThanOrEqual(4);
    }
    expect(dict).toContain('cvPreviewLoading: "CV-Vorschau wird geladen …"');
  });
});
