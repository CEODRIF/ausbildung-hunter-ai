/**
 * Trial activation facade (`src/lib/billing/trial.ts`).
 *
 * Covers:
 *  - input validation (UUID shape, ISO parsing) — fail closed, zero DB calls
 *  - the one-trial / no-restart contract at the facade boundary: only the
 *    server RPC's stored-timestamp verdicts are mapped; a consumed trial
 *    comes back `trial_already_used`, never `activated`
 *  - exact 72 h period passthrough (facade must not alter the oracle times)
 *  - malformed / unexpected RPC payloads NEVER surface as a successful
 *    activation (fail closed)
 *
 * The concurrency guarantee (no double activation under racing requests)
 * lives in Postgres (FOR UPDATE + on-conflict on `trial_activated_at`,
 * migration 20261120000000) and is pinned by
 * `tests/subscription-migrations.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ admin: null as unknown, user: null as unknown }));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    if (holder.admin === "__throw__") throw new Error("no service role env");
    return holder.admin;
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => holder.user,
}));

const { activateTrial, isUuidShape, parseIsoUtcMs } = await import(
  "@/lib/billing/trial"
);

const USER = "11111111-1111-4111-8111-411111111111";

type Call = { kind: "rpc"; name: string; args: Record<string, unknown> };

function makeRpcAdmin(
  respond:
    | ((name: string, args: Record<string, unknown>) => {
        data?: unknown;
        error?: unknown;
      })
    | "throw",
  calls: Call[],
) {
  return {
    rpc(name: string, args: Record<string, unknown>) {
      calls.push({ kind: "rpc", name, args });
      if (respond === "throw") return Promise.reject(new Error("rpc boom"));
      return Promise.resolve(respond(name, args));
    },
  };
}

let calls: Call[];

beforeEach(() => {
  calls = [];
  holder.admin = null;
  holder.user = null;
});

afterEach(() => {
  holder.admin = null;
  holder.user = null;
});

describe("isUuidShape", () => {
  it("accepts a well-formed UUID (lower- and uppercase)", () => {
    expect(isUuidShape(USER)).toBe(true);
    expect(isUuidShape(USER.toUpperCase())).toBe(true);
  });

  it("rejects non-strings and malformed UUIDs", () => {
    expect(isUuidShape("not-a-uuid")).toBe(false);
    expect(isUuidShape("11111111-1111-4111-8111-4111111111")).toBe(false);
    expect(isUuidShape(12345)).toBe(false);
    expect(isUuidShape(null)).toBe(false);
    expect(isUuidShape(undefined)).toBe(false);
  });
});

describe("parseIsoUtcMs", () => {
  it("parses ISO-8601 strings to epoch ms", () => {
    const iso = "2026-11-20T12:00:00.000Z";
    expect(parseIsoUtcMs(iso)).toBe(Date.parse(iso));
  });

  it("rejects numbers, empty strings, and garbage", () => {
    expect(parseIsoUtcMs(1795104000000)).toBeNull();
    expect(parseIsoUtcMs("")).toBeNull();
    expect(parseIsoUtcMs("garbage")).toBeNull();
    expect(parseIsoUtcMs(null)).toBeNull();
    expect(parseIsoUtcMs({})).toBeNull();
  });
});

describe("activateTrial — input validation (fail closed, zero DB calls)", () => {
  it("rejects a non-UUID userId before any database access", async () => {
    holder.admin = makeRpcAdmin(() => ({ data: null }), calls);
    const res = await activateTrial("not-a-uuid");
    expect(res).toEqual({ ok: false, error: "invalid_input" });
    expect(calls).toEqual([]);
  });

  it("fails closed when the admin client cannot be constructed", async () => {
    holder.admin = "__throw__";
    const res = await activateTrial(USER);
    expect(res).toEqual({ ok: false, error: "failed" });
    expect(calls).toEqual([]);
  });
});

describe("activateTrial — RPC mapping", () => {
  it("maps 'activated' with the exact 72 h period from the oracle", async () => {
    const startIso = "2026-11-20T12:00:00.000Z";
    const endIso = "2026-11-23T12:00:00.000Z"; // exactly +72 h
    holder.admin = makeRpcAdmin(() => ({
      data: {
        status: "activated",
        plan_id: "trial",
        current_period_start: startIso,
        current_period_end: endIso,
        trial_activated_at: startIso,
      },
    }), calls);

    const res = await activateTrial(USER);
    expect(res).toEqual({
      ok: true,
      status: "activated",
      periodStartMs: Date.parse(startIso),
      periodEndMs: Date.parse(endIso),
      trialActivatedAtMs: Date.parse(startIso),
    });
    // The facade passes the server-resolved identity straight through.
    expect(calls).toEqual([
      { kind: "rpc", name: "activate_trial", args: { p_user_id: USER } },
    ]);
    expect(Date.parse(endIso) - Date.parse(startIso)).toBe(72 * 3600 * 1000);
  });

  it("unwraps a 1-row array payload (house idiom)", async () => {
    const startIso = "2026-11-20T12:00:00.000Z";
    const endIso = "2026-11-23T12:00:00.000Z";
    holder.admin = makeRpcAdmin(() => ({
      data: [
        {
          status: "activated",
          current_period_start: startIso,
          current_period_end: endIso,
          trial_activated_at: null,
        },
      ],
    }), calls);

    const res = await activateTrial(USER);
    expect(res).toEqual({
      ok: true,
      status: "activated",
      periodStartMs: Date.parse(startIso),
      periodEndMs: Date.parse(endIso),
      trialActivatedAtMs: null,
    });
  });

  it("maps 'trial_already_used' — a consumed trial is never re-activated", async () => {
    const usedIso = "2026-10-01T09:30:00.000Z";
    holder.admin = makeRpcAdmin(() => ({
      data: { status: "trial_already_used", trial_activated_at: usedIso },
    }), calls);

    const res = await activateTrial(USER);
    expect(res).toEqual({
      ok: true,
      status: "trial_already_used",
      trialActivatedAtMs: Date.parse(usedIso),
    });
  });

  it("maps 'paid_active' with the stored plan and period end", async () => {
    const endIso = "2026-12-31T23:59:59.000Z";
    holder.admin = makeRpcAdmin(() => ({
      data: {
        status: "paid_active",
        plan_id: "premium_monthly",
        current_period_end: endIso,
      },
    }), calls);

    const res = await activateTrial(USER);
    expect(res).toEqual({
      ok: true,
      status: "paid_active",
      planId: "premium_monthly",
      periodEndMs: Date.parse(endIso),
    });
  });

  it("allows a null period end on 'paid_active'", async () => {
    holder.admin = makeRpcAdmin(() => ({
      data: { status: "paid_active", plan_id: "premium_10d" },
    }), calls);

    const res = await activateTrial(USER);
    expect(res).toEqual({
      ok: true,
      status: "paid_active",
      planId: "premium_10d",
      periodEndMs: null,
    });
  });
});

describe("activateTrial — malformed payloads fail closed (no fake activation)", () => {
  it("fails when 'activated' is missing the period end", async () => {
    holder.admin = makeRpcAdmin(() => ({
      data: {
        status: "activated",
        current_period_start: "2026-11-20T12:00:00.000Z",
        current_period_end: null,
      },
    }), calls);
    expect(await activateTrial(USER)).toEqual({ ok: false, error: "failed" });
  });

  it("fails when the period end is not after the start", async () => {
    holder.admin = makeRpcAdmin(() => ({
      data: {
        status: "activated",
        current_period_start: "2026-11-20T12:00:00.000Z",
        current_period_end: "2026-11-20T12:00:00.000Z",
      },
    }), calls);
    expect(await activateTrial(USER)).toEqual({ ok: false, error: "failed" });
  });

  it("fails when 'activated' carries an unparseable start", async () => {
    holder.admin = makeRpcAdmin(() => ({
      data: {
        status: "activated",
        current_period_start: "garbage",
        current_period_end: "2026-11-23T12:00:00.000Z",
      },
    }), calls);
    expect(await activateTrial(USER)).toEqual({ ok: false, error: "failed" });
  });

  it("fails when 'paid_active' has an empty plan id", async () => {
    holder.admin = makeRpcAdmin(() => ({
      data: { status: "paid_active", plan_id: "" },
    }), calls);
    expect(await activateTrial(USER)).toEqual({ ok: false, error: "failed" });
  });

  it("fails on an unknown status", async () => {
    holder.admin = makeRpcAdmin(
      () => ({ data: { status: "refunded" } }),
      calls,
    );
    expect(await activateTrial(USER)).toEqual({ ok: false, error: "failed" });
  });

  it("fails on a null payload", async () => {
    holder.admin = makeRpcAdmin(() => ({ data: null }), calls);
    expect(await activateTrial(USER)).toEqual({ ok: false, error: "failed" });
  });

  it("fails on an RPC error", async () => {
    holder.admin = makeRpcAdmin(
      () => ({ error: { message: "missing_user_id" } }),
      calls,
    );
    expect(await activateTrial(USER)).toEqual({ ok: false, error: "failed" });
  });

  it("fails when the RPC throws", async () => {
    holder.admin = makeRpcAdmin("throw", calls);
    expect(await activateTrial(USER)).toEqual({ ok: false, error: "failed" });
  });
});
