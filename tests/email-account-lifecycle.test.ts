import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
// Keep the REAL getDisconnectBlockers (it is tested directly); mock only
// the destructive steps so the action test stays hermetic.
vi.mock("@/lib/email-oauth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email-oauth")>();
  return {
    ...actual,
    deleteEmailAccount: vi.fn(),
    revokeEmailAuthorization: vi.fn(),
  };
});

const { createClient } = await import("@/lib/supabase/server");
const { createAdminClient } = await import("@/lib/supabase/admin");
const { deleteEmailAccount, getDisconnectBlockers, revokeEmailAuthorization } =
  await import("@/lib/email-oauth");
const { disconnectEmailAccount } = await import("@/app/settings/email/actions");

const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACCOUNT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER_USER_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const ACTION_CALLS: Array<{ table: string; filters: Record<string, unknown> }> =
  [];

function mockCounts(
  opts: {
    activeCampaigns?: number;
    drafts?: number;
    throwFor?: (table: string) => boolean;
  } = {},
) {
  ACTION_CALLS.length = 0;
  vi.mocked(createAdminClient).mockReturnValue({
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const chain: Record<string | symbol, unknown> = new Proxy(
        {},
        {
          get(_t, prop) {
            if (typeof prop !== "string") return undefined;
            if (prop === "select") return () => chain;
            if (prop === "eq" || prop === "in")
              return (col: string, val: unknown) => {
                filters[col] = val;
                return chain;
              };
            if (prop === "then")
              return (onF?: unknown) => {
                if (opts.throwFor?.(table)) throw new Error(`boom:${table}`);
                ACTION_CALLS.push({ table, filters: { ...filters } });
                const count =
                  table === "email_campaigns"
                    ? (opts.activeCampaigns ?? 0)
                    : (opts.drafts ?? 0);
                return Promise.resolve({
                  data: null,
                  count,
                  error: null,
                }).then(onF as never);
              };
            return () => chain;
          },
        },
      );
      return chain;
    },
  } as never);
}

function mockSession(userId: string | null) {
  vi.mocked(createClient).mockResolvedValue({
    auth: {
      getUser: async () => ({
        data: { user: userId ? { id: userId } : null },
      }),
    },
  } as never);
}

function actionForm(accountId?: string) {
  const form = new FormData();
  if (accountId) form.set("accountId", accountId);
  return form;
}

/** Server actions signal redirects by throwing; the URL is in the digest. */
async function redirectUrl(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return String((error as { digest?: string }).digest ?? "");
  }
  return "<no-redirect>";
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("migration guards (20261004000000)", () => {
  const sql = readFileSync(
    fileURLToPath(
      new URL(
        "../supabase/migrations/20261004000000_email_account_lifecycle.sql",
        import.meta.url,
      ),
    ),
    "utf8",
  );

  it("makes campaigns.email_account_id nullable with ON DELETE SET NULL", () => {
    expect(sql).toMatch(/alter column email_account_id drop not null/i);
    expect(sql).toMatch(/on delete set null/i);
  });

  it("keeps referential integrity (the FK is replaced, not removed)", () => {
    expect(sql).toMatch(
      /foreign key \(email_account_id\)\s*references public\.email_accounts\(id\)/i,
    );
  });

  it("leaves the drafts FK (RESTRICT) untouched (no DDL on application_drafts)", () => {
    expect(sql).not.toMatch(/alter table public\.application_drafts/i);
    expect(sql).not.toMatch(/drop constraint[^;]*application_drafts/i);
  });
});

