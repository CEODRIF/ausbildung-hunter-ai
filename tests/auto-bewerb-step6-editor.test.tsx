// @vitest-environment jsdom
/**
 * AUTO BEWERB — Step 6 simplified e-mail preparation (UI contract).
 *
 * Reference layout pinned here (real components, jsdom, German = default):
 *   1. Shared e-mail template — subject + rich-text editor (toolbar, tokens,
 *      character counter), AI draft, live preview, attach flags, validation
 *      checklist. NO shared-recipient override (field, hint and warning are
 *      removed — a stale stored value is ignored and never displayed).
 *   2. Companies and attachments — read-only rows: company, position, the
 *      company's OWN verified recipient (read-only, green verified marker;
 *      never an input), the company's OWN cover-letter PDF + shared
 *      supporting documents as chips, batch-wide total in the header; a
 *      missing verified recipient warns (→ Step 2).
 *   3. ONE global sending-account selector (for the whole batch) — real
 *      connected accounts only (no hardcoded/fictional entries, no
 *      credentials); selecting persists immediately through the EXISTING
 *      settings action (saved values only — an in-progress draft is never
 *      flushed); failures revert the selection.
 *   4. Back / Continue navigation unchanged.
 *
 * Also pinned: the editor toolbar contract and its onChange flow (persistence).
 */
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import React from "react";
import { I18nProvider } from "@/lib/i18n";
import { EmailRichEditor } from "@/components/auto-bewerb/email-rich-editor";
import { AttachmentManifest } from "@/components/auto-bewerb/attachment-manifest";
import { SendingAccountSelect } from "@/components/auto-bewerb/sending-account-select";
import { Step6Email } from "@/components/auto-bewerb/step6-email";
import { AutoBewerbContext, StepShell } from "@/components/auto-bewerb/shared";
import {
  AUTO_BEWERB_EMAIL_DEFAULT_BODY,
  AUTO_BEWERB_EMAIL_DEFAULT_SUBJECT,
} from "@/lib/auto-bewerb/schema";
import { saveEmailSettingsAction } from "@/app/auto-bewerb/actions";

vi.mock("@/app/auto-bewerb/actions", () => ({
  saveEmailTemplateAction: vi.fn(),
  saveEmailSettingsAction: vi.fn(),
}));

/** Mutable fake workspace (per test) for the `useAutoBewerb` hook — the rest
 *  of the shared module (Note, SectionCard, StepShell, companyLabel,
 *  statusPill) stays REAL so the rendered markup is the production markup. */
const wsHolder = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/components/auto-bewerb/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/auto-bewerb/shared")>();
  return { ...actual, useAutoBewerb: () => wsHolder.current };
});

const ts = "2026-12-01T00:00:00.000Z";

const ACCT1 = { id: "acct1", provider: "gmail", email: "mail@example.de", is_active: true, requires_reconnect: false };
const ACCT2 = { id: "acct2", provider: "outlook", email: "outlook@example.de", is_active: true, requires_reconnect: false };

function companyRow(id: string, company: string, email: string, job: string) {
  return {
    id,
    user_id: "u1",
    company,
    company_key: company.toLowerCase(),
    slot_no: 1,
    ad_raw: "x".repeat(40),
    ad_extracted: {
      jobTitle: job,
      occupation: job,
      company,
      companyAddress: "",
      location: "",
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
      applicationEmail: email,
      companyNotes: [],
      missingOrAmbiguous: [],
    },
    ad_analysis: null,
    profile_snapshot: null,
    status: "ready",
    recipient_email: null,
    email_subject: null,
    email_body: null,
    email_attach_cv: true,
    email_attach_letter: true,
    email_account_id: null,
    idempotency_key: null,
    approved: true,
    approved_at: ts,
    scheduled_at: null,
    schedule_timezone: null,
    sent_at: null,
    provider_message_id: null,
    last_failure_code: null,
    ad_confirmed_at: ts,
    cv_reviewed_at: null,
    letter_reviewed_at: null,
    created_at: ts,
    updated_at: ts,
  };
}

