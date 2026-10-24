/**
 * Payment & subscription history — read-only facade + billing-page wiring.
 *
 * Pinned contract:
 *   1. NEVER INVENTS DATA: only persisted, shape-valid rows are returned;
 *      invalid rows (bad status/currency/amount/id/date/is_mock) are
 *      dropped; empty results stay empty (honest empty state downstream).
 *   2. USER-SCOPED: mock_checkouts filtered by user_id; admin_audit_log
 *      filtered by target_user_id + the three manual-grant actions only;
 *      capped at 50 per list.
 *   3. READ-ONLY: the facade issues SELECTs only (no insert/update/
 *      delete/upsert/rpc in the module).
 *   4. FAIL EXPLICIT: lookup errors resolve {ok:false} (the page shows
 *      the "unavailable" note, never fabricated history).
 *   5. PAGE WIRING: the billing page renders only persisted entries with
 *      explicit simulated/manual labeling and the no-provider notice.
 *   6. i18n: billing.history parity across de/en/fr/ar.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ admin: null as unknown }));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => holder.admin,
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => null,
}));

const { getPaymentHistory } = await import("@/lib/billing/payment-history");
const { dictionaries, SUPPORTED_LANGUAGES } =
  await import("@/lib/i18n/dictionaries");

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (relative: string) =>
  readFileSync(resolve(root, relative), "utf8");

const FACADE = read("src/lib/billing/payment-history.ts");
const PAGE = read("src/app/settings/billing/page.tsx");
const DOC = read("docs/billing-payment-capabilities.md");

const USER = "11111111-1111-4111-8111-411111111111";
const D1 = "2026-10-01T10:00:00.000Z";
const D2 = "2026-10-15T12:00:00.000Z";

// ---------------------------------------------------------------------------
// Thenable chain mock (Supabase builders are awaitable at any step)
// ---------------------------------------------------------------------------

interface Call {
  table: string;
  filters: Record<string, unknown>;
  limit: number | null;
}

interface AdminOpts {
  rows?: Record<string, unknown[]>;
  errorTable?: string;
  throwTable?: string;
}

function makeAdmin(opts: AdminOpts = {}) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const filters: Record<string, unknown> = {};
    let limit: number | null = null;
    const run = async () => {
      calls.push({ table, filters: { ...filters }, limit });
      if (opts.throwTable === table)
        throw new Error("simulated client failure");
      if (opts.errorTable === table)
        return { data: null, error: { message: "simulated query error" } };
      return { data: opts.rows?.[table] ?? [], error: null };
    };
    const chain = {
      select: () => chain,
      eq: (c: string, v: unknown) => {
        filters[c] = v;
        return chain;
      },
      in: (c: string, v: unknown[]) => {
        filters[c] = v;
        return chain;
      },
      order: () => chain,
      limit: (n: number) => {
        limit = n;
        return chain;
      },
      then: (
        res: ((v: unknown) => unknown) | null,
        rej: ((e: unknown) => unknown) | null,
      ) => run().then(res ?? undefined, rej ?? undefined),
    };
    return chain;
  };
  return { from, calls };
}

const OTHER_USER = "99999999-9999-4999-8999-999999999999";

function onlineRow(over: Record<string, unknown> = {}) {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    user_id: USER, // the facade re-validates this (defense in depth)
    plan_id: "premium_monthly",
    amount_cents: 2000,
    currency: "USD",
    status: "succeeded",
    is_mock: true,
    created_at: D1,
    ...over,
  };
}

function manualRow(over: Record<string, unknown> = {}) {
  return {
    action: "set_plan",
    target_user_id: USER, // the facade re-validates this (defense in depth)
    details: { plan: "pro", period_days: 30 },
    created_at: D1,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 1. Facade — never invents, only persisted + shape-valid rows
// ---------------------------------------------------------------------------

describe("getPaymentHistory — persisted rows only", () => {
  it("returns valid online rows in order, isMock forced", async () => {
    holder.admin = makeAdmin({
      rows: {
        mock_checkouts: [
          onlineRow({ status: "pending", created_at: D2 }),
          onlineRow(),
        ],
        admin_audit_log: [],
      },
    });
    const res = await getPaymentHistory(USER);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.history.onlinePayments).toHaveLength(2);
    expect(res.history.onlinePayments[0].status).toBe("pending");
    expect(res.history.onlinePayments[0].createdAtMs).toBe(Date.parse(D2));
    expect(res.history.onlinePayments[1].amountCents).toBe(2000);
    expect(res.history.onlinePayments[1].isMock).toBe(true);
  });

  it("drops invalid online rows (never renders a fake transaction)", async () => {
    holder.admin = makeAdmin({
      rows: {
        mock_checkouts: [
          onlineRow(),
          onlineRow({ status: "refunded" }), // unknown status
          onlineRow({ currency: "EUR" }),
          onlineRow({ amount_cents: 0 }),
          onlineRow({ id: "not-a-uuid" }),
          onlineRow({ created_at: "yesterday-ish" }),
          onlineRow({ is_mock: false }),
          null,
        ],
        admin_audit_log: [],
      },
    });
    const res = await getPaymentHistory(USER);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.history.onlinePayments).toHaveLength(1);
    expect(res.history.onlinePayments[0].id).toBe(
      "22222222-2222-4222-8222-222222222222",
    );
  });

  it("parses manual grants: action, plan, period; tolerates empty details", async () => {
    holder.admin = makeAdmin({
      rows: {
        mock_checkouts: [],
        admin_audit_log: [
          manualRow({
            action: "cancel_subscription",
            details: {},
            created_at: D2,
          }),
          manualRow({
            action: "reactivate_subscription",
            details: { plan: "pro", period_days: 30 },
          }),
          manualRow({ action: "grant_admin", details: {} }), // not a subscription action
          manualRow({ created_at: "???" }),
          null,
        ],
      },
    });
    const res = await getPaymentHistory(USER);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.history.manualGrants).toHaveLength(2);
    expect(res.history.manualGrants[0]).toMatchObject({
      action: "cancel_subscription",
      plan: null,
      periodDays: null,
      createdAtMs: Date.parse(D2),
    });
    expect(res.history.manualGrants[1]).toMatchObject({
      action: "reactivate_subscription",
      plan: "pro",
      periodDays: 30,
    });
  });

  it("reports providerConfigured=false (no real payment provider)", async () => {
    holder.admin = makeAdmin();
    const res = await getPaymentHistory(USER);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.history.providerConfigured).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cross-user exclusion — the mock admin client IGNORES query filters and
// returns the fixture rows verbatim (a hostile/emulated "filter bypass").
// Only the facade's second-layer user check must exclude foreign rows.
// ---------------------------------------------------------------------------

describe("getPaymentHistory — cross-user exclusion (filter-ignoring DB emulation)", () => {
  it("drops online rows whose user_id is not the session user", async () => {
    holder.admin = makeAdmin({
      rows: {
        mock_checkouts: [
          onlineRow(),
          onlineRow({
            user_id: OTHER_USER,
            id: "33333333-3333-4333-8333-333333333333",
          }),
          onlineRow({ user_id: null }),
          onlineRow({ user_id: "not-a-uuid" }),
        ],
        admin_audit_log: [],
      },
    });
    const res = await getPaymentHistory(USER);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.history.onlinePayments).toHaveLength(1);
    // The scoping column must never leak into the rendered entry:
    expect(Object.keys(res.history.onlinePayments[0])).not.toContain("user_id");
    expect(res.history.onlinePayments[0].id).toBe(
      "22222222-2222-4222-8222-222222222222",
    );
  });

  it("drops manual-grant rows whose target_user_id is not the session user", async () => {
    holder.admin = makeAdmin({
      rows: {
        mock_checkouts: [],
        admin_audit_log: [
          manualRow(),
          manualRow({
            target_user_id: OTHER_USER,
            action: "cancel_subscription",
            details: {},
            created_at: D2,
          }),
          manualRow({
            target_user_id: null,
            action: "reactivate_subscription",
          }),
        ],
      },
    });
    const res = await getPaymentHistory(USER);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.history.manualGrants).toHaveLength(1);
    expect(res.history.manualGrants[0].action).toBe("set_plan");
    expect(Object.keys(res.history.manualGrants[0])).not.toContain(
      "target_user_id",
    );
  });

  it("treats non-array payloads as empty (no crash, no data)", async () => {
    // A thenable chain (Supabase builders are awaitable at any step)
    // that resolves a bogus, non-array "data" payload for both tables:
    const chainFactory = () => {
      const result = { data: { bogus: "shape" }, error: null };
      const chain = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        order: () => chain,
        limit: () => chain,
        then: (
          res: ((v: unknown) => unknown) | null,
          rej: ((e: unknown) => unknown) | null,
        ) => Promise.resolve(result).then(res ?? undefined, rej ?? undefined),
      };
      return chain;
    };
    holder.admin = { from: () => chainFactory(), calls: [] };
    const res = await getPaymentHistory(USER);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.history.onlinePayments).toEqual([]);
    expect(res.history.manualGrants).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. Facade — user-scoped, capped, fail-explicit
// ---------------------------------------------------------------------------

describe("getPaymentHistory — scoping and failure", () => {
  it("scopes both tables to the session user, caps at 50", async () => {
    const admin = makeAdmin();
    holder.admin = admin;
    const res = await getPaymentHistory(USER);
    expect(res.ok).toBe(true);
    const online = admin.calls.find((c) => c.table === "mock_checkouts");
    const manual = admin.calls.find((c) => c.table === "admin_audit_log");
    expect(online?.filters).toMatchObject({ user_id: USER });
    expect(online?.limit).toBe(50);
    expect(manual?.filters).toMatchObject({ target_user_id: USER });
    expect(manual?.filters["action"]).toEqual([
      "set_plan",
      "reactivate_subscription",
      "cancel_subscription",
    ]);
    expect(manual?.limit).toBe(50);
  });

  it("invalid user id → invalid_input without a database call", async () => {
    const admin = makeAdmin();
    holder.admin = admin;
    const res = await getPaymentHistory("not-a-uuid");
    expect(res).toEqual({ ok: false, error: "invalid_input" });
    expect(admin.calls).toHaveLength(0);
  });

  it("query error → {ok:false, failed} (page shows unavailable, nothing fabricated)", async () => {
    holder.admin = makeAdmin({ errorTable: "mock_checkouts" });
    expect(await getPaymentHistory(USER)).toEqual({
      ok: false,
      error: "failed",
    });
    holder.admin = makeAdmin({ throwTable: "admin_audit_log" });
    expect(await getPaymentHistory(USER)).toEqual({
      ok: false,
      error: "failed",
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Facade — read-only by construction
// ---------------------------------------------------------------------------

describe("payment-history module — read-only", () => {
  it("issues SELECTs only (no writes, no RPCs)", () => {
    expect(FACADE).toContain(".select(");
    expect(FACADE).not.toContain(".insert(");
    expect(FACADE).not.toContain(".upsert(");
    expect(FACADE).not.toContain(".update(");
    expect(FACADE).not.toContain(".delete(");
    expect(FACADE).not.toContain(".rpc(");
  });
});

// ---------------------------------------------------------------------------
// 4. Page wiring — honest states, no invented data
// ---------------------------------------------------------------------------

describe("billing page — history section (source contract)", () => {
  it("reads the history for the session user only", () => {
    expect(PAGE).toContain("getPaymentHistory(user.id)");
  });

  it("renders the explicit states: unavailable, no provider, both empty states", () => {
    expect(PAGE).toContain('t("billing.history.title")');
    expect(PAGE).toContain('t("billing.history.unavailable")');
    expect(PAGE).toContain('t("billing.history.noProvider")');
    expect(PAGE).toContain('t("billing.history.onlineEmpty")');
    expect(PAGE).toContain('t("billing.history.manualEmpty")');
  });

  it("labels simulated payments and manual grants distinctly", () => {
    expect(PAGE).toContain('t("billing.history.simulated")');
    expect(PAGE).toContain('t("billing.history.onlineTitle")');
    expect(PAGE).toContain('t("billing.history.manualTitle")');
    // Manual actions are mapped to i18n keys (grant/reactivate/cancel).
    expect(PAGE).toContain('"actionGrant"');
    expect(PAGE).toContain('"actionReactivate"');
    expect(PAGE).toContain('"actionCancel"');
    expect(PAGE).toContain("billing.history.${manualActionKey(g.action)}");
    // Online payment statuses are mapped to i18n keys.
    expect(PAGE).toContain("billing.history.${onlineStatusKey(p.status)}");
    expect(PAGE).toContain('"statusSucceeded"');
    expect(PAGE).toContain('"statusExpired"');
  });
});

// ---------------------------------------------------------------------------
// 5. i18n parity — billing.history
// ---------------------------------------------------------------------------

describe("i18n — billing.history parity", () => {
  it("has de's exact key set with non-empty values in every language", () => {
    const deKeys = Object.keys(
      (dictionaries.de.billing as Record<string, unknown>)["history"] as object,
    ).sort();
    expect(deKeys).toEqual([
      "actionCancel",
      "actionGrant",
      "actionReactivate",
      "manualEmpty",
      "manualTitle",
      "noProvider",
      "onlineEmpty",
      "onlineTitle",
      "periodDays",
      "simulated",
      "statusCanceled",
      "statusExpired",
      "statusFailed",
      "statusPending",
      "statusSucceeded",
      "title",
      "unavailable",
    ]);
    for (const lang of SUPPORTED_LANGUAGES) {
      const section = (dictionaries[lang].billing as Record<string, unknown>)[
        "history"
      ] as Record<string, string>;
      expect(Object.keys(section).sort()).toEqual(deKeys);
      for (const key of deKeys) {
        expect(section[key]).toBeTypeOf("string");
        expect(section[key]?.trim()).not.toHaveLength(0);
      }
    }
  });

  it("periodDays carries the {days} placeholder in every language", () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      const section = (dictionaries[lang].billing as Record<string, unknown>)[
        "history"
      ] as Record<string, string>;
      expect(section["periodDays"]).toContain("{days}");
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Documentation — the missing capability is documented, not hidden
// ---------------------------------------------------------------------------

describe("docs — billing payment capabilities", () => {
  it("documents the unconfigured provider, the 501 webhook, and mock isolation", () => {
    expect(DOC).toContain("No real payment provider is configured");
    expect(DOC).toContain("billing_provider_not_configured");
    expect(DOC).toContain("is_mock = true");
    expect(DOC).toContain("Manual grants are **not payments**");
  });
});
