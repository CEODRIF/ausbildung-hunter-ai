// @vitest-environment jsdom
/**
 * AI Bewerbung Studio — batch workspace UI (jsdom, real de dictionary).
 *
 * Pins what the user actually sees in the redesigned workspace:
 *   1. the navigator: slot cards (company/title/status/progress), the exact
 *      lock reason on a blocked slot, the blocked "add" state, delete with
 *      two-step confirmation
 *   2. the per-app editor: explicit confirm bars ("bestätigen" → "Bestätigt")
 *   3. batch send: independent per-item eligibility, the batch approval
 *      checkbox gate, partial-success reporting, retry-failed-only
 *   4. configuration-required state (no active email account)
 *   5. structural mobile-safety: the only horizontal scroller is the
 *      navigator strip (internal scroll), no fixed px widths on the shell
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { sanitizeCvDocument, type CvDocument } from "@/lib/templates/cv";

const { dictionaries } = await import("@/lib/i18n/dictionaries");

const makeT = () => (key: string, params?: Record<string, unknown>) => {
  let cur: unknown = dictionaries.de;
  for (const part of key.split(".")) {
    cur = (cur as Record<string, unknown> | undefined)?.[part];
  }
  let s = typeof cur === "string" ? cur : key;
  if (params) {
    for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v));
  }
  return s;
};

vi.mock("@/lib/i18n", () => ({ useI18n: () => ({ t: makeT(), lang: "de" }) }));
const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

type ActionResult = { ok: true; value: unknown } | { ok: false; code: string; message: string };
const actions = {
  createApplicationAction: vi.fn<() => Promise<ActionResult>>(async () => ({ ok: true, value: { id: "new-app" } })),
  updateApplicationAction: vi.fn<() => Promise<ActionResult>>(async () => ({ ok: true, value: null })),
  saveDocumentAction: vi.fn<() => Promise<ActionResult>>(async () => ({ ok: true, value: null })),
  approveApplicationAction: vi.fn<() => Promise<ActionResult>>(async () => ({ ok: true, value: {} })),
  sendApplicationAction: vi.fn<
    (input: { applicationId: string; confirmed?: boolean }) => Promise<ActionResult>
  >(async () => ({ ok: true, value: { attemptId: "att", scheduledAt: null, dispatchStatus: "sent" } })),
  cancelSendAction: vi.fn<() => Promise<ActionResult>>(async () => ({ ok: true, value: null })),
  refreshApplicationAction: vi.fn<() => Promise<ActionResult>>(async () => ({ ok: true, value: { app: null } })),
  refreshBatchAction: vi.fn<() => Promise<ActionResult>>(async () => ({ ok: true, value: null })),
  deleteApplicationAction: vi.fn<() => Promise<ActionResult>>(async () => ({ ok: true, value: null })),
  confirmStepAction: vi.fn<() => Promise<ActionResult>>(async () => ({ ok: true, value: null })),
};
vi.mock("@/app/bewerbung-studio/actions", () => actions);

const { StudioClient } = await import("@/components/bewerbung-studio/studio-client");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const APP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BASE_APP = {
  id: APP_ID,
  user_id: "user-a",
  ad_raw: "x".repeat(40),
  ad_extracted: {
    jobTitle: "Fachinformatiker",
    occupation: "Fachinformatiker",
    company: "Tech GmbH",
    companyAddress: "",
    location: "Berlin",
    startDate: "",
    applicationDeadline: "",
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
    applicationEmail: "jobs@tech-gmbh.de",
    companyNotes: [],
    missingOrAmbiguous: [],
  },
  ad_analysis: null,
  profile_snapshot: null,
  status: "ready",
  email_account_id: "33333333-3333-4333-8333-333333333333",
  recipient_email: "jobs@tech-gmbh.de",
  idempotency_key: null,
  approved: false,
  approved_at: null,
  scheduled_at: null,
  ad_confirmed_at: null,
  profile_confirmed_at: null,
  cv_reviewed_at: null,
  letter_reviewed_at: null,
  checklist_ack_at: null,
  schedule_timezone: null,
  sent_at: null,
  provider_message_id: null,
  last_failure_code: null,
  created_at: "2026-12-01T00:00:00.000Z",
  updated_at: "2026-12-01T00:00:00.000Z",
};

const ALL_DONE = { ad: true, profile: true, cv: true, letter: true, docs: true, email: true, quality: true };

function batchApp(app: Record<string, unknown>, over: Record<string, unknown> = {}) {
  return {
    app: { ...BASE_APP, ...app },
    completion: { done: { ...ALL_DONE }, missing: [], complete: true, progress: 1 },
    slot: { unlocked: true, complete: true, missing: [] },
    hasCv: true,
    hasLetter: true,
    hasEmail: true,
    emailSubject: "Bewerbung als Fachinformatiker",
    emailBody: "anbei meine vollständige Bewerbung.",
    emailAttachmentIds: ["att-1"],
    docVersions: { cv: 2, letter: 3, email: 1 },
    attachmentCount: 1,
    latestAttempt: null,
    ...over,
  };
}

function makeBatch(over: Record<string, unknown> = {}) {
  const apps = (over.apps as unknown[] | undefined) ?? [
    batchApp({ id: APP_ID }),
    batchApp({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }),
  ];
  return {
    limit: 10,
    completeCount: 1,
    canAdd: false,
    blockingAppId: APP_ID,
    missingForBlockingApp: ["cv"],
    ...over,
    apps,
  };
}

function initial(over: Record<string, unknown> = {}) {
  return {
    available: true,
    missingTables: [],
    userId: "user-a",
    userFacts: { fullName: "Test User", email: "test@example.de", phone: null, location: "Berlin", linkedin: null },
    emailAccounts: [
      { id: "33333333-3333-4333-8333-333333333333", provider: "gmail" as const, email: "a@gmail.com", is_active: true, requires_reconnect: false },
    ],
    appSummaries: [],
    batch: makeBatch(),
    bundle: null,
    profile: null,
    ...over,
  } as unknown as Parameters<typeof StudioClient>[0]["initial"];
}

beforeEach(() => {
  vi.clearAllMocks();
  pushMock.mockReset();
  (globalThis as { localStorage?: Storage }).localStorage ??= (() => {
    const store = new Map<string, string>();
    return {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    } as Storage;
  })();
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Navigator
// ---------------------------------------------------------------------------

describe("batch navigator", () => {
  it("shows slot cards with company, status and the EXACT missing requirements; the blocked slot explains why it is locked", () => {
    const lockedApp = batchApp(
      { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
      {
        app: { ...BASE_APP, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", ad_extracted: { ...BASE_APP.ad_extracted, company: "Beta AG" } },
        completion: { done: { ...ALL_DONE, cv: false }, missing: ["cv"], complete: false, progress: 6 / 7 },
        slot: { unlocked: false, complete: false, missing: ["cv"] },
      },
    );
    const openApp = batchApp({ id: APP_ID }, {
      completion: { done: { ...ALL_DONE, cv: false }, missing: ["cv"], complete: false, progress: 6 / 7 },
      slot: { unlocked: true, complete: false, missing: ["cv"] },
    });
    render(<StudioClient initial={initial({ batch: makeBatch({ apps: [openApp, lockedApp] }) })} />);

    // both companies visible (desktop column + mobile strip render in jsdom)
    expect(screen.getAllByText("Tech GmbH").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Beta AG").length).toBeGreaterThan(0);
    // the unlocked slot lists its missing requirement
    expect(screen.getAllByText(/Lebenslauf geprüft/).length).toBeGreaterThan(0);
    // the locked slot shows the lock hint with the exact missing item
    expect(screen.getAllByText(/Fehlt: Lebenslauf geprüft/).length).toBeGreaterThan(0);
    // add slot is blocked and names the blocking company
    expect(screen.getAllByText(/Zuerst Tech GmbH abschließen/).length).toBeGreaterThan(0);
    // batch progress in the header
    expect(screen.getAllByText(/1\/10 vollständig/).length).toBeGreaterThan(0);
  });

  it("add slot offers the new application when everything is complete (canAdd)", () => {
    render(
      <StudioClient
        initial={initial({ batch: makeBatch({ canAdd: true, blockingAppId: null, missingForBlockingApp: [] }) })}
      />,
    );
    expect(screen.getAllByText("Neue Bewerbung").length).toBeGreaterThan(0);
  });

  it("shows 'batch full' at the 10-slot cap", () => {
    const apps = Array.from({ length: 10 }, (_, i) =>
      batchApp({ id: `cccccccc-0000-4000-8000-${String(i).padStart(12, "0")}` }),
    );
    render(<StudioClient initial={initial({ batch: makeBatch({ apps, canAdd: false }) })} />);
    expect(screen.getAllByText("Batch voll (max. 10)").length).toBeGreaterThan(0);
  });

  it("delete requires the two-step confirmation and calls the server action with the slot's id", async () => {
    render(<StudioClient initial={initial()} />);
    const del = screen.getAllByLabelText("Bewerbung löschen").at(0)!;
    fireEvent.click(del);
    expect(screen.getAllByText("Löschen?").length).toBeGreaterThan(0);
    // cancel path first
    fireEvent.click(screen.getAllByText("Abbrechen").at(0)!);
    expect(actions.deleteApplicationAction).not.toHaveBeenCalled();
    // confirm path
    fireEvent.click(screen.getAllByLabelText("Bewerbung löschen").at(0)!);
    fireEvent.click(screen.getAllByText("Ja, löschen").at(0)!);
    await waitFor(() => expect(actions.deleteApplicationAction).toHaveBeenCalledWith(APP_ID));
  });
});

// ---------------------------------------------------------------------------
// Per-app confirm bars
// ---------------------------------------------------------------------------

describe("per-app completion confirmations", () => {
  const bundle = {
    app: { ...BASE_APP },
    documents: {
      // sanitized the same way the server sanitizes stored CV docs
      cv: sanitizeCvDocument({
        templateId: "classic",
        personal: { fullName: "Test User", email: "test@example.de", location: "Berlin" },
        summary: "Profil",
      }) as CvDocument,
      cover_letter: null,
      email: null,
    },
    attachments: [],
    attempts: [],
  };

  it("the CV step shows the confirm action; confirming stamps it and shows 'Bestätigt'", async () => {
    actions.confirmStepAction.mockImplementationOnce(async () => ({
      ok: true,
      value: { ...BASE_APP, cv_reviewed_at: "2026-12-01T05:00:00.000Z" },
    }));
    render(<StudioClient initial={initial({ bundle })} />);
    // jump to the CV step
    fireEvent.click(screen.getAllByText("Lebenslauf").at(-1)!);
    const confirmBtn = await screen.findByRole("button", { name: "Lebenslauf als geprüft bestätigen" });
    fireEvent.click(confirmBtn);
    await waitFor(() =>
      expect(actions.confirmStepAction).toHaveBeenCalledWith(APP_ID, "cv"),
    );
    expect(screen.getAllByText("Bestätigt").length).toBeGreaterThan(0);
  });

  it("the ad step shows 'Anzeigedetails bestätigen' once extracted details exist", async () => {
    render(<StudioClient initial={initial({ bundle })} />);
    // analysis step is the default step
    expect(screen.getAllByText("Anzeigedetails bestätigen").length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Batch send
// ---------------------------------------------------------------------------

describe("batch send", () => {
  it("configuration-required state when no active email account exists", () => {
    render(
      <StudioClient
        initial={initial({
          emailAccounts: [
            { id: "acct-x", provider: "gmail" as const, email: "x@gmail.com", is_active: false, requires_reconnect: true },
          ],
        })}
      />,
    );
    fireEvent.click(screen.getAllByText("Batch-Versand").at(-1)!);
    expect(screen.getAllByText(/Kein aktives E-Mail-Konto verbunden/).length).toBeGreaterThan(0);
  });

  it("validates each item independently: only complete+approved apps are selectable", () => {
    const notApproved = batchApp(
      { id: "dddddddd-0000-4000-8000-000000000001" },
      {
        // complete package, but NOT yet approved → not selectable
        app: { ...BASE_APP, id: "dddddddd-0000-4000-8000-000000000001", ad_extracted: { ...BASE_APP.ad_extracted, company: "Gamma GbR" }, approved: false },
      },
    );
    const incomplete = batchApp(
      { id: "dddddddd-0000-4000-8000-000000000002" },
      {
        app: { ...BASE_APP, id: "dddddddd-0000-4000-8000-000000000002", ad_extracted: { ...BASE_APP.ad_extracted, company: "Delta AG" }, approved: false },
        completion: { done: { ...ALL_DONE, letter: false, email: false }, missing: ["letter", "email"], complete: false, progress: 5 / 7 },
        slot: { unlocked: true, complete: false, missing: ["letter", "email"] },
        emailSubject: null,
        emailBody: null,
      },
    );
    const sent = batchApp(
      { id: "dddddddd-0000-4000-8000-000000000003" },
      { app: { ...BASE_APP, id: "dddddddd-0000-4000-8000-000000000003", ad_extracted: { ...BASE_APP.ad_extracted, company: "Epsilon SE" }, status: "sent" } },
    );
    const eligible = batchApp(
      { id: "dddddddd-0000-4000-8000-000000000004" },
      { app: { ...BASE_APP, id: "dddddddd-0000-4000-8000-000000000004", ad_extracted: { ...BASE_APP.ad_extracted, company: "Zeta GmbH" }, approved: true } },
    );
    // eligible needs an email too — BASE_APP has recipient + docs set
    render(
      <StudioClient
        initial={initial({ batch: makeBatch({ apps: [eligible, notApproved, incomplete, sent], completeCount: 3, canAdd: false, blockingAppId: null, missingForBlockingApp: [] }) })}
      />,
    );
    fireEvent.click(screen.getAllByText("Batch-Versand").at(-1)!);
    expect(screen.getByText("Batch-Versand (max. 10 E-Mails)")).toBeTruthy();

    // independent review rows show recipient + subject
    expect(screen.getAllByText("jobs@tech-gmbh.de").length).toBeGreaterThan(0);
    // eligibility labels (one selectable item → one "ready" row)
    expect(screen.getAllByText("Versandbereit").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/Noch nicht genehmigt/).length).toBe(1);
    expect(screen.getAllByText(/Noch nicht vollständig: Anschreiben geprüft · E-Mail vollständig/).length).toBe(1);
    expect(screen.getAllByText("Gesendet").length).toBeGreaterThanOrEqual(1);
  });

  it("batch approval checkbox gates the send; partial success is reported; retry only re-sends the failed item", async () => {
    const aId = "dddddddd-0000-4000-8000-000000000004";
    const bId = "dddddddd-0000-4000-8000-000000000005";
    const eligible = batchApp({ id: aId }, { app: { ...BASE_APP, id: aId, approved: true, ad_extracted: { ...BASE_APP.ad_extracted, company: "Zeta GmbH" } } });
    const second = batchApp({ id: bId }, { app: { ...BASE_APP, id: bId, approved: true, ad_extracted: { ...BASE_APP.ad_extracted, company: "Eta GmbH" } } });
    render(
      <StudioClient initial={initial({ batch: makeBatch({ apps: [eligible, second], completeCount: 2, canAdd: true, blockingAppId: null, missingForBlockingApp: [] }) })} />,
    );
    fireEvent.click(screen.getAllByText("Batch-Versand").at(-1)!);
    await waitFor(() => expect(screen.getByText("Batch-Versand (max. 10 E-Mails)")).toBeTruthy());

    // approval checkbox gates the send button
    const sendBtn = screen.getByRole("button", { name: /Ausgewählte E-Mails senden/ }) as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(true);
    const approve = screen.getByRole("checkbox", { name: /Ich habe alle ausgewählten E-Mails/ }) as HTMLInputElement;
    fireEvent.click(approve);
    await waitFor(() => expect(sendBtn.disabled).toBe(false));

    // first app succeeds, second fails → partial success
    actions.sendApplicationAction.mockImplementation(async (input: { applicationId: string }) => {
      if (input.applicationId === bId) return { ok: false, code: "not_approved", message: "Bitte genehmigen Sie die Bewerbung zuerst." };
      return { ok: true, value: { attemptId: `att-${input.applicationId}`, scheduledAt: null, dispatchStatus: "sent" } };
    });
    fireEvent.click(sendBtn);
    await waitFor(() => expect(screen.getByText(/Ergebnis: 1 gesendet\/geplant, 1 fehlgeschlagen\./)).toBeTruthy());
    expect(screen.getAllByText(/Zeta GmbH/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Bitte genehmigen Sie die Bewerbung zuerst\./)).toBeTruthy();
    expect(actions.sendApplicationAction).toHaveBeenCalledTimes(2);
    // both items were individually confirmed (batch approval + per-app data)
    for (const call of actions.sendApplicationAction.mock.calls) {
      expect((call[0] as { confirmed: boolean }).confirmed).toBe(true);
    }

    // retry → ONLY the failed id is re-sent
    const secondImpl = async (input: { applicationId: string; confirmed?: boolean }): Promise<ActionResult> =>
      input.applicationId === bId
        ? { ok: true, value: { attemptId: "att-retry", scheduledAt: null, dispatchStatus: "sent" } }
        : { ok: true, value: { attemptId: "x", scheduledAt: null, dispatchStatus: "sent" } };
    actions.sendApplicationAction.mockImplementation(secondImpl);
    fireEvent.click(screen.getByRole("button", { name: "Nur fehlgeschlagene wiederholen" }));
    await waitFor(() => expect(actions.sendApplicationAction).toHaveBeenCalledTimes(3));
    const lastCall = actions.sendApplicationAction.mock.calls.at(-1)![0] as { applicationId: string };
    expect(lastCall.applicationId).toBe(bId);
  });

  it("the batch never touches sent/sending apps (their rows are not selectable)", () => {
    const sending = batchApp(
      { id: "dddddddd-0000-4000-8000-000000000006" },
      { app: { ...BASE_APP, id: "dddddddd-0000-4000-8000-000000000006", ad_extracted: { ...BASE_APP.ad_extracted, company: "Theta GmbH" }, status: "sending" } },
    );
    render(<StudioClient initial={initial({ batch: makeBatch({ apps: [sending] }) })} />);
    fireEvent.click(screen.getAllByText("Batch-Versand").at(-1)!);
    expect(screen.getAllByText("Wird versendet").length).toBeGreaterThanOrEqual(1);
    const checkboxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(checkboxes.every((c) => c.disabled)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Structural mobile safety (jsdom cannot measure layout — these assert the
// classes that guarantee no page-level horizontal overflow)
// ---------------------------------------------------------------------------

describe("responsive structure", () => {
  it("the only horizontal scroller is the navigator strip; the shell uses no fixed px widths", () => {
    const { container } = render(<StudioClient initial={initial()} />);
    const html = container.innerHTML;
    // the mobile strip scrolls internally (snap strip)
    expect(html).toContain("overflow-x-auto");
    expect(html).toContain("snap-x");
    // the page shell is fluid: max-w-* + padding, never w-[Npx] with N ≥ 100
    expect(html).toMatch(/max-w-7xl/);
    expect(/(^|[\s"'])w-\[\d{3,}px\]/.test(html)).toBe(false);
    // the editor column is min-w-0 (grid child can shrink without overflow)
    expect(html).toContain("min-w-0");
  });
});
