/**
 * Application Automation — required UX (CRITICAL FIX, 2026-10-20).
 *
 * The "New series" action must be GONE from this page entirely: no three-dot
 * menu, no header button, no setup form, no hidden entry point — and opening
 * or refreshing the page must never create a series or navigate anywhere.
 *
 * The page is a pure guided workflow on the CURRENT series:
 *   paste company information / job ad → "Check information" (analysis +
 *   review, exactly which fields need attention) → "Confirm and add" (ONE
 *   row in the current series) → edit / delete rows → Documents → Letters
 *   → Review → Send. No manual row-count controls (Company target / Add rows
 *   stay removed).
 *
 * Pinned here (SSR first paint against the mocked actions module):
 *   A. no New series button, three-dot menu, setup form or any other
 *      series-creation entry point anywhere on the page (12-row, zero-row
 *      AND no-campaign renders),
 *   B. the Company target + Add rows controls are gone from step 1,
 *   C. the Smart Input with the "Check information" button is the primary
 *      entry point (the old "Auto-organize" one-shot is gone; the "Confirm
 *      and add" button does not exist before a check passes),
 *   D. opening / refreshing the page never creates a series and never
 *      navigates (zero create-action calls, zero router calls) for
 *      zero / one / twelve row campaigns,
 *   E. with NO campaign at all the page shows a neutral "no series" state —
 *      no creation controls, nothing created, no navigation,
 *   F. existing rows stay editable and deletable,
 *   G. static contract on client.tsx: no series-creation logic at all.
 */
import { describe, expect, it, vi } from "vitest";

/* eslint-disable @typescript-eslint/no-explicit-any */

const TODAY = new Date().toISOString().slice(0, 10);
const USER = "user-1";

/** Records every create+view action invocation (must stay 0 on load). */
const createCalls: number[] = [];
/** Records every router navigation (must stay 0 on load/refresh). */
const navCalls: string[] = [];

vi.doMock("@/app/bewerbung-automation/actions", () => ({
  bewCancelSend: vi.fn(async () => ({ cancelled: 0 })),
  bewCreateCampaignView: vi.fn(async () => {
    createCalls.push(1);
    return null;
  }),
  bewGetView: vi.fn(async () => null),
  bewRefreshSend: vi.fn(async () => null),
}));
vi.doMock("next/link", async () => {
  const React = await import("react");
  return { default: (props: any) => React.createElement("a", props, props.children) };
});
vi.mock("next/navigation", () => ({
  redirect: () => {
    throw new Error("NEXT_REDIRECT");
  },
  // The smart input (inside the wizard) calls useRouter() for the
  // expired-session /login navigation; stub it for the bare node SSR and
  // RECORD every call so a load-time navigation is a test failure.
  useRouter: () => ({
    push: (to: string) => navCalls.push(`push:${to}`),
    replace: (to: string) => navCalls.push(`replace:${to}`),
    back: () => navCalls.push("back"),
    forward: () => navCalls.push("forward"),
    refresh: () => {},
    prefetch: () => {},
  }),
}));

const React = await import("react");
const { renderToString } = await import("react-dom/server");
const { I18nProvider } = await import("@/lib/i18n");
const { BewerbungAutomation } = await import("@/components/bewerbung-automation/client");

function appRow(seq: number): any {
  return {
    id: `app-${seq}`,
    seq,
    company_name: `Company ${seq}`,
    contact_name: null,
    company_email: `hr@company-${seq}.de`,
    company_address: null,
    subject: "",
    body_html: "",
    body_text: "",
    status: "pending",
    error_code: null,
    error_message: null,
    attempt_count: 0,
    provider_message_id: null,
    sent_at: null,
  };
}

function renderWizard(rows: number | null): string {
  createCalls.length = 0;
  navCalls.length = 0;
  const view: any =
    rows === null
      ? null
      : {
          campaign: {
            id: "c1",
            user_id: USER,
            email_account_id: "acct-1",
            purpose: "ausbildung",
            status: "draft",
            requested_count: rows,
            valid_count: rows,
            total_count: rows,
            generated_count: 0,
            sent_count: 0,
            failed_count: 0,
            excluded_count: 0,
            usage_date: TODAY,
            created_at: new Date().toISOString(),
            started_at: null,
            completed_at: null,
          },
          applications: Array.from({ length: rows }, (_, i) => appRow(i + 1)),
          documents: [],
          usage: { remaining: 100, daily_limit: 100 },
          senderEmail: "sender@gmail.com",
        };
  return renderToString(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(BewerbungAutomation, {
        schemaOk: true,
        initialView: view,
        userName: "Max",
        userEmail: "max@example.com",
      }),
    ),
  );
}

/** The exact assertions that pin "no series-creation entry point". */
function expectNoSeriesCreation(html: string): void {
  // The three-dot menu (the previous implementation) is gone…
  expect(html).not.toContain('id="bew-series-menu"');
  expect(html).not.toContain("Serien-Optionen");
  // …and so is every visible "New series" label or creation state.
  expect(html).not.toContain("Neue Serie");
  expect(html).not.toContain("Serie wird erstellt");
  // The old setup form (count / purpose / position) and its Start
  // button are gone — no row-count entry point of any kind.
  expect(html).not.toContain("Serie starten");
  expect(html).not.toContain("Wie viele Bewerbungen möchtest du");
  expect(html).not.toContain("Art der Bewerbung");
  expect(html).not.toContain('id="bew-count"');
}

