import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Search credits (Phase 16).
 *
 * Two layers are covered:
 *  1. the server library against the RPC boundary (mocked Supabase client),
 *  2. the SQL/route CONTRACTS that make the guarantees real (atomic charge,
 *     idempotency, lazy reset without accumulation, no refund, read-only
 *     RLS). Those cannot be executed without a live Postgres, so the
 *     migration and the route are asserted on their source text — an honest
 *     proxy for DB-level invariants.
 */

const rpcMock = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: rpcMock }),
}));

const {
  chargeSearchCredits,
  getSearchCreditStatus,
  InvalidSearchCountError,
  isAllowedSearchCount,
  remainingAfter,
  SEARCH_COUNT_OPTIONS,
  setSearchStatus,
  FREE_CREDIT_LIMIT,
  FREE_RESET_HOURS,
} = await import("@/lib/search-credits");
const { AI_SEARCH_COUNTS } = await import("@/lib/opportunities/ai-search");

const ROOT = process.cwd();
const MIGRATION = readFileSync(
  path.join(ROOT, "supabase/migrations/20261016000000_search_credits.sql"),
  "utf8",
);
const ROUTE = readFileSync(
  path.join(ROOT, "src/app/api/opportunities/ai-search/route.ts"),
  "utf8",
);
const LIB = readFileSync(path.join(ROOT, "src/lib/search-credits.ts"), "utf8");
const UI = readFileSync(
  path.join(ROOT, "src/components/ai-search.tsx"),
  "utf8",
);
const PAGE = readFileSync(
  path.join(ROOT, "src/app/opportunities/ai-search/page.tsx"),
  "utf8",
);

const USER = "11111111-1111-4111-8111-111111111111";
const SEARCH = "22222222-2222-4222-8222-222222222222";

function chargeRow(overrides: Record<string, unknown> = {}) {
  return {
    status: "charged",
    credit_limit: 150,
    credits_remaining: 125,
    balance_before: 150,
    balance_after: 125,
    resets_at: "2026-10-06T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  rpcMock.mockReset();
});

// ---------------------------------------------------------------------------
// 1. Policy: 150 / 5 days (free) — 500 / 24 h (code activated)
// ---------------------------------------------------------------------------

describe("credit policy", () => {
  it("free users have 150 credits with a 5-day (120 h) cycle", () => {
    expect(FREE_CREDIT_LIMIT).toBe(150);
    expect(FREE_RESET_HOURS).toBe(120);
    // The free default lives in SQL as the fallback branch.
    expect(MIGRATION).toContain("return query select 150, 120;");
  });

  it("reports 150 credits for a normal user (never 500)", async () => {
    rpcMock.mockResolvedValue({
      data: [
        {
          credit_limit: 150,
          credits_remaining: 150,
          reset_hours: 120,
          resets_at: "2026-10-06T00:00:00.000Z",
          premium: false,
        },
      ],
      error: null,
    });
    const status = await getSearchCreditStatus(USER);
    expect(status).toEqual({
      creditLimit: 150,
      creditsRemaining: 150,
      resetHours: 120,
      resetsAt: "2026-10-06T00:00:00.000Z",
      premium: false,
    });
    expect(rpcMock).toHaveBeenCalledWith("get_search_credit_status", {
      target_user_id: USER,
    });
  });

  it("reports 500 / 24 h for a user who activated the premium code", async () => {
    rpcMock.mockResolvedValue({
      data: [
        {
          credit_limit: 500,
          credits_remaining: 500,
          reset_hours: 24,
          resets_at: "2026-10-02T00:00:00.000Z",
          premium: true,
        },
      ],
      error: null,
    });
    const status = await getSearchCreditStatus(USER);
    expect(status.creditLimit).toBe(500);
    expect(status.creditsRemaining).toBe(500);
    expect(status.resetHours).toBe(24);
    expect(status.premium).toBe(true);
  });

  it("premium policy only applies while the code is ACTIVE and linked", () => {
    // SQL: the upgrade is resolved from user_quota_upgrades + invitation_codes
    // (an active code row), never from the request or the frontend.
    expect(MIGRATION).toContain("from public.user_quota_upgrades uqu");
    expect(MIGRATION).toContain("and uqu.active = true");
    expect(MIGRATION).toContain("and ic.is_active = true");
    // The code itself is DATA in invitation_codes with 500 / 24 h.
    expect(MIGRATION).toContain("('CEODRIF0090', 'quota_upgrade', 500, 24, true, 1000)");
    // …and never a literal in the client component or the page.
    expect(UI).not.toContain("CEODRIF0090");
    expect(PAGE).not.toContain("CEODRIF0090");
    expect(LIB).not.toContain("CEODRIF0090");
  });

  it("resets lazily to the LIMIT (no accumulation) and only in SQL", () => {
    // Reset sets the balance back to the limit — never adds to it.
    expect(MIGRATION).toContain("set credits_remaining = policy_limit,");
    expect(MIGRATION).not.toContain("credits_remaining + policy_limit");
    // Lazy: driven by the cycle timestamp on any request, no cron needed.
    expect(MIGRATION).toContain(
      "where c.user_id = target_user_id\n     returning * into credits_row;",
    );
    expect(MIGRATION).toContain("if timezone('utc', now()) >= credits_row.last_reset_at");
    // The reset is audited in the ledger.
    expect(MIGRATION).toContain("policy_limit, 0, policy_limit, 'reset'");
  });
});

