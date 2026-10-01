import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Search upgrade code activation (Phase 17).
 *
 * The UI only ever sends the CODE. The entitlement is read back from the
 * database, so nothing the browser sends can raise the limit. These tests
 * exercise the real action + the real credits library against a mocked
 * Supabase boundary, and assert the two policies stay separate:
 *   free user      → 150 credits / 72 h
 *   code activated → 500 credits / 24 h
 */

const activateQuotaCode = vi.fn();
const getCurrentUserAndProfile = vi.fn();
const rpc = vi.fn();

vi.mock("@/lib/email-campaigns", () => ({ activateQuotaCode }));
vi.mock("@/lib/auth", () => ({ getCurrentUserAndProfile }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc,
    from: () => ({ insert: vi.fn(async () => ({ error: null })) }),
  }),
}));

const { activateSearchUpgrade } = await import(
  "@/app/opportunities/ai-search/actions"
);
const { getSearchCreditStatus } = await import("@/lib/search-credits");

const USER = { id: "user-1", email: "u@example.test" };
const PROFILE = { account_status: "active" };

function creditRow(overrides: Record<string, unknown> = {}) {
  return {
    credits_remaining: 120,
    credit_limit: 150,
    reset_hours: 72,
    resets_at: "2026-10-05T00:00:00.000Z",
    premium: false,
    ...overrides,
  };
}

beforeEach(() => {
  activateQuotaCode.mockReset();
  getCurrentUserAndProfile.mockReset();
  rpc.mockReset();
  getCurrentUserAndProfile.mockResolvedValue({ user: USER, profile: PROFILE });
  activateQuotaCode.mockResolvedValue(150);
});

describe("search upgrade activation", () => {
  it("keeps a normal user on the free policy (150 credits / 72 h)", async () => {
    rpc.mockResolvedValue({ data: [creditRow()], error: null });
    const result = await activateSearchUpgrade("SOMECODE");
    expect(result.ok).toBe(true);
    expect(result.creditLimit).toBe(150);
    expect(result.resetHours).toBe(72);
    expect(result.premium).toBe(false);
  });

  it("gives a code-activated user 500 credits / 24 h — read from the database", async () => {
    rpc.mockResolvedValue({
      data: [
        creditRow({
          credits_remaining: 500,
          credit_limit: 500,
          reset_hours: 24,
          premium: true,
        }),
      ],
      error: null,
    });
    const result = await activateSearchUpgrade("CEODRIF0090");
    expect(result.ok).toBe(true);
    expect(result.creditLimit).toBe(500);
    expect(result.resetHours).toBe(24);
    expect(result.premium).toBe(true);
    expect(result.message).toContain("500");
  });

  it("verifies the code through the EXISTING activation path (server-side)", async () => {
    rpc.mockResolvedValue({ data: [creditRow()], error: null });
    await activateSearchUpgrade("  ceodrif0090  ");
    // Passed to the existing server-side code system, trimmed.
    expect(activateQuotaCode).toHaveBeenCalledWith("ceodrif0090");
  });

  it("cannot be used to raise the limit from the client (no limit parameter)", async () => {
    rpc.mockResolvedValue({ data: [creditRow()], error: null });
    // A tampered caller tries to smuggle a bigger limit — it is ignored
    // because the action accepts only a code and reads the truth from the DB.
    const result = await (
      activateSearchUpgrade as unknown as (
        code: string,
        extra?: unknown,
      ) => Promise<{ creditLimit?: number; premium?: boolean }>
    )("SOMECODE", { dailyLimit: 500, creditLimit: 500, premium: true });
    expect(result.creditLimit).toBe(150);
    expect(result.premium).toBe(false);
  });

  it("rejects an invalid / already-used code with a clear message and no change", async () => {
    activateQuotaCode.mockRejectedValue(
      new Error("That upgrade code is invalid or has already been used."),
    );
    const result = await activateSearchUpgrade("WRONGCODE");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("invalid or has already been used");
    // The entitlement was never read/updated.
    expect(rpc).not.toHaveBeenCalled();
    expect(result.creditLimit).toBeUndefined();
  });

  it("requires an authenticated, active account", async () => {
    getCurrentUserAndProfile.mockResolvedValue({ user: null, profile: null });
    const blocked = await activateSearchUpgrade("CEODRIF0090");
    expect(blocked.ok).toBe(false);
    expect(blocked.message).toBe("Not authorized.");
    expect(activateQuotaCode).not.toHaveBeenCalled();

    getCurrentUserAndProfile.mockResolvedValue({
      user: USER,
      profile: { account_status: "suspended" },
    });
    const suspended = await activateSearchUpgrade("CEODRIF0090");
    expect(suspended.ok).toBe(false);
    expect(activateQuotaCode).not.toHaveBeenCalled();
  });

  it("does nothing for an empty code", async () => {
    const result = await activateSearchUpgrade("   ");
    expect(result.ok).toBe(false);
    expect(activateQuotaCode).not.toHaveBeenCalled();
  });

  it("is idempotent: re-activating an already active code stays ok", async () => {
    rpc.mockResolvedValue({
      data: [
        creditRow({
          credits_remaining: 380,
          credit_limit: 500,
          reset_hours: 24,
          premium: true,
        }),
      ],
      error: null,
    });
    const result = await activateSearchUpgrade("CEODRIF0090");
    expect(result.ok).toBe(true);
    expect(result.premium).toBe(true);
    expect(result.creditsRemaining).toBe(380);
  });

  it("maps the database row to the entitlement (no frontend math)", async () => {
    rpc.mockResolvedValue({ data: [creditRow({ premium: true, credit_limit: 500 })], error: null });
    const status = await getSearchCreditStatus(USER.id);
    expect(status).toMatchObject({
      creditLimit: 500,
      resetHours: 72,
      premium: true,
    });
    // The SQL function is the only source.
    expect(rpc).toHaveBeenCalledWith("get_search_credit_status", {
      target_user_id: USER.id,
    });
  });
});

describe("upgrade-code secrets never reach the browser", () => {
  it("the client component contains no upgrade code value", () => {
    const client = readFileSync(
      "src/components/ai-search.tsx",
      "utf8",
    );
    expect(client).not.toContain("CEODRIF0090");
    // …nor any client-supplied limit.
    expect(client).not.toContain("dailyLimit");
    expect(client).toContain("activateSearchUpgrade(code)");
  });

  it("the action takes a code only (no limit parameter) and the code lives in the DB", () => {
    const action = readFileSync(
      "src/app/opportunities/ai-search/actions.ts",
      "utf8",
    );
    expect(action).toMatch(
      /export async function activateSearchUpgrade\(\s*code: string,?\s*\)/,
    );
    expect(action).not.toContain("dailyLimit");
    expect(action).not.toContain("CEODRIF0090");

    const migration = readFileSync(
      "supabase/migrations/20261016000000_search_credits.sql",
      "utf8",
    );
    // The code is DATA in invitation_codes (server-side), not code.
    expect(migration).toContain("values ('CEODRIF0090', 'quota_upgrade', 500, 24");
  });
});
