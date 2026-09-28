import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// Keep the REAL getDisconnectBlockers / listEmailAccounts (they are the
// security-relevant reads); mock only the destructive steps so the
// disconnect test stays hermetic.
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
const { revalidatePath } = await import("next/cache");
const { deleteEmailAccount, getDisconnectBlockers, revokeEmailAuthorization } =
  await import("@/lib/email-oauth");
const { listDraftsBySender } = await import("@/lib/application-drafts");
const { disconnectEmailAccount, reassignDraftSender } =
  await import("@/app/settings/email/actions");

const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ACC_A = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ACC_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const DRAFT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

type Row = Record<string, unknown>;

function makeEngine(
  seed: { drafts?: Row[]; accounts?: Row[]; campaigns?: Row[] } = {},
  opts: { updateError?: (table: string) => string | null } = {},
) {
  const tables: Record<string, Row[]> = {
    application_drafts: [...(seed.drafts ?? [])],
    email_accounts: [...(seed.accounts ?? [])],
    email_campaigns: [...(seed.campaigns ?? [])],
  };
  const calls: Array<{
    table: string;
    op: string;
    filters: Record<string, unknown>;
  }> = [];
  const updateCalls: Array<{
    table: string;
    payload: Row;
    filters: Record<string, unknown>;
  }> = [];

  const matches = (table: string, filters: Record<string, unknown>) =>
    (tables[table] ?? []).filter((row) =>
      Object.entries(filters).every(([k, v]) =>
        Array.isArray(v) ? v.includes(row[k]) : row[k] === v,
      ),
    );

  const from = (table: string) => {
    const filters: Record<string, unknown> = {};
    let countMode = false;
    let payload: Row | null = null;
    let selectCols: string[] | null = null;
    // Faithful PostgREST behavior: only the selected columns come back.
    const project = (row: Row) => {
      const cols = selectCols;
      return cols === null || cols.includes("*")
        ? row
        : Object.fromEntries(
            Object.entries(row).filter(([k]) => cols.includes(k)),
          );
    };
    const chain: Record<string | symbol, unknown> = new Proxy(
      {},
      {
        get(_t, prop) {
          if (typeof prop !== "string") return undefined;
          if (prop === "select")
            return (cols: string, o?: { count?: string }) => {
              if (o?.count === "exact") countMode = true;
              selectCols = cols
                .split(",")
                .map((c) => c.trim())
                .filter(Boolean);
              return chain;
            };
          if (prop === "eq" || prop === "in")
            return (col: string, val: unknown) => {
              filters[col] = val;
              return chain;
            };
          if (prop === "update")
            return (p: Row) => {
              payload = p;
              return chain;
            };
          if (prop === "order" || prop === "limit") return () => chain;
          if (prop === "single" || prop === "maybeSingle")
            return async () => {
              calls.push({ table, op: prop, filters: { ...filters } });
              const row = matches(table, filters)[0];
              return { data: row ? project(row) : null, error: null };
            };
          if (prop === "then")
            return (onF?: unknown) => {
              if (payload) {
                calls.push({ table, op: "update", filters: { ...filters } });
                const injected = opts.updateError?.(table);
                let error: { message: string } | null = null;
                if (injected) error = { message: injected };
                else {
                  for (const row of matches(table, filters))
                    Object.assign(row, payload);
                  updateCalls.push({
                    table,
                    payload: { ...payload },
                    filters: { ...filters },
                  });
                }
                return Promise.resolve({ data: null, error }).then(
                  onF as never,
                );
              }
              calls.push({
                table,
                op: countMode ? "count" : "list",
                filters: { ...filters },
              });
              return Promise.resolve(
                countMode
                  ? {
                      data: null,
                      count: matches(table, filters).length,
                      error: null,
                    }
                  : { data: matches(table, filters).map(project), error: null },
              ).then(onF as never);
            };
          return () => chain;
        },
      },
    );
    return chain;
  };

  vi.mocked(createAdminClient).mockReturnValue({ from } as never);
  return { tables, calls, updateCalls };
}

const draftRow = (sender: string, extra: Row = {}): Row => ({
  id: DRAFT,
  user_id: USER,
  goal: "ausbildung",
  sender_email_account_id: sender,
  subject: "Bewerbung Fachkraft",
  body_html: "<p>Betreuungstext</p>",
  body_text: "Betreuungstext",
  opportunity_key: "opp-1",
  opportunity_title: "Opportunity",
  opportunity_company: "Company",
  opportunity_source_url: "https://example.com",
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-02T00:00:00Z",
  ...extra,
});
const accountRow = (id: string, userId = USER, active = true): Row => ({
  id,
  user_id: userId,
  provider: "gmail",
  email: `${id.slice(0, 4)}@example.com`,
  is_active: active,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
  last_used_at: null,
});

