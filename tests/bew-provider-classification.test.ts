import { describe, expect, it } from "vitest";

import {
  BEW_MAX_DOCUMENT_SIZE,
  classifySendError,
  isDocumentKind,
  validateDocumentInput,
} from "@/lib/bewerbung-automation";

describe("validateDocumentInput", () => {
  const PDF = "application/pdf";
  const DOCX =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

  it("accepts allowed document MIME types within size", () => {
    expect(validateDocumentInput(PDF, 1024)).toEqual({ ok: true });
    expect(validateDocumentInput(DOCX, 5 * 1024 * 1024)).toEqual({ ok: true });
    expect(validateDocumentInput("image/png", 1)).toEqual({ ok: true });
  });

  it("rejects empty / non-positive size", () => {
    expect(validateDocumentInput(PDF, 0)).toMatchObject({ ok: false, error: "empty" });
    expect(validateDocumentInput(PDF, -5)).toMatchObject({ ok: false, error: "empty" });
    expect(validateDocumentInput(PDF, NaN)).toMatchObject({ ok: false, error: "empty" });
  });

  it("rejects files above the 10 MB ceiling", () => {
    const check = validateDocumentInput(PDF, BEW_MAX_DOCUMENT_SIZE + 1);
    expect(check).toMatchObject({ ok: false, error: "too-large" });
  });

  it("accepts exactly the ceiling", () => {
    expect(validateDocumentInput(PDF, BEW_MAX_DOCUMENT_SIZE)).toEqual({ ok: true });
  });

  it("rejects unsupported MIME types (e.g. executables, webp, txt)", () => {
    expect(validateDocumentInput("application/zip", 100)).toMatchObject({
      ok: false,
      error: "unsupported",
    });
    expect(validateDocumentInput("text/plain", 100)).toMatchObject({
      ok: false,
      error: "unsupported",
    });
    expect(validateDocumentInput("", 100)).toMatchObject({
      ok: false,
      error: "unsupported",
    });
  });

  it("isDocumentKind recognizes the three kinds only", () => {
    expect(isDocumentKind("cv")).toBe(true);
    expect(isDocumentKind("certificate")).toBe(true);
    expect(isDocumentKind("supporting")).toBe(true);
    expect(isDocumentKind("bogus")).toBe(false);
  });
});

describe("classifySendError", () => {
  it("maps a temporary ProviderFailure to retry", () => {
    expect(classifySendError({ code: "provider_rate_limited", message: "x", temporary: true }))
      .toMatchObject({ kind: "retry", code: "provider_rate_limited" });
    expect(classifySendError({ code: "provider_temporary", temporary: true }))
      .toMatchObject({ kind: "retry" });
  });

  it("maps a reconnect ProviderFailure to reconnect", () => {
    expect(classifySendError({ code: "reconnect_required", reconnect: true }))
      .toMatchObject({ kind: "reconnect", code: "reconnect_required" });
    expect(classifySendError({ code: "gmail_scope_missing", reconnect: true, temporary: false }))
      .toMatchObject({ kind: "reconnect" });
  });

  it("maps a definitive (non-temporary, non-reconnect) failure to failed", () => {
    expect(classifySendError({ code: "provider_rejected", temporary: false }))
      .toMatchObject({ kind: "failed", code: "provider_rejected" });
    expect(classifySendError({ code: "provider_not_configured" }))
      .toMatchObject({ kind: "failed" });
  });

  it("reconnect wins over temporary when both flags are set", () => {
    expect(classifySendError({ code: "x", temporary: true, reconnect: true }))
      .toMatchObject({ kind: "reconnect" });
  });

  it("treats a raw network error as UNCERTAIN (never auto-retry)", () => {
    const result = classifySendError(new Error("fetch failed"));
    expect(result).toMatchObject({ kind: "uncertain", code: "provider_uncertain" });
  });

  it("treats an AbortError / timeout as uncertain", () => {
    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";
    expect(classifySendError(abort)).toMatchObject({ kind: "uncertain" });
  });

  it("treats null / unknown as uncertain", () => {
    expect(classifySendError(null)).toMatchObject({ kind: "uncertain" });
    expect(classifySendError(undefined)).toMatchObject({ kind: "uncertain" });
  });

  it("keeps a string code-only error as failed (recognized shape)", () => {
    expect(classifySendError({ code: "attachment_unavailable" })).toMatchObject({
      kind: "failed",
      code: "attachment_unavailable",
    });
  });
});
