/**
 * Deckblatt quota status — production regression suite.
 *
 * Production incident: "/deckblatt" showed
 * "Die Nutzungsbegrenzung konnte nicht geprüft werden." before any design
 * was generated. The ONLY code path that produces that state is
 *   GET/POST /api/deckblatt/* → quota RPC → error → null → 503
 *   { code: "usage_unavailable" } → client error "usage_unavailable".
 *
 * This suite pins the whole chain down:
 *   1. status for a new user → 0/2 (no error)
 *   2. status after one success → 1/2
 *   3. status after two successes → 2/2
 *   4. status is READ-ONLY (never reserves/consumes)
 *   5. unauthenticated status requests are rejected
 *   6. an RPC failure produces a CONTROLLED error (503 usage_unavailable,
 *      never a 500) and a diagnostic that preserves the PostgREST code
 *      (PGRST205 = function not found → migration not applied)
 *   7. the reservation stays atomic (one RPC per run_id, idempotent)
 *   8. a failed generation still releases the quota
 *
 * Behavioural parts run against a mocked PostgREST chain (the same pattern
 * as tests/rate-limit.test.ts / tests/account-data.test.ts); the SQL-level
 * guarantees are pinned by contract assertions on the migration itself.
 *
 * PII discipline is asserted, not assumed: the diagnostics may contain the
 * route, the RPC name, the auth state and the PostgREST code — never a user
 * id, run id or RPC argument.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "@supabase/supabase-js";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getCurrentUserAndProfile: vi.fn() }));

const { createClient } = await import("@/lib/supabase/server");
const { getCurrentUserAndProfile } = await import("@/lib/auth");
const {
  completeDeckblattGeneration,
  getDeckblattUsageStatus,
  releaseDeckblattGeneration,
  reserveDeckblattGeneration,
} = await import("@/lib/deckblatt/usage");
const { GET: getStatus } = await import("@/app/api/deckblatt/status/route");

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (relative: string) => readFileSync(resolve(root, relative), "utf8");
const migration = read("supabase/migrations/20261020000000_deckblatt_usage.sql");
const usageLib = read("src/lib/deckblatt/usage.ts");
const statusRoute = read("src/app/api/deckblatt/status/route.ts");

const USER_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const TODAY = "2026-10-03";

interface RpcError {
  message: string;
  code?: string;
}
type RpcResult = { data: unknown; error: RpcError | null };

/** Mocked Supabase chain: auth.getUser + rpc, with a call ledger. */
function makeClient(handlers: {
  user?: { id: string } | null;
  rpc?: (name: string, args: Record<string, unknown>) => RpcResult;
}) {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  vi.mocked(createClient).mockResolvedValue(
    {
      auth: {
        getUser: async () => ({
          // Explicit null = no session (must NOT fall back to the default).
          data: { user: handlers.user === undefined ? { id: USER_ID } : handlers.user },
          error: null,
        }),
      },
      rpc: async (name: string, args: Record<string, unknown>): Promise<RpcResult> => {
        rpcCalls.push({ name, args });
        return handlers.rpc ? handlers.rpc(name, args) : { data: null, error: null };
      },
    } as never,
  );
  return { rpcCalls };
}

/** The row the status RPC returns for a given used-count (SQL shape:
 *  daily_limit, used, remaining, usage_date — "limit" itself is a fully
 *  reserved PostgreSQL word and cannot be a RETURNS TABLE field name). */
const statusRow = (used: number) => ({
  daily_limit: 2,
  used,
  remaining: 2 - used,
  usage_date: TODAY,
});

let logSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  logSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  logSpy.mockRestore();
});

const logged = () => logSpy.mock.calls.map((args) => args.join(" ")).join("\n");

// ---------------------------------------------------------------------------
// 1-4. Status behaviour (0/2 → 1/2 → 2/2; read-only)
// ---------------------------------------------------------------------------