function mockSession(userId: string | null) {
  vi.mocked(createClient).mockResolvedValue({
    auth: {
      getUser: async () => ({
        data: { user: userId ? { id: userId } : null },
      }),
    },
  } as never);
}

const reassignForm = (draftId?: string, accountId?: string) => {
  const form = new FormData();
  if (draftId) form.set("draftId", draftId);
  if (accountId) form.set("emailAccountId", accountId);
  return form;
};

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

describe("reassignDraftSender — authentication & input guards", () => {
  it("redirects to /login without a session (no DB access)", async () => {
    const engine = makeEngine({
      drafts: [draftRow(ACC_A)],
      accounts: [accountRow(ACC_A), accountRow(ACC_B)],
    });
    mockSession(null);
    const url = await redirectUrl(
      reassignDraftSender(reassignForm(DRAFT, ACC_B)),
    );
    expect(url).toContain("/login");
    expect(engine.calls).toEqual([]);
    expect(engine.updateCalls).toEqual([]);
  });

  it("rejects a non-UUID draftId before any DB access", async () => {
    const engine = makeEngine({
      drafts: [draftRow(ACC_A)],
      accounts: [accountRow(ACC_A), accountRow(ACC_B)],
    });
    mockSession(USER);
    const url = await redirectUrl(
      reassignDraftSender(reassignForm("../other", ACC_B)),
    );
    expect(url).toContain("error=reassign_failed");
    expect(engine.calls).toEqual([]);
    expect(engine.updateCalls).toEqual([]);
  });

  it("rejects a non-UUID destination id before any DB access", async () => {
    const engine = makeEngine({
      drafts: [draftRow(ACC_A)],
      accounts: [accountRow(ACC_A), accountRow(ACC_B)],
    });
    mockSession(USER);
    const url = await redirectUrl(
      reassignDraftSender(reassignForm(DRAFT, "bogus-id")),
    );
    expect(url).toContain("error=reassign_failed");
    expect(engine.calls).toEqual([]);
  });
});

describe("reassignDraftSender — ownership & validation", () => {
  const seed = () =>
    makeEngine({
      drafts: [draftRow(ACC_A)],
      accounts: [accountRow(ACC_A), accountRow(ACC_B)],
    });

  it("rejects a foreign draft (no update, row untouched)", async () => {
    const engine = makeEngine({
      drafts: [draftRow(ACC_A, { user_id: OTHER })],
      accounts: [accountRow(ACC_A), accountRow(ACC_B)],
    });
    mockSession(USER);
    const url = await redirectUrl(
      reassignDraftSender(reassignForm(DRAFT, ACC_B)),
    );
    expect(url).toContain("error=reassign_failed");
    expect(engine.updateCalls).toEqual([]);
    expect(
      engine.tables["application_drafts"][0]["sender_email_account_id"],
    ).toBe(ACC_A);
  });

  it("rejects a missing draft", async () => {
    const engine = seed();
    mockSession(USER);
    const url = await redirectUrl(
      reassignDraftSender(
        reassignForm("ffffffff-ffff-4fff-8fff-ffffffffffff", ACC_B),
      ),
    );
    expect(url).toContain("error=reassign_failed");
    expect(engine.updateCalls).toEqual([]);
  });

  it("rejects a missing destination account", async () => {
    const engine = seed();
    mockSession(USER);
    const url = await redirectUrl(
      reassignDraftSender(
        reassignForm(DRAFT, "99999999-9999-4999-8999-999999999999"),
      ),
    );
    expect(url).toContain("error=reassign_failed");
    expect(engine.updateCalls).toEqual([]);
  });

  it("rejects a destination account owned by another user", async () => {
    const engine = makeEngine({
      drafts: [draftRow(ACC_A)],
      accounts: [accountRow(ACC_A), accountRow(ACC_B, OTHER)],
    });
    mockSession(USER);
    const url = await redirectUrl(
      reassignDraftSender(reassignForm(DRAFT, ACC_B)),
    );
    expect(url).toContain("error=reassign_failed");
    expect(engine.updateCalls).toEqual([]);
    expect(
      engine.tables["application_drafts"][0]["sender_email_account_id"],
    ).toBe(ACC_A);
  });

  it("rejects an inactive (not connected) destination account", async () => {
    const engine = makeEngine({
      drafts: [draftRow(ACC_A)],
      accounts: [accountRow(ACC_A), accountRow(ACC_B, USER, false)],
    });
    mockSession(USER);
    const url = await redirectUrl(
      reassignDraftSender(reassignForm(DRAFT, ACC_B)),
    );
    expect(url).toContain("error=reassign_failed");
    expect(engine.updateCalls).toEqual([]);
  });
});

