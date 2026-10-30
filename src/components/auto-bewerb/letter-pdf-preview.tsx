"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, FileText, Fullscreen, Loader2, Maximize, Minimize, RefreshCw, ZoomIn, ZoomOut } from "lucide-react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { Button } from "@/components/ui";
import { useI18n } from "@/lib/i18n";

/**
 * Step 5 — inline COVER LETTER PDF preview (the actual saved letter on its
 * clean white A4 folio pages). NEVER downloads.
 *
 * Same architecture as the Step 4 CV preview (src/components/auto-bewerb/
 * step4-cv-generation.tsx): the bytes come from the SAME export endpoint the
 * explicit "Export PDF" button uses (`doc=letter&preview=1` only switches
 * the Content-Disposition to inline), are verified (HTTP status +
 * application/pdf + %PDF- signature + completeness), and are rendered by
 * pdf.js DIRECTLY onto canvases. The native browser PDF viewer is never
 * involved — a parse failure surfaces as the explicit error state with
 * Retry, never as a gray frame.
 *
 * The pdf.js worker is imported as a main-thread module (registers
 * `globalThis.pdfjsWorker` → the documented "fake worker" path): no worker
 * file to ship, no CSP surface.
 *
 * Company isolation: a stale in-flight request is aborted, a stale document
 * destroyed, and in-flight page renders cancelled when the
 * company/version/attempt changes — one company's preview can never render
 * another company's letter.
 */

/** A preview fetch failure: HTTP status (null = body verified as NOT a PDF). */
class LetterPreviewFetchError extends Error {
  constructor(
    readonly status: number | null,
    readonly truncated = false,
  ) {
    super(`Letter preview fetch failed (status=${status ?? "n/a"}${truncated ? ", truncated body" : ""})`);
  }
}

/**
 * Fetch the stored LETTER PDF through the current session and verify that
 * the response actually IS the complete document:
 *   1. HTTP 200 (the route answers 4xx/5xx with JSON, never a fake PDF),
 *   2. `application/pdf` Content-Type,
 *   3. the `%PDF-` file signature at byte 0,
 *   4. a COMPLETE body: when `Content-Length` is present, the received byte
 *      count must match it — a truncated response is a hard error.
 *
 * Returns the complete bytes — byte-identical to what the Export button
 * downloads (same endpoint + renderer; only the disposition differs).
 */
export async function fetchLetterPreviewPdf(companyId: string, signal: AbortSignal): Promise<Uint8Array> {
  const res = await fetch(
    `/api/auto-bewerb/export-pdf?companyId=${encodeURIComponent(companyId)}&doc=letter&preview=1`,
    { cache: "no-store", signal },
  );
  if (!res.ok) throw new LetterPreviewFetchError(res.status);
  const contentType = res.headers.get("content-type") ?? "";
  const bytes = new Uint8Array(await res.arrayBuffer());
  // "%PDF" (0x25 0x50 0x44 0x46) at byte 0 — the IETF file signature.
  const isPdf =
    bytes.length > 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
  console.info("[auto-bewerb] letter preview:", {
    status: res.status,
    contentType,
    contentLength: res.headers.get("content-length"),
    bytesReceived: bytes.byteLength,
    signature: isPdf,
  });
  if (!contentType.startsWith("application/pdf") || !isPdf) throw new LetterPreviewFetchError(null);
  const contentLength = res.headers.get("content-length");
  if (contentLength !== null && Number.isInteger(Number(contentLength)) && bytes.byteLength !== Number(contentLength)) {
    throw new LetterPreviewFetchError(res.status, true);
  }
  return bytes;
}

/** Last COMPLETED preview load, keyed by company:version:attempt. While
 *  `done.key` differs from the current key, the viewer is "loading". */
type LetterPreviewDone =
  | { key: string; ok: true; pdf: PDFDocumentProxy }
  | { key: string; ok: false; message: string }
  | null;