describe("status behaviour (mocked PostgREST chain)", () => {
  it("1. a user WITHOUT a usage row gets 0 used / 2 remaining — not an error", async () => {
    makeClient({
      rpc: (name) =>
        name === "get_deckblatt_usage_status"
          ? { data: [statusRow(0)], error: null }
          : { data: null, error: null },
    });
    expect(await getDeckblattUsageStatus()).toEqual({ limit: 2, used: 0, remaining: 2 });
  });

  it("2. after one successful generation: 1 used / 1 remaining", async () => {
    makeClient({
      rpc: (name) =>
        name === "get_deckblatt_usage_status"
          ? { data: [statusRow(1)], error: null }
          : { data: null, error: null },
    });
    expect(await getDeckblattUsageStatus()).toEqual({ limit: 2, used: 1, remaining: 1 });
  });

  it("3. after two successful generations: 2 used / 0 remaining", async () => {
    makeClient({
      rpc: (name) =>
        name === "get_deckblatt_usage_status"
          ? { data: [statusRow(2)], error: null }
          : { data: null, error: null },
    });
    expect(await getDeckblattUsageStatus()).toEqual({ limit: 2, used: 2, remaining: 0 });
  });

  it("4. status never CHARGES: it only reads the quota and settles abandoned reservations", async () => {
    const { rpcCalls } = makeClient({
      rpc: (name) =>
        name === "get_deckblatt_usage_status"
          ? { data: [statusRow(0)], error: null }
          : { data: null, error: null },
    });
    await getDeckblattUsageStatus();
    await getDeckblattUsageStatus(); // repeated page loads must stay free
    // Per load: read the quota, then give back any reservation that was never
    // settled. The status page is the only place the user sees the number (and
    // the generate button is disabled while it reads "exhausted"), so a lost
    // reservation has to be recovered here or the user stays stuck.
    expect(rpcCalls.map((call) => call.name)).toEqual([
      "expire_stale_deckblatt_runs",
      "get_deckblatt_usage_status",
      "expire_stale_deckblatt_runs",
      "get_deckblatt_usage_status",
    ]);
    // No charging RPC may ever be reachable from a GET path.
    for (const call of rpcCalls) {
      expect(["get_deckblatt_usage_status", "expire_stale_deckblatt_runs"]).toContain(
        call.name,
      );
      expect(JSON.stringify(call.args)).toContain(USER_ID);
    }
  });
});

// ---------------------------------------------------------------------------
// 5-6. Auth + controlled failure
// ---------------------------------------------------------------------------

