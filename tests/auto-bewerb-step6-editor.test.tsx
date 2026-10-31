// @vitest-environment jsdom
/**
 * AUTO BEWERB — Step 6 rich-text editor + attachment manifest (UI contract).
 *
 * Contract pinned here (real components, jsdom, German = the default language):
 *   1. the editor toolbar offers paragraph format / bold / italic / underline
 *      / alignment / bulleted + numbered lists / undo / redo / insert link
 *      and the FOUR token buttons (candidate, contact, company, greeting);
 *   2. every edit and every token insertion flows to onChange (persistence);
 *   3. the manifest renders the REAL filenames, the per-company document
 *      count and the batch-wide total; missing required documents warn and
 *      open the card by default; healthy cards are collapsed;
 *   4. Step 6 pre-fills the concise default subject + body, renders the
 *      personalized + sanitized live preview and the manifest section.
 */
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { I18nProvider } from "@/lib/i18n";
import { EmailRichEditor } from "@/components/auto-bewerb/email-rich-editor";
import { AttachmentManifest } from "@/components/auto-bewerb/attachment-manifest";
import { Step6Email } from "@/components/auto-bewerb/step6-email";
import {
  AUTO_BEWERB_EMAIL_DEFAULT_BODY,
  AUTO_BEWERB_EMAIL_DEFAULT_SUBJECT,
} from "@/lib/auto-bewerb/schema";

vi.mock("@/app/auto-bewerb/actions", () => ({
  saveEmailTemplateAction: vi.fn(),
  saveEmailSettingsAction: vi.fn(),
}));

/** Mutable fake workspace (per test) for the `useAutoBewerb` hook — the rest
 *  of the shared module (Note, SectionCard, companyLabel, statusPill) stays
 *  REAL so the rendered markup is the production markup. */
const wsHolder = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/components/auto-bewerb/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/auto-bewerb/shared")>();
  return { ...actual, useAutoBewerb: () => wsHolder.current };
});

const ts = "2026-12-01T00:00:00.000Z";

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
    emailAccounts: [{ id: "acct1", provider: "gmail", email: "mail@example.de", is_active: true, requires_reconnect: false }],
    candidateName: "Mustapha Drif",
    ...over,
  };
}

const setWs = (ws: unknown) => {
  wsHolder.current = { ws, refresh: vi.fn(), notify: vi.fn(), goToStep: vi.fn() };
};

// jsdom has no document.execCommand — a test-local stub so token insertion
// and formatting have a visible effect (appends the inserted text).
let origExecCommand: unknown;

afterEach(() => {
  cleanup();
  document.execCommand = origExecCommand as never;
});

// ---------------------------------------------------------------------------
// The rich-text editor
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
// The attachment manifest
// ---------------------------------------------------------------------------

describe("AttachmentManifest", () => {
  it("lists REAL filenames, per-company counts + batch total; missing docs warn (card open on issue)", () => {
    setWs(makeWs());
    render(
      <I18nProvider>
        <AttachmentManifest />
      </I18nProvider>,
    );
    // Section title + batch-wide total (c1: cv+letter+shared = 3, c2: letter+shared = 2):
    expect(screen.getByText("Unternehmen und zu sendende Dokumente")).toBeInTheDocument();
    expect(screen.getByText("5 Anhänge insgesamt")).toBeInTheDocument();

    // Healthy company (collapsed by default → filenames hidden):
    expect(screen.getByText("Kältebau Nord GmbH")).toBeInTheDocument();
    expect(screen.getByText("3 Dokumente")).toBeInTheDocument();
    expect(screen.queryByText("Lebenslauf_Mustapha_Drif.pdf")).not.toBeInTheDocument();
    // Its verified recipient + personalized subject are visible:
    expect(screen.getByText("jobs@kaltbau-nord.de")).toBeInTheDocument();

    // Company with a MISSING CV → the warning is visible and the card is
    // OPEN by default, showing the REAL filenames of what WILL be sent:
    expect(screen.getByText("Lebenslauf noch nicht erstellt")).toBeInTheDocument();
    expect(screen.getByText("2 Dokumente")).toBeInTheDocument();
    expect(screen.getByText("Anschreiben_Tech Süd AG.pdf")).toBeInTheDocument();
    expect(screen.getByText("Abiturzeugnis.pdf")).toBeInTheDocument();
    expect(screen.getByText("bewerbung@tech-sued.de")).toBeInTheDocument();

    // Expanding the healthy card reveals its exact per-company filenames:
    fireEvent.click(screen.getByRole("button", { name: /Kältebau Nord GmbH/ }));
    expect(screen.getByText("Lebenslauf_Mustapha_Drif.pdf")).toBeInTheDocument();
    expect(screen.getByText("Anschreiben_Kältebau Nord GmbH.pdf")).toBeInTheDocument();
  });

  it("shows no manifest for an empty series", () => {
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
// Step 6 — subject + body rendering, live preview, defaults
// ---------------------------------------------------------------------------

describe("Step 6 (subject + body rendering, live preview, defaults)", () => {
  it("pre-fills the concise DEFAULT subject when none is saved; renders the personalized, sanitized preview + manifest", () => {
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

    // The attachment manifest section is part of Step 6:
    expect(screen.getByText("Unternehmen und zu sendende Dokumente")).toBeInTheDocument();
  });

  it("a SET global recipient shows the explicit override warning (never silent)", () => {
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
    expect(screen.getByText(/WARNUNG: Der gemeinsame Empfänger ist gesetzt — alle 2 Bewerbungen werden an diese EINE Adresse gesendet/)).toBeInTheDocument();
  });

  it("an EMPTY global recipient shows no override warning (per-company routing is the default)", () => {
    setWs(makeWs());
    render(
      <I18nProvider>
        <Step6Email />
      </I18nProvider>,
    );
    expect(screen.queryByText(/WARNUNG: Der gemeinsame Empfänger ist gesetzt/)).not.toBeInTheDocument();
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
});