describe("reassignDraftSender — success & preservation", () => {
  it("updates ONLY sender_email_account_id, scoped to user + draft", async () => {
    const engine = makeEngine({
      drafts: [draftRow(ACC_A)],
      accounts: [accountRow(ACC_A), accountRow(ACC_B)],
    });
    mockSession(USER);
    const url = await redirectUrl(
      reassignDraftSender(reassignForm(DRAFT, ACC_B)),
    );
    expect(url).toContain("/settings/email?reassigned=1");
    expect(engine.updateCalls).toHaveLength(1);
    const update = engine.updateCalls[0];
    expect(update.table).toBe("application_drafts");
    expect(update.payload).toEqual({ sender_email_account_id: ACC_B });
    expect(update.filters).toEqual({ id: DRAFT, user_id: USER });
    expect(revalidatePath).toHaveBeenCalledWith("/settings/email");
    expect(revalidatePath).toHaveBeenCalledWith("/applications/new");
  });

  it("preserves the entire draft (subject/body/goal/opportunity data)", async () => {
    const engine = makeEngine({
      drafts: [draftRow(ACC_A)],
      accounts: [accountRow(ACC_A), accountRow(ACC_B)],
    });
    mockSession(USER);
    await redirectUrl(reassignDraftSender(reassignForm(DRAFT, ACC_B)));
    const draft = engine.tables["application_drafts"][0];
    expect(draft["sender_email_account_id"]).toBe(ACC_B);
    // Everything else is byte-for-byte untouched.
    expect(draft["subject"]).toBe("Bewerbung Fachkraft");
    expect(draft["body_html"]).toBe("<p>Betreuungstext</p>");
    expect(draft["body_text"]).toBe("Betreuungstext");
    expect(draft["goal"]).toBe("ausbildung");
    expect(draft["opportunity_key"]).toBe("opp-1");
    expect(draft["opportunity_title"]).toBe("Opportunity");
    expect(draft["opportunity_company"]).toBe("Company");
    expect(draft["opportunity_source_url"]).toBe("https://example.com");
    // Exactly one mutating call in total (recipients/attachments are
    // separate rows and are never touched).
    expect(engine.updateCalls).toHaveLength(1);
    expect(engine.calls.filter((c) => c.op === "update").length).toBe(1);
  });

  it("is a safe no-op when the destination equals the current sender", async () => {
    const engine = makeEngine({
      drafts: [draftRow(ACC_A)],
      accounts: [accountRow(ACC_A), accountRow(ACC_B)],
    });
    mockSession(USER);
    const url = await redirectUrl(
      reassignDraftSender(reassignForm(DRAFT, ACC_A)),
    );
    expect(url).toContain("reassigned=1");
    expect(
      engine.tables["application_drafts"][0]["sender_email_account_id"],
    ).toBe(ACC_A);
  });
});