function companyView(over: Record<string, unknown> = {}) {
  const { id, company, email, job, ...rest } = over as { id: string; company: string; email: string; job: string } & Record<string, unknown>;
  return {
    company: companyRow(id, company, email, job),
    cv: { id: `cv-${id}` },
    cvVersion: 1,
    cvPdfName: "Lebenslauf_Mustapha_Drif.pdf",
    letter: { id: `letter-${id}`, text: "…", tone: "professional" },
    letterVersion: 1,
    letterPdfName: `Anschreiben_${company}.pdf`,
    latestAttempt: null,
    ...rest,
  };
}

function makeWs(over: Record<string, unknown> = {}) {
  return {
    ready: true,
    setupIssue: null,
    profile: null,
    photoSupported: false,
    photo: null,
    companies: [
      companyView({ id: "c1", company: "Kältebau Nord GmbH", email: "jobs@kaltbau-nord.de", job: "Anlagenmechaniker SHK" }),
      companyView({ id: "c2", company: "Tech Süd AG", email: "bewerbung@tech-sued.de", job: "Fachinformatiker", cv: null, cvVersion: null, cvPdfName: null }),
    ],
    attachments: [
      {
        id: "d1",
        user_id: "u1",
        display_name: "Abiturzeugnis.pdf",
        doc_category: "school_certificate",
        mime_type: "application/pdf",
        size_bytes: 10,
        storage_path: "u1/auto-bewerb/docs/d1.pdf",
        file_hash: "h1",
        created_at: ts,
        updated_at: ts,
      },
    ],
    emailTemplate: AUTO_BEWERB_EMAIL_DEFAULT_BODY,
    emailSettings: {
      body: AUTO_BEWERB_EMAIL_DEFAULT_BODY,
      recipient: "",
      subject: AUTO_BEWERB_EMAIL_DEFAULT_SUBJECT,
      accountId: "acct1",
      attachCv: true,
      attachLetter: true,
    },
    emailSettingsSupported: true,
    emailAccounts: [ACCT1],
    candidateName: "Mustapha Drif",
    ...over,
  };
}

let lastCtx: { ws: unknown; step: number; refresh: ReturnType<typeof vi.fn>; notify: ReturnType<typeof vi.fn>; goToStep: ReturnType<typeof vi.fn> } | null = null;
const setWs = (ws: unknown, step = 6) => {
  const ctx = { ws, step, refresh: vi.fn().mockResolvedValue(undefined), notify: vi.fn(), goToStep: vi.fn() };
  lastCtx = ctx;
  wsHolder.current = ctx;
};

/** The ONE global sending-account control (disclosure button, fixed label). */
const accountButton = () => screen.getByRole("button", { name: "Versand-Konto (für alle E-Mails)" });

// jsdom has no document.execCommand — a test-local stub so token insertion
// and formatting have a visible effect (appends the inserted text).
let origExecCommand: unknown;

afterEach(() => {
  cleanup();
  document.execCommand = origExecCommand as never;
  vi.mocked(saveEmailSettingsAction).mockReset();
  lastCtx = null;
});

// ---------------------------------------------------------------------------
// The rich-text editor (unchanged contract)
// ---------------------------------------------------------------------------

