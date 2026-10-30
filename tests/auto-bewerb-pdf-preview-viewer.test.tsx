// @vitest-environment jsdom
/**
 * AUTO BEWERB — Step 4 PDF preview VIEWER behavior (pdf.js canvas renderer).
 *
 * Context: PR #103 fixed the disposition (inline vs attachment) and the
 * unwanted download, but the native browser PDF viewer still failed to
 * render the blob URL inside the iframe (gray frame + broken-document
 * icon). A valid %PDF- signature does NOT guarantee that PDFium renders
 * the blob. This fix therefore renders the verified bytes ITSELF with
 * pdf.js onto canvases — if the bytes parse, the document is visible.
 *
 * Contract pinned here (real component, jsdom, mocked fetch + pdf.js):
 *   1. a valid response renders EVERY page as a visible canvas
 *      (no iframe, no blob URL, no window.open / download anchor);
 *   2. zoom in re-renders every page at the new scale;
 *   3. 401 → explicit session-expired error + retry refetches;
 *   4. 200 with a NON-PDF body (HTML error page) → explicit error state;
 *   5. a TRUNCATED body (Content-Length mismatch) → hard error;
 *   6. a pdf.js parse failure → explicit error state + retry re-parses;
 *   7. switching company destroys the old document and fetches the new
 *      one (per-company isolation);
 *   8. fetchCvPreviewPdf returns the COMPLETE body, never just the head.
 */
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { I18nProvider } from "@/lib/i18n";
import { CvPdfPreview, fetchCvPreviewPdf } from "@/components/auto-bewerb/step4-cv-generation";

vi.mock("@/app/auto-bewerb/actions", () => ({
  markDocumentReviewedAction: vi.fn(),
  saveCompanyDocumentAction: vi.fn(),
}));

/** Fake pdf.js: A4 pages, per-call page objects, recordable render fns. */
const mocks = vi.hoisted(() => {
  const renderFns: Array<ReturnType<typeof vi.fn>> = [];
  const makePage = () => {
    const page = {
      getViewport: (o: { scale: number }) => ({ width: 595.28 * o.scale, height: 841.89 * o.scale }),
      render: vi.fn(() => ({ promise: Promise.resolve({}), cancel: () => undefined })),
    };
    renderFns.push(page.render);
    return page;
  };
  const makeDoc = (numPages: number) => ({
    numPages,
    getPage: vi.fn(async () => makePage()),
    destroy: vi.fn(async () => undefined),
  });
  return {
    renderFns,
    makeDoc,
    doc: null as ReturnType<typeof makeDoc> | null,
    getDocument: vi.fn(),
  };
});

vi.mock("pdfjs-dist", () => ({
  getDocument: (...args: unknown[]) => mocks.getDocument(...(args as [unknown])),
}));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs", () => ({}));

/** COMPLETE body — the renderer's real output ends with %%EOF; the viewer
 *  must receive exactly what the server sent, first to last byte. */
const PDF_BYTES = new TextEncoder().encode("%PDF-1.7 fake-but-complete-cv-bytes\n...content...\n%%EOF");

function pdfResponse(bytes: Uint8Array, init: { status?: number; contentType?: string; contentLength?: string | null } = {}) {
  const headers: Record<string, string> = { "Content-Type": init.contentType ?? "application/pdf" };
  if (init.contentLength !== null) headers["Content-Length"] = init.contentLength ?? String(bytes.byteLength);
  return new Response(bytes as unknown as BodyInit, { status: init.status ?? 200, headers });
}

const mockedFetch = () => fetch as unknown as ReturnType<typeof vi.fn>;
const renderedPageCount = () => mocks.renderFns.filter((f) => f.mock.calls.length > 0).length;

beforeEach(() => {
  mocks.renderFns.length = 0;
  mocks.doc = mocks.makeDoc(2);
  mocks.getDocument.mockReset();
  mocks.getDocument.mockReturnValue({ promise: Promise.resolve(mocks.doc) });
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pdfResponse(PDF_BYTES))));
  // jsdom lacks ResizeObserver — minimal fake (400px stage width).
  vi.stubGlobal(
    "ResizeObserver",
    class FakeRO {
      constructor(private cb: (entries: Array<{ contentRect: { width: number } }>) => void) {}
      observe() {
        queueMicrotask(() => this.cb([{ contentRect: { width: 400 } }]));
      }
      disconnect() {}
    },
  );
  vi.spyOn(window, "open").mockImplementation(() => null);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderPreview(companyId = "comp-a", version = 1) {
  return render(
    <I18nProvider>
      <CvPdfPreview companyId={companyId} version={version} name="Kältebau Nord GmbH" />
    </I18nProvider>,
  );
}