describe("status route (GET /api/deckblatt/status)", () => {
  it("5a. unauthenticated request → 401 { code: 'unauthorized' }", async () => {
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue({ user: null, profile: null });
    makeClient({});
    const response = await getStatus();
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: "unauthorized" });
  });

  it("5b. unauthenticated lib call → null, and NO RPC is issued at all", async () => {
    const { rpcCalls } = makeClient({ user: null });
    expect(await getDeckblattUsageStatus()).toBeNull();
    expect(rpcCalls).toHaveLength(0);
    expect(logged()).toContain("unauthenticated");
  });

  it("6a. authenticated + healthy RPC → 200 { limit, used, remaining }", async () => {
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue({
      user: { id: USER_ID } as User,
      profile: null,
    });
    makeClient({
      rpc: (name) =>
        name === "get_deckblatt_usage_status"
          ? { data: [statusRow(1)], error: null }
          : { data: null, error: null },
    });
    const response = await getStatus();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ limit: 2, used: 1, remaining: 1 });
  });

  it("6b. RPC failure → controlled 503 { code: 'usage_unavailable' } (never a 500)", async () => {
    vi.mocked(getCurrentUserAndProfile).mockResolvedValue({
      user: { id: USER_ID } as User,
      profile: null,
    });
    makeClient({
      rpc: (name) =>
        name === "get_deckblatt_usage_status"
          ? {
              data: null,
              error: {
                message:
                  "Could not find the function public.get_deckblatt_usage_status(uuid) in the schema cache.",
                code: "PGRST205",
              },
            }
          : { data: null, error: null },
    });
    const response = await getStatus();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "usage_unavailable" });
  });

  it("6c. the diagnostic preserves the PostgREST code + message (route, rpc, auth state) — no PII", async () => {
    makeClient({
      rpc: (name) =>
        name === "get_deckblatt_usage_status"
          ? {
              data: null,
              error: {
                message:
                  "Could not find the function public.get_deckblatt_usage_status(uuid) in the schema cache.",
                code: "PGRST205",
              },
            }
          : { data: null, error: null },
    });
    expect(await getDeckblattUsageStatus()).toBeNull();
    const line = logged();
    expect(line).toContain("route=/api/deckblatt/status");
    expect(line).toContain("rpc=get_deckblatt_usage_status");
    expect(line).toContain("auth=authenticated");
    expect(line).toContain("postgrest_code=PGRST205");
    expect(line).toContain("Could not find the function");
    // The underlying Supabase error is NOT hidden by a generic replacement.
    expect(line).not.toContain("user.id");
    expect(line).not.toContain(USER_ID);
    expect(line).not.toContain(RUN_ID);
  });

  it("6d. malformed RPC row → null + shape diagnostic (controlled)", async () => {
    makeClient({ rpc: () => ({ data: null, error: null }) });
    expect(await getDeckblattUsageStatus()).toBeNull();
    expect(logged()).toContain("malformed_rpc_row");
  });
});

// ---------------------------------------------------------------------------
// 7. Reservation stays atomic (wiring + idempotency key)
// ---------------------------------------------------------------------------

describe("reserve — atomic wiring", () => {
  it("7a. one reserve RPC per run, carrying the idempotency key", async () => {
    const { rpcCalls } = makeClient({
      rpc: (name) =>
        name === "reserve_deckblatt_generation"
          ? { data: [{ status: "reserved", used: 1, remaining: 1 }], error: null }
          : { data: null, error: null },
    });
    expect(await reserveDeckblattGeneration(RUN_ID)).toEqual({
      status: "reserved",
      used: 1,
      remaining: 1,
    });
    // Exactly ONE charge: the abandoned-reservation recovery runs first (it
    // only gives quota back), then the reservation itself.
    const reserveCalls = rpcCalls.filter(
      (call) => call.name === "reserve_deckblatt_generation",
    );
    expect(reserveCalls).toHaveLength(1);
    expect(reserveCalls[0].args).toEqual({ target_user_id: USER_ID, p_run_id: RUN_ID });
    expect(rpcCalls.map((call) => call.name)).toEqual([
      "expire_stale_deckblatt_runs",
      "reserve_deckblatt_generation",
    ]);
  });

  it("7b. replayed run_id → already_reserved (never charged twice)", async () => {
    makeClient({
      rpc: (name) =>
        name === "reserve_deckblatt_generation"
          ? { data: [{ status: "already_reserved", used: 1, remaining: 1 }], error: null }
          : { data: null, error: null },
    });
    expect(await reserveDeckblattGeneration(RUN_ID)).toEqual({
      status: "already_reserved",
      used: 1,
      remaining: 1,
    });
  });

  it("7c. at the limit → quota_exhausted (nothing charged)", async () => {
    makeClient({
      rpc: (name) =>
        name === "reserve_deckblatt_generation"
          ? { data: [{ status: "quota_exhausted", used: 2, remaining: 0 }], error: null }
          : { data: null, error: null },
    });
    expect(await reserveDeckblattGeneration(RUN_ID)).toEqual({
      status: "quota_exhausted",
      used: 2,
      remaining: 0,
    });
  });

  it("7d. RPC failure → null (the route degrades to 503, nothing consumed)", async () => {
    makeClient({
      rpc: (name) =>
        name === "reserve_deckblatt_generation"
          ? { data: null, error: { message: "boom", code: "PGRST205" } }
          : { data: null, error: null },
    });
    expect(await reserveDeckblattGeneration(RUN_ID)).toBeNull();
    expect(logged()).toContain("postgrest_code=PGRST205");
  });
});