describe("getDisconnectBlockers", () => {
  it("counts only active campaigns, scoped to user AND account", async () => {
    mockCounts({ activeCampaigns: 3, drafts: 0 });
    const result = await getDisconnectBlockers(USER_ID, ACCOUNT_ID);
    expect(result).toEqual({ activeCampaigns: 3, drafts: 0 });

    const campaignCall = ACTION_CALLS.find(
      (c) => c.table === "email_campaigns",
    );
    expect(campaignCall?.filters["user_id"]).toBe(USER_ID);
    expect(campaignCall?.filters["email_account_id"]).toBe(ACCOUNT_ID);
    expect(campaignCall?.filters["status"]).toEqual(["queued", "sending"]);
  });

  it("counts drafts by sender, scoped to user AND account", async () => {
    mockCounts({ activeCampaigns: 0, drafts: 2 });
    const result = await getDisconnectBlockers(USER_ID, ACCOUNT_ID);
    expect(result).toEqual({ activeCampaigns: 0, drafts: 2 });
    const draftCall = ACTION_CALLS.find(
      (c) => c.table === "application_drafts",
    );
    expect(draftCall?.filters["user_id"]).toBe(USER_ID);
    expect(draftCall?.filters["sender_email_account_id"]).toBe(ACCOUNT_ID);
  });

  it("returns zeros instead of throwing when counts are null", async () => {
    mockCounts({});
    const result = await getDisconnectBlockers(USER_ID, ACCOUNT_ID);
    expect(result).toEqual({ activeCampaigns: 0, drafts: 0 });
  });

  it("never counts other users' rows (faithful scoping)", async () => {
    // Faithful mock: any cross-user query returns nothing.
    vi.mocked(createAdminClient).mockReturnValue({
      from: (table: string) => {
        const filters: Record<string, unknown> = {};
        const chain: Record<string | symbol, unknown> = new Proxy(
          {},
          {
            get(_t, prop) {
              if (typeof prop !== "string") return undefined;
              if (prop === "select") return () => chain;
              if (prop === "eq" || prop === "in")
                return (col: string, val: unknown) => {
                  filters[col] = val;
                  return chain;
                };
              if (prop === "then")
                return (onF?: unknown) => {
                  const own = filters["user_id"] === USER_ID;
                  const count = own ? (table === "email_campaigns" ? 3 : 2) : 0;
                  return Promise.resolve({
                    data: null,
                    count,
                    error: null,
                  }).then(onF as never);
                };
              return () => chain;
            },
          },
        );
        return chain;
      },
    } as never);
    const own = await getDisconnectBlockers(USER_ID, ACCOUNT_ID);
    const foreign = await getDisconnectBlockers(OTHER_USER_ID, ACCOUNT_ID);
    expect(own).toEqual({ activeCampaigns: 3, drafts: 2 });
    expect(foreign).toEqual({ activeCampaigns: 0, drafts: 0 });
  });
});

describe("disconnectEmailAccount action", () => {
  it("redirects to /login without a session", async () => {
    mockSession(null);
    mockCounts({});
    const url = await redirectUrl(
      disconnectEmailAccount(actionForm(ACCOUNT_ID)),
    );
    expect(url).toContain("/login");
    expect(deleteEmailAccount).not.toHaveBeenCalled();
  });

  it("404-style guard for a missing account id (no lookup at all)", async () => {
    mockSession(USER_ID);
    const url = await redirectUrl(disconnectEmailAccount(actionForm()));
    expect(url).toContain("error=account_not_found");
  });

  it("blocks while active campaigns exist — nothing is revoked or deleted", async () => {
    mockSession(USER_ID);
    mockCounts({ activeCampaigns: 2 });
    const url = await redirectUrl(
      disconnectEmailAccount(actionForm(ACCOUNT_ID)),
    );
    expect(url).toContain("error=active_campaigns");
    expect(revokeEmailAuthorization).not.toHaveBeenCalled();
    expect(deleteEmailAccount).not.toHaveBeenCalled();
  });

  it("blocks while drafts use the sender — nothing is revoked or deleted", async () => {
    mockSession(USER_ID);
    mockCounts({ activeCampaigns: 0, drafts: 4 });
    const url = await redirectUrl(
      disconnectEmailAccount(actionForm(ACCOUNT_ID)),
    );
    expect(url).toContain("error=drafts_in_use");
    expect(revokeEmailAuthorization).not.toHaveBeenCalled();
    expect(deleteEmailAccount).not.toHaveBeenCalled();
  });

  it("allows disconnect with terminal-only history (active count is 0)", async () => {
    mockSession(USER_ID);
    mockCounts({ activeCampaigns: 0, drafts: 0 });
    const url = await redirectUrl(
      disconnectEmailAccount(actionForm(ACCOUNT_ID)),
    );
    expect(url).toContain("disconnected=1");
    expect(revokeEmailAuthorization).toHaveBeenCalledWith(USER_ID, ACCOUNT_ID);
    expect(deleteEmailAccount).toHaveBeenCalledWith(USER_ID, ACCOUNT_ID);
  });

  it("surfaces a generic error when the blocker query itself fails", async () => {
    mockSession(USER_ID);
    mockCounts({ throwFor: () => true });
    const url = await redirectUrl(
      disconnectEmailAccount(actionForm(ACCOUNT_ID)),
    );
    expect(url).toContain("error=disconnect_failed");
    expect(revokeEmailAuthorization).not.toHaveBeenCalled();
    expect(deleteEmailAccount).not.toHaveBeenCalled();
  });

  it("surfaces a generic error when the delete fails (no leak of FK details)", async () => {
    mockSession(USER_ID);
    mockCounts({});
    vi.mocked(deleteEmailAccount).mockRejectedValueOnce(
      new Error("fk restrict violation detail"),
    );
    const url = await redirectUrl(
      disconnectEmailAccount(actionForm(ACCOUNT_ID)),
    );
    expect(url).toContain("error=disconnect_failed");
    expect(url).not.toContain("fk restrict");
  });
});
