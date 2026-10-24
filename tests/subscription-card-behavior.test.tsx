// @vitest-environment jsdom
/**
 * BEHAVIORAL render tests for the dashboard SubscriptionCard (the real
 * component, real German dictionary, jsdom). Proves by rendered output:
 *
 *   - every state (none / active / canceled / expired / lookupFailed)
 *     renders safely and distinctly;
 *   - historical labels (canceled pro, expired premium_10d) show the plan
 *     identity WITHOUT any "active/entitled" signal — the lapsed hint
 *     (free-plan limits apply) is rendered;
 *   - the lookup-failure state renders the explicit no-entitlement notice;
 *   - the card links to /settings/billing and labels the mock provider as
 *     a demo.
 *
 * The card holds no entitlement logic (display-only) — access decisions
 * remain exclusively in the entitlement service (pinned elsewhere).
 */
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const { dictionaries } = await import("@/lib/i18n/dictionaries");

const makeT = () => (key: string, params?: Record<string, unknown>) => {
  let cur: unknown = dictionaries.de;
  for (const part of key.split(".")) {
    cur = (cur as Record<string, unknown> | undefined)?.[part];
  }
  let s = typeof cur === "string" ? cur : key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.split(`{${k}}`).join(String(v));
    }
  }
  return s;
};

const { SubscriptionCard } = await import("@/components/dashboard-content");

import type { DashboardSubscription } from "@/lib/dashboard";

const t = makeT();
const START = Date.parse("2026-10-01T00:00:00.000Z");
const END = Date.parse("2026-11-01T00:00:00.000Z");

const sub = (over: Partial<DashboardSubscription>): DashboardSubscription => ({
  planLabel: "Free",
  status: "none",
  provider: null,
  periodStartMs: null,
  periodEndMs: null,
  lookupFailed: false,
  ...over,
});

afterEach(cleanup);

describe("SubscriptionCard — rendered states (behavioral)", () => {
  it("no subscription: 'Free' + 'Kein Abonnement' + none-hint, no dates", () => {
    render(<SubscriptionCard subscription={sub({})} t={t} locale="de" />);
    expect(screen.getByText("Free")).toBeInTheDocument();
    expect(screen.getByText("Kein Abonnement")).toBeInTheDocument();
    expect(screen.getByText(/Free-Plan-Limits aktiv/)).toBeInTheDocument();
    expect(screen.queryByText(/Verlängern/i)).not.toBeInTheDocument();
  });

  it("active premium_monthly: label + 'Aktiv' + both dates + demo provider", () => {
    render(
      <SubscriptionCard
        subscription={sub({
          planLabel: "Premium Monthly",
          status: "active",
          provider: "mock",
          periodStartMs: START,
          periodEndMs: END,
        })}
        t={t}
        locale="de"
      />,
    );
    expect(screen.getByText("Premium Monthly")).toBeInTheDocument();
    expect(screen.getByText("Aktiv")).toBeInTheDocument();
    // Intl "de" short-month rendering of the two period boundaries
    // (\s also tolerates a no-break space across ICU builds):
    expect(screen.getByText(/1\.\sOkt\./)).toBeInTheDocument();
    expect(screen.getByText(/1\.\sNov\./)).toBeInTheDocument();
    // mock provider must be labeled as a demo, never as a real provider:
    expect(screen.getByText("Demo (simuliert)")).toBeInTheDocument();
    // no lapsed/none hints in the active state:
    expect(screen.queryByText(/Free-Plan-Limits/)).not.toBeInTheDocument();
  });

  it("CANCELED pro: historical label 'Pro' + 'Gekündigt' + lapsed hint, never 'Aktiv'", () => {
    render(
      <SubscriptionCard
        subscription={sub({
          planLabel: "Pro",
          status: "canceled",
          provider: "manual",
          periodStartMs: START,
          periodEndMs: END,
        })}
        t={t}
        locale="de"
      />,
    );
    expect(screen.getByText("Pro")).toBeInTheDocument();
    expect(screen.getByText("Gekündigt")).toBeInTheDocument();
    expect(screen.getByText(/Free-Plan-Limits gelten/)).toBeInTheDocument();
    expect(screen.queryByText("Aktiv")).not.toBeInTheDocument();
  });

  it("EXPIRED premium_10d: historical label + 'Abgelaufen' + lapsed hint", () => {
    render(
      <SubscriptionCard
        subscription={sub({
          planLabel: "Premium 10 Days",
          status: "expired",
          provider: "mock",
          periodStartMs: START,
          periodEndMs: END,
        })}
        t={t}
        locale="de"
      />,
    );
    expect(screen.getByText("Premium 10 Days")).toBeInTheDocument();
    expect(screen.getByText("Abgelaufen")).toBeInTheDocument();
    expect(screen.getByText(/Free-Plan-Limits gelten/)).toBeInTheDocument();
    expect(screen.queryByText("Aktiv")).not.toBeInTheDocument();
  });

  it("lookup failure: explicit no-entitlement notice, no plan/status/date rendered", () => {
    render(
      <SubscriptionCard
        subscription={sub({ status: "none", lookupFailed: true })}
        t={t}
        locale="de"
      />,
    );
    expect(
      screen.getByText(/keine kostenpflichtigen Berechtigungen erteilt/i),
    ).toBeInTheDocument();
    expect(screen.queryByText("Aktiv")).not.toBeInTheDocument();
    expect(screen.queryByText("Kein Abonnement")).not.toBeInTheDocument();
  });

  it("links to /settings/billing for management", () => {
    render(<SubscriptionCard subscription={sub({})} t={t} locale="de" />);
    const link = screen.getByRole("link", { name: "Verwalten" });
    expect(link).toHaveAttribute("href", "/settings/billing");
  });
});
