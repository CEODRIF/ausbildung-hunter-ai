// @vitest-environment jsdom
/**
 * BEHAVIORAL tests — billing page active-plan display (`/settings/billing`).
 *
 * Renders the REAL server page component in jsdom with the service
 * boundary mocked (`getBillingStatus` / `getPaymentHistory` / session).
 * Pins the required display contract:
 *
 *  - an ACTIVE persisted row marks exactly ONE offer card, through the
 *    canonical mapping (plus → premium_10d, pro → premium_monthly,
 *    commercial ids → themselves) — never from client selection;
 *  - the active card is highlighted green, labeled as the user's active
 *    plan, shows the persisted start/end dates + remaining time, and its
 *    purchase button is replaced by a NON-purchasing "current plan" state;
 *  - every other card remains purchasable and is never marked active
 *    (canceled/expired rows mark none).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const holder = vi.hoisted(() => ({
  billing: null as unknown,
  history: {
    ok: true,
    history: {
      providerConfigured: true,
      onlinePayments: [] as unknown[],
      manualGrants: [] as unknown[],
    },
  } as unknown,
}));

vi.mock("@/lib/auth", () => ({
  getCurrentUserAndProfile: async () => ({
    user: {
      id: "a0000000-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      email: "a@test.invalid",
    },
    profile: { account_status: "active" },
  }),
}));
vi.mock("@/lib/i18n/server", async () => {
  const { dictionaries } = await import("@/lib/i18n/dictionaries");
  const t = (key: string, vars?: Record<string, unknown>): string => {
    let node: unknown = (dictionaries as Record<string, unknown>).en;
    for (const part of key.split(".")) {
      node = (node as Record<string, unknown> | undefined)?.[part];
    }
    if (typeof node !== "string") return key;
    return node.replace(/\{(\w+)\}/g, (m, n) => String(vars?.[n] ?? m));
  };
  return {
    getServerT: async () => t,
    getRequestLang: async () => "en" as const,
  };
});
vi.mock("@/lib/i18n", () => ({
  useI18n: () => ({ t: vi.fn((k: string) => k) }),
}));
vi.mock("@/lib/billing/entitlement-service", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  getBillingStatus: async () => holder.billing,
}));
vi.mock("@/lib/billing/payment-history", () => ({
  getPaymentHistory: async () => holder.history,
}));
vi.mock("@/app/settings/billing/actions", () => ({
  activateTrialAction: async () => ({ status: "idle" }),
}));

const Page = (await import("@/app/settings/billing/page")).default;
const { dictionaries } = await import("@/lib/i18n/dictionaries");
const { localeForLang } = await import("@/lib/i18n/core");

function t(key: string, vars?: Record<string, unknown>): string {
  let node: unknown = (dictionaries as Record<string, unknown>).en;
  for (const part of key.split(".")) {
    node = (node as Record<string, unknown> | undefined)?.[part];
  }
  if (typeof node !== "string") return key;
  return node.replace(/\{(\w+)\}/g, (m, n) => String(vars?.[n] ?? m));
}

const locale = localeForLang("en");
const fmt = (ms: number | null) =>
  ms !== null ? new Date(ms).toLocaleDateString(locale) : "—";

function billingSpec(
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    planId: "free",
    planLabel: "Free",
    rowPlanId: null,
    status: "none",
    provider: null,
    periodStartMs: null,
    periodEndMs: null,
    trialUsed: false,
    lookupFailed: false,
    mockPaymentsEnabled: false,
    aiPerDay: 0,
    emailsPerDay: 0,
    emailsUsedToday: 0,
    features: {},
    ...over,
  };
}

const DAY = 86_400_000;

function offerCard(title: string): Element {
  const h = screen.getByRole("heading", { name: title });
  const card = h.closest("div.flex.flex-col.p-5");
  if (!card) throw new Error(`offer card "${title}" not found`);
  return card;
}

async function renderBilling(spec: Record<string, unknown>) {
  holder.billing = spec;
  return render((await Page()) as React.ReactElement);
}

beforeEach(() => {
  holder.history = {
    ok: true,
    history: {
      providerConfigured: true,
      onlinePayments: [],
      manualGrants: [],
    },
  };
});
afterEach(() => cleanup());

// ---------------------------------------------------------------------------
// Task 1 — active-plan card state
// ---------------------------------------------------------------------------

describe("active plan — Plus (admin-granted row plan='plus')", () => {
  it("marks the Premium-10d card green with the active label, persisted dates, remaining time, and a non-purchasing current-plan state", async () => {
    const now = Date.now();
    await renderBilling(
      billingSpec({
        planId: "plus",
        planLabel: "Plus",
        rowPlanId: "plus",
        status: "active",
        provider: "manual",
        periodStartMs: now,
        // 10.5 days: stable "10 days left" across the render's clock ticks.
        periodEndMs: now + 10.5 * DAY,
      }),
    );

    const card = offerCard("Premium 10 Days");
    // Green active indicator (consistent with the existing success palette):
    expect(card.className).toContain("border-success");
    expect(card.className).toContain("ring-success");
    // Clear "your active plan" label:
    expect(card.textContent).toContain(t("billing.offers.yourActivePlan"));
    // Non-purchasing state: current-plan div, NO checkout link on this card:
    expect(card.querySelector('[aria-disabled="true"]')).not.toBeNull();
    expect(card.textContent).toContain(t("billing.offers.current"));
    expect(
      card.querySelector('a[href*="checkout?plan=premium_10d"]'),
    ).toBeNull();
    // Persisted start / end / remaining:
    expect(card.textContent).toContain(t("billing.currentPlan.periodStart"));
    expect(card.textContent).toContain(fmt(now));
    expect(card.textContent).toContain(t("billing.currentPlan.periodEnd"));
    expect(card.textContent).toContain(t("billing.offers.remaining"));
    expect(card.textContent).toContain("10 days left");

    // The other offers remain available and are NOT marked active:
    const monthly = offerCard("Premium Monthly");
    expect(monthly.className).not.toContain("border-success");
    expect(monthly.textContent).not.toContain(
      t("billing.offers.yourActivePlan"),
    );
    expect(
      monthly.querySelector('a[href*="checkout?plan=premium_monthly"]'),
    ).not.toBeNull();
    const trial = offerCard("Free for 3 Days");
    expect(trial.className).not.toContain("border-success");
    // Trial still unused → the activation CTA is offered (server re-checks):
    expect(trial.textContent).toContain("billing.trial.cta");
  });
});

describe("active plan — Pro (admin-granted row plan='pro')", () => {
  it("marks the Premium-Monthly card as the active plan; Premium-10d stays purchasable", async () => {
    const now = Date.now();
    await renderBilling(
      billingSpec({
        planId: "pro",
        planLabel: "Pro",
        rowPlanId: "pro",
        status: "active",
        provider: "manual",
        periodStartMs: now,
        periodEndMs: now + 30.5 * DAY,
      }),
    );

    const card = offerCard("Premium Monthly");
    expect(card.className).toContain("border-success");
    expect(card.textContent).toContain(t("billing.offers.yourActivePlan"));
    expect(
      card.querySelector('a[href*="checkout?plan=premium_monthly"]'),
    ).toBeNull();
    expect(card.textContent).toContain("30 days left");

    const ten = offerCard("Premium 10 Days");
    expect(ten.className).not.toContain("border-success");
    expect(
      ten.querySelector('a[href*="checkout?plan=premium_10d"]'),
    ).not.toBeNull();
  });
});

describe("active plan — commercial rows map to themselves", () => {
  it("row plan='premium_10d' marks exactly the Premium-10d card", async () => {
    const now = Date.now();
    await renderBilling(
      billingSpec({
        planId: "premium_10d",
        planLabel: "Premium 10 Days",
        rowPlanId: "premium_10d",
        status: "active",
        provider: "mock",
        periodStartMs: now,
        periodEndMs: now + 10.5 * DAY,
      }),
    );
    const card = offerCard("Premium 10 Days");
    expect(card.className).toContain("border-success");
    expect(card.textContent).toContain(t("billing.offers.yourActivePlan"));
    expect(offerCard("Premium Monthly").className).not.toContain(
      "border-success",
    );
  });

  it("an ACTIVE trial (5 h remaining) marks exactly the trial card, with hour-granularity remaining time and no CTA", async () => {
    const now = Date.now();
    await renderBilling(
      billingSpec({
        planId: "trial",
        planLabel: "Trial",
        rowPlanId: "trial",
        status: "active",
        provider: "manual",
        periodStartMs: now,
        periodEndMs: now + 5 * 3_600_000,
        trialUsed: true,
      }),
    );
    const card = offerCard("Free for 3 Days");
    expect(card.className).toContain("border-success");
    expect(card.textContent).toContain(t("billing.offers.yourActivePlan"));
    expect(card.textContent).toContain("5 hours left");
    // Active trial: the activation CTA is gone (isCurrent branch):
    expect(card.textContent).not.toContain("billing.trial.cta");
    expect(offerCard("Premium 10 Days").className).not.toContain(
      "border-success",
    );
  });
});

describe("no false active marks", () => {
  it("a CANCELED plus row marks no offer card as active (and keeps the offers purchasable)", async () => {
    const now = Date.now();
    await renderBilling(
      billingSpec({
        planId: "free",
        planLabel: "Plus",
        rowPlanId: "plus",
        status: "canceled",
        provider: "manual",
        periodStartMs: now - 30 * DAY,
        periodEndMs: now - 5 * DAY,
      }),
    );
    for (const title of [
      "Free for 3 Days",
      "Premium 10 Days",
      "Premium Monthly",
    ]) {
      const card = offerCard(title);
      expect(card.className, title).not.toContain("border-success");
      expect(card.textContent, title).not.toContain(
        t("billing.offers.yourActivePlan"),
      );
    }
  });

  it("an EXPIRED premium_10d row (computed expiry) marks no offer card", async () => {
    const now = Date.now();
    await renderBilling(
      billingSpec({
        planId: "free",
        planLabel: "Premium 10 Days",
        rowPlanId: "premium_10d",
        status: "expired",
        provider: "mock",
        periodStartMs: now - 20 * DAY,
        periodEndMs: now - 10 * DAY,
      }),
    );
    expect(offerCard("Premium 10 Days").className).not.toContain(
      "border-success",
    );
  });
});
