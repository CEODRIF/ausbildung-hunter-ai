/**
 * Send step — Refresh button on the scheduled-batch card (SSR smoke tests).
 *
 * The refresh icon in the scheduled-pending card's header re-reads the latest
 * persisted status (server action `bewRefreshSend`, which also lets the server
 * continue THIS campaign's queue once it is due — the same atomic claim core
 * the cron tick uses; nothing is ever sent before the due instant). This suite
 * pins the rendered surface:
 *
 *   - the button exists (aria-labelled, localized, enabled initially) ONLY in
 *     the scheduled-pending card, alongside the intact
 *     "Cancel remaining" / "Reschedule" actions;
 *   - the card renders the persisted instant, timezone and queued count;
 *   - every other state (immediate, not sending, already in-flight) renders
 *     NO refresh button — no surface drift;
 *   - all four locales carry the three new keys with non-empty values.
 *
 * Same pattern as the other component smoke tests in this repo:
 * renderToString + I18nProvider (SSR first paint = default language de).
 * No testing-library, no browser, no real e-mail.
 */
import { describe, expect, it, vi } from "vitest";
/* eslint-disable @typescript-eslint/no-explicit-any */

vi.mock("@/app/bewerbung-automation/actions", () => ({
  bewStartSend: vi.fn(async () => ({ ok: true })),
  bewRescheduleSend: vi.fn(async () => ({ ok: true })),
}));
vi.mock("next/link", async () => {
  const React = await import("react");
  return { default: (props: any) => React.createElement("a", props, props.children) };
});

const React = await import("react");
const { renderToString } = await import("react-dom/server");
const { I18nProvider } = await import("@/lib/i18n");
const { SendStep } = await import("@/components/bewerbung-automation/send-step");
const { dictionaries } = await import("@/lib/i18n/dictionaries");

const SCHEDULED = new Date(Date.now() + 30 * 60 * 1000).toISOString();

function renderSendStep(
  over: {
    sending?: boolean;
    startedAt?: string | null;
    scheduledAt?: string | null;
  } = {},
): string {
  const view: any = {
    campaign: {
      id: "c1",
      user_id: "user-1",
      email_account_id: "acct-1",
      purpose: "ausbildung",
      status: "sending",
      requested_count: 5,
      valid_count: 5,
      total_count: 5,
      generated_count: 5,
      sent_count: 0,
      failed_count: 0,
      excluded_count: 0,
      usage_date: new Date().toISOString().slice(0, 10),
      created_at: new Date().toISOString(),
      started_at: over.startedAt ?? null,
      completed_at: null,
      email_subject: "Bewerbung",
      email_body_html: "<p>Bewerbungsanfrage</p>",
      scheduled_at: over.scheduledAt === undefined ? SCHEDULED : over.scheduledAt,
      timezone: "Europe/Berlin",
    },
    applications: Array.from({ length: 5 }, (_, i) => ({
      id: `app-${i + 1}`,
      seq: i + 1,
      company_name: `Firma ${i + 1}`,
      contact_name: null,
      company_email: `hr@firma-${i + 1}.de`,
      company_address: null,
      subject: "",
      body_html: "<p>Bewerbung</p>",
      body_text: "Bewerbung",
      status: "queued",
      error_code: null,
      error_message: null,
      attempt_count: 0,
      provider_message_id: null,
      sent_at: null,
    })),
    documents: [
      {
        id: "cd-1", campaign_id: "c1", document_id: "d1", user_id: "user-1",
        kind: "cv", storage_path: "user-1/cv.pdf", filename: "cv.pdf",
        mime_type: "application/pdf", size_bytes: 100, created_at: new Date().toISOString(),
      },
      {
        id: "cd-2", campaign_id: "c1", document_id: "d2", user_id: "user-1",
        kind: "certificate", storage_path: "user-1/cert.pdf", filename: "cert.pdf",
        mime_type: "application/pdf", size_bytes: 100, created_at: new Date().toISOString(),
      },
    ],
    usage: { remaining: 45, daily_limit: 50 },
    senderEmail: "sender@example.de",
  };
  return renderToString(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(SendStep, {
        view,
        refresh: async () => undefined,
        pump: async () => true,
        selectedIds: new Set<string>(),
        onCancelSend: () => undefined,
        sending: over.sending ?? true,
      }),
    ),
  );
}

const REFRESH_ARIA = 'aria-label="Status aktualisieren"';

describe("scheduled-pending card: refresh button surface", () => {
  it("renders exactly ONE aria-labelled refresh button next to the title", () => {
    const html = renderSendStep();
    expect(html).toContain("Geplanter Versand");
    expect(html.match(new RegExp(REFRESH_ARIA, "g"))).toHaveLength(1);
  });

  it("the refresh button is enabled initially and is a real <button>", () => {
    const html = renderSendStep();
    const idx = html.indexOf(REFRESH_ARIA);
    expect(idx).toBeGreaterThan(-1);
    const button = html.slice(
      html.lastIndexOf("<button", idx),
      html.indexOf("</button>", idx) + "</button>".length,
    );
    // React renders a disabled boolean attribute as disabled="" — the
    // Tailwind "disabled:…" classes in the className string must not count.
    expect(button.includes("disabled=\"\"")).toBe(false);
  });

  it("keeps Cancel remaining + Reschedule intact and shows the persisted instant, zone and queued count", () => {
    const html = renderSendStep();
    expect(html).toContain("Verbleibende abbrechen");
    expect(html).toContain("Neu planen");
    expect(html).toContain("Europe/Berlin");
    expect(html).toContain("5 in Warteschlange");
  });
});

describe("every other state renders NO refresh button", () => {
  it("immediate send (no scheduled_at): no refresh button", () => {
    expect(renderSendStep({ scheduledAt: null })).not.toContain(REFRESH_ARIA);
  });

  it("not sending (pre-send trigger): no refresh button", () => {
    expect(renderSendStep({ sending: false })).not.toContain(REFRESH_ARIA);
  });

  it("schedule now due / in flight (started_at set): live progress panel, no refresh button", () => {
    const html = renderSendStep({ startedAt: new Date().toISOString() });
    expect(html).not.toContain(REFRESH_ARIA);
    expect(html).toContain("Versand läuft …");
  });
});

describe("i18n: refresh keys exist and are non-empty in all four locales", () => {
  it("de/en/fr/ar carry refreshStatus, refreshed and refreshFailed", () => {
    for (const lang of ["de", "en", "fr", "ar"] as const) {
      const bew = (dictionaries as any)[lang].bewauto;
      expect(bew.refreshStatus, `${lang}.refreshStatus`).toBeTruthy();
      expect(bew.refreshed, `${lang}.refreshed`).toBeTruthy();
      expect(bew.refreshFailed, `${lang}.refreshFailed`).toBeTruthy();
    }
    // Spot-check the actual rendered string (de first paint).
    expect(dictionaries.de.bewauto.refreshStatus).toBe("Status aktualisieren");
  });
});