export function LetterPdfPreview({ companyId, version, name }: { companyId: string; version: number; name: string }) {
  const { t } = useI18n();
  const [done, setDone] = useState<LetterPreviewDone>(null);
  const [attempt, setAttempt] = useState(0);

  // No synchronous setState in the effect (React Compiler rule): loading is
  // DERIVED — while no load completed for the current key, we are loading.
  const key = `${companyId}:${version}:${attempt}`;
  const current = done && done.key === key ? done : null;

  useEffect(() => {
    const controller = new AbortController();
    let pdf: PDFDocumentProxy | null = null;
    const k = `${companyId}:${version}:${attempt}`;
    void (async () => {
      try {
        const bytes = await fetchLetterPreviewPdf(companyId, controller.signal);
        // Worker module first (side effect: globalThis.pdfjsWorker), so
        // getDocument deterministically takes the main-thread path.
        await import("pdfjs-dist/build/pdf.worker.min.mjs");
        const pdfjs = await import("pdfjs-dist");
        if (controller.signal.aborted) return;
        pdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise;
        if (controller.signal.aborted) {
          void pdf.destroy().catch(() => undefined);
          return;
        }
        console.info("[auto-bewerb] letter preview parsed:", { pages: pdf.numPages });
        setDone({ key: k, ok: true, pdf });
      } catch (err) {
        if (controller.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) return;
        const status = err instanceof LetterPreviewFetchError ? err.status : null;
        setDone({
          key: k,
          ok: false,
          message:
            status === 401 || status === 403
              ? t("autoBewerb.previewSessionError")
              : t("autoBewerb.letterPreviewError"),
        });
      }
    })();
    return () => {
      controller.abort();
      if (pdf) void pdf.destroy().catch(() => undefined);
    };
  }, [companyId, version, attempt, t]);

  if (!current) {
    return (
      <div className="flex h-full min-h-[420px] w-full flex-col items-center justify-center gap-3 rounded-md bg-white">
        <Loader2 size={22} className="animate-spin text-muted" />
        <p className="text-xs font-semibold text-muted">{t("autoBewerb.letterPreviewLoading")}</p>
      </div>
    );
  }

  if (!current.ok) {
    return (
      <div className="flex h-full min-h-[420px] w-full flex-col items-center justify-center gap-3 rounded-md bg-white p-6 text-center">
        <AlertTriangle size={22} className="text-danger" />
        <p className="max-w-sm text-xs font-semibold leading-5 text-danger">{current.message}</p>
        <Button variant="secondary" size="sm" onClick={() => setAttempt((a) => a + 1)}>
          <RefreshCw size={13} /> {t("autoBewerb.retry")}
        </Button>
      </div>
    );
  }

  return <LetterPdfCanvasView key={key} doc={current.pdf} name={name} />;
}

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.25;
/** Horizontal padding of the page row (`p-3` = 12px per side) — subtracted
 *  from the measured stage width so fit-to-width (100%) NEVER produces a
 *  horizontal scrollbar. */
const STAGE_PAD_X = 24;

/**
 * The parsed letter as white A4 sheets on the dark stage: vertical scroll,
 * zoom (50%–300%, fit-to-width = 100%), one page per canvas. The toolbar
 * (page position, zoom, fit, fullscreen) is sticky INSIDE the stage and the
 * whole viewer can enter the browser fullscreen — same viewer experience as
 * the Step 4 document workspace.
 */
