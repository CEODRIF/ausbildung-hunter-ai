import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const { createAdminClient } = await import("@/lib/supabase/admin");
const {
  recoverStaleCampaigns,
  getCampaign,
  processCampaignBatch,
  STALE_SENDING_AFTER_MINUTES,
  STALE_QUEUED_AFTER_HOURS,
} = await import("@/lib/email-campaigns");

const USER_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_USER_ID = "77777777-7777-4777-8777-777777777777";
const CAMPAIGN_ID = "44444444-4444-4444-8444-444444444444";
const DRAFT_ID = "55555555-5555-4555-8555-555555555555";
const ACCOUNT_ID = "66666666-6666-4666-8666-666666666666";

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const HOUR = 3_600_000;

function campaignRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CAMPAIGN_ID,
    user_id: USER_ID,
    draft_id: DRAFT_ID,
    email_account_id: ACCOUNT_ID,
    usage_date: "2026-09-28",
    status: "sending",
    started_at: iso(1 * HOUR),
    created_at: iso(2 * HOUR),
    ...overrides,
  };
}

interface RecoveryHandlers {
  single?: (
    table: string,
    filters: Record<string, unknown>,
  ) => Record<string, unknown> | null;
  list?: (
    table: string,
    filters: Record<string, unknown>,
  ) => Record<string, unknown>[];
  rpc?: (name: string, args: Record<string, unknown>) => unknown;
}

function makeAdminMock(handlers: RecoveryHandlers) {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const listCalls: Array<{
    table: string;
    filters: Record<string, unknown>;
  }> = [];
  const from = (table: string) => {
    const filters: Record<string, unknown> = {};
    const chain: Record<string | symbol, unknown> = new Proxy(
      {},
      {
        get(_t, prop) {
          if (typeof prop !== "string") return undefined;
          if (prop === "select" || prop === "order") return () => chain;
          if (prop === "eq" || prop === "lt")
            return (col: string, val: unknown) => {
              filters[col] = val;
              return chain;
            };
          if (prop === "single")
            return async () => ({
              data: handlers.single?.(table, { ...filters }) ?? null,
              error: null,
            });
          if (prop === "then")
            return (onF?: unknown) => {
              listCalls.push({ table, filters: { ...filters } });
              return Promise.resolve({
                data: handlers.list?.(table, { ...filters }) ?? [],
                error: null,
              }).then(onF as never);
            };
          return () => chain;
        },
      },
    );
    return chain;
  };
  const client = {
    from,
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      return Promise.resolve({
        data: handlers.rpc?.(name, args) ?? null,
        error: null,
      });
    },
  };
  vi.mocked(createAdminClient).mockReturnValue(client as never);
  return { rpcCalls, listCalls };
}

const campaignSingle =
  (row: Record<string, unknown>) =>
  (table: string, filters: Record<string, unknown>) =>
    table === "email_campaigns" &&
    filters["id"] === CAMPAIGN_ID &&
    filters["user_id"] === USER_ID
      ? row
      : null;

