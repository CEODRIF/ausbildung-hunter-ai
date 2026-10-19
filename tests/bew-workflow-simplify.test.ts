/**
 * Application Automation — simplified guided workflow (smart input first).
 *
 * The initial view no longer offers the "Company target" and "Add rows"
 * controls, and "New series" is no longer the prominent header button —
 * the creation is a deliberate SECONDARY action inside a small menu. The
 * primary entry point on step 1 is the Smart Input (paste →
 * Auto-organize → editable row), and the page always opens in the CURRENT
 * series without creating or switching anything on load.
 *
 * Pinned here (SSR first paint against the mocked actions module):
 *   A. the series menu exists and the new-series action is reachable ONLY
 *      through it (no prominent header button anywhere else),
 *   B. the Company target + Add rows controls are gone from step 1,
 *   C. the Smart Input + live preview render on first paint BEFORE the
 *      company table (the visual focus),
 *   D. zero/one/multiple-row campaigns all open in the current series —
 *      the create action is never called during the first paint, no
 *      navigation is triggered, and the empty state stays useful.
 */
import { describe, expect, it, vi } from "vitest";

/* eslint-disable @typescript-eslint/no-explicit-any */

const TODAY = new Date().toISOString().slice(0, 10);
const USER = "user-1";

/** Records every create+view action invocation (must stay 0 on load). */
const createCalls: number[] = [];

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
  // expired-session /login navigation; stub it for the bare node SSR.
  useRouter: () => ({
    push: () => {},
    replace: () => {},
    back: () => {},
    forward: () => {},
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

function renderWizard(rows: number): string {
  const view: any = {
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

describe("A. New series is a deliberate secondary menu item", () => {
  it("renders the series menu with the creation inside it — and no other new-series button", () => {
    const html = renderWizard(12);
    // The menu trigger (icon-only, accessible label + title).
    expect(html).toContain('id="bew-series-menu"');
    expect(html).toContain("Serien-Optionen");
    // The creation action exists — inside the menu…
    const detailsIdx = html.indexOf("<details");
    const menuItemIdx = html.indexOf("Neue Serie</button>");
    expect(detailsIdx).toBeGreaterThan(-1);
    expect(menuItemIdx).toBeGreaterThan(detailsIdx);
    // …and it is the ONLY "Neue Serie" on the page (the old prominent
    // header button is gone — nothing named that appears before the menu).
    expect(html.indexOf("Neue Serie")).toBe(menuItemIdx);
    expect(html.indexOf("Neue Serie</button>", menuItemIdx + 1)).toBe(-1);
  });
});

describe("B. the removed controls are gone from step 1", () => {
  it("no Company target, no Add rows (12-row campaign)", () => {
    const html = renderWizard(12);
    expect(html).not.toContain("Unternehmens-Ziel");
    expect(html).not.toContain("Gewünschte Anzahl an Unternehmen");
    expect(html).not.toContain("Zeilen hinzufügen");
    expect(html).not.toContain("Anzahl der hinzuzufügenden Zeilen");
  });
});

describe("C. Smart Input is the primary entry point on first paint", () => {
  it("the smart input + live preview render BEFORE the company table", () => {
    const html = renderWizard(12);
    const smart = html.indexOf('id="bew-smart-input"');
    const preview = html.indexOf("Erkannte Informationen");
    const table = html.indexOf("Firma</th>");
    expect(smart).toBeGreaterThan(-1);
    expect(preview).toBeGreaterThan(-1);
    expect(table).toBeGreaterThan(-1);
    // The paste field and its detected-information preview are the visual
    // focus; the existing entries stay visible BELOW them.
    expect(smart).toBeLessThan(table);
    expect(preview).toBeLessThan(table);
  });
});

describe("D. the page opens in the current series — nothing created on load", () => {
  it.each([
    [0, "zero rows"],
    [1, "one row"],
    [12, "twelve rows"],
  ])("opens a %s campaign without creating a series or navigating", (rows) => {
    createCalls.length = 0;
    const html = renderWizard(rows);
    // The CURRENT campaign's data is on screen (the real total)…
    expect(html).toContain(`Alle: ${rows}`);
    // …and the smart input is available as the primary entry point.
    expect(html).toContain('id="bew-smart-input"');
    // The first paint created nothing (no series-creation action)…
    expect(createCalls).toHaveLength(0);
  });

  it("shows the useful empty state when the series has zero companies", () => {
    const html = renderWizard(0);
    expect(html).toContain("Keine Einträge mehr vorhanden.");
    expect(html).toContain('id="bew-smart-input"');
  });
});