function LetterPdfCanvasView({ doc, name }: { doc: PDFDocumentProxy; name: string }) {
  const { t } = useI18n();
  const [zoom, setZoom] = useState(1);
  const [containerWidth, setContainerWidth] = useState(0);
  const [pageSizes, setPageSizes] = useState<{ width: number; height: number }[] | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const pageEls = useRef<Array<HTMLDivElement | null>>([]);
  const rafPending = useRef(false);

  // Measure the live stage width (no hard-coded modal width) — the fit
  // base scale follows window/modal resizing.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = (w: number) => {
      if (w > 0) setContainerWidth(w);
    };
    measure(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => measure(entries[0]?.contentRect.width ?? el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Page sizes in PDF points (scale 1) — synchronous getViewport once the
  // page is available (getPage results are cached by pdf.js).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const sizes: { width: number; height: number }[] = [];
      for (let p = 1; p <= doc.numPages; p += 1) {
        const page = await doc.getPage(p);
        if (cancelled) return;
        const v = page.getViewport({ scale: 1 });
        sizes.push({ width: v.width, height: v.height });
      }
      if (!cancelled) setPageSizes(sizes);
    })();
    return () => {
      cancelled = true;
    };
  }, [doc]);

  // Fullscreen state (browser Fullscreen API, no extra dependency).
  useEffect(() => {
    const onFsChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  const toggleFullscreen = () => {
    const el = viewRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    } else {
      void el.requestFullscreen?.().catch(() => undefined);
    }
  };

  // Current page = the page whose top is nearest at/above the stage's
  // vertical middle. rAF-throttled scroll handler (event, not effect).
  const handleStageScroll = () => {
    if (rafPending.current) return;
    rafPending.current = true;
    requestAnimationFrame(() => {
      rafPending.current = false;
      const stage = stageRef.current;
      if (!stage) return;
      const stageTop = stage.getBoundingClientRect().top;
      const mid = stage.clientHeight * 0.5;
      let page = 1;
      pageEls.current.forEach((el, i) => {
        if (!el) return;
        if (el.getBoundingClientRect().top - stageTop <= mid) page = i + 1;
      });
      setCurrentPage((prev) => (prev === page ? prev : page));
    });
  };

  const widest = pageSizes?.reduce((m, s) => Math.max(m, s.width), 0) ?? 0;
  const fitWidth = Math.max(0, containerWidth - STAGE_PAD_X);
  const baseScale = fitWidth > 0 && widest > 0 ? fitWidth / widest : 0;
  const scale = baseScale * zoom;

  return (
    <div
      ref={viewRef}
      className="flex h-full min-h-[420px] w-full flex-col overflow-hidden rounded-md bg-white [&:fullscreen]:min-h-0 [&:fullscreen]:rounded-none [&:fullscreen]:shadow-none"
    >
      <div
        ref={stageRef}
        onScroll={handleStageScroll}
        className="relative flex-1 overflow-auto bg-surface-2/40 [scrollbar-gutter:stable]"
        role="region"
        aria-label={`${name} — Anschreiben`}
      >
        {/* Integrated toolbar: page position + zoom controls */}
        <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-line/60 bg-white/95 px-2 py-1.5 backdrop-blur">
          <span
            className="flex shrink-0 items-center gap-1.5 text-[11px] font-semibold tabular-nums text-muted"
            aria-label={t("autoBewerb.letterPreviewPageLabel", { page: currentPage, count: doc.numPages })}
          >
            <FileText size={13} />
            {currentPage} / {doc.numPages}
          </span>
          <div className="flex items-center gap-0.5" role="group" aria-label={`${name} — Zoom`}>
            <button
              type="button"
              title={t("autoBewerb.cvPreviewZoomOut")}
              aria-label={t("autoBewerb.cvPreviewZoomOut")}
              disabled={zoom <= ZOOM_MIN}
              onClick={() => setZoom((z) => Math.max(ZOOM_MIN, Number((z - ZOOM_STEP).toFixed(3))))}
              className="rounded-md p-1.5 text-ink-soft transition-colors hover:bg-surface-2 disabled:opacity-40"
            >
              <ZoomOut size={14} />
            </button>
            <span className="w-10 text-center text-[11px] font-semibold tabular-nums text-ink">
              {Math.round(zoom * 100)}%
            </span>
            <button
              type="button"
              title={t("autoBewerb.cvPreviewZoomIn")}
              aria-label={t("autoBewerb.cvPreviewZoomIn")}
              disabled={zoom >= ZOOM_MAX}
              onClick={() => setZoom((z) => Math.min(ZOOM_MAX, Number((z + ZOOM_STEP).toFixed(3))))}
              className="rounded-md p-1.5 text-ink-soft transition-colors hover:bg-surface-2 disabled:opacity-40"
            >
              <ZoomIn size={14} />
            </button>
            <button
              type="button"
              title={t("autoBewerb.cvPreviewFit")}
              aria-label={t("autoBewerb.cvPreviewFit")}
              disabled={zoom === 1}
              onClick={() => setZoom(1)}
              className="rounded-md p-1.5 text-ink-soft transition-colors hover:bg-surface-2 disabled:opacity-40"
            >
              <Maximize size={14} />
            </button>
            <button
              type="button"
              title={isFullscreen ? t("autoBewerb.cvPreviewExitFullscreen") : t("autoBewerb.cvPreviewFullscreen")}
              aria-label={isFullscreen ? t("autoBewerb.cvPreviewExitFullscreen") : t("autoBewerb.cvPreviewFullscreen")}
              onClick={toggleFullscreen}
              className="rounded-md p-1.5 text-ink-soft transition-colors hover:bg-surface-2"
            >
              {isFullscreen ? <Minimize size={14} /> : <Fullscreen size={14} />}
            </button>
          </div>
        </div>

        {/* Pages — centered, A4 aspect preserved, fit-to-width initial */}
        {scale > 0 && pageSizes ? (
          <div className="mx-auto flex w-max min-w-full flex-col items-center gap-4 p-3">
            {pageSizes.map((size, i) => (
              <div
                key={i + 1}
                ref={(el) => {
                  pageEls.current[i] = el;
                }}
                className="shrink-0"
              >
                <LetterPdfPage
                  doc={doc}
                  pageNumber={i + 1}
                  pageCount={doc.numPages}
                  width={size.width * scale}
                  height={size.height * scale}
                  scale={scale}
                />
              </div>
            ))}
          </div>
        ) : (
          <div className="flex h-full min-h-[320px] items-center justify-center">
            <Loader2 size={20} className="animate-spin text-muted" />
          </div>
        )}
      </div>
    </div>
  );
}