describe("EmailRichEditor", () => {
  it("offers the full toolbar: format, B/I/U, align, lists, undo/redo, link + 4 token buttons", () => {
    render(
      <I18nProvider>
        <EmailRichEditor value="<p>Text</p>" onChange={vi.fn()} placeholder="Platzhalter" />
      </I18nProvider>,
    );
    // Paragraph format select:
    const select = screen.getByLabelText("Absatzformat") as HTMLSelectElement;
    expect(select).toHaveValue("p");
    for (const opt of ["Normal", "Überschrift 1", "Überschrift 2"]) {
      expect(screen.getByRole("option", { name: opt })).toBeInTheDocument();
    }
    // Formatting + structure:
    for (const label of [
      "Fett",
      "Kursiv",
      "Unterstrichen",
      "Linksbündig",
      "Zentriert",
      "Rechtsbündig",
      "Aufzählung",
      "Nummerierte Liste",
      "Rückgängig",
      "Wiederholen",
      "Link einfügen",
    ]) {
      expect(screen.getByRole("button", { name: label }), label).toBeInTheDocument();
    }
    // The personalization token buttons:
    for (const token of ["{{candidate_name}}", "{{contact_person}}", "{{company_name}}", "{{greeting}}"]) {
      expect(screen.getByRole("button", { name: token }), token).toBeInTheDocument();
    }
    // The placeholder is only visual data (an attribute — never content):
    expect(document.querySelector('[role="textbox"]')?.getAttribute("data-placeholder")).toBe("Platzhalter");
  });

  it("token insertion + edits flow to onChange (persistence contract)", () => {
    origExecCommand = document.execCommand;
    document.execCommand = vi.fn((cmd: string, _ui: boolean, arg?: string) => {
      if (cmd === "insertText") {
        document.querySelector('[role="textbox"]')?.appendChild(document.createTextNode(arg ?? ""));
      }
      return true;
    }) as never;
    const onChange = vi.fn();
    render(
      <I18nProvider>
        <EmailRichEditor value="<p>Grüß Gott</p>" onChange={onChange} />
      </I18nProvider>,
    );
    // A token button inserts the placeholder into the document:
    fireEvent.click(screen.getByRole("button", { name: "{{candidate_name}}" }));
    expect(onChange).toHaveBeenCalled();
    const html = onChange.mock.calls.at(-1)?.[0] as string;
    expect(html).toContain("{{candidate_name}}");
    expect(html).toContain("Grüß Gott");

    // A direct edit (input event) propagates the exact new innerHTML:
    const box = document.querySelector('[role="textbox"]') as HTMLElement;
    box.innerHTML = "<p>Neuer <strong>Text</strong></p>";
    fireEvent.input(box);
    expect(onChange.mock.calls.at(-1)?.[0]).toBe("<p>Neuer <strong>Text</strong></p>");
  });
});

// ---------------------------------------------------------------------------
// Companies and attachments panel (the simplified manifest)
// ---------------------------------------------------------------------------

