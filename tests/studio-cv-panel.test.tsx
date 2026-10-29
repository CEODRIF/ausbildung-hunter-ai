// @vitest-environment jsdom
/**
 * AI Bewerbung Studio — CvPanel fact-violation (422) behavior.
 *
 * When the server rejects a generated CV with `fact_violations`:
 *   - the candidate sees the SPECIFIC offending fields (not only a generic
 *     "check your data" message);
 *   - the existing CV state is NOT touched (no onCvChange / onSaveCv), so
 *     the saved CV and all user edits survive the failed attempt;
 *   - retrying re-calls generate-cv only (the ad analysis is stored and
 *     reused — no re-analysis).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { sanitizeCvDocument, type CvDocument } from "@/lib/templates/cv";

vi.mock("@/lib/i18n", async () => {
  const { dictionaries: deDict } = await import("@/lib/i18n/dictionaries");
  const makeT = () => (key: string, vars?: Record<string, string | number>) => {
    const parts = key.split(".");
    let cur: unknown = deDict.de;
    for (const p of parts) cur = (cur as Record<string, unknown>)?.[p];
    if (typeof cur !== "string") return key;
    return vars ? cur.replace(/\{(\w+)\}/g, (_, n: string) => String(vars[n] ?? "")) : cur;
  };
  return { useI18n: () => ({ t: makeT(), lang: "de" }) };
});

const { CvPanel } = await import("@/components/bewerbung-studio/panels-docs");

const BASE_CV = sanitizeCvDocument({
  templateId: "classic",
  personal: { fullName: "Mustapha Drif", email: "mustapha.drif@example.de", location: "Berlin" },
  summary: "Motivierter Kandidat",
}) as CvDocument;

function cv422(violations: Array<{ field: string; value: string; reason: string }>) {
  return new Response(
    JSON.stringify({
      error:
        "Die generierte Version enthält Angaben, die sich nicht aus Ihren Daten ableiten lassen. Bitte erneut versuchen — andernfalls Ihre Daten prüfen.",
      code: "fact_violations",
      violations,
    }),
    { status: 422, headers: { "Content-Type": "application/json" } },
  );
}

describe("CvPanel — fact_violations (422)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows the specific offending fields and does NOT touch the existing CV", async () => {
    const onCvChange = vi.fn();
    const onSaveCv = vi.fn(async () => true);
    const fetchMock = vi.fn<(url: string, init?: { body?: string }) => Promise<Response>>(async () =>
      cv422([
        { field: "personal.phone", value: "0151 2345678", reason: "not_in_source" },
        { field: "languages", value: "Englisch C1", reason: "not_in_source" },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);
    const before = JSON.stringify(BASE_CV);

    render(
      <CvPanel
        active
        applicationId="app-1"
        baseCv={BASE_CV}
        cv={null}
        onCvChange={onCvChange}
        onSaveCv={onSaveCv}
        onGoProfile={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Lebenslauf generieren" }));

    await waitFor(() =>
      expect(screen.getByText(/Betroffene Angaben: personal\.phone: 0151 2345678, languages: Englisch C1/)).toBeTruthy(),
    );

    // failed generation must NOT replace or save anything
    expect(onCvChange).not.toHaveBeenCalled();
    expect(onSaveCv).not.toHaveBeenCalled();
    expect(JSON.stringify(BASE_CV)).toBe(before);
    // the request carried the application (stored ad extraction) — retry
    // reuses it, no re-analysis
    const body = JSON.parse(fetchMock.mock.calls[0]![1]?.body ?? "{}");
    expect(body.applicationId).toBe("app-1");
  });

  it("shows a plain error (no field list) when the server sends no violations", async () => {
    const onCvChange = vi.fn();
    const onSaveCv = vi.fn(async () => true);
    vi.stubGlobal("fetch", vi.fn(async () => cv422([])));

    render(
      <CvPanel
        active
        applicationId="app-1"
        baseCv={BASE_CV}
        cv={null}
        onCvChange={onCvChange}
        onSaveCv={onSaveCv}
        onGoProfile={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Lebenslauf generieren" }));

    await waitFor(() => expect(screen.getByText(/Bitte erneut versuchen/)).toBeTruthy());
    expect(screen.queryByText(/Betroffene Angaben/)).toBeNull();
    expect(onCvChange).not.toHaveBeenCalled();
  });
});
