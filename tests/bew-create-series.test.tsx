// @vitest-environment jsdom
/**
 * Application Automation — first-series creation (bug fix, 2026-10-25).
 *
 * Root cause fixed: commit 0868839 removed the ONLY series-creation entry
 * point, so an eligible subscriber WITHOUT any series saw a dead-end
 * "no series" notice with no controls — and no way in the app to create a
 * first series (the bewCreateCampaign / bewCreateCampaignView server
 * actions were exported but referenced by no UI).
 *
 * Contract pinned here (real component, jsdom, mocked actions module):
 *   1. verified no-series state (successful query, no campaign) → the
 *      creation form renders (count / purpose / position + Start);
 *   2. a page LOAD never creates a series (zero action calls, zero
 *      navigation) — creation happens only on an explicit submit;
 *   3. a valid submit calls bewCreateCampaignView exactly once with the
 *      form values and shows the WIZARD of the returned, persisted view;
 *   4. a client-invalid count disables the submit and never calls the
 *      action (the server re-validates 1..100 regardless);
 *   5. a rejected create (server error) shows the localized, actionable
 *      error message and KEEPS the form — never a silent empty state;
 *   6. a FAILED initial load (DB/network) shows the actionable retry
 *      state — never the "no series" form and never a fake empty state;
 *      the retry re-runs the server component (router.refresh).
 *
 * Ownership/RLS, plan-gating (layout), entitlement gating (send path) and
 * create+persistence at the engine level are pinned by their existing
 * suites (security/authorization, plan-gate, R1 quota tests,
 * bew-wizard-navigation, bew-perf-roundtrips).
 */
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import React from "react";

/** Records every router navigation (a load-time navigation is a failure). */
const navCalls: string[] = [];

vi.mock("@/app/bewerbung-automation/actions", () => ({
  bewCancelSend: vi.fn(async () => ({ cancelled: 0 })),
  bewCreateCampaignView: vi.fn(),
  bewGetView: vi.fn(async () => null),
  bewRefreshSend: vi.fn(async () => null),
}));
vi.mock("next/navigation", () => ({
  redirect: () => {
    throw new Error("NEXT_REDIRECT");
  },
  useRouter: () => ({
    push: (to: string) => navCalls.push(`push:${to}`),
    replace: (to: string) => navCalls.push(`replace:${to}`),
    back: () => navCalls.push("back"),
    forward: () => navCalls.push("forward"),
    refresh: () => navCalls.push("refresh"),
    prefetch: () => {},
  }),
}));

const { bewCreateCampaignView } =
  await import("@/app/bewerbung-automation/actions");
const { I18nProvider } = await import("@/lib/i18n");
const { BewerbungAutomation } =
  await import("@/components/bewerbung-automation/client");

const TODAY = new Date().toISOString().slice(0, 10);
const USER = "user-1";

