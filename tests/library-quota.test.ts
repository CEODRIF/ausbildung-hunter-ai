import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Deutsch Bibliothek — daily download quota: SERVER-SIDE contracts.
 *
 * The quota exists ONLY in the server layer (this file) + the atomic RPC
 * (migration 20261204000000, pinned by library-quota-migration.test.ts).
 * The browser never sees the external URL before authorization and never
 * supplies a plan, user id, or counter — every assertion here pins one of
 * those boundaries:
 *
 *   1. plan matrix: trial=1, plus=10, pro=30, everything else 0 (the map
 *      is exhaustive over PlanId — a missing entry can never grant);
 *   2. the mandate: the exact Arabic free-tier message in all 4 locales;
 *   3. getBookQuotaState: guest → guest state (NO privileged call);
 *      limit 0 → exhausted WITHOUT reading the counter table (and no
 *      profile/plan absence is ever treated as a trial);
 *   4. initiateBookDownload: published-only re-check, entitlement-driven
 *      limit passed to the RPC as p_limit (1/10/30), the RPC result is
 *      the single source of granted/denied, the URL is delivered only on
 *      grant, malformed/denied outcomes fail closed (db_error /
 *      quota_exhausted), and p_user_id is ALWAYS the session user id
 *      (no impersonation path exists in this module).
 *
 * Mock boundary: the supabase clients + the entitlement resolver
 * (getEntitlements is the trusted subscription source — see
 * src/lib/billing/entitlements.ts).
 */

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/config", () => ({
  getSupabaseEnv: () => ({
    supabaseUrl: "https://proj.supabase.co",
    supabaseAnonKey: "anon-test-key",
  }),
}));
vi.mock("@/lib/billing/entitlements", () => ({ getEntitlements: vi.fn() }));

import { createAdminClient } from "@/lib/supabase/admin";
import { getEntitlements } from "@/lib/billing/entitlements";
import { PLAN_IDS } from "@/lib/billing/plans";
import { dictionaries } from "@/lib/i18n/dictionaries";
import {
  BOOK_DOWNLOADS_PER_DAY,
  getBookQuotaState,
  initiateBookDownload,
  isQuotaSchemaMissing,
  utcToday,
} from "@/lib/book-library";

const USER = "11111111-1111-4111-8111-111111111111";
const BOOK_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const PUBLISHED_BOOK = {
  id: BOOK_ID,
  download_url: "https://example.com/buch.pdf",
  published: true,
};

type EntitlementsValue = Awaited<ReturnType<typeof getEntitlements>>;
function ent(
  planId: EntitlementsValue["planId"],
  source: "subscription" | "default",
): EntitlementsValue {
  return {
    planId,
    planLabel: String(planId),
    emailsPerDay: 0,
    aiPerDay: 0,
    subscription: null,
    source,
  };
}

/** Faithful enough admin-client mock: constraint-filtered maybeSingle +
 *  a recordable rpc. */
interface AdminMockState {
  calls: string[];
  tables: Record<string, { rows: Record<string, unknown>[]; error?: unknown }>;
  rpc: ReturnType<typeof vi.fn>;
}

interface MaybeSingleResult {
  data: Record<string, unknown> | null;
  error: unknown;
}
/** The minimal chained query surface the app layer uses. */
interface EqChain {
  eq: (col: string, value: unknown) => EqChain;
  maybeSingle: () => Promise<MaybeSingleResult>;
}

function makeAdminMock(): AdminMockState {
  const state: AdminMockState = { calls: [], tables: {}, rpc: vi.fn() };
  vi.mocked(createAdminClient).mockReturnValue({
    from: (table: string) => {
      state.calls.push(`from:${table}`);
      const constraints: Record<string, unknown> = {};
      return {
        select: (sel: string) => {
          state.calls.push(`select:${sel}`);
          // Chainable: the quota read uses .eq(user_id).eq(quota_day).
          function eq(col: string, value: unknown): EqChain {
            constraints[col] = value;
            state.calls.push(`eq:${col}=${String(value)}`);
            return {
              eq,
              maybeSingle: () =>
                Promise.resolve({
                  data:
                    state.tables[table]?.rows.find((row) =>
                      Object.entries(constraints).every(
                        ([k, v]) => row[k] === v,
                      ),
                    ) ?? null,
                  error: state.tables[table]?.error ?? null,
                }),
            };
          }
          return { eq };
        },
      };
    },
    rpc: state.rpc,
  } as never);
  return state;
}