describe("AttachmentManifest (companies and attachments)", () => {
  it("lists REAL filenames as chips + batch total; each company's OWN verified recipient is shown read-only", () => {
    setWs(makeWs());
    render(
      <I18nProvider>
        <AttachmentManifest />
      </I18nProvider>,
    );
    // Section title + batch-wide total (c1: cv+letter+shared = 3, c2: letter+shared = 2):
    expect(screen.getByText("Unternehmen und Anhänge")).toBeInTheDocument();
    expect(screen.getByText("5 Anhänge insgesamt")).toBeInTheDocument();
    // Column header:
    expect(screen.getByText("Anhänge")).toBeInTheDocument();

    // Company + applied position per row:
    expect(screen.getByText("Kältebau Nord GmbH")).toBeInTheDocument();
    expect(screen.getByText("Anlagenmechaniker SHK")).toBeInTheDocument();
    expect(screen.getByText("Tech Süd AG")).toBeInTheDocument();
    expect(screen.getByText("Fachinformatiker")).toBeInTheDocument();

    // Company-specific cover-letter PDF + shared supporting documents as chips:
    expect(screen.getByText("Lebenslauf_Mustapha_Drif.pdf")).toBeInTheDocument();
    expect(screen.getByText("Anschreiben_Kältebau Nord GmbH.pdf")).toBeInTheDocument();
    expect(screen.getByText("Anschreiben_Tech Süd AG.pdf")).toBeInTheDocument();
    expect(screen.getAllByText("Abiturzeugnis.pdf").length).toBe(2);

    // Each company's OWN verified recipient (from the Step 2 data) is
    // displayed READ-ONLY below the name/position, with a verified marker:
    expect(screen.getByText("jobs@kaltbau-nord.de")).toBeInTheDocument();
    expect(screen.getByText("bewerbung@tech-sued.de")).toBeInTheDocument();
    expect(screen.getAllByText("Verifizierter Empfänger").length).toBe(2);
    // …but it is never an input — no editable e-mail field exists here:
    expect(document.querySelectorAll('input[type="email"]').length).toBe(0);
  });

  it("a company WITHOUT a verified recipient warns and points to Step 2", () => {
    setWs(
      makeWs({
        companies: [
          companyView({ id: "c1", company: "Kältebau Nord GmbH", email: "", job: "Anlagenmechaniker SHK" }),
          companyView({ id: "c2", company: "Tech Süd AG", email: "", job: "Fachinformatiker" }),
        ],
      }),
    );
    render(
      <I18nProvider>
        <AttachmentManifest />
      </I18nProvider>,
    );
    expect(screen.getAllByText("Empfänger fehlt — bitte in Schritt 2 prüfen").length).toBe(2);
    // No address is invented or shown as verified for the missing ones:
    expect(screen.queryByText("Verifizierter Empfänger")).not.toBeInTheDocument();
  });

  it("missing CV/letter warn on the affected company's row", () => {
    setWs(makeWs()); // c2 has no CV in the default workspace
    render(
      <I18nProvider>
        <AttachmentManifest />
      </I18nProvider>,
    );
    expect(screen.getByText("Lebenslauf noch nicht erstellt")).toBeInTheDocument();
    // …while the healthy company has no warning at all:
    expect(screen.queryByText(/Empfänger fehlt/)).not.toBeInTheDocument();
  });

  it("shows no panel for an empty series", () => {
    setWs(makeWs({ companies: [] }));
    const { container } = render(
      <I18nProvider>
        <AttachmentManifest />
      </I18nProvider>,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

// ---------------------------------------------------------------------------
// The ONE global sending-account selector
// ---------------------------------------------------------------------------

describe("SendingAccountSelect (one global selector for the batch)", () => {
  it("lists ONLY the actual connected accounts (real data, nothing hardcoded)", () => {
    setWs(makeWs({ emailAccounts: [ACCT1, ACCT2] }));
    render(
      <I18nProvider>
        <SendingAccountSelect accountId="acct1" onAccountChange={vi.fn()} saving={false} />
      </I18nProvider>,
    );
    // Exactly ONE account control:
    expect(screen.getAllByRole("button", { name: "Versand-Konto (für alle E-Mails)" }).length).toBe(1);
    fireEvent.click(accountButton());
    const options = within(screen.getByRole("listbox")).getAllByRole("option");
    expect(options.length).toBe(2); // exactly ws.emailAccounts — no fictional entries
    const listbox = screen.getByRole("listbox");
    expect(within(listbox).getByText("mail@example.de")).toBeInTheDocument();
    expect(within(listbox).getByText("outlook@example.de")).toBeInTheDocument();
    // No credentials ever rendered:
    expect(document.body.textContent).not.toContain("token");
  });

  it("displays the selected account clearly (address + checkmark in the list)", () => {
    setWs(makeWs({ emailAccounts: [ACCT1, ACCT2] }));
    render(
      <I18nProvider>
        <SendingAccountSelect accountId="acct1" onAccountChange={vi.fn()} saving={false} />
      </I18nProvider>,
    );
    // The selected address is visible on the control itself:
    expect(accountButton().textContent).toContain("mail@example.de");
    fireEvent.click(accountButton());
    expect(screen.getByRole("option", { name: /mail@example\.de/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("option", { name: /outlook@example\.de/ })).toHaveAttribute("aria-selected", "false");
  });

  it("no connected account → helpful empty state with the existing connect action (no dropdown)", () => {
    setWs(makeWs({ emailAccounts: [] }));
    render(
      <I18nProvider>
        <SendingAccountSelect accountId="" onAccountChange={vi.fn()} saving={false} />
      </I18nProvider>,
    );
    expect(screen.queryByRole("button", { name: "Versand-Konto (für alle E-Mails)" })).not.toBeInTheDocument();
    const cta = screen.getByRole("link", { name: "E-Mail-Konto verbinden" });
    expect(cta).toHaveAttribute("href", "/settings/email");
  });

  it("an account needing reconnection cannot be selected", () => {
    setWs(makeWs({ emailAccounts: [{ ...ACCT2, requires_reconnect: true }] }));
    render(
      <I18nProvider>
        <SendingAccountSelect accountId="" onAccountChange={vi.fn()} saving={false} />
      </I18nProvider>,
    );
    fireEvent.click(accountButton());
    expect(screen.getByRole("option", { name: /outlook@example\.de/ })).toBeDisabled();
    expect(screen.getByText("Neu verbinden")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Step 6 — simplified layout, defaults, persistence, navigation
// ---------------------------------------------------------------------------

describe("Step 6 (simplified layout)", () => {
  it("layout order: shared template → companies and attachments → ONE global sending account", () => {
    setWs(makeWs());
    render(
      <I18nProvider>
        <Step6Email />
      </I18nProvider>,
    );
    const template = screen.getByRole("heading", { name: "Gemeinsame E-Mail-Vorlage" });
    const companies = screen.getByRole("heading", { name: "Unternehmen und Anhänge" });
    const account = accountButton();
    expect(template.compareDocumentPosition(companies) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(companies.compareDocumentPosition(account) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The sending-account label (the explicit reference wording) — exactly ONE:
    expect(screen.getAllByText("Versand-Konto (für alle E-Mails)").length).toBe(1);
    // AI draft button is still in the template section:
    expect(screen.getByRole("button", { name: "E-Mail-Entwurf (KI)" })).toBeInTheDocument();
  });

  it("NO recipient input anywhere in Step 6 — the shared-recipient override is gone, addresses are read-only", () => {
    setWs(makeWs());
    render(
      <I18nProvider>
        <Step6Email />
      </I18nProvider>,
    );
    // No editable e-mail input of any kind on the page:
    expect(document.querySelectorAll('input[type="email"]').length).toBe(0);
    // The shared-recipient field (label/hint/warning) no longer exists:
    expect(screen.queryByLabelText(/Gemeinsamer Empfänger/)).not.toBeInTheDocument();
    expect(screen.queryByText(/WARNUNG: Der gemeinsame Empfänger/)).not.toBeInTheDocument();
    // Each company's OWN verified address is shown as read-only text:
    expect(screen.getByText("jobs@kaltbau-nord.de")).toBeInTheDocument();
    expect(screen.getByText("bewerbung@tech-sued.de")).toBeInTheDocument();
  });

  it("pre-fills the DEFAULT subject; editor holds the default body; personalized preview renders", () => {
    setWs(
      makeWs({
        emailSettings: {
          body: AUTO_BEWERB_EMAIL_DEFAULT_BODY,
          recipient: "",
          subject: "",
          accountId: "acct1",
          attachCv: true,
          attachLetter: true,
        },
      }),
    );
    render(
      <I18nProvider>
        <Step6Email />
      </I18nProvider>,
    );
    // The subject is pre-filled with the concise default ({{company_name}}
    // kept as a token — personalized per recipient):
    const subjectInput = screen.getByLabelText(/Gemeinsamer Betreff/) as HTMLInputElement;
    expect(subjectInput.value).toBe(AUTO_BEWERB_EMAIL_DEFAULT_SUBJECT);

    // The editor holds the default body (tokens stay as editable tokens):
    const box = document.querySelector('[role="textbox"]') as HTMLElement;
    expect(box.innerHTML).toContain("Meine vollständigen Bewerbungsunterlagen");
    expect(box.innerHTML).toContain("{{candidate_name}}");

    // Live preview: personalized for the first company (candidate name +
    // company substituted from verified data):
    expect(screen.getByText("Mustapha Drif")).toBeInTheDocument();
    const previewSubjects = screen.getAllByText("Bewerbung um einen Ausbildungsplatz bei Kältebau Nord GmbH");
    expect(previewSubjects.length).toBeGreaterThanOrEqual(1);

    // The companies-and-attachments section is part of Step 6:
    expect(screen.getByText("Unternehmen und Anhänge")).toBeInTheDocument();
  });

  it("selecting a sending account persists immediately via the EXISTING settings action (saved values; the in-progress draft is NOT flushed)", async () => {
    vi.mocked(saveEmailSettingsAction).mockResolvedValue({ ok: true } as never);
    setWs(makeWs({ emailAccounts: [ACCT1, ACCT2] }));
    render(
      <I18nProvider>
        <Step6Email />
      </I18nProvider>,
    );
    // Start an UNSAVED body edit first (the draft must survive the account switch):
    const box = document.querySelector('[role="textbox"]') as HTMLElement;
    box.innerHTML = "<p>Mein ungespeicherter <strong>Entwurf</strong></p>";
    fireEvent.input(box);

    // Select the other account:
    fireEvent.click(accountButton());
    fireEvent.click(screen.getByRole("option", { name: /outlook@example\.de/ }));

    // Persisted through the existing mechanism with the SAVED field values:
    expect(saveEmailSettingsAction).toHaveBeenCalledTimes(1);
    expect(saveEmailSettingsAction).toHaveBeenCalledWith({
      body: AUTO_BEWERB_EMAIL_DEFAULT_BODY,
      recipient: "",
      subject: AUTO_BEWERB_EMAIL_DEFAULT_SUBJECT,
      accountId: "acct2",
      attachCv: true,
      attachLetter: true,
    });
    // The control now shows the newly selected account:
    expect(accountButton().textContent).toContain("outlook@example.de");
    // Success feedback (persist → refresh → toast, all async):
    await vi.waitFor(() => expect(lastCtx?.notify).toHaveBeenCalledWith("success", expect.any(String)));
  });

  it("a FAILED account persistence reverts the selection and reports the error", () => {
    vi.mocked(saveEmailSettingsAction).mockResolvedValue({ ok: false } as never);
    setWs(makeWs({ emailAccounts: [ACCT1, ACCT2] }));
    render(
      <I18nProvider>
        <Step6Email />
      </I18nProvider>,
    );
    fireEvent.click(accountButton());
    fireEvent.click(screen.getByRole("option", { name: /outlook@example\.de/ }));
    // Wait for the async revert:
    return vi.waitFor(() => {
      expect(accountButton().textContent).toContain("mail@example.de");
      expect(accountButton().textContent).not.toContain("outlook@example.de");
    }).then(() => {
      expect(lastCtx?.notify).toHaveBeenCalledWith("error", expect.any(String));
    });
  });

  it("no override warning is displayed — even with a STALE stored shared recipient (per-company routing only)", () => {
    // A stored settings row still carries an old shared-recipient value:
    setWs(
      makeWs({
        emailSettings: {
          body: AUTO_BEWERB_EMAIL_DEFAULT_BODY,
          recipient: "zentral@postbox.de",
          subject: AUTO_BEWERB_EMAIL_DEFAULT_SUBJECT,
          accountId: "acct1",
          attachCv: true,
          attachLetter: true,
        },
      }),
    );
    render(
      <I18nProvider>
        <Step6Email />
      </I18nProvider>,
    );
    // No override warning, no shared-recipient field, and the stale address
    // is never shown — the per-company verified recipients are displayed:
    expect(screen.queryByText(/WARNUNG: Der gemeinsame Empfänger/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Gemeinsamer Empfänger/)).not.toBeInTheDocument();
    expect(screen.queryByText("zentral@postbox.de")).not.toBeInTheDocument();
    expect(screen.getByText("jobs@kaltbau-nord.de")).toBeInTheDocument();
    expect(screen.getByText("bewerbung@tech-sued.de")).toBeInTheDocument();
  });

  it("a SAVED subject wins over the default; the editor keeps the saved body", () => {
    setWs(
      makeWs({
        emailTemplate: "<p>Mein gespeicherter <strong>Text</strong></p>",
        emailSettings: {
          body: "<p>Mein gespeicherter <strong>Text</strong></p>",
          recipient: "",
          subject: "Mein individueller Betreff",
          accountId: "acct1",
          attachCv: true,
          attachLetter: true,
        },
      }),
    );
    render(
      <I18nProvider>
        <Step6Email />
      </I18nProvider>,
    );
    const subjectInput = screen.getByLabelText(/Gemeinsamer Betreff/) as HTMLInputElement;
    expect(subjectInput.value).toBe("Mein individueller Betreff");
    const box = document.querySelector('[role="textbox"]') as HTMLElement;
    expect(box.innerHTML).toContain("Mein gespeicherter <strong>Text</strong>");
  });

  it("Back and Continue navigation are intact around the redesigned step", () => {
    const ws = makeWs();
    setWs(ws);
    // StepShell uses the REAL context hook (the mock only replaces the export
    // for other modules) — so the provider gets the full real context value:
    const fullCtx = {
      ...(lastCtx as object),
      toast: null,
      dismissToast: vi.fn(),
      syncing: false,
      companyId: null,
      selectCompany: vi.fn(),
      drafts: { cv: {}, letter: {} },
      setDraft: vi.fn(),
    };
    render(
      <I18nProvider>
        <AutoBewerbContext.Provider value={fullCtx as never}>
          <StepShell title="Schritt 6 · E-Mail vorbereiten" subtitle="…">
            <Step6Email />
          </StepShell>
        </AutoBewerbContext.Provider>
      </I18nProvider>,
    );
    expect(screen.getByRole("button", { name: /Zurück/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Weiter/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Zurück/ }));
    expect(lastCtx?.goToStep).toHaveBeenCalledWith(5);
    fireEvent.click(screen.getByRole("button", { name: /Weiter/ }));
    expect(lastCtx?.goToStep).toHaveBeenCalledWith(7);
  });
});
