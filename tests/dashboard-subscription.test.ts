/**
 * Dashboard subscription card — display-only subscription summary.
 *
 * Pinned contract:
 *   1. displayPlanLabel (runtime): the persisted row's plan identity is
 *      shown in EVERY state where a row exists (canceled/expired keep their
 *      historical name), while the entitlement plane (planId/planRow) stays
 *      on the fail-closed 'free' fallback — a historical label must never
 *      grant paid limits.
 *   2. Dashboard data (source): the summary comes from resolveSubscription
 *      in its own try/catch; ANY failure yields null (card omitted — the
 *      dashboard never guesses a billing state).
 *   3. Card rendering (source): conditional on non-null; links to
 *      /settings/billing; reuses the billing.currentPlan.* status
 *      vocabulary; lapsed/none hints; lookupFailed shows the explicit
 *      no-entitlement notice.
 *   4. Shell nav (source): /settings/billing is a first-class account nav
 *      entry (nav.billing).
 *   5. i18n (runtime): nav.billing + dash.subscription exist in all four
 *      languages with identical key sets (drift = t() returning the path).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({
  admin: null as unknown,
  user: null as unknown,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => holder.admin,
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => holder.user,
}));

const { displayPlanLabel, resolveSubscription } = await import(
  "@/lib/billing/entitlement-service"
);
const { dictionaries, SUPPORTED_LANGUAGES } = await import(
  "@/lib/i18n/dictionaries"
);

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (relative: string) => readFileSync(resolve(root, relative), "utf8");

const DASH_LIB = read("src/lib/dashboard.ts");
const DASH_CARD = read("src/components/dashboard-content.tsx");
const APP_SHELL = read("src/components/app-shell.tsx");

// ---------------------------------------------------------------------------
// Minimal admin-client mock (subscriptions + billing_plans only)
// ---------------------------------------------------------------------------

function installAdmin(
  subRow: Record<string, unknown> | null,
  planRow: Record<string, unknown> | null,
) {
  holder.admin = {
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        maybeSingle: async () => {
          const row = table === "subscriptions" ? subRow : planRow;
          return { data: row, error: null };
        },
      };
      return chain;
    },
    rpc: async () => ({ data: { used: 0, resets_at: null }, error: null }),
  };
  holder.user = null;
}

const NOW = Date.parse("2026-10-15T12:00:00.000Z");

// ---------------------------------------------------------------------------
// 1. displayPlanLabel — display plane vs entitlement plane
// ---------------------------------------------------------------------------

describe("displayPlanLabel — historical identity without entitlements", () => {
  it("no row → 'Free' (both planes agree)", async () => {
    installAdmin(null, null);
    const sub = await resolveSubscription(
      "11111111-1111-4111-8111-411111111111",
      NOW,
    );
    expect(displayPlanLabel(sub)).toBe("Free");
    expect(sub.planId).toBe("free");
  });

  it("canceled pro row → label keeps 'Pro', entitlement stays free", async () => {
    installAdmin(
      {
        plan: "pro",
        status: "canceled",
        provider: "manual",
        current_period_start: "2026-09-01T00:00:00.000Z",
        current_period_end: "2026-10-01T00:00:00.000Z",
        canceled_at: "2026-09-20T00:00:00.000Z",
        trial_activated_at: null,
      },
      null,
    );
    const sub = await resolveSubscription(
      "11111111-1111-4111-8111-411111111111",
      NOW,
    );
    expect(displayPlanLabel(sub)).toBe("Pro");
    // Entitlement plane untouched by the display label:
    expect(sub.planId).toBe("free");
    expect(sub.planRow).toBeNull();
    expect(sub.status).toBe("canceled");
  });

  it("computed-expired premium_monthly row → label keeps the plan, planId free", async () => {
    installAdmin(
      {
        plan: "premium_monthly",
        status: "active",
        provider: "mock",
        current_period_start: "2026-09-15T00:00:00.000Z",
        current_period_end: "2026-10-15T00:00:00.000Z",
        canceled_at: null,
        trial_activated_at: null,
      },
      null,
    );
    const sub = await resolveSubscription(
      "11111111-1111-4111-8111-411111111111",
      NOW,
    );
    expect(sub.status).toBe("expired");
    expect(displayPlanLabel(sub)).toBe("Premium Monthly");
    expect(sub.planId).toBe("free");
    expect(sub.planRow).toBeNull();
  });

  it("active pro row with plan catalog → 'Pro' on both planes", async () => {
    installAdmin(
      {
        plan: "pro",
        status: "active",
        provider: "manual",
        current_period_start: "2026-10-01T00:00:00.000Z",
        current_period_end: "2026-11-01T00:00:00.000Z",
        canceled_at: null,
        trial_activated_at: null,
      },
      {
        plan_id: "pro",
        emails_per_day: 500,
        ai_requests_per_day: 1500,
        price_cents: 0,
        duration_kind: "none",
        duration_value: 0,
        is_commercial: false,
        feature_limits: null,
      },
    );
    const sub = await resolveSubscription(
      "11111111-1111-4111-8111-411111111111",
      NOW,
    );
    expect(displayPlanLabel(sub)).toBe("Pro");
    expect(sub.planId).toBe("pro");
  });
});

// ---------------------------------------------------------------------------
// 2. Dashboard data — server-derived, fail-soft to null
// ---------------------------------------------------------------------------

describe("dashboard data — subscription summary (source contract)", () => {
  it("resolves the subscription server-side from the session user id", () => {
    expect(DASH_LIB).toContain("resolveSubscription");
    expect(DASH_LIB).toContain("displayPlanLabel");
    expect(DASH_LIB).toContain("resolveSubscription(userId)");
  });

  it("is display-only and fail-soft: any failure yields null (card omitted)", () => {
    expect(DASH_LIB).toContain("let subscription: DashboardSubscription | null = null;");
    expect(DASH_LIB).toContain("subscription = null;");
    expect(DASH_LIB).toContain("subscription,");
  });

  it("carries the summary on the DashboardData type", () => {
    expect(DASH_LIB).toContain("subscription: DashboardSubscription | null;");
  });
});

// ---------------------------------------------------------------------------
// 3. Dashboard card — conditional, linked, state-aware
// ---------------------------------------------------------------------------

describe("dashboard subscription card (source contract)", () => {
  it("renders only when the summary resolved (no guessed billing state)", () => {
    expect(DASH_CARD).toContain("{subscription && (");
    expect(DASH_CARD).toContain("<SubscriptionCard subscription={subscription}");
  });

  it("links to /settings/billing for management", () => {
    expect(DASH_CARD).toContain('href="/settings/billing"');
    expect(DASH_CARD).toContain('t("dash.subscription.manage")');
  });

  it("reuses the billing.currentPlan status vocabulary for all states", () => {
    expect(DASH_CARD).toContain('"statusActive"');
    expect(DASH_CARD).toContain('"statusCanceled"');
    expect(DASH_CARD).toContain('"statusExpired"');
    expect(DASH_CARD).toContain('"statusNone"');
    expect(DASH_CARD).toContain("billing.currentPlan.${statusKey}");
  });

  it("explains lapsed and missing states; lookup failure says no entitlements", () => {
    expect(DASH_CARD).toContain('t("dash.subscription.none")');
    expect(DASH_CARD).toContain('t("dash.subscription.lapsed")');
    expect(DASH_CARD).toContain('t("billing.currentPlan.lookupFailed")');
  });
});

// ---------------------------------------------------------------------------
// 4. Shell navigation — billing is a first-class account entry
// ---------------------------------------------------------------------------

describe("app shell nav — billing entry", () => {
  it("nav.billing points to /settings/billing", () => {
    expect(APP_SHELL).toContain('labelKey: "nav.billing"');
    expect(APP_SHELL).toContain('href: "/settings/billing"');
  });
});

// ---------------------------------------------------------------------------
// 5. i18n — 4-language parity for the new keys
// ---------------------------------------------------------------------------

describe("i18n — nav.billing + dash.subscription parity", () => {
  it("nav.billing is a non-empty string in every language", () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      const value = (dictionaries[lang].nav as Record<string, string>)["billing"];
      expect(value).toBeTypeOf("string");
      expect(value?.trim()).not.toHaveLength(0);
    }
  });

  it("dash.subscription has de's exact key set, non-empty values, everywhere", () => {
    const deKeys = Object.keys(
      (dictionaries.de.dash as Record<string, unknown>)["subscription"] as object,
    ).sort();
    expect(deKeys).toEqual(["lapsed", "manage", "none", "title"]);
    for (const lang of SUPPORTED_LANGUAGES) {
      const section = (
        dictionaries[lang].dash as Record<string, unknown>
      )["subscription"] as Record<string, string>;
      expect(Object.keys(section).sort()).toEqual(deKeys);
      for (const key of deKeys) {
        expect(section[key]).toBeTypeOf("string");
        expect(section[key]?.trim()).not.toHaveLength(0);
      }
    }
  });
});
