// @vitest-environment jsdom
/**
 * AUTO BEWERB — Step 2: VACANCY RETENTION after a provider failure.
 *
 * The user must never lose the entered job advertisement when the AI
 * provider fails (the production complaint: "temporarily unavailable" with no
 * way to retry without re-pasting the whole vacancy). Pinned here:
 *   1. a failed analysis (HTTP 503, code provider_unavailable) shows the
 *      ACCURATE localized message (by code, not a bare generic) and the
 *      textarea still holds the complete vacancy,
 *   2. the retry (second Analyze click) re-sends the identical body — no
 *      re-entry,
 *   3. the draft persists to localStorage and survives a remount (page
 *      refresh simulation),
 *   4. a successfully SAVED company clears the draft (and the field).
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutoBewerbWorkspace } from "@/lib/auto-bewerb/schema";

vi.mock("@/app/auto-bewerb/actions", () => ({
  addCompanyAction: vi.fn(),
  deleteCompanyAction: vi.fn(),
  updateCompanyAction: vi.fn(),
}));

import type { AutoBewerbContextValue } from "@/components/auto-bewerb/shared";

const { addCompanyAction } = await import("@/app/auto-bewerb/actions");
const { I18nProvider } = await import("@/lib/i18n");
const { AutoBewerbContext } = await import("@/components/auto-bewerb/shared");
const { Step2Companies } = await import("@/components/auto-bewerb/step2-companies");

const AD_DRAFT_KEY = "auto-bewerb:step2-ad-draft";

const SHOPVISION_AD = [
  "Kaufmann / Kauffrau im E-Commerce (m/w/d) — ShopVision Digital GmbH, Hamburg",
  "Ausbildungsstart 01.08.2027, Vollzeit. Aufgaben: Online-Marketing (SEO, Google Ads), Web-Shop-Pflege (Shopware),",
  "KPI-Auswertung in Excel, Kundenbetreuung. Profil: guter Schulabschluss, Excel-Grundlagen, Deutsch muttersprachlich,",
  "Englisch B1, Teamfähigkeit, Eigeninitiative. Bewerbung mit Lebenslauf und Zeugnissen per E-Mail bis 30.09.2026.",
].join(" ");

const SUCCESS_BODY = {
  extract: {
    jobTitle: "Kaufmann / Kauffrau im E-Commerce (m/w/d)",
    occupation: "Kaufmann im E-Commerce",
    company: "ShopVision Digital GmbH",
    companyAddress: "",
    location: "Hamburg",
    startDate: "01.08.2027",
    applicationDeadline: "30.09.2026",
    requiredQualifications: [],
    preferredQualifications: [],
    technicalSkills: [],
    softSkills: [],
    languageRequirements: [],
    educationRequirement: "",
    responsibilities: [],
    requestedDocuments: [],
    applicationMethod: "",
    contactPerson: "",
    applicationEmail: "",
    companyNotes: [],
    missingOrAmbiguous: [],
  },
  analysis: {
    matchScore: 70,
    matched: [],
    missing: [],
    transferable: [],
    weaknesses: [],
    recommendations: [],
    questions: [],
  },
  reused: false,
  profileHash: "h",
};

type FetchCall = { url: string; body: Record<string, unknown> };
let fetchCalls: FetchCall[] = [];
let nextResponses: Array<{ status: number; body: Record<string, unknown> }> = [];

function jsonResponse(status: number, body: Record<string, unknown>) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function wsFixture(): AutoBewerbWorkspace {
  return {
    ready: true,
    setupIssue: null,
    profile: null,
    photoSupported: false,
    photo: null,
    companies: [],
    attachments: [],
    emailTemplate: "",
    emailSettings: null,
    emailSettingsSupported: false,
    emailAccounts: [],
    candidateName: "",
    batchesSupported: false,
    batches: [],
    sendStats: { sentToday: 0, scheduled: 0, processing: 0, totalToday: 0, failed: 0 },
    capacity: null,
    sendHistory: [],
    sendingWindow: { open: false, label: "07:30–10:30 Europe/Berlin", nextStartMs: null },
  };
}

function step2Context(): AutoBewerbContextValue {
  return {
    ws: wsFixture(),
    refresh: vi.fn().mockResolvedValue(undefined),
    step: 2,
    goToStep: vi.fn(),
    toast: null,
    notify: vi.fn(),
    dismissToast: vi.fn(),
    syncing: false,
    companyId: null,
    selectCompany: vi.fn(),
    drafts: { cv: {}, letter: {} },
    setDraft: vi.fn(),
  };
}

function renderStep2() {
  return render(
    <I18nProvider>
      <AutoBewerbContext.Provider value={step2Context()}>
        <Step2Companies />
      </AutoBewerbContext.Provider>
    </I18nProvider>,
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  fetchCalls = [];
  nextResponses = [];
  window.localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/auto-bewerb/analyze-ad")) {
        const body = JSON.parse((init?.body ?? "{}") as string) as Record<string, unknown>;
        fetchCalls.push({ url, body });
        const response = nextResponses.length > 1 ? nextResponses.shift()! : nextResponses[0];
        return jsonResponse(response.status, response.body);
      }
      return jsonResponse(404, {});
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("retention after a provider failure", () => {
  it("shows the accurate code-based message and keeps the complete vacancy for the retry", async () => {
    nextResponses = [
      { status: 503, body: { error: "The AI provider is temporarily unavailable.", code: "provider_unavailable", retryable: true } },
      { status: 503, body: { error: "The AI provider is temporarily unavailable.", code: "provider_unavailable", retryable: true } },
    ];
    renderStep2();
    const textarea = screen.getByLabelText(/Text der Stellenanzeige/) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: SHOPVISION_AD } });

    fireEvent.click(screen.getByRole("button", { name: "Analysieren" }));

    // The ACCURATE localized message for the provider-unavailable code —
    // not the old bare generic.
    await screen.findByText("Der KI-Dienst ist gerade nicht erreichbar. Bitte in wenigen Augenblicken erneut versuchen.");

    // The complete vacancy is preserved in the field.
    expect(textarea.value).toBe(SHOPVISION_AD);

    // The retry re-sends the IDENTICAL body — no re-entry.
    fireEvent.click(screen.getByRole("button", { name: "Analysieren" }));
    await waitFor(() => expect(fetchCalls).toHaveLength(2));
    expect(fetchCalls[1].body.adText).toBe(SHOPVISION_AD);
    expect(fetchCalls[1].body.adText).toBe(fetchCalls[0].body.adText);
  });

  it("maps the timeout code to its own actionable message", async () => {
    nextResponses = [
      { status: 504, body: { error: "The AI provider timed out.", code: "provider_timeout", retryable: true } },
    ];
    renderStep2();
    const textarea = screen.getByLabelText(/Text der Stellenanzeige/) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: SHOPVISION_AD } });
    fireEvent.click(screen.getByRole("button", { name: "Analysieren" }));
    await screen.findByText("Die Analyse hat zu lange gedauert (Zeitüberschreitung). Bitte erneut versuchen.");
    expect(textarea.value).toBe(SHOPVISION_AD);
  });

  it("maps the configuration code to a non-retryable message (retry would not help)", async () => {
    nextResponses = [
      { status: 503, body: { error: "AI provider is not configured.", code: "provider_not_configured", retryable: false } },
    ];
    renderStep2();
    const textarea = screen.getByLabelText(/Text der Stellenanzeige/) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: SHOPVISION_AD } });
    fireEvent.click(screen.getByRole("button", { name: "Analysieren" }));
    await screen.findByText("Der KI-Dienst ist derzeit nicht erreichbar (Konfigurationsproblem). Bitte den Anbieter kontaktieren.");
  });
});

describe("draft persistence (survives a refresh; cleared on save)", () => {
  it("stores the draft and restores it after a remount", async () => {
    nextResponses = [
      { status: 503, body: { error: "The AI provider is temporarily unavailable.", code: "provider_unavailable", retryable: true } },
    ];
    renderStep2();
    const textarea = screen.getByLabelText(/Text der Stellenanzeige/) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: SHOPVISION_AD } });
    fireEvent.click(screen.getByRole("button", { name: "Analysieren" }));
    await screen.findByText("Der KI-Dienst ist gerade nicht erreichbar. Bitte in wenigen Augenblicken erneut versuchen.");
    // Let the debounced draft write (300 ms) land.
    await sleep(450);
    expect(window.localStorage.getItem(AD_DRAFT_KEY)).toBe(SHOPVISION_AD);

    // Simulate a page refresh: unmount + a fresh component instance.
    cleanup();
    renderStep2();
    const restored = screen.getByLabelText(/Text der Stellenanzeige/) as HTMLTextAreaElement;
    expect(restored.value).toBe(SHOPVISION_AD);
  });

  it("clears the draft once the company is saved", async () => {
    nextResponses = [{ status: 200, body: SUCCESS_BODY }];
    (addCompanyAction as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    renderStep2();
    const textarea = screen.getByLabelText(/Text der Stellenanzeige/) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: SHOPVISION_AD } });
    await sleep(450); // debounced draft write
    expect(window.localStorage.getItem(AD_DRAFT_KEY)).toBe(SHOPVISION_AD);

    fireEvent.click(screen.getByRole("button", { name: "Analysieren" }));
    await screen.findByText("Analyse-Ergebnis (Vorschau — noch nicht gespeichert)");
    const preview = screen.getByText("Analyse-Ergebnis (Vorschau — noch nicht gespeichert)").closest(".space-y-3");
    expect(within(preview as HTMLElement).getByText("ShopVision Digital GmbH")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Unternehmen hinzufügen" }));
    const addMock = addCompanyAction as unknown as ReturnType<typeof vi.fn>;
    await waitFor(() => expect(addCompanyAction).toHaveBeenCalledTimes(1));
    expect(addMock.mock.calls[0][0].adRaw).toBe(SHOPVISION_AD);
    expect(addMock.mock.calls[0][0].extract.company).toBe("ShopVision Digital GmbH");

    await waitFor(() => expect(textarea.value).toBe(""));
    expect(window.localStorage.getItem(AD_DRAFT_KEY)).toBeNull();
  });
});
