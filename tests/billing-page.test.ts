/**
 * Billing UI behavior tests — `/settings/billing` (page, server actions,
 * trial form, loading state, success page) + 4-language dictionary parity.
 *
 * The sandbox has no Supabase, so these tests pin the BEHAVIORAL CONTRACT
 * at two levels:
 *
 * 1. Source contracts (readFileSync) — the security model of the billing
 *    surface is structural, so it is asserted on the source text:
 *    - the page is fully SERVER-derived (`getBillingStatus(user.id)` in a
 *      try/catch that fails CLOSED to a degraded error card while the
 *      static offer list stays visible);
 *    - offer cards come only from the typed catalogue
 *      (`COMMERCIAL_PLAN_IDS` / `COMMERCIAL_PLANS` / `plan.priceCents`) —
 *      the page accepts no searchParams/formData, so price, duration, and
 *      limits can never be client-supplied;
 *    - the server actions resolve identity ONLY from the server session
 *      (`supabase.auth.getUser()`); the only formData fields are intents
 *      (plan_id, idempotency_key, checkout_id, outcome) — never a user
 *      identity; actions never touch a table directly (no `.from(`) —
 *      all decisions live in the service facades;
 *    - the trial form submits intent only (no inputs, no identity);
 *    - the checkout SUCCESS page is read-only: visiting the URL with an
 *      arbitrary or guessed checkout id shows a panel — it never calls
 *      `completeMockCheckout` and never writes any row, so a success
 *      link alone grants nothing.
 *
 * 2. Runtime dictionary parity — all four languages (de/en/fr/ar) must
 *    carry the SAME key sets for every billing section (drift = runtime
 *    `t()` returning the key path instead of text), all values non-empty,
 *    the interpolation placeholders (`{hours}`, `{days}`, `{used}`,
 *    `{limit}`) present, and `billing.featureNames` covering every
 *    `ALL_FEATURE_IDS` entry.
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

const { dictionaries, SUPPORTED_LANGUAGES } =
  await import("@/lib/i18n/dictionaries");
const { ALL_FEATURE_IDS } = await import("@/lib/billing/entitlement-service");

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (relative: string) =>
  readFileSync(resolve(root, relative), "utf8");

const PAGE = read("src/app/settings/billing/page.tsx");
const ACTIONS = read("src/app/settings/billing/actions.ts");
const TRIAL_FORM = read("src/app/settings/billing/trial-activation-form.tsx");
const LOADING = read("src/app/settings/billing/loading.tsx");
const SUCCESS_PAGE = read("src/app/settings/billing/checkout/success/page.tsx");

// ---------------------------------------------------------------------------
// Page: server-derived billing status (fail closed)
// ---------------------------------------------------------------------------

describe("billing page — server-derived status", () => {
  it("derives the billing status server-side with one lookup", () => {
    expect(PAGE).toContain("getBillingStatus(user.id)");
  });

  it("is force-dynamic and redirects unauthenticated/locked users to /login", () => {
    expect(PAGE).toContain('export const dynamic = "force-dynamic"');
    expect(PAGE).toContain('redirect("/login")');
  });

  it("fails closed on lookup errors: degraded card, offers stay visible", () => {
    // getBillingStatus is wrapped in try/catch → billing = null (degraded)
    expect(PAGE).toContain("billing = null");
    // The degraded view renders the localized error card with a retry link.
    expect(PAGE).toContain('t("billing.offers.errorTitle")');
    expect(PAGE).toContain('t("billing.offers.errorBody")');
    expect(PAGE).toContain('t("billing.offers.retry")');
    // A per-user lookup that cannot be verified must say so explicitly
    // (no paid entitlements are presented while it fails).
    expect(PAGE).toContain("billing.lookupFailed ?");
    expect(PAGE).toContain('t("billing.currentPlan.lookupFailed")');
  });
});

// ---------------------------------------------------------------------------
// Page: offers from the typed catalogue only
// ---------------------------------------------------------------------------

describe("billing page — offer cards", () => {
  it("builds offer cards exclusively from the typed plan catalogue", () => {
    expect(PAGE).toContain("COMMERCIAL_PLAN_IDS.map((planId)");
    expect(PAGE).toContain("COMMERCIAL_PLANS[planId]");
    // Price is formatted from the catalogue's cents value — never from a
    // client-supplied source.
    expect(PAGE).toContain("plan.priceCents");
    expect(PAGE).toContain("billing.offers.freePrice");
  });

  it("accepts no client input of any kind (no searchParams, no formData)", () => {
    expect(PAGE).not.toContain("searchParams");
    expect(PAGE).not.toContain("formData");
  });

  it("shows usage rows for every feature id with quota-kind semantics", () => {
    expect(PAGE).toContain("ALL_FEATURE_IDS");
    expect(PAGE).toContain("FEATURE_QUOTA_KIND");
    // No-limit, disabled, and per-day/per-expiry reset labels all wired.
    expect(PAGE).toContain('t("billing.usage.noLimit")');
    expect(PAGE).toContain('t("billing.usage.disabled")');
    expect(PAGE).toContain("billing.usage.${resetKey}");
    expect(PAGE).toContain('t("billing.usage.usedOf"');
    expect(PAGE).toContain('t("billing.usage.remaining")');
  });

  it("routes trial + upgrades through the server flow", () => {
    expect(PAGE).toContain("<TrialActivationForm />");
    // Upgrade CTA links carry only a plan id — the checkout page re-resolves
    // the plan against the catalogue server-side.
    expect(PAGE).toContain("checkout?plan=");
  });

  it("flags mock payments via server state, not a client flag", () => {
    expect(PAGE).toContain("billing.mockPaymentsEnabled ?");
    expect(PAGE).toContain('t("billing.checkout.demoBanner")');
    expect(PAGE).toContain('t("billing.checkout.inertNotice")');
  });

  it("does not render its own <main> (layout owns the document shell)", () => {
    expect(PAGE).not.toContain("<main");
  });
});

// ---------------------------------------------------------------------------
// Server actions: identity from the session only
// ---------------------------------------------------------------------------

describe("billing server actions", () => {
  it('is a "use server" module', () => {
    expect(ACTIONS.trimStart().startsWith('"use server"')).toBe(true);
  });

  it("resolves identity exclusively from the server session", () => {
    expect(ACTIONS).toContain("supabase = await createClient()");
    expect(ACTIONS).toContain("auth.getUser()");
  });

  it("reads only intent fields from formData — never an identity", () => {
    const fields = [...ACTIONS.matchAll(/formData\.get\(\s*"([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(fields.length).toBeGreaterThanOrEqual(4);
    const allowed = ["plan_id", "idempotency_key", "checkout_id", "outcome"];
    for (const field of fields) {
      expect(allowed).toContain(field);
    }
    // All four intent fields are actually exercised.
    for (const field of allowed) {
      expect(fields).toContain(field);
    }
  });

  it("delegates every decision to the service facades (no table access)", () => {
    expect(ACTIONS).toContain("activateTrial(userId)");
    expect(ACTIONS).toContain(
      "createMockCheckout(userId, planId, idempotencyKey)",
    );
    expect(ACTIONS).toContain(
      "completeMockCheckout(userId, checkoutId, outcome)",
    );
    // The actions never issue Supabase queries themselves.
    expect(ACTIONS).not.toContain(".from(");
    expect(ACTIONS).not.toContain(".rpc(");
  });

  it("revalidates the billing page after state-changing outcomes", () => {
    expect(ACTIONS).toContain('revalidatePath("/settings/billing")');
  });
});

// ---------------------------------------------------------------------------
// Trial form: intent only
// ---------------------------------------------------------------------------

describe("trial activation form", () => {
  it("is a client component using useActionState with the trial action", () => {
    expect(TRIAL_FORM.startsWith('"use client"')).toBe(true);
    expect(TRIAL_FORM).toContain("useActionState(");
    expect(TRIAL_FORM).toContain("activateTrialAction");
  });

  it("submits no data at all (no inputs, no name attributes)", () => {
    expect(TRIAL_FORM).not.toContain("<input");
    expect(TRIAL_FORM).not.toContain('name="');
  });
});

// ---------------------------------------------------------------------------
// Loading state
// ---------------------------------------------------------------------------

describe("billing loading state", () => {
  it("renders a shimmer skeleton", () => {
    expect(LOADING).toContain("shimmer");
  });
});

// ---------------------------------------------------------------------------
// Success page: read-only — a success URL grants nothing
// ---------------------------------------------------------------------------

describe("checkout success page", () => {
  it("only reads the stored transaction (user-scoped) and the billing status", () => {
    expect(SUCCESS_PAGE).toContain("getMockCheckout(user.id, checkoutId)");
    expect(SUCCESS_PAGE).toContain("getBillingStatus(user.id)");
  });

  it("never completes a payment or writes any row from a URL visit", () => {
    expect(SUCCESS_PAGE).not.toContain("completeMockCheckout");
    expect(SUCCESS_PAGE).not.toContain("activateTrial");
    expect(SUCCESS_PAGE).not.toContain(".insert(");
    expect(SUCCESS_PAGE).not.toContain(".upsert(");
    expect(SUCCESS_PAGE).not.toContain(".update(");
    expect(SUCCESS_PAGE).not.toContain(".delete(");
    expect(SUCCESS_PAGE).not.toContain(".rpc(");
  });
});

// ---------------------------------------------------------------------------
// Dictionary parity across all four languages
// ---------------------------------------------------------------------------

const BILLING_SECTIONS = [
  "featureNames",
  "errors",
  "checkout",
  "success",
  "trial",
  "currentPlan",
  "usage",
  "offers",
] as const;

describe("billing dictionaries — 4-language parity", () => {
  it("supports exactly de/en/fr/ar", () => {
    expect([...SUPPORTED_LANGUAGES]).toEqual(["de", "en", "fr", "ar"]);
  });

  for (const section of BILLING_SECTIONS) {
    it(`every language has de's exact key set for billing.${section} (non-empty)`, () => {
      const deSection = dictionaries.de.billing[section] as Record<
        string,
        string
      >;
      const deKeys = Object.keys(deSection).sort();
      expect(deKeys.length).toBeGreaterThan(0);
      for (const lang of SUPPORTED_LANGUAGES) {
        const sectionObj = dictionaries[lang].billing[section] as Record<
          string,
          string
        >;
        expect(Object.keys(sectionObj).sort()).toEqual(deKeys);
        for (const key of deKeys) {
          expect(sectionObj[key]).toBeTypeOf("string");
          expect(sectionObj[key]?.trim()).not.toHaveLength(0);
        }
      }
    });
  }

  it("interpolation placeholders exist in every language", () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      expect(dictionaries[lang].billing.offers.durationHours).toContain(
        "{hours}",
      );
      expect(dictionaries[lang].billing.offers.durationDays).toContain(
        "{days}",
      );
      expect(dictionaries[lang].billing.usage.usedOf).toContain("{used}");
      expect(dictionaries[lang].billing.usage.usedOf).toContain("{limit}");
    }
  });

  it("billing.featureNames covers every ALL_FEATURE_IDS entry in every language", () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      const names = dictionaries[lang].billing.featureNames as Record<
        string,
        string
      >;
      for (const featureId of ALL_FEATURE_IDS) {
        expect(names[featureId]).toBeTypeOf("string");
        expect(names[featureId]?.trim()).not.toHaveLength(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Active-plan display — canonical mapping + green current state (2026-10-25)
// ---------------------------------------------------------------------------

const { canonicalCommercialPlanId, LEGACY_TO_COMMERCIAL } =
  await import("@/lib/billing/commercial-plans");

describe("billing page — active-plan display (server-derived only)", () => {
  it("derives the current offer card from the canonical plan mapping, only while the row is ACTIVE", () => {
    expect(PAGE).toContain("canonicalCommercialPlanId(billing.planId)");
    expect(PAGE).toMatch(
      /billing\.status === "active"\s*\?\s*canonicalCommercialPlanId/,
    );
  });

  it("canonicalCommercialPlanId maps only documented pairs (fail-closed otherwise)", () => {
    expect(canonicalCommercialPlanId("plus")).toBe("premium_10d");
    expect(canonicalCommercialPlanId("pro")).toBe("premium_monthly");
    expect(canonicalCommercialPlanId("trial")).toBe("trial");
    expect(canonicalCommercialPlanId("premium_10d")).toBe("premium_10d");
    expect(canonicalCommercialPlanId("premium_monthly")).toBe(
      "premium_monthly",
    );
    expect(canonicalCommercialPlanId("free")).toBeNull();
    expect(LEGACY_TO_COMMERCIAL).toEqual({
      plus: "premium_10d",
      pro: "premium_monthly",
    });
  });

  it("highlights the active card in green with an 'active plan' label and a NON-PURCHASING current-plan state", () => {
    expect(PAGE).toContain("border-success ring-1 ring-success/30");
    expect(PAGE).toContain('t("billing.offers.yourActivePlan")');
    // The current-plan state is a plain div (aria-disabled), not a link:
    expect(PAGE).toContain('aria-disabled="true"');
    expect(PAGE).toContain('t("billing.offers.current")');
    // The purchase Link is now conditional (only non-current offers):
    expect(PAGE).toMatch(/\) : isCurrent \? \(/);
  });

  it("shows the persisted start/end dates and remaining time on the active card", () => {
    expect(PAGE).toContain('t("billing.currentPlan.periodStart")');
    expect(PAGE).toContain('t("billing.currentPlan.periodEnd")');
    expect(PAGE).toContain('t("billing.offers.remaining")');
    expect(PAGE).toContain('t("billing.offers.remainingDays"');
    expect(PAGE).toContain('t("billing.offers.remainingHours"');
    expect(PAGE).toContain('t("billing.currentPlan.remaining")');
  });

  it("the paid-active trial hint covers admin plus/pro rows (canonical mapping, not just premium ids)", () => {
    expect(PAGE).toContain(
      'canonicalPlan === "premium_10d" || canonicalPlan === "premium_monthly"',
    );
  });
});