/** Convenience: published book visible to the app layer. */
function withBook(state: AdminMockState, published: boolean = true) {
  state.tables.german_books = {
    rows: [{ ...PUBLISHED_BOOK, published }],
  };
}

function rpcGrant(
  granted: boolean,
  usedCount: number,
  limit: number,
  deduplicated = false,
) {
  return {
    data: { granted, deduplicated, date: utcToday(), used_count: usedCount, limit },
    error: null,
  };
}

afterEach(() => vi.clearAllMocks());

// ---------------------------------------------------------------------------
// 1. Plan matrix (the spec's numbers, fail-closed for everything else)
// ---------------------------------------------------------------------------

describe("BOOK_DOWNLOADS_PER_DAY — plan matrix", () => {
  it("grants exactly the spec'd limits: trial 1, plus 10, pro 30", () => {
    expect(BOOK_DOWNLOADS_PER_DAY.trial).toBe(1);
    expect(BOOK_DOWNLOADS_PER_DAY.plus).toBe(10);
    expect(BOOK_DOWNLOADS_PER_DAY.pro).toBe(30);
  });

  it("grants 0 for the free sentinel and the premium_* commercial plans", () => {
    expect(BOOK_DOWNLOADS_PER_DAY.free).toBe(0);
    expect(BOOK_DOWNLOADS_PER_DAY.premium_10d).toBe(0);
    expect(BOOK_DOWNLOADS_PER_DAY.premium_monthly).toBe(0);
  });

  it("is exhaustive over PlanId (a new plan can never grant by omission)", () => {
    expect(Object.keys(BOOK_DOWNLOADS_PER_DAY).sort()).toEqual(
      [...PLAN_IDS].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// 2. The mandated free-tier message (exact string, all four locales)
// ---------------------------------------------------------------------------

describe("exhausted free-tier message (mandate)", () => {
  it("is the EXACT Arabic string in every locale", () => {
    for (const lang of Object.keys(dictionaries)) {
      const dict = dictionaries[lang as keyof typeof dictionaries];
      expect(dict.library.quota.exhaustedFree, `locale ${lang}`).toBe(
        "لقد انتهت حصتك المجانية",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 3. getBookQuotaState (display / pre-check — trusted inputs only)
// ---------------------------------------------------------------------------

describe("getBookQuotaState", () => {
  it("guest (null user) → guest state, zero privileged calls", async () => {
    const state = makeAdminMock();
    const result = await getBookQuotaState(null);
    expect(result).toEqual({
      state: "guest",
      tier: "none",
      limit: 0,
      used: 0,
      remaining: 0,
    });
    expect(state.calls).toEqual([]);
    expect(getEntitlements).not.toHaveBeenCalled();
  });

  it("expired trial / no subscription (default source) → exhausted at 0, no counter read", async () => {
    const state = makeAdminMock();
    vi.mocked(getEntitlements).mockResolvedValue(ent("free", "default"));
    const result = await getBookQuotaState(USER);
    expect(result.state).toBe("exhausted");
    expect(result.limit).toBe(0);
    expect(result.tier).toBe("none");
    // The absence of a plan is never treated as a trial.
    expect(state.calls.filter((c) => c.startsWith("from:"))).toEqual([]);
  });

  it("active trial with nothing used today → ready, 1 left of 1", async () => {
    const state = makeAdminMock();
    vi.mocked(getEntitlements).mockResolvedValue(ent("trial", "subscription"));
    state.tables.book_download_quota = { rows: [] };
    const result = await getBookQuotaState(USER);
    expect(result).toEqual({
      state: "ready",
      tier: "trial",
      limit: 1,
      used: 0,
      remaining: 1,
    });
    // The counter read is keyed by the UTC day (the reset convention).
    expect(state.calls).toContain("from:book_download_quota");
    expect(state.calls).toContain(`eq:quota_day=${utcToday()}`);
    expect(state.calls).toContain(`eq:user_id=${USER}`);
  });

  it("active trial with the one download used → exhausted (remaining 0)", async () => {
    const state = makeAdminMock();
    vi.mocked(getEntitlements).mockResolvedValue(ent("trial", "subscription"));
    state.tables.book_download_quota = {
      rows: [{ user_id: USER, quota_day: utcToday(), used_count: 1 }],
    };
    const result = await getBookQuotaState(USER);
    expect(result).toEqual({
      state: "exhausted",
      tier: "trial",
      limit: 1,
      used: 1,
      remaining: 0,
    });
  });

  it("plus mid-day (5 of 10 used) → ready with 5 left", async () => {
    const state = makeAdminMock();
    vi.mocked(getEntitlements).mockResolvedValue(ent("plus", "subscription"));
    state.tables.book_download_quota = {
      rows: [{ user_id: USER, quota_day: utcToday(), used_count: 5 }],
    };
    const result = await getBookQuotaState(USER);
    expect(result).toEqual({
      state: "ready",
      tier: "plus",
      limit: 10,
      used: 5,
      remaining: 5,
    });
  });

  it("NEXT-DAY RESET: yesterday's row does not count against today", async () => {
    const state = makeAdminMock();
    vi.mocked(getEntitlements).mockResolvedValue(ent("trial", "subscription"));
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    expect(yesterday).not.toBe(utcToday()); // guard: the test is meaningful
    state.tables.book_download_quota = {
      rows: [{ user_id: USER, quota_day: yesterday, used_count: 1 }],
    };
    // Today's key has no row → a fresh, full allotment.
    const result = await getBookQuotaState(USER);
    expect(result.state).toBe("ready");
    expect(result.used).toBe(0);
    expect(result.remaining).toBe(1);
  });

  it("reads ONLY the session user's rows (no cross-user counter read)", async () => {
    const other = "22222222-2222-4222-8222-222222222222";
    const state = makeAdminMock();
    vi.mocked(getEntitlements).mockResolvedValue(ent("pro", "subscription"));
    state.tables.book_download_quota = {
      rows: [
        { user_id: USER, quota_day: utcToday(), used_count: 0 },
        { user_id: other, quota_day: utcToday(), used_count: 29 },
      ],
    };
    const result = await getBookQuotaState(USER);
    // The mock filters by BOTH constraints — the other user's row is
    // invisible; this proves the query carries the session user_id.
    expect(result.used).toBe(0);
    expect(result.remaining).toBe(30);
    expect(state.calls).toContain(`eq:user_id=${USER}`);
    expect(state.calls).not.toContain(`eq:user_id=${other}`);
  });
});

// ---------------------------------------------------------------------------
// 4. initiateBookDownload — authorization gates (no grant before the RPC)
// ---------------------------------------------------------------------------

describe("initiateBookDownload — gates", () => {
  it("rejects a malformed book id before ANY privileged call", async () => {
    const state = makeAdminMock();
    const result = await initiateBookDownload(USER, "not-a-uuid");
    expect(result).toEqual({
      ok: false,
      error: "book_unavailable",
      remaining: 0,
      tier: "none",
    });
    expect(state.calls).toEqual([]);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("a missing book → book_unavailable, no RPC", async () => {
    const state = makeAdminMock();
    state.tables.german_books = { rows: [] };
    vi.mocked(getEntitlements).mockResolvedValue(ent("trial", "subscription"));
    const result = await initiateBookDownload(USER, BOOK_ID);
    expect(result.ok === false && result.error).toBe("book_unavailable");
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("an UNPUBLISHED book → book_unavailable, no RPC (re-checked server-side)", async () => {
    const state = makeAdminMock();
    withBook(state, /* published */ false);
    vi.mocked(getEntitlements).mockResolvedValue(ent("pro", "subscription"));
    const result = await initiateBookDownload(USER, BOOK_ID);
    expect(result.ok === false && result.error).toBe("book_unavailable");
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("expired trial (no current subscription) → no_eligible_plan, no RPC", async () => {
    // getEntitlements already resolved the expired row to the fail-closed
    // default state — the quota layer must act on that and nothing else.
    const state = makeAdminMock();
    withBook(state);
    vi.mocked(getEntitlements).mockResolvedValue(ent("free", "default"));
    const result = await initiateBookDownload(USER, BOOK_ID);
    expect(result).toEqual({
      ok: false,
      error: "no_eligible_plan",
      remaining: 0,
      tier: "none",
    });
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("legacy `free` row (even when subscription-sourced) grants nothing", async () => {
    const state = makeAdminMock();
    withBook(state);
    vi.mocked(getEntitlements).mockResolvedValue(ent("free", "subscription"));
    const result = await initiateBookDownload(USER, BOOK_ID);
    expect(result.ok === false && result.error).toBe("no_eligible_plan");
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("premium_monthly (subscription-sourced but 0 in the matrix) grants nothing", async () => {
    const state = makeAdminMock();
    withBook(state);
    vi.mocked(getEntitlements).mockResolvedValue(
      ent("premium_monthly", "subscription"),
    );
    const result = await initiateBookDownload(USER, BOOK_ID);
    expect(result.ok === false && result.error).toBe("no_eligible_plan");
    expect(state.rpc).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 5. initiateBookDownload — the RPC is the single consume path
// ---------------------------------------------------------------------------

describe("initiateBookDownload — quota consume", () => {
  it("active trial: limit 1 is passed to the RPC; the grant delivers the URL with remaining 0", async () => {
    const state = makeAdminMock();
    withBook(state);
    vi.mocked(getEntitlements).mockResolvedValue(ent("trial", "subscription"));
    state.rpc.mockResolvedValue(rpcGrant(true, 1, 1));
    const result = await initiateBookDownload(USER, BOOK_ID);
    expect(state.rpc).toHaveBeenCalledTimes(1);
    expect(state.rpc).toHaveBeenCalledWith("reserve_book_download", {
      p_user_id: USER,
      p_book_id: BOOK_ID,
      p_limit: 1,
    });
    expect(result).toEqual({
      ok: true,
      url: PUBLISHED_BOOK.download_url,
      remaining: 0,
      tier: "trial",
      deduplicated: false,
    });
  });

  it("active trial already used today: the RPC denies → quota_exhausted, no URL", async () => {
    const state = makeAdminMock();
    withBook(state);
    vi.mocked(getEntitlements).mockResolvedValue(ent("trial", "subscription"));
    state.rpc.mockResolvedValue(rpcGrant(false, 1, 1));
    const result = await initiateBookDownload(USER, BOOK_ID);
    expect(result).toEqual({
      ok: false,
      error: "quota_exhausted",
      remaining: 0,
      tier: "trial",
    });
  });

  it("plus: limit 10; a 9th download is granted with 1 remaining", async () => {
    const state = makeAdminMock();
    withBook(state);
    vi.mocked(getEntitlements).mockResolvedValue(ent("plus", "subscription"));
    state.rpc.mockResolvedValue(rpcGrant(true, 9, 10));
    const result = await initiateBookDownload(USER, BOOK_ID);
    expect(state.rpc).toHaveBeenCalledWith("reserve_book_download", {
      p_user_id: USER,
      p_book_id: BOOK_ID,
      p_limit: 10,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.remaining).toBe(1);
      expect(result.tier).toBe("plus");
    }
  });

  it("plus at 10 of 10: denied → quota_exhausted", async () => {
    const state = makeAdminMock();
    withBook(state);
    vi.mocked(getEntitlements).mockResolvedValue(ent("plus", "subscription"));
    state.rpc.mockResolvedValue(rpcGrant(false, 10, 10));
    const result = await initiateBookDownload(USER, BOOK_ID);
    expect(result.ok === false && result.error).toBe("quota_exhausted");
  });

  it("pro: limit 30; a 30th download is granted with 0 remaining", async () => {
    const state = makeAdminMock();
    withBook(state);
    vi.mocked(getEntitlements).mockResolvedValue(ent("pro", "subscription"));
    state.rpc.mockResolvedValue(rpcGrant(true, 30, 30));
    const result = await initiateBookDownload(USER, BOOK_ID);
    expect(state.rpc).toHaveBeenCalledWith("reserve_book_download", {
      p_user_id: USER,
      p_book_id: BOOK_ID,
      p_limit: 30,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.remaining).toBe(0);
      expect(result.tier).toBe("pro");
    }
  });

  it("concurrent/duplicate same-book retry within the window is DEDUPED (granted, not re-counted)", async () => {
    const state = makeAdminMock();
    withBook(state);
    vi.mocked(getEntitlements).mockResolvedValue(ent("trial", "subscription"));
    // The RPC saw the same book <10 s earlier → grants WITHOUT incrementing.
    state.rpc.mockResolvedValue(rpcGrant(true, 1, 1, /* deduplicated */ true));
    const result = await initiateBookDownload(USER, BOOK_ID);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.deduplicated).toBe(true);
      expect(result.remaining).toBe(0); // 1 of 1 was consumed by the FIRST request
    }
  });

  it("RPC failure because the QUOTA TABLE is missing (42P01) → quota_unavailable, loud migration log, no grant", async () => {
    const state = makeAdminMock();
    withBook(state);
    vi.mocked(getEntitlements).mockResolvedValue(ent("pro", "subscription"));
    state.rpc.mockResolvedValue({
      data: null,
      error: {
        message: 'relation "public.book_download_quota" does not exist',
        details: "",
        hint: "",
        code: "42P01",
      },
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await initiateBookDownload(USER, BOOK_ID);
    expect(result).toEqual({
      ok: false,
      error: "quota_unavailable",
      remaining: 0,
      tier: "pro",
    });
    // The log names the exact artifact to apply (deployment gap, not a
    // transient fault) — and never a URL, token, or book id.
    const logged = spy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("20261204000000_book_download_quota.sql");
    expect(logged).not.toContain(PUBLISHED_BOOK.download_url);
    spy.mockRestore();
  });

  it("RPC failure because the FUNCTION is missing (PostgREST 404 schema cache) → quota_unavailable", async () => {
    const state = makeAdminMock();
    withBook(state);
    vi.mocked(getEntitlements).mockResolvedValue(ent("trial", "subscription"));
    state.rpc.mockResolvedValue({
      data: null,
      error: {
        message: "schema cache",
        details:
          'Resource "public.reserve_book_download" not found in the schema cache',
        hint: "",
        code: "PGRST202",
      },
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await initiateBookDownload(USER, BOOK_ID);
    expect(result.ok === false && result.error).toBe("quota_unavailable");
    const logged = spy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("20261204000000_book_download_quota.sql");
    spy.mockRestore();
  });

  it("a RUNTIME SQL fault inside the RPC (not a missing schema) stays db_error", async () => {
    const state = makeAdminMock();
    withBook(state);
    vi.mocked(getEntitlements).mockResolvedValue(ent("pro", "subscription"));
    state.rpc.mockResolvedValue({
      data: null,
      error: {
        message: "invalid_quota_limit",
        details: "",
        hint: "",
        code: "P0001",
      },
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await initiateBookDownload(USER, BOOK_ID);
    expect(result.ok === false && result.error).toBe("db_error");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("a malformed RPC payload (no granted flag) fails closed → db_error", async () => {
    const state = makeAdminMock();
    withBook(state);
    vi.mocked(getEntitlements).mockResolvedValue(ent("pro", "subscription"));
    state.rpc.mockResolvedValue({ data: { surprise: true }, error: null });
    const result = await initiateBookDownload(USER, BOOK_ID);
    expect(result.ok === false && result.error).toBe("db_error");
  });

  it("the house jsonb unwrap idiom: a 1-row array result is honored", async () => {
    const state = makeAdminMock();
    withBook(state);
    vi.mocked(getEntitlements).mockResolvedValue(ent("plus", "subscription"));
    state.rpc.mockResolvedValue({
      data: [{ granted: true, deduplicated: false, used_count: 1, limit: 10 }],
      error: null,
    });
    const result = await initiateBookDownload(USER, BOOK_ID);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.remaining).toBe(9);
  });

  it("p_user_id is ALWAYS the session user id (no impersonation surface)", async () => {
    // The module accepts exactly (userId, bookId) — the userId is produced
    // by the server action from the session only. Whatever is passed in is
    // the only actor that can be consumed; there is no second identity
    // input to forge.
    const state = makeAdminMock();
    withBook(state);
    vi.mocked(getEntitlements).mockResolvedValue(ent("pro", "subscription"));
    state.rpc.mockResolvedValue(rpcGrant(true, 1, 30));
    await initiateBookDownload(USER, BOOK_ID);
    const args = vi.mocked(state.rpc).mock.calls[0][1] as Record<
      string,
      unknown
    >;
    expect(args.p_user_id).toBe(USER);
    expect(args).not.toHaveProperty("actor_id");
    expect(args).not.toHaveProperty("user_id");
    expect(args).not.toHaveProperty("plan");
    expect(args).not.toHaveProperty("remaining");
  });

  it("exactly ONE rpc call per initiation (no app-level double consume)", async () => {
    const state = makeAdminMock();
    withBook(state);
    vi.mocked(getEntitlements).mockResolvedValue(ent("pro", "subscription"));
    state.rpc.mockResolvedValue(rpcGrant(true, 1, 30));
    await initiateBookDownload(USER, BOOK_ID);
    await initiateBookDownload(USER, BOOK_ID);
    expect(state.rpc).toHaveBeenCalledTimes(2); // one per explicit initiation
  });
});

// ---------------------------------------------------------------------------
// 6. Day key helper (must agree with the RPC's (timezone('utc', now()))::date)
// ---------------------------------------------------------------------------

describe("utcToday — the reset key", () => {
  it("is a UTC YYYY-MM-DD string", () => {
    const today = utcToday();
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(today).toBe(new Date().toISOString().slice(0, 10));
  });
});

// ---------------------------------------------------------------------------
// 7. Failure classification (deployment gap vs transient fault)
// ---------------------------------------------------------------------------

describe("isQuotaSchemaMissing — RPC failure classification", () => {
  it("detects a missing function (Postgres + PostgREST spellings)", () => {
    expect(
      isQuotaSchemaMissing({
        message: 'function public.reserve_book_download(uuid,uuid,integer) does not exist',
        code: "42883",
      }),
    ).toBe(true);
    expect(
      isQuotaSchemaMissing({
        message: "schema cache",
        details:
          'Resource "public.reserve_book_download" not found in the schema cache',
        code: "PGRST202",
      }),
    ).toBe(true);
    expect(isQuotaSchemaMissing({ message: "Could not find the function", code: "PGRST204" })).toBe(true);
  });

  it("detects a missing quota table (42P01 or the message alone)", () => {
    expect(
      isQuotaSchemaMissing({
        message: 'relation "public.book_download_quota" does not exist',
        code: "42P01",
      }),
    ).toBe(true);
    // Code-less message (some PostgREST versions only carry the text).
    expect(isQuotaSchemaMissing({ message: "relation book_download_quota does not exist" })).toBe(true);
  });

  it("does NOT flag runtime SQL faults or unrelated errors as a schema miss", () => {
    expect(
      isQuotaSchemaMissing({ message: "invalid_quota_limit", code: "P0001" }),
    ).toBe(false);
    expect(
      isQuotaSchemaMissing({ message: "permission denied for table book_download_quota", code: "42501" }),
    ).toBe(false);
    expect(isQuotaSchemaMissing({ message: "connection timeout", code: "08006" })).toBe(false);
    expect(isQuotaSchemaMissing(null)).toBe(false);
    expect(isQuotaSchemaMissing(undefined)).toBe(false);
  });
});

describe("download error messages — locale completeness (regression)", () => {
  it("quota_unavailable is translated in ALL four locales (never a raw key)", () => {
    for (const lang of Object.keys(dictionaries)) {
      const dict = dictionaries[lang as keyof typeof dictionaries];
      const message = dict.library.download.errors.quota_unavailable;
      expect(typeof message, `locale ${lang}`).toBe("string");
      expect((message as string).length, `locale ${lang}`).toBeGreaterThan(10);
      // A raw key leak would be the key itself.
      expect(message).not.toBe("quota_unavailable");
    }
  });
});