// ---------------------------------------------------------------------------
// 2. selected_count === credits charged (nothing else)
// ---------------------------------------------------------------------------

describe("selected count is the price", () => {
  it("accepts exactly the offered options", () => {
    expect([...SEARCH_COUNT_OPTIONS]).toEqual([10, 25, 50, 100]);
    // The credits allow-list and the AI-search options cannot drift apart.
    expect([...SEARCH_COUNT_OPTIONS]).toEqual([...AI_SEARCH_COUNTS]);
    for (const value of SEARCH_COUNT_OPTIONS)
      expect(isAllowedSearchCount(value)).toBe(true);
  });

  it("rejects any other value server-side (18)", async () => {
    for (const value of [0, 15, 101, 150, 500, 1000, -10, 24.5, "25", null])
      expect(isAllowedSearchCount(value)).toBe(false);
    await expect(
      chargeSearchCredits({ userId: USER, searchId: SEARCH, selectedCount: 150 }),
    ).rejects.toBeInstanceOf(InvalidSearchCountError);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it.each([10, 25, 50, 100])(
    "charges exactly %i credits (never a different amount)",
    async (count) => {
      rpcMock.mockResolvedValue({
        data: [
          chargeRow({
            credits_remaining: 150 - count,
            balance_after: 150 - count,
          }),
        ],
        error: null,
      });
      const outcome = await chargeSearchCredits({
        userId: USER,
        searchId: SEARCH,
        selectedCount: count,
      });
      expect(rpcMock).toHaveBeenCalledWith("charge_search_credits", {
        target_user_id: USER,
        p_search_id: SEARCH,
        p_count: count,
      });
      expect(outcome.status).toBe("charged");
      expect(outcome.balanceBefore).toBe(150);
      expect(outcome.balanceAfter).toBe(150 - count);
      expect(outcome.creditsRemaining).toBe(remainingAfter(150, count));
    },
  );

  it("keeps charging the selected count even when fewer results are found (19)", () => {
    // The charge is independent of the result count: the library exposes no
    // refund RPC and the migration defines no refund function (the words only
    // appear in explanatory comments).
    expect(LIB).not.toMatch(/rpc\(\s*"[^"]*refund/i);
    expect(MIGRATION).not.toMatch(/create or replace function public\.[a-z_]*refund/i);
    const statusStart = MIGRATION.indexOf(
      "create or replace function public.set_search_status",
    );
    const statusFn = MIGRATION.slice(
      statusStart,
      MIGRATION.indexOf("$$;", statusStart) + 3,
    );
    expect(statusFn).toContain("update public.searches s");
    // The status function never touches the balance (no refund path).
    expect(statusFn).not.toContain("user_search_credits");
    expect(statusFn).not.toContain("credit_transactions");
  });
});

// ---------------------------------------------------------------------------
// 3. Charge happens BEFORE the search — never after
// ---------------------------------------------------------------------------

describe("charge ordering", () => {
  it("the route charges, then rejects insufficient balances, then runs", () => {
    const chargeAt = ROUTE.indexOf("await chargeSearchCredits(");
    const insufficientAt = ROUTE.indexOf('"insufficient_credits"');
    const reserveAt = ROUTE.indexOf("await reserveAIUsage(");
    const runAt = ROUTE.indexOf("await runAISearch(");
    expect(chargeAt).toBeGreaterThan(-1);
    expect(chargeAt).toBeLessThan(insufficientAt);
    expect(insufficientAt).toBeLessThan(reserveAt);
    expect(reserveAt).toBeLessThan(runAt);
    // No insufficient balance → the run never starts (402 before the stream).
    expect(ROUTE).toContain("{ status: 402 }");
  });

  it("returns insufficient_credits with the balance and never starts a stream", async () => {
    rpcMock.mockResolvedValue({
      data: [
        chargeRow({
          status: "insufficient_credits",
          credits_remaining: 15,
          balance_before: 15,
          balance_after: 15,
        }),
      ],
      error: null,
    });
    const outcome = await chargeSearchCredits({
      userId: USER,
      searchId: SEARCH,
      selectedCount: 25,
    });
    expect(outcome.status).toBe("insufficient_credits");
    if (outcome.status === "insufficient_credits") {
      expect(outcome.required).toBe(25);
      expect(outcome.creditsRemaining).toBe(15);
    }
    // The 402 branch returns before the stream is constructed.
    const guard = ROUTE.slice(
      ROUTE.indexOf('if (charge.status === "insufficient_credits")'),
      ROUTE.indexOf("await reserveAIUsage("),
    );
    expect(guard).not.toContain("runAISearch");
  });

  it("the UI blocks the run regardless of the client state", () => {
    expect(UI).toContain("const sufficientCredits = credits.creditsRemaining >= count;");
    expect(UI).toContain("if (!sufficientCredits) return;");
    expect(UI).toContain("disabled={!hasProfile || !sufficientCredits}");
    expect(UI).toContain("Not enough search credits.");
  });
});

// ---------------------------------------------------------------------------
// 4. Atomicity, idempotency, no refund
// ---------------------------------------------------------------------------

describe("atomic + idempotent charging", () => {
  it("uses a single conditional UPDATE with the balance guard (13)", () => {
    expect(MIGRATION).toContain("set credits_remaining = c.credits_remaining - p_count");
    expect(MIGRATION).toContain("and c.credits_remaining >= p_count");
    // Row-count check: no row updated ⇒ insufficient, nothing charged.
    expect(MIGRATION).toContain("if after_balance is null then");
    expect(MIGRATION).toContain("'insufficient_credits'::text");
    // The row is locked so two concurrent runs cannot pass on the same balance.
    expect(MIGRATION).toContain("for update;");
  });

  it("never charges twice for the same search_id (12, 15)", async () => {
    // SQL-level uniqueness for search charges (double click / retry / replay).
    expect(MIGRATION).toContain(
      "create unique index if not exists credit_transactions_search_charge_idx",
    );
    expect(MIGRATION).toContain(
      "where type = 'search' and search_id is not null;",
    );
    rpcMock.mockResolvedValue({
      data: [
        chargeRow({
          status: "already_charged",
          credits_remaining: 125,
          balance_before: 150,
          balance_after: 125,
        }),
      ],
      error: null,
    });
    const outcome = await chargeSearchCredits({
      userId: USER,
      searchId: SEARCH,
      selectedCount: 25,
    });
    expect(outcome.status).toBe("already_charged");
    // The already-charged replay reports the ORIGINAL txn, not a new charge.
    expect(outcome.balanceAfter).toBe(125);
  });

  it("records one search row per run with the charged amount", () => {
    expect(MIGRATION).toContain(
      "insert into public.searches (search_id, user_id, selected_count, credits_charged, status)",
    );
    expect(MIGRATION).toContain("values (p_search_id, target_user_id, p_count, p_count, 'running')");
    expect(MIGRATION).toContain(
      "check (selected_count in (10, 25, 50, 100))",
    );
  });

  it("client disconnect marks the run interrupted WITHOUT a refund (11)", () => {
    expect(ROUTE).toContain("async cancel()");
    expect(ROUTE).toContain('status: "interrupted"');
    expect(ROUTE).toContain('await setSearchStatus({ userId: user.id, searchId, status: "completed" })');
    expect(ROUTE).toContain('status: "failed"');
  });

  it("status updates accept the full lifecycle and never change a balance", async () => {
    rpcMock.mockResolvedValue({ data: null, error: null });
    for (const status of ["pending", "running", "completed", "failed", "cancelled", "interrupted"] as const) {
      await setSearchStatus({ userId: USER, searchId: SEARCH, status });
      expect(rpcMock).toHaveBeenCalledWith("set_search_status", {
        target_user_id: USER,
        p_search_id: SEARCH,
        p_status: status,
      });
    }
    expect(MIGRATION).toContain(
      "check (status in ('pending', 'running', 'completed', 'failed', 'cancelled', 'interrupted'))",
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Security: server-side only, RLS, no frontend trust
// ---------------------------------------------------------------------------

describe("security", () => {
  it("the balance cannot be modified from the browser (14)", () => {
    // RLS: read-own only, no user write policy, direct writes revoked.
    expect(MIGRATION).toContain(
      "revoke all on public.user_search_credits from anon, authenticated;",
    );
    expect(MIGRATION).toContain(
      "grant select on public.user_search_credits to authenticated;",
    );
    expect(MIGRATION).toContain('create policy "Users can read their own search credits"');
    expect(MIGRATION).not.toMatch(/for update\s+to authenticated/);
    // The library is server-only and reads the user id from the session.
    expect(LIB).toContain('import "server-only";');
    expect(LIB).not.toContain("localStorage");
    // The client component never writes credits — it only renders them.
    expect(UI).not.toContain("setCredits(initialCredits");
    expect(UI).toContain("credits.creditsRemaining");
  });

  it("RPCs reject cross-user calls and validate the count inside SQL (18, 20)", () => {
    // auth.uid() guard in every mutating/reading RPC.
    expect(MIGRATION.match(/if auth\.uid\(\) is not null and auth\.uid\(\) <> target_user_id then/g)?.length).toBe(3);
    expect(MIGRATION).toContain("raise exception 'not_authorized';");
    // Server-side allow-list inside SQL as well.
    expect(MIGRATION).toContain("if p_count is null or p_count not in (10, 25, 50, 100) then");
    expect(MIGRATION).toContain("raise exception 'invalid_search_count';");
    // Ledger is read-own only and append-only for users.
    expect(MIGRATION).toContain(
      "revoke all on public.credit_transactions from anon, authenticated;",
    );
    expect(MIGRATION).toContain(
      "revoke all on public.searches from anon, authenticated;",
    );
    expect(MIGRATION).toContain("grant execute on function public.charge_search_credits(uuid, uuid, integer) to authenticated;");
  });

  it("charges are logged with before/after balances (14)", () => {
    expect(MIGRATION).toContain("create table if not exists public.credit_transactions");
    for (const column of [
      "user_id uuid not null",
      "search_id uuid",
      "amount integer not null",
      "balance_before integer not null",
      "balance_after integer not null",
      "type text not null check (type in ('search', 'reset'))",
    ])
      expect(MIGRATION).toContain(column);
    // The charge is written as a negative amount with both balances.
    expect(MIGRATION).toContain(
      "values (target_user_id, p_search_id, -p_count, before_balance, after_balance, 'search')",
    );
  });

  it("the client sends a requestId so a replay is idempotent (12)", () => {
    expect(UI).toContain("requestId: crypto.randomUUID()");
    expect(ROUTE).toContain("requestId: z.string().uuid().optional()");
    expect(ROUTE).toContain("const searchId = parsed.data.requestId ?? crypto.randomUUID();");
  });
});
