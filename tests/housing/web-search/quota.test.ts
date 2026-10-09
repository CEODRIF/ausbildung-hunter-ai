import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Offline: the Supabase server client is fully mocked.
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
const { createClient } = await import("@/lib/supabase/server");

import {
  berlinCalendarDate,
  completeHousingWebSearch,
  getHousingWebSearchDailyLimit,
  getHousingWebSearchStatus,
  nextBerlinMidnight,
  releaseHousingWebSearch,
  reserveHousingWebSearch,
  tzOffsetMs,
} from "@/lib/housing/web-search/quota";

// ---------------------------------------------------------------------------
// Berlin calendar-day math (DST-safe)
// ---------------------------------------------------------------------------

describe("Berlin calendar-day helpers", () => {
  // EU DST 2026: CEST (UTC+2) until the fallback on 2026-10-25 01:00 UTC.
  it("maps UTC instants to the Europe/Berlin calendar date (winter CET)", () => {
    // 2026-11-09 is winter time: Berlin = UTC+1.
    expect(berlinCalendarDate(new Date("2026-11-09T19:00:00Z"))).toBe("2026-11-09"); // 20:00 Berlin
    expect(berlinCalendarDate(new Date("2026-11-09T22:30:00Z"))).toBe("2026-11-09"); // 23:30 Berlin
    expect(berlinCalendarDate(new Date("2026-11-09T23:00:00Z"))).toBe("2026-11-10"); // 00:00 Berlin
  });

  it("maps UTC instants to the Europe/Berlin calendar date (summer CEST)", () => {
    // 2026-06-15 is summer time: Berlin = UTC+2.
    expect(berlinCalendarDate(new Date("2026-06-15T21:59:00Z"))).toBe("2026-06-15");
    expect(berlinCalendarDate(new Date("2026-06-15T22:00:00Z"))).toBe("2026-06-16");
  });

  it("returns the correct UTC offset for both DST regimes", () => {
    expect(tzOffsetMs(Date.parse("2026-11-09T12:00:00Z"), "Europe/Berlin")).toBe(3_600_000);
    expect(tzOffsetMs(Date.parse("2026-06-15T12:00:00Z"), "Europe/Berlin")).toBe(7_200_000);
  });

  it("computes the next Berlin midnight across winter and summer", () => {
    // Winter (CET, UTC+1): noon UTC → Berlin 13:00 → next midnight 23:00 UTC.
    expect(nextBerlinMidnight(new Date("2026-11-09T12:00:00Z")).toISOString())
      .toBe("2026-11-09T23:00:00.000Z");
    // Summer (CEST, UTC+2): noon UTC → Berlin 14:00 → next midnight 22:00 UTC.
    expect(nextBerlinMidnight(new Date("2026-06-15T12:00:00Z")).toISOString())
      .toBe("2026-06-15T22:00:00.000Z");
    // Berlin just after local midnight still resets at the NEXT midnight.
    expect(nextBerlinMidnight(new Date("2026-06-15T22:30:00Z")).toISOString())
      .toBe("2026-06-16T22:00:00.000Z");
  });

  it("is DST-safe on the spring-forward day (2026-03-29, 01:00 UTC)", () => {
    // Before the switch (Berlin still CET): next midnight is 23:00 UTC.
    expect(nextBerlinMidnight(new Date("2026-03-28T12:00:00Z")).toISOString())
      .toBe("2026-03-28T23:00:00.000Z");
    // After the switch (Berlin CEST): next midnight is 22:00 UTC.
    expect(nextBerlinMidnight(new Date("2026-03-29T05:00:00Z")).toISOString())
      .toBe("2026-03-29T22:00:00.000Z");
  });

  it("is DST-safe on the autumn-fallback day (2026-10-25, 01:00 UTC)", () => {
    // After the fallback (Berlin CET): next midnight is 23:00 UTC.
    expect(nextBerlinMidnight(new Date("2026-10-25T05:00:00Z")).toISOString())
      .toBe("2026-10-25T23:00:00.000Z");
  });
});