// ---------------------------------------------------------------------------
// 8. Failed generation → release (refund), void-complete shape
// ---------------------------------------------------------------------------

describe("release + complete", () => {
  it("8a. a FAILED reserved run is refunded (released) with the run_id", async () => {
    const { rpcCalls } = makeClient({
      rpc: (name) =>
        name === "release_deckblatt_generation"
          ? { data: [{ status: "released", used: 1, remaining: 1 }], error: null }
          : { data: null, error: null },
    });
    expect(await releaseDeckblattGeneration(RUN_ID)).toBe(true);
    expect(rpcCalls[0].name).toBe("release_deckblatt_generation");
    expect(rpcCalls[0].args).toEqual({ target_user_id: USER_ID, p_run_id: RUN_ID });
  });

  it("8b. double release / unknown run → no_op → false (no double refund)", async () => {
    makeClient({
      rpc: (name) =>
        name === "release_deckblatt_generation"
          ? { data: [{ status: "no_op", used: 0, remaining: 2 }], error: null }
          : { data: null, error: null },
    });
    expect(await releaseDeckblattGeneration(RUN_ID)).toBe(false);
  });

  it("8c. release never throws (RPC error → false + diagnostic)", async () => {
    makeClient({
      rpc: (name) =>
        name === "release_deckblatt_generation"
          ? { data: null, error: { message: "boom", code: "42501" } }
          : { data: null, error: null },
    });
    expect(await releaseDeckblattGeneration(RUN_ID)).toBe(false);
    expect(logged()).toContain("postgrest_code=42501");
  });

  it("8d. complete treats the VOID RPC (data=null, error=null) as success", async () => {
    makeClient({ rpc: () => ({ data: null, error: null }) });
    expect(await completeDeckblattGeneration(RUN_ID)).toBe(true);
  });

  it("8e. complete with an RPC error → false (logged, never thrown)", async () => {
    makeClient({ rpc: () => ({ data: null, error: { message: "boom", code: "42501" } }) });
    expect(await completeDeckblattGeneration(RUN_ID)).toBe(false);
    expect(logged()).toContain("postgrest_code=42501");
  });
});

// ---------------------------------------------------------------------------
// SQL contract — read-only status, UTC, names/args, security
// ---------------------------------------------------------------------------