describe("A. New series is GONE — no button, no three-dot menu, no setup form", () => {
  it.each([
    [12, "12-row campaign"],
    [0, "zero-row campaign"],
  ])("renders no series-creation entry point on a %s (menu, button, form)", (rows) => {
    expectNoSeriesCreation(renderWizard(rows));
  });

  it("renders no series-creation entry point when there is no campaign at all", () => {
    expectNoSeriesCreation(renderWizard(null));
  });
});

describe("B. the removed row-count controls stay gone from step 1", () => {
  it("no Company target, no Add rows (12-row campaign)", () => {
    const html = renderWizard(12);
    expect(html).not.toContain("Unternehmens-Ziel");
    expect(html).not.toContain("Gewünschte Anzahl an Unternehmen");
    expect(html).not.toContain("Zeilen hinzufügen");
    expect(html).not.toContain("Anzahl der hinzuzufügenden Zeilen");
  });
});

describe("C. Smart Input + Check → Review → Confirm is the primary entry point", () => {
  it("the smart input and the 'Check information' button render BEFORE the company table", () => {
    const html = renderWizard(12);
    const smart = html.indexOf('id="bew-smart-input"');
    const preview = html.indexOf("Erkannte Informationen");
    const check = html.indexOf("Informationen prüfen");
    const table = html.indexOf("Firma</th>");
    expect(smart).toBeGreaterThan(-1);
    expect(preview).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(-1);
    expect(table).toBeGreaterThan(-1);
    expect(smart).toBeLessThan(table);
    expect(preview).toBeLessThan(table);
    expect(check).toBeLessThan(table);
  });

  it("the old one-shot 'Auto-organize' is gone and 'Confirm and add' does not exist before a check passes", () => {
    const html = renderWizard(12);
    expect(html).not.toContain("Automatisch organisieren");
    // The confirm button only appears AFTER a successful check (client
    // state) — it must not be part of the first paint.
    expect(html).not.toContain("Bestätigen und hinzufügen");
  });
});

describe("D. opening / refreshing the page never creates or navigates", () => {
  it.each([
    [0, "zero rows"],
    [1, "one row"],
    [12, "twelve rows"],
  ])("opens a %s campaign without creating a series or navigating", (rows) => {
    const html = renderWizard(rows);
    // The CURRENT campaign's data is on screen (the real total)…
    expect(html).toContain(`Alle: ${rows}`);
    // …and the smart input is available as the primary entry point.
    expect(html).toContain('id="bew-smart-input"');
    // The first paint created nothing (no series-creation action)…
    expect(createCalls).toHaveLength(0);
    // …and navigated nowhere (no redirect to another series or page).
    expect(navCalls).toEqual([]);
  });

  it("shows the useful empty state when the series has zero companies", () => {
    const html = renderWizard(0);
    expect(html).toContain("Keine Einträge mehr vorhanden.");
    expect(html).toContain('id="bew-smart-input"');
  });
});

describe("E. no campaign at all → a neutral no-series state (nothing created)", () => {
  it("shows the no-series notice without any creation controls, calls or navigation", () => {
    const html = renderWizard(null);
    expect(html).toContain("Keine Bewerbungsserie vorhanden");
    expect(html).toContain("Aktuell ist keine Bewerbungsserie vorhanden");
    // No wizard, no smart input (there is no current series to add to),
    // no setup form, no hidden menu.
    expect(html).not.toContain('id="bew-smart-input"');
    expect(html).not.toContain('id="bew-series-menu"');
    expect(html).not.toContain("Neue Serie");
    expect(html).not.toContain("Serie starten");
    expect(html).not.toContain("Wie viele Bewerbungen möchtest du");
    // Nothing was created or navigated by rendering the page.
    expect(createCalls).toHaveLength(0);
    expect(navCalls).toEqual([]);
  });
});

describe("F. existing rows stay editable and deletable", () => {
  it("the company table renders editable inputs and the safe per-row delete", () => {
    const html = renderWizard(2);
    // Editable fields (value + input) for each existing row…
    expect(html).toContain("Company 1");
    expect(html).toContain('value="hr@company-1.de"');
    expect(html).toContain("Company 2");
    // …and the existing safe deletion flow (addresses ONE row by seq).
    expect(html).toContain("Firmenzeile 1 löschen");
    expect(html).toContain("Firmenzeile 2 löschen");
    // The step-1→2 wizard footer is intact.
    expect(html).toContain("Zu den Dokumenten");
  });
});

describe("G. static contract on client.tsx: no series creation at all", () => {
  it("the client imports no creation action and contains no creation logic or menu", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(
      join(process.cwd(), "src/components/bewerbung-automation/client.tsx"),
      "utf8",
    );
    // No creation entry point in any form: not a button, not a menu, not a
    // setup form, not a hidden overflow item.
    expect(src).not.toContain("startNewSeries");
    expect(src).not.toContain("bewCreateCampaignView");
    expect(src).not.toContain("bewCreateCampaign");
    expect(src).not.toContain("buildPendingView");
    expect(src).not.toContain("bew-series-menu");
    expect(src).not.toContain("seriesMenuAria");
    expect(src).not.toContain("newCampaign");
    expect(src).not.toContain("setupStart");
    // The no-series state is a notice, not a form.
    expect(src).toContain("noSeriesTitle");
    expect(src).toContain("noSeriesBody");
    // The step keeps its defensive guards — inert (always false/null) on
    // this page.
    expect(src).toContain("creatingSeries={false}");
    expect(src).toContain("seriesConfirmation={null}");
  });
});