const USAGE = {
  date: "2026-09-28",
  emails_sent: 1,
  emails_reserved: 0,
  daily_limit: 50,
  remaining: 49,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("thresholds", () => {
  it("are positive, documented constants", () => {
    expect(STALE_SENDING_AFTER_MINUTES).toBeGreaterThan(0);
    expect(STALE_QUEUED_AFTER_HOURS).toBeGreaterThan(0);
  });
});

describe("recoverStaleCampaigns", () => {
  it("does nothing for a terminal campaign", async () => {
    const row = campaignRow({
      status: "completed",
      created_at: iso(24 * HOUR),
    });
    const mock = makeAdminMock({ single: campaignSingle(row), list: () => [] });
    const result = await recoverStaleCampaigns(USER_ID, CAMPAIGN_ID);
    expect(result).toEqual({
      recovered: false,
      stalledMessagesFailed: 0,
      staleCampaignCancelled: false,
      status: "completed",
    });
    expect(mock.rpcCalls).toEqual([]);
    expect(mock.listCalls).toEqual([]);
  });

  it("does nothing for a healthy in-flight campaign", async () => {
    const row = campaignRow();
    const mock = makeAdminMock({
      single: campaignSingle(row),
      list: () => [],
    });
    const result = await recoverStaleCampaigns(USER_ID, CAMPAIGN_ID);
    expect(result.recovered).toBe(false);
    expect(mock.rpcCalls).toEqual([]);
  });

  it("re-finalizes stale in-flight messages with a deterministic reason", async () => {
    const row = campaignRow();
    const mock = makeAdminMock({
      single: campaignSingle(row),
      list: (table, filters) =>
        table === "email_messages" && filters["status"] === "sending"
          ? [{ id: "msg-1" }, { id: "msg-2" }]
          : [],
      rpc: (name) => (name === "finalize_email_message" ? true : null),
    });
    const result = await recoverStaleCampaigns(USER_ID, CAMPAIGN_ID);

    expect(result.stalledMessagesFailed).toBe(2);
    expect(result.recovered).toBe(true);
    const finals = mock.rpcCalls.filter(
      (c) => c.name === "finalize_email_message",
    );
    expect(finals.map((c) => c.args["target_message_id"])).toEqual([
      "msg-1",
      "msg-2",
    ]);
    for (const final of finals) {
      expect(final.args["succeeded"]).toBe(false);
      expect(final.args["provider_id"]).toBeNull();
      expect(final.args["failure_code"]).toBe("worker_stalled");
      expect(final.args["failure_message"]).toEqual(
        expect.stringContaining("not confirmed as sent"),
      );
    }
  });

  it("scopes the stale query to the session user + campaign with a real threshold", async () => {
    const row = campaignRow();
    const mock = makeAdminMock({
      single: campaignSingle(row),
      list: () => [],
    });
    await recoverStaleCampaigns(USER_ID, CAMPAIGN_ID);
    const query = mock.listCalls.find((c) => c.table === "email_messages");
    expect(query).toBeTruthy();
    expect(query?.filters["campaign_id"]).toBe(CAMPAIGN_ID);
    expect(query?.filters["user_id"]).toBe(USER_ID);
    expect(query?.filters["status"]).toBe("sending");
    const threshold = Date.parse(String(query?.filters["updated_at"]));
    const ageMs = Date.now() - threshold;
    expect(ageMs).toBeGreaterThanOrEqual(
      STALE_SENDING_AFTER_MINUTES * 60_000 - 5_000,
    );
    expect(ageMs).toBeLessThanOrEqual(
      STALE_SENDING_AFTER_MINUTES * 60_000 + 60_000,
    );
  });

  it("does not count messages the finalize RPC rejected", async () => {
    const row = campaignRow();
    makeAdminMock({
      single: campaignSingle(row),
      list: (table, filters) =>
        table === "email_messages" && filters["status"] === "sending"
          ? [{ id: "msg-1" }]
          : [],
      rpc: (name) => (name === "finalize_email_message" ? false : null),
    });
    const result = await recoverStaleCampaigns(USER_ID, CAMPAIGN_ID);
    expect(result.stalledMessagesFailed).toBe(0);
    expect(result.recovered).toBe(false);
  });

  it("cancels a never-started campaign older than the TTL", async () => {
    const row = campaignRow({
      status: "queued",
      started_at: null,
      created_at: iso((STALE_QUEUED_AFTER_HOURS + 1) * HOUR),
    });
    const mock = makeAdminMock({
      single: campaignSingle(row),
      list: () => [],
      rpc: (name) => {
        if (name === "cancel_queued_campaign") {
          row["status"] = "cancelled";
          return true;
        }
        return null;
      },
    });
    const result = await recoverStaleCampaigns(USER_ID, CAMPAIGN_ID);
    expect(result.staleCampaignCancelled).toBe(true);
    expect(result.recovered).toBe(true);
    expect(result.status).toBe("cancelled");
    const cancel = mock.rpcCalls.find(
      (c) => c.name === "cancel_queued_campaign",
    );
    expect(cancel?.args["target_user_id"]).toBe(USER_ID);
    expect(cancel?.args["target_campaign_id"]).toBe(CAMPAIGN_ID);
  });

  it("keeps a fresh queued campaign (worker may still pick it up)", async () => {
    const row = campaignRow({
      status: "queued",
      started_at: null,
      created_at: iso(1 * HOUR),
    });
    const mock = makeAdminMock({ single: campaignSingle(row), list: () => [] });
    const result = await recoverStaleCampaigns(USER_ID, CAMPAIGN_ID);
    expect(result.staleCampaignCancelled).toBe(false);
    expect(result.recovered).toBe(false);
    expect(mock.rpcCalls).toEqual([]);
  });

  it("never auto-cancels a campaign that already started", async () => {
    const row = campaignRow({
      status: "queued",
      started_at: iso(1 * HOUR),
      created_at: iso(48 * HOUR),
    });
    const mock = makeAdminMock({ single: campaignSingle(row), list: () => [] });
    const result = await recoverStaleCampaigns(USER_ID, CAMPAIGN_ID);
    expect(result.staleCampaignCancelled).toBe(false);
    expect(mock.rpcCalls).toEqual([]);
  });

  it("rejects access to another user's campaign", async () => {
    const row = campaignRow();
    makeAdminMock({ single: campaignSingle(row), list: () => [] });
    await expect(
      recoverStaleCampaigns(OTHER_USER_ID, CAMPAIGN_ID),
    ).rejects.toThrow("Campaign not found.");
  });
});

describe("getCampaign hook", () => {
  it("heals stale in-flight messages while the monitor loads", async () => {
    const row = campaignRow();
    const mock = makeAdminMock({
      single: (table, filters) =>
        table === "application_drafts"
          ? { body_html: "<p>Hi</p>", body_text: "Hi" }
          : campaignSingle(row)(table, filters),
      list: (table, filters) =>
        table === "email_messages"
          ? filters["status"] === "sending"
            ? [{ id: "msg-1" }]
            : [
                {
                  id: "msg-1",
                  recipient_email: "a@b.c",
                  company_name: null,
                  status: "failed",
                  error_code: "worker_stalled",
                  error_message: "stalled",
                  provider_message_id: null,
                  sent_at: null,
                  attempt_count: 1,
                },
              ]
          : [],
      rpc: (name) =>
        name === "finalize_email_message"
          ? true
          : name === "get_daily_usage_snapshot"
            ? USAGE
            : null,
    });
    const data = await getCampaign(USER_ID, CAMPAIGN_ID);
    expect(
      mock.rpcCalls.some(
        (c) =>
          c.name === "finalize_email_message" &&
          c.args["target_message_id"] === "msg-1",
      ),
    ).toBe(true);
    expect(data.messages).toHaveLength(1);
    expect(data.usage).toEqual(USAGE);
    expect(data.campaign.status).toBe("sending");
  });
});

describe("processCampaignBatch hook", () => {
  it("recovers before claiming, then reports the re-read status", async () => {
    const row = campaignRow();
    const mock = makeAdminMock({
      single: (table, filters) =>
        table === "application_drafts"
          ? { body_html: "<p>Hi</p>", body_text: "Hi" }
          : campaignSingle(row)(table, filters),
      list: (table, filters) =>
        table === "email_messages" && filters["status"] === "sending"
          ? [{ id: "msg-1" }]
          : [],
      // claim_next_email_message → null (nothing left to claim)
      rpc: (name) => (name === "finalize_email_message" ? true : null),
    });
    const result = await processCampaignBatch(USER_ID, CAMPAIGN_ID);
    expect(result).toEqual({ processed: 0, status: "sending" });
    const finalizeIndex = mock.rpcCalls.findIndex(
      (c) => c.name === "finalize_email_message",
    );
    const claimIndex = mock.rpcCalls.findIndex(
      (c) => c.name === "claim_next_email_message",
    );
    expect(finalizeIndex).toBeGreaterThanOrEqual(0);
    expect(claimIndex).toBeGreaterThanOrEqual(0);
    expect(finalizeIndex).toBeLessThan(claimIndex);
  });
});