describe("SQL contract (20261020000000_deckblatt_usage.sql)", () => {
  const functionBlock = (name: string) => {
    const start = migration.indexOf(`function public.${name}(`);
    const end = migration.indexOf(`revoke execute on function public.${name}`);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return migration.slice(start, end);
  };

  it("the status function is a pure SELECT — it cannot reserve or consume", () => {
    const block = functionBlock("get_deckblatt_usage_status");
    expect(block).toContain("returns table (");
    expect(block).not.toMatch(/insert\s+into/i);
    expect(block).not.toMatch(/\bupdate\s+public/i);
    expect(block).not.toMatch(/delete\s+from/i);
  });

  it("no usage row today → the function yields exactly (2, 0, 2, today)", () => {
    const block = functionBlock("get_deckblatt_usage_status");
    expect(block).toContain("where not exists (");
    expect(block).toContain("select 2, 0, 2, (now() at time zone 'utc')::date");
  });

  it("all date math is explicitly UTC (no current_date, no bare now()::date)", () => {
    expect(migration).not.toContain("current_date");
    expect(migration).not.toMatch(/now\(\)\s*::\s*date/);
    const utcDates = migration.match(/\(now\(\) at time zone 'utc'\)::date/g) ?? [];
    // status read, not-exists branch, reserve, release + declarations
    expect(utcDates.length).toBeGreaterThanOrEqual(5);
  });

  it("RPC names and argument names in usage.ts exactly match the SQL functions", () => {
    const pairs: Array<[string, string[]]> = [
      ["get_deckblatt_usage_status", ["target_user_id"]],
      ["reserve_deckblatt_generation", ["target_user_id", "p_run_id"]],
      ["release_deckblatt_generation", ["target_user_id", "p_run_id"]],
      ["complete_deckblatt_generation", ["target_user_id", "p_run_id"]],
    ];
    for (const [name, params] of pairs) {
      expect(usageLib, `typescript calls ${name}`).toContain(`"${name}"`);
      const signature = functionBlock(name).slice(0, functionBlock(name).indexOf("\n)"));
      for (const param of params) {
        expect(usageLib, `typescript sends ${name}(${param})`).toContain(`${param}:`);
        expect(signature, `sql ${name} declares ${param}`).toContain(param);
      }
    }
  });

  it("all four RPCs are security definer, search_path-pinned, authenticated-only", () => {
    for (const name of [
      "get_deckblatt_usage_status",
      "reserve_deckblatt_generation",
      "release_deckblatt_generation",
      "complete_deckblatt_generation",
    ]) {
      const block = functionBlock(name);
      expect(block, `${name} definer`).toContain("security definer");
      expect(block, `${name} search_path`).toContain("set search_path = public");
      expect(migration, `${name} revoke`).toContain(
        `revoke execute on function public.${name}(`,
      );
      // Grant line: "grant execute on function public.<name>(<params>) to
      // authenticated;" — the parameter list sits between name and grantee.
      const grantIdx = migration.indexOf(`grant execute on function public.${name}`);
      expect(grantIdx, `${name} grant exists`).toBeGreaterThan(-1);
      const grantLine = migration.slice(grantIdx, migration.indexOf("\n", grantIdx));
      expect(grantLine, `${name} grantee`).toMatch(/ to authenticated;\s*$/);
    }
  });

  it("every WRITE RPC refuses another user's id (auth.uid() guard)", () => {
    for (const name of [
      "reserve_deckblatt_generation",
      "release_deckblatt_generation",
      "complete_deckblatt_generation",
    ]) {
      const block = functionBlock(name);
      expect(block, `${name} guard`).toContain(
        "if auth.uid() is not null and auth.uid() <> target_user_id then",
      );
      expect(block, `${name} raise`).toContain("raise exception 'not_authorized';");
    }
  });

  it("the (user_id, usage_date) uniqueness constraint exists", () => {
    expect(migration).toContain("constraint ai_deckblatt_usage_user_date_unique");
    expect(migration).toContain("unique (user_id, usage_date)");
  });

  it("the status route imports ONLY the read function (no write path in status)", () => {
    expect(statusRoute).toContain('import { getDeckblattUsageStatus } from "@/lib/deckblatt/usage"');
    expect(statusRoute).not.toContain("reserveDeckblattGeneration");
    expect(statusRoute).not.toContain("releaseDeckblattGeneration");
    expect(statusRoute).not.toContain("completeDeckblattGeneration");
  });
});

// ---------------------------------------------------------------------------
// Diagnostics contract — what the server log may and may not contain
// ---------------------------------------------------------------------------

describe("diagnostics (PII-free) in usage.ts", () => {
  it("logs route, rpc, auth state and the PostgREST error code", () => {
    expect(usageLib).toContain("route=");
    expect(usageLib).toContain("rpc=");
    expect(usageLib).toContain("auth=");
    expect(usageLib).toContain("postgrest_code=");
  });

  it("no console.* line interpolates user ids, run ids or RPC arguments", () => {
    for (const line of usageLib.split("\n")) {
      if (!line.includes("console.")) continue;
      expect(line).not.toContain("user.id");
      expect(line).not.toContain("runId");
      expect(line).not.toContain("target_user_id");
      expect(line).not.toContain("p_run_id");
    }
  });
});