describe("reassignDraftSender — failure handling & leak protection", () => {
  it("failure without partial mutation (update error → row unchanged, no revalidation)", async () => {
    const engine = makeEngine(
      {
        drafts: [draftRow(ACC_A)],
        accounts: [accountRow(ACC_A), accountRow(ACC_B)],
      },
      {
        updateError: (t) => (t === "application_drafts" ? "db down" : null),
      },
    );
    mockSession(USER);
    const url = await redirectUrl(
      reassignDraftSender(reassignForm(DRAFT, ACC_B)),
    );
    expect(url).toContain("error=reassign_failed");
    expect(
      engine.tables["application_drafts"][0]["sender_email_account_id"],
    ).toBe(ACC_A);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("never leaks DB/FK details into the redirect", async () => {
    makeEngine(
      {
        drafts: [draftRow(ACC_A)],
        accounts: [accountRow(ACC_A), accountRow(ACC_B)],
      },
      {
        updateError: () => "update application_drafts: fk violation detail",
      },
    );
    mockSession(USER);
    const url = await redirectUrl(
      reassignDraftSender(reassignForm(DRAFT, ACC_B)),
    );
    expect(url).toContain("/settings/email?error=reassign_failed");
    expect(url).not.toContain("fk");
  });

  it("uses one fixed code for every rejection (no ownership oracle)", async () => {
    const foreign = makeEngine({
      drafts: [draftRow(ACC_A, { user_id: OTHER })],
      accounts: [accountRow(ACC_A), accountRow(ACC_B)],
    });
    mockSession(USER);
    const url = await redirectUrl(
      reassignDraftSender(reassignForm(DRAFT, ACC_B)),
    );
    expect(url).toContain("/settings/email?error=reassign_failed");
    expect(foreign.updateCalls).toEqual([]);
  });
});

describe("reassignment unblocks the disconnect (end to end)", () => {
  it("old sender becomes disconnectable after reassignment", async () => {
    const engine = makeEngine({
      drafts: [draftRow(ACC_A)],
      accounts: [accountRow(ACC_A), accountRow(ACC_B)],
    });
    mockSession(USER);
    // Before: the draft blocks ACC_A.
    expect(await getDisconnectBlockers(USER, ACC_A)).toEqual({
      activeCampaigns: 0,
      drafts: 1,
    });
    // Reassign to ACC_B.
    const url = await redirectUrl(
      reassignDraftSender(reassignForm(DRAFT, ACC_B)),
    );
    expect(url).toContain("reassigned=1");
    // After: ACC_A is free, ACC_B now holds the draft.
    expect(await getDisconnectBlockers(USER, ACC_A)).toEqual({
      activeCampaigns: 0,
      drafts: 0,
    });
    expect(await getDisconnectBlockers(USER, ACC_B)).toEqual({
      activeCampaigns: 0,
      drafts: 1,
    });
    // The existing disconnect flow now succeeds against ACC_A.
    const disconnectUrl = await redirectUrl(
      disconnectEmailAccount(
        (() => {
          const f = new FormData();
          f.set("accountId", ACC_A);
          return f;
        })(),
      ),
    );
    expect(disconnectUrl).toContain("disconnected=1");
    expect(deleteEmailAccount).toHaveBeenCalledWith(USER, ACC_A);
    expect(revokeEmailAuthorization).toHaveBeenCalledWith(USER, ACC_A);
    // The draft itself survived the whole flow, now on ACC_B.
    expect(engine.tables["application_drafts"]).toHaveLength(1);
    expect(
      engine.tables["application_drafts"][0]["sender_email_account_id"],
    ).toBe(ACC_B);
  });

  it("keeps active-campaign protection: the campaign keeps its own sender and still blocks", async () => {
    const engine = makeEngine({
      drafts: [draftRow(ACC_A)],
      accounts: [accountRow(ACC_A), accountRow(ACC_B)],
      campaigns: [
        {
          id: "camp-1",
          user_id: USER,
          draft_id: DRAFT,
          email_account_id: ACC_A,
          status: "sending",
        },
      ],
    });
    mockSession(USER);
    const url = await redirectUrl(
      reassignDraftSender(reassignForm(DRAFT, ACC_B)),
    );
    expect(url).toContain("reassigned=1");
    // The campaign row is untouched — it keeps its own sender.
    const campaign = engine.tables["email_campaigns"][0];
    expect(campaign["email_account_id"]).toBe(ACC_A);
    expect(campaign["status"]).toBe("sending");
    // Drafts no longer block ACC_A, but the active campaign still does.
    expect(await getDisconnectBlockers(USER, ACC_A)).toEqual({
      activeCampaigns: 1,
      drafts: 0,
    });
    const disconnectUrl = await redirectUrl(
      disconnectEmailAccount(
        (() => {
          const f = new FormData();
          f.set("accountId", ACC_A);
          return f;
        })(),
      ),
    );
    expect(disconnectUrl).toContain("error=active_campaigns");
    expect(deleteEmailAccount).not.toHaveBeenCalled();
  });
});

describe("listDraftsBySender (settings page read)", () => {
  it("returns only the user's own drafts on that sender (scoped)", async () => {
    const engine = makeEngine({
      drafts: [
        draftRow(ACC_A),
        draftRow(ACC_A, {
          id: "22222222-2222-4222-8222-222222222222",
          subject: "Second",
        }),
        draftRow(ACC_A, {
          id: "33333333-3333-4333-8333-333333333333",
          user_id: OTHER,
        }),
      ],
      accounts: [accountRow(ACC_A)],
    });
    const result = await listDraftsBySender(USER, ACC_A);
    expect(result).toEqual([
      { id: DRAFT, subject: "Bewerbung Fachkraft", goal: "ausbildung" },
      {
        id: "22222222-2222-4222-8222-222222222222",
        subject: "Second",
        goal: "ausbildung",
      },
    ]);
    const listCall = engine.calls.find(
      (c) => c.table === "application_drafts" && c.op === "list",
    );
    expect(listCall?.filters["user_id"]).toBe(USER);
    expect(listCall?.filters["sender_email_account_id"]).toBe(ACC_A);
  });

  it("never returns another user's drafts for the same sender", async () => {
    makeEngine({
      drafts: [draftRow(ACC_A, { user_id: OTHER })],
      accounts: [accountRow(ACC_A)],
    });
    const result = await listDraftsBySender(USER, ACC_A);
    expect(result).toEqual([]);
  });
});