/** A fresh, PERSISTED view of the just-created campaign (server truth). */
function freshView(rows = 1) {
  const app = (seq: number) => ({
    id: `app-${seq}`,
    seq,
    company_name: "",
    contact_name: null,
    company_email: "",
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
  });
  return {
    campaign: {
      id: "c-new",
      user_id: USER,
      email_account_id: null,
      purpose: "ausbildung",
      status: "draft",
      requested_count: rows,
      valid_count: 0,
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
    applications: Array.from({ length: rows }, (_, i) => app(i + 1)),
    documents: [],
    usage: { remaining: 100, daily_limit: 100 },
    senderEmail: null,
  };
}

function renderNoSeries(
  createResult: unknown = freshView(1),
  initialLoadError = false,
) {
  const createMock = bewCreateCampaignView as unknown as ReturnType<
    typeof vi.fn
  >;
  createMock.mockReset();
  createMock.mockResolvedValueOnce(createResult);
  navCalls.length = 0;
  return render(
    <I18nProvider>
      <BewerbungAutomation
        schemaOk
        initialView={null}
        initialLoadError={initialLoadError}
        userName="Max"
        userEmail="max@example.com"
      />
    </I18nProvider>,
  );
}

afterEach(() => {
  cleanup();
  navCalls.length = 0;
});

describe("no-series state → the first-series creation form", () => {
  it("renders the form (count / purpose / position + Start), no wizard", async () => {
    renderNoSeries();
    // The form is present…
    expect(screen.getByLabelText(/Wie viele Bewerbungen/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Art der Bewerbung/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Serie starten" }),
    ).toBeInTheDocument();
    // …and the wizard is NOT (no current series to add companies to).
    expect(document.getElementById("bew-smart-input")).toBeNull();
  });

  it("a page load never creates a series and never navigates", async () => {
    const createMock = bewCreateCampaignView as unknown as ReturnType<
      typeof vi.fn
    >;
    renderNoSeries();
    expect(createMock).not.toHaveBeenCalled();
    expect(navCalls).toEqual([]);
  });
});

describe("submitting the form", () => {
  it("a valid submit creates the series once and shows the wizard", async () => {
    const createMock = bewCreateCampaignView as unknown as ReturnType<
      typeof vi.fn
    >;
    renderNoSeries();
    const count = screen.getByLabelText(
      /Wie viele Bewerbungen/,
    ) as HTMLInputElement;
    fireEvent.change(count, { target: { value: "5" } });
    const purpose = screen.getByLabelText(
      /Art der Bewerbung/,
    ) as HTMLSelectElement;
    fireEvent.change(purpose, { target: { value: "arbeit" } });
    fireEvent.change(screen.getByLabelText(/Bezeichnung der Stelle/), {
      target: { value: "Mechatroniker" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Serie starten" }));
    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    const fd = createMock.mock.calls[0][0] as FormData;
    expect(fd.get("count")).toBe("5");
    expect(fd.get("purpose")).toBe("arbeit");
    expect(fd.get("positionTitle")).toBe("Mechatroniker");
    // The returned, PERSISTED view is what the wizard now shows (the smart
    // input is mounted for the current series; the creation form is gone).
    await waitFor(() =>
      expect(document.getElementById("bew-smart-input")).not.toBeNull(),
    );
    expect(document.getElementById("bew-count")).toBeNull();
    expect(navCalls).toEqual([]);
  });

  it("a client-invalid count disables the submit and never calls the action", async () => {
    const createMock = bewCreateCampaignView as unknown as ReturnType<
      typeof vi.fn
    >;
    renderNoSeries();
    const count = screen.getByLabelText(
      /Wie viele Bewerbungen/,
    ) as HTMLInputElement;
    fireEvent.change(count, { target: { value: "0" } });
    const start = screen.getByRole("button", { name: "Serie starten" });
    expect(start).toBeDisabled();
    expect(
      screen.getByText("Bitte eine ganze Zahl zwischen 1 und 100 eingeben."),
    ).toBeInTheDocument();
    expect(createMock).not.toHaveBeenCalled();
  });

  it("a rejected create shows the actionable error and keeps the form (never a silent empty state)", async () => {
    const createMock = bewCreateCampaignView as unknown as ReturnType<
      typeof vi.fn
    >;
    createMock.mockReset();
    createMock.mockRejectedValueOnce(new Error("INVALID_PURPOSE"));
    navCalls.length = 0;
    render(
      <I18nProvider>
        <BewerbungAutomation
          schemaOk
          initialView={null}
          initialLoadError={false}
          userName="Max"
          userEmail="max@example.com"
        />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Serie starten" }));
    // Localized, actionable message for the exact server error code…
    await screen.findByText("Ungültiger Bewerbungstyp.");
    // …the form stays usable (no wizard, no navigation, no reset to a
    // "no series" dead end).
    expect(
      screen.getByRole("button", { name: "Serie starten" }),
    ).toBeInTheDocument();
    expect(document.getElementById("bew-smart-input")).toBeNull();
    expect(navCalls).toEqual([]);
  });
});

describe("a FAILED initial load is an error state, not an empty state", () => {
  it("shows the retry card (title + retry button), no form, no wizard", async () => {
    const createMock = bewCreateCampaignView as unknown as ReturnType<
      typeof vi.fn
    >;
    renderNoSeries(freshView(1), true);
    expect(
      screen.getByText("Deine Bewerbungsserie konnte nicht geladen werden"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Bitte prüfe deine Verbindung und versuche es erneut. Deine Daten sind nicht verloren.",
      ),
    ).toBeInTheDocument();
    // Never the creation form, never the wizard…
    expect(document.getElementById("bew-count")).toBeNull();
    expect(document.getElementById("bew-smart-input")).toBeNull();
    // …and nothing was created.
    expect(createMock).not.toHaveBeenCalled();
    // The retry re-runs the server component (a full RSC refresh)…
    fireEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }));
    expect(navCalls).toContain("refresh");
  });
});