type LetterPdfPageDone = { scale: number; ok: boolean } | null;

/** One letter page: its own canvas, its own render task (cancellable), its
 *  own done-flag DERIVED from the last completed render scale — a zoom
 *  change immediately re-arms the spinner until the new render lands. */
function LetterPdfPage({
  doc,
  pageNumber,
  pageCount,
  width,
  height,
  scale,
}: {
  doc: PDFDocumentProxy;
  pageNumber: number;
  pageCount: number;
  width: number;
  height: number;
  scale: number;
}) {
  const { t } = useI18n();
  const [done, setDone] = useState<LetterPdfPageDone>(null);
  const [attempt, setAttempt] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dpr = Math.min(typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1, 2);

  const current = done && Math.abs(done.scale - scale) < 1e-9 ? done : null;
  const rendered = current?.ok === true;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let task: RenderTask | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const page = await doc.getPage(pageNumber);
        if (cancelled) return;
        const viewport = page.getViewport({ scale });
        // pdf.js v5: pass the canvas element (it acquires the 2d context
        // itself); `transform` applies the devicePixelRatio upscaling.
        task = page.render({
          canvas,
          viewport,
          transform: [dpr, 0, 0, dpr, 0, 0],
        });
        await task.promise;
        if (!cancelled) setDone({ scale, ok: true });
      } catch (err) {
        if (cancelled || (err instanceof Error && err.name === "RenderingCancelledException")) return;
        console.error("[auto-bewerb] letter preview page render failed:", { page: pageNumber, error: err });
        if (!cancelled) setDone({ scale, ok: false });
      }
    })();
    return () => {
      cancelled = true;
      try {
        task?.cancel();
      } catch {
        /* already finished */
      }
    };
  }, [doc, pageNumber, scale, dpr, attempt]);

  return (
    <div className="relative shrink-0" style={{ width: Math.floor(width), height: Math.floor(height) }}>
      <canvas
        ref={canvasRef}
        width={Math.max(1, Math.floor(width * dpr))}
        height={Math.max(1, Math.floor(height * dpr))}
        style={{ width: Math.floor(width), height: Math.floor(height) }}
        aria-label={t("autoBewerb.letterPreviewPageLabel", { page: pageNumber, count: pageCount })}
        className="block bg-white shadow-[0_2px_14px_rgba(0,0,0,0.35)]"
      />
      {!rendered && (
        <div className="absolute inset-0 flex items-center justify-center bg-white">
          {current?.ok === false ? (
            <div className="flex flex-col items-center gap-2 p-4 text-center">
              <AlertTriangle size={20} className="text-danger" />
              <p className="max-w-48 text-[11px] font-semibold leading-4 text-danger">{t("autoBewerb.letterPreviewParseError")}</p>
              <Button variant="secondary" size="sm" onClick={() => setAttempt((a) => a + 1)}>
                <RefreshCw size={12} /> {t("autoBewerb.retry")}
              </Button>
            </div>
          ) : (
            <Loader2 size={20} className="animate-spin text-muted" />
          )}
        </div>
      )}
    </div>
  );
}