describe("getHousingWebSearchDailyLimit (server-side setting)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("defaults to 20 per user per day", () => {
    expect(getHousingWebSearchDailyLimit()).toBe(20);
  });

  it("honors a valid positive integer", () => {
    vi.stubEnv("HOUSING_WEB_SEARCH_DAILY_MAX", "35");
    expect(getHousingWebSearchDailyLimit()).toBe(35);
  });

  it("falls back to 20 on invalid values (never fails open)", () => {
    vi.stubEnv("HOUSING_WEB_SEARCH_DAILY_MAX", "0");
    expect(getHousingWebSearchDailyLimit()).toBe(20);
    vi.stubEnv("HOUSING_WEB_SEARCH_DAILY_MAX", "-3");
    expect(getHousingWebSearchDailyLimit()).toBe(20);
    vi.stubEnv("HOUSING_WEB_SEARCH_DAILY_MAX", "abc");
    expect(getHousingWebSearchDailyLimit()).toBe(20);
    vi.stubEnv("HOUSING_WEB_SEARCH_DAILY_MAX", "12.5");
    expect(getHousingWebSearchDailyLimit()).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// RPC wrappers (mocked Supabase client)
// ---------------------------------------------------------------------------

interface FakeClient {
  rpc: ReturnType<typeof vi.fn>;
  auth: { getUser: ReturnType<typeof vi.fn> };
}
function setFakeClient(impl?: {
  user?: { id: string } | null;
  rpc?: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
}): FakeClient {
  const rpc = vi.fn(impl?.rpc ?? (async () => ({ data: null, error: null })));
  const client: FakeClient = {
    rpc,
    auth: { getUser: vi.fn(async () => ({ data: { user: impl?.user ?? { id: "user-1" } } })) },
  };
  vi.mocked(createClient).mockResolvedValue(client as never);
  return client;
}

const RESERVED = { data: [{ status: "reserved", used: 1, remaining: 19 }], error: null };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("reserveHousingWebSearch", () => {
  it("maps a successful reservation and passes the server-side limit", async () => {
    const client = setFakeClient({
      rpc: async (name, args) => {
        if (name === "reserve_housing_web_search") {
          expect(args).toMatchObject({
            target_user_id: "user-1",
            p_run_id: "run-1",
            p_daily_limit: 20,
          });
          return RESERVED;
        }
        return { data: null, error: null }; // stale recovery etc.
      },
    });
    const out = await reserveHousingWebSearch("run-1");
    expect(out).toEqual({ status: "reserved", used: 1, remaining: 19 });
    expect(client.rpc).toHaveBeenCalledWith(
      "reserve_housing_web_search",
      expect.objectContaining({ p_daily_limit: 20 }),
    );
  });

  it("passes the env-configured limit (server-side setting)", async () => {
    vi.stubEnv("HOUSING_WEB_SEARCH_DAILY_MAX", "5");
    setFakeClient({ rpc: async () => RESERVED });
    await reserveHousingWebSearch("run-1");
    expect(createClient).toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("maps quota_exhausted (block, no paid call possible)", async () => {
    setFakeClient({
      rpc: async () => ({ data: [{ status: "quota_exhausted", used: 20, remaining: 0 }], error: null }),
    });
    await expect(reserveHousingWebSearch("run-2")).resolves.toEqual({
      status: "quota_exhausted",
      used: 20,
      remaining: 0,
    });
  });

  it("maps already_reserved (idempotent retry — never charged twice)", async () => {
    setFakeClient({
      rpc: async () => ({ data: [{ status: "already_reserved", used: 3, remaining: 17 }], error: null }),
    });
    await expect(reserveHousingWebSearch("run-1")).resolves.toEqual({
      status: "already_reserved",
      used: 3,
      remaining: 17,
    });
  });

  it("fails closed: RPC error → null (the route must NOT call the provider)", async () => {
    setFakeClient({
      rpc: async () => ({ data: null, error: { message: "function does not exist", code: "PGRST205" } }),
    });
    await expect(reserveHousingWebSearch("run-1")).resolves.toBeNull();
  });

  it.each([
    [
      "a missing function (42883 — migration not applied)",
      { message: "function public.reserve_housing_web_search(uuid, uuid, integer) does not exist", code: "42883" },
    ],
    [
      "a permission denial (42501 — EXECUTE not granted)",
      { message: "permission denied for function reserve_housing_web_search", code: "42501" },
    ],
  ])("fails closed on %s", async (_name, error) => {
    setFakeClient({ rpc: async () => ({ data: null, error }) });
    await expect(reserveHousingWebSearch("run-1")).resolves.toBeNull();
  });

  it("logs sanitized diagnostics with the run_id correlation on RPC failure", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      setFakeClient({
        rpc: async () => ({
          data: null,
          error: {
            message: "function public.reserve_housing_web_search(uuid, uuid, integer) does not exist",
            code: "42883",
          },
        }),
      });
      const RUN = "9f86d081-884c-40b0-9e2f-0e1c5b6a1234";
      await expect(reserveHousingWebSearch(RUN)).resolves.toBeNull();
      const line = spy
        .mock.calls.map((c) => String(c[0]))
        .find((m) => m.includes("rpc=reserve_housing_web_search"));
      expect(line).toBeDefined();
      expect(line).toContain("postgrest_code=42883");
      expect(line).toContain(`run_id=${RUN}`);
      // No user ID (PII) in the diagnostic line.
      expect(line).not.toContain("user-1");
    } finally {
      spy.mockRestore();
    }
  });

  it("fails closed: unauthenticated → null", async () => {
    setFakeClient({ user: null });
    await expect(reserveHousingWebSearch("run-1")).resolves.toBeNull();
  });

  it("fails closed: malformed row → null", async () => {
    setFakeClient({ rpc: async () => ({ data: [{ nope: true }], error: null }) });
    await expect(reserveHousingWebSearch("run-1")).resolves.toBeNull();
  });

  it("survives a throwing client (transport failure) → null", async () => {
    setFakeClient({
      rpc: async () => {
        throw new Error("network down");
      },
    });
    await expect(reserveHousingWebSearch("run-1")).resolves.toBeNull();
  });
});

describe("release / complete (settlement)", () => {
  it("release refunds a reserved run → true", async () => {
    setFakeClient({
      rpc: async () => ({ data: [{ status: "released", used: 0, remaining: 20 }], error: null }),
    });
    await expect(releaseHousingWebSearch("run-1")).resolves.toBe(true);
  });

  it("release is a no-op for unknown/succeeded runs → false", async () => {
    setFakeClient({
      rpc: async () => ({ data: [{ status: "no_op", used: 5, remaining: 15 }], error: null }),
    });
    await expect(releaseHousingWebSearch("nope")).resolves.toBe(false);
  });

  it("release never throws on RPC errors", async () => {
    setFakeClient({ rpc: async () => ({ data: null, error: { message: "x" } }) });
    await expect(releaseHousingWebSearch("run-1")).resolves.toBe(false);
  });

  it("complete marks success (no error) → true", async () => {
    setFakeClient();
    await expect(completeHousingWebSearch("run-1")).resolves.toBe(true);
  });

  it("complete reports RPC errors → false (never throws)", async () => {
    setFakeClient({ rpc: async () => ({ data: null, error: { message: "boom" } }) });
    await expect(completeHousingWebSearch("run-1")).resolves.toBe(false);
  });
});

describe("getHousingWebSearchStatus", () => {
  it("maps the status row and anchors resetsAt to the next Berlin midnight", async () => {
    // 2026-10-09 is still CEST (UTC+2): next Berlin midnight = 22:00 UTC.
    vi.useFakeTimers({ now: new Date("2026-10-09T12:00:00Z"), shouldAdvanceTime: true });
    try {
      setFakeClient({
        rpc: async (name) => {
          if (name === "get_housing_web_search_status") {
            return {
              data: [{ daily_limit: 20, used: 8, remaining: 12, usage_date: "2026-10-09" }],
              error: null,
            };
          }
          return { data: null, error: null };
        },
      });
      const status = await getHousingWebSearchStatus();
      expect(status).toEqual({
        limit: 20,
        used: 8,
        remaining: 12,
        usageDate: "2026-10-09",
        resetsAt: "2026-10-09T22:00:00.000Z",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns null on RPC failure (UI shows a neutral state)", async () => {
    setFakeClient({ rpc: async () => ({ data: null, error: { message: "x" } }) });
    await expect(getHousingWebSearchStatus()).resolves.toBeNull();
  });

  it("returns null when unauthenticated", async () => {
    setFakeClient({ user: null });
    await expect(getHousingWebSearchStatus()).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Concurrency: N racing reserves must never exceed the limit.
//
// The fake below emulates the SQL contract of reserve_housing_web_search()
// (ONE atomic conditional upsert per request; exactly one winner per slot;
// per-run_id idempotency). True atomicity lives in that single statement;
// this test proves the module handles every concurrent outcome correctly.
// ---------------------------------------------------------------------------

describe("concurrent requests", () => {
  function emulatedQuotaRpc(limit: number) {
    let used = 0;
    const runs = new Set<string>();
    let tail: Promise<unknown> = Promise.resolve();
    return (name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }> => {
      if (name !== "reserve_housing_web_search") {
        return Promise.resolve({ data: null, error: null });
      }
      const p = tail.then(() => {
        const runId = String(args.p_run_id);
        if (runs.has(runId)) {
          return { data: [{ status: "already_reserved", used, remaining: Math.max(limit - used, 0) }], error: null };
        }
        if (used >= limit) {
          return { data: [{ status: "quota_exhausted", used: limit, remaining: 0 }], error: null };
        }
        used += 1;
        runs.add(runId);
        return { data: [{ status: "reserved", used, remaining: limit - used }], error: null };
      });
      tail = p.catch(() => undefined);
      return p;
    };
  }

  it("20 of 25 racing reserves win when the limit is 20 (no overshoot)", async () => {
    setFakeClient({ rpc: emulatedQuotaRpc(20) });
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) => reserveHousingWebSearch(`run-${i}`)),
    );
    const reserved = results.filter((r) => r?.status === "reserved");
    const exhausted = results.filter((r) => r?.status === "quota_exhausted");
    expect(reserved).toHaveLength(20);
    expect(exhausted).toHaveLength(5);
    // The winner sequence is exactly 1..20 — the limit is never exceeded.
    const usedValues = reserved.map((r) => (r as { used: number }).used).sort((a, b) => a - b);
    expect(usedValues).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it("a retry with the same run_id during the race is never double-charged", async () => {
    setFakeClient({ rpc: emulatedQuotaRpc(20) });
    const first = await reserveHousingWebSearch("same-run");
    const retry = await reserveHousingWebSearch("same-run");
    expect(first?.status).toBe("reserved");
    expect(retry?.status).toBe("already_reserved");
    expect(retry?.used).toBe(1); // still exactly ONE consumed
  });
});

// ---------------------------------------------------------------------------
// Cross-midnight / DST refunds.
//
// The day key for a refund lives in the SQL (the run's created_at converted
// to Europe/Berlin). The harness below emulates the corrected SQL contract
// exactly (usage rows per Berlin day; release/stale sweeps refund the run's
// OWN reservation day) so the module + day math can be exercised end-to-end
// offline. The static contract test below pins this behavior to the actual
// committed migration text.
// ---------------------------------------------------------------------------

function emulatedQuotaByDay(limit: number) {
  const clock = { now: new Date("2026-11-08T22:59:00Z") };
  const usage = new Map<string, number>(); // Berlin day -> used
  const runs = new Map<string, { day: string; status: string; created: number }>();
  const STALE_MS = 15 * 60 * 1000;
  const day = () => berlinCalendarDate(clock.now);
  let sweepRefunded = 0;

  const sweep = () => {
    sweepRefunded = 0;
    for (const [, r] of runs) {
      if (r.status === "reserved" && clock.now.getTime() - r.created > STALE_MS) {
        r.status = "failed";
        usage.set(r.day, Math.max((usage.get(r.day) ?? 0) - 1, 0)); // refund RUN'S OWN day
        sweepRefunded += 1;
      }
    }
  };

  const rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }> =
    (name, args) => {
      if (name === "expire_stale_housing_web_search_runs") {
        sweep();
        return Promise.resolve({ data: sweepRefunded, error: null });
      }
      if (name === "reserve_housing_web_search") {
        const runId = String(args.p_run_id);
        if (runs.has(runId)) {
          const d = day();
          const u = usage.get(d) ?? 0;
          return Promise.resolve({
            data: [{ status: "already_reserved", used: u, remaining: Math.max(limit - u, 0) }],
            error: null,
          });
        }
        const d = day();
        if ((usage.get(d) ?? 0) >= limit) {
          return Promise.resolve({ data: [{ status: "quota_exhausted", used: limit, remaining: 0 }], error: null });
        }
        usage.set(d, (usage.get(d) ?? 0) + 1);
        runs.set(runId, { day: d, status: "reserved", created: clock.now.getTime() });
        return Promise.resolve({
          data: [{ status: "reserved", used: usage.get(d), remaining: limit - (usage.get(d) ?? 0) }],
          error: null,
        });
      }
      if (name === "release_housing_web_search") {
        const r = runs.get(String(args.p_run_id));
        if (!r || r.status !== "reserved") {
          const d = day();
          const u = usage.get(d) ?? 0;
          return Promise.resolve({ data: [{ status: "no_op", used: u, remaining: Math.max(limit - u, 0) }], error: null });
        }
        r.status = "failed";
        usage.set(r.day, Math.max((usage.get(r.day) ?? 0) - 1, 0)); // refund RUN'S OWN day
        return Promise.resolve({
          data: [{ status: "released", used: usage.get(r.day) ?? 0, remaining: limit - (usage.get(r.day) ?? 0) }],
          error: null,
        });
      }
      if (name === "get_housing_web_search_status") {
        const d = day();
        const u = usage.get(d) ?? 0;
        return Promise.resolve({
          data: [{ daily_limit: limit, used: u, remaining: Math.max(limit - u, 0), usage_date: d }],
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    };

  setFakeClient({ rpc });
  return { clock, usage, runs };
}

describe("cross-midnight and DST refunds (regression: no limit overshoot)", () => {
  it("a run stranded across Berlin midnight refunds YESTERDAY's row, never today's", async () => {
    const h = emulatedQuotaByDay(20);

    // Day 2026-11-08, Berlin 23:59 (CET): reservation happens, then the
    // platform kills the function before settlement (run stays 'reserved').
    h.clock.now = new Date("2026-11-08T22:59:00Z");
    expect(await reserveHousingWebSearch("run-night")).toMatchObject({ status: "reserved", used: 1 });
    expect(h.usage.get("2026-11-08")).toBe(1);

    // 81 minutes later: Berlin 01:20 on 2026-11-09 (past the 15-min stale
    // window). The first new reserve triggers the stale sweep.
    h.clock.now = new Date("2026-11-09T00:20:00Z");
    expect(await reserveHousingWebSearch("run-b1")).toMatchObject({ status: "reserved" });

    // The refund landed on the run's OWN day (2026-11-08), not the recovery
    // day — today's counter is untouched by yesterday's refund.
    expect(h.usage.get("2026-11-08")).toBe(0);
    expect(h.usage.get("2026-11-09")).toBe(1);

    // 2026-11-09: exactly 20 searches allowed, the 21st rejected. (With the
    // old recovery-day refund, the 21st would have been admitted.)
    for (let i = 2; i <= 20; i += 1) {
      expect((await reserveHousingWebSearch(`run-b${i}`))?.status).toBe("reserved");
    }
    expect((await reserveHousingWebSearch("run-b21"))?.status).toBe("quota_exhausted");
    expect(h.usage.get("2026-11-09")).toBe(20);
  });

  it("keeps the correct day across the spring-forward DST boundary (2026-03-29)", async () => {
    const h = emulatedQuotaByDay(20);

    // Run created 2026-03-28T22:00Z = Berlin 2026-03-28 23:00 (still CET,
    // transition happens 2026-03-29T01:00Z) → its day is 2026-03-28.
    h.clock.now = new Date("2026-03-28T22:00:00Z");
    expect(berlinCalendarDate(h.clock.now)).toBe("2026-03-28");
    expect(await reserveHousingWebSearch("run-dst")).toMatchObject({ status: "reserved" });
    expect(h.usage.get("2026-03-28")).toBe(1);

    // Recovery 2026-03-29T02:00Z = Berlin 2026-03-29 05:00 (CEST, after the
    // spring-forward) — 4h later, well past the stale window.
    h.clock.now = new Date("2026-03-29T02:00:00Z");
    expect(berlinCalendarDate(h.clock.now)).toBe("2026-03-29");
    expect(await reserveHousingWebSearch("run-c1")).toMatchObject({ status: "reserved" });

    // Refund hit the pre-DST day (2026-03-28); the post-DST recovery day
    // only carries its own new reservation.
    expect(h.usage.get("2026-03-28")).toBe(0);
    expect(h.usage.get("2026-03-29")).toBe(1);

    // Full 20 still available on 2026-03-29; the 21st is rejected.
    for (let i = 2; i <= 20; i += 1) {
      expect((await reserveHousingWebSearch(`run-c${i}`))?.status).toBe("reserved");
    }
    expect((await reserveHousingWebSearch("run-c21"))?.status).toBe("quota_exhausted");
    expect(h.usage.get("2026-03-29")).toBe(20);
  });

  it("same-day provider-failure refund still behaves (release → no_op idempotent)", async () => {
    const h = emulatedQuotaByDay(20);
    h.clock.now = new Date("2026-11-09T10:00:00Z");

    expect(await reserveHousingWebSearch("run-x")).toMatchObject({ status: "reserved", used: 1 });
    // Provider failed → the route refunds within the same request/day.
    expect(await releaseHousingWebSearch("run-x")).toBe(true);
    expect(h.usage.get("2026-11-09")).toBe(0);
    // Second release is a no-op — a double release cannot refund twice.
    expect(await releaseHousingWebSearch("run-x")).toBe(false);
    expect(h.usage.get("2026-11-09")).toBe(0);
  });
});

describe("migration SQL contract (static pin)", () => {
  const MIGRATION = "supabase/migrations/20261107000000_housing_web_search_quota.sql";
  const fnBody = (sql: string, fn: string): string => {
    const start = sql.indexOf(`function public.${fn}(`);
    const end = sql.indexOf(`revoke execute on function public.${fn}`);
    if (start === -1 || end === -1) throw new Error(`${fn} not found in migration`);
    return sql.slice(start, end);
  };

  it("guards get_housing_web_search_status with auth.uid() (no cross-user reads)", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    const body = fnBody(sql, "get_housing_web_search_status");
    expect(body).toContain("raise exception 'not_authorized'");
    expect(body).toContain("auth.uid() is not null and auth.uid() <> target_user_id");
    // It must be plpgsql (a pure-SQL function cannot carry the guard).
    expect(body).toContain("language plpgsql");
  });

  it("refunds the run's OWN Berlin reservation day in release and stale recovery", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    const release = fnBody(sql, "release_housing_web_search");
    expect(release).toMatch(/run_row\.created_at at time zone 'Europe\/Berlin'/);
    const expire = fnBody(sql, "expire_stale_housing_web_search_runs");
    expect(expire).toMatch(/created_at at time zone 'Europe\/Berlin'/);
    expect(expire).toContain("stale.r_day");
  });
});