describe("Step 4 viewer — pdf.js canvas rendering", () => {
  it("renders EVERY page as a visible canvas — no iframe, no download", async () => {
    renderPreview();
    // Fit layout + both pages rendered (the toolbar shows the page count).
    await screen.findByText("2 Seiten");
    await waitFor(() => expect(renderedPageCount()).toBe(2));
    const canvases = document.querySelectorAll("canvas");
    expect(canvases.length).toBe(2);
    // The broken-iframe path is gone by construction.
    expect(document.querySelector("iframe")).toBeNull();
    expect(document.querySelector("a[download]")).toBeNull();
    expect(window.open).not.toHaveBeenCalled();
    // Fit-to-width = 100% on first render.
    expect(screen.getByText("100%")).toBeInTheDocument();
  });

  it("zoom in re-renders every page at the new scale", async () => {
    renderPreview();
    await screen.findByText("2 Seiten");
    await waitFor(() => expect(renderedPageCount()).toBe(2));
    fireEvent.click(screen.getByRole("button", { name: "Vergrößern" }));
    await waitFor(() => expect(renderedPageCount()).toBe(4));
    expect(screen.getByText("125%")).toBeInTheDocument();
  });

  it("401 → explicit session-expired error + Retry refetches", async () => {
    mockedFetch().mockResolvedValueOnce(
      new Response("{}", { status: 401, headers: { "Content-Type": "application/json" } }),
    );
    renderPreview();
    await screen.findByText(/Sitzung ist abgelaufen/);
    expect(mockedFetch()).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }));
    await waitFor(() => expect(mockedFetch()).toHaveBeenCalledTimes(2));
  });

  it("200 with a NON-PDF body (HTML error page) → explicit error state, never a frame", async () => {
    mockedFetch().mockResolvedValueOnce(
      new Response("<html>oops</html>", { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }),
    );
    renderPreview();
    await screen.findByText(/CV-Vorschau konnte nicht geladen werden/);
    expect(mocks.getDocument).not.toHaveBeenCalled();
  });

  it("TRUNCATED body (Content-Length mismatch) → hard error, never a broken document", async () => {
    mockedFetch().mockResolvedValueOnce(pdfResponse(PDF_BYTES, { contentLength: String(PDF_BYTES.byteLength + 500) }));
    renderPreview();
    await screen.findByText(/CV-Vorschau konnte nicht geladen werden/);
    expect(mocks.getDocument).not.toHaveBeenCalled();
  });

  it("pdf.js parse failure → explicit error state + Retry re-parses", async () => {
    // A FRESH response per call — a Response body can only be read once.
    mockedFetch().mockImplementation(() => Promise.resolve(pdfResponse(PDF_BYTES)));
    mocks.getDocument.mockReturnValue({ promise: Promise.reject(new Error("Invalid PDF structure")) });
    renderPreview();
    await screen.findByText(/CV-Vorschau konnte nicht geladen werden/);
    expect(mocks.getDocument).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }));
    await waitFor(() => expect(mocks.getDocument).toHaveBeenCalledTimes(2));
  });

  it("switching company destroys the old document and fetches the new one", async () => {
    const docs: Array<{ destroy: ReturnType<typeof vi.fn> }> = [];
    mocks.getDocument.mockImplementation(() => {
      const d = mocks.makeDoc(2);
      docs.push(d);
      return { promise: Promise.resolve(d) };
    });
    const { rerender } = render(
      <I18nProvider>
        <CvPdfPreview companyId="comp-a" version={1} name="Firma A" />
      </I18nProvider>,
    );
    await screen.findByText("2 Seiten");
    await waitFor(() => expect(renderedPageCount()).toBe(2));
    expect(mockedFetch()).toHaveBeenCalledTimes(1);

    rerender(
      <I18nProvider>
        <CvPdfPreview companyId="comp-b" version={1} name="Firma B" />
      </I18nProvider>,
    );
    // The old document is destroyed; a fresh request goes to comp-b ONLY.
    await waitFor(() => expect(docs[0].destroy).toHaveBeenCalled());
    await waitFor(() => expect(mockedFetch()).toHaveBeenCalledTimes(2));
    expect(String(mockedFetch().mock.calls[1][0])).toContain("companyId=comp-b");
    expect(String(mockedFetch().mock.calls[1][0])).not.toContain("comp-a");
    // The new company's document renders (its own canvases).
    await screen.findByText("2 Seiten");
    expect(docs.length).toBeGreaterThanOrEqual(2);
  });
});

describe("fetchCvPreviewPdf — response verification (unit)", () => {
  it("returns the COMPLETE body, not just its first bytes", async () => {
    const bytes = await fetchCvPreviewPdf("comp-a", new AbortController().signal);
    expect(bytes.byteLength).toBe(PDF_BYTES.byteLength);
    expect(new TextDecoder().decode(bytes.slice(-5))).toBe("%%EOF");
  });

  it("preserves the HTTP status on 4xx/5xx", async () => {
    mockedFetch().mockResolvedValueOnce(new Response("{}", { status: 502, headers: { "Content-Type": "application/json" } }));
    const err = await fetchCvPreviewPdf("comp-a", new AbortController().signal).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { status?: number }).status).toBe(502);
  });

  it("rejects a body whose signature is not %PDF-", async () => {
    mockedFetch().mockResolvedValueOnce(
      new Response("<html>login expired</html>", { status: 200, headers: { "Content-Type": "text/html" } }),
    );
    const err = await fetchCvPreviewPdf("comp-a", new AbortController().signal).catch((e) => e);
    expect((err as { status?: number }).status).toBeNull();
  });

  it("rejects a correct body with the wrong Content-Type", async () => {
    mockedFetch().mockResolvedValueOnce(pdfResponse(PDF_BYTES, { contentType: "text/plain" }));
    const err = await fetchCvPreviewPdf("comp-a", new AbortController().signal).catch((e) => e);
    expect((err as { status?: number }).status).toBeNull();
  });

  it("rejects a TRUNCATED body (Content-Length > received bytes)", async () => {
    mockedFetch().mockResolvedValueOnce(pdfResponse(PDF_BYTES, { contentLength: String(PDF_BYTES.byteLength + 1) }));
    const err = await fetchCvPreviewPdf("comp-a", new AbortController().signal).catch((e) => e);
    expect((err as { truncated?: boolean }).truncated).toBe(true);
  });

  it("propagates an aborted fetch as AbortError", async () => {
    mockedFetch().mockImplementationOnce(((_url: string, init?: { signal?: AbortSignal }) => {
      if (init?.signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
      return Promise.resolve(pdfResponse(PDF_BYTES));
    }) as typeof fetch);
    const ac = new AbortController();
    ac.abort();
    const err = await fetchCvPreviewPdf("comp-a", ac.signal).catch((e) => e);
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe("AbortError");
  });
});
