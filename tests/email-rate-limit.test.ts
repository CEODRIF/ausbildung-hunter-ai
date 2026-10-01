import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Smart Sending / Rate Limiting (Phase 25).
 *
 * The atomic sender slot lives in Postgres (one row per Gmail account,
 * reserved with a single conditional UPDATE — one winner per interval
 * window). This suite verifies:
 *
 *   - the interval configuration (fixed 6000ms default, 5000ms hard floor,
 *     4999ms is impossible, range is exactly 5000–6000ms),
 *   - the worker orchestration on an in-memory store that mirrors the
 *     claim/finalize/retry RPCs AND the slot's atomic semantics (fake
 *     timers drive the pacing),
 *   - sender-level isolation (campaigns share a slot, accounts do not),
 *   - multi-worker / multi-tab / reload safety,
 *   - waiting messages are never failed/sent/deleted,
 *   - 429/5xx go through the existing retry path (re-queue + slot),
 *     permanent failures finalize without looping,
 *   - no duplicate sends, no touched accounts/tokens/credits.
 */

type Row = Record<string, unknown>;

const store: Record<string, Row[]> = {};
/** Atomic slot state — one "next allowed" timestamp per sender account,
 *  exactly like the Postgres row. Persists across calls = "the database". */
const slots = new Map<string, number>();
const slotCalls: Array<{ account: string; interval: number; at: number }> = [];
const rpcNames: string[] = [];
const deletedFrom: string[] = [];
const sends: Array<{ at: number; to: string }> = [];
let sendBehavior: (
  to: string,
) => Promise<{ providerMessageId: string }>;

const USAGE = {
  date: "2026-10-02",
  emails_sent: 0,
  emails_reserved: 0,
  daily_limit: 100,
  remaining: 100,
};

vi.mock("@/lib/supabase/admin", () => {
  const from = (table: string) => makeChain(table);
  return {
    createAdminClient: () => ({
      from,
      rpc: (name: string, args?: Record<string, unknown>) =>
        rpcCall(name, args ?? {}),
      storage: { from: () => ({ remove: async () => undefined }) },
    }),
  };
});

/** The atomic slot + claim/finalize/retry, with the same semantics as the
 *  real RPCs (single-threaded event loop ≈ one winner per window). */
function rpcCall(
  name: string,
  args: Record<string, unknown>,
): Promise<{ data: unknown; error: null }> {
  rpcNames.push(name);
  const now = Date.now();
  switch (name) {
    case "reserve_sender_slot": {
      const account = String(args.target_account_id);
      const interval = Number(args.min_interval_ms ?? 6000);
      slotCalls.push({ account, interval, at: now });
      const nextAllowed = slots.get(account) ?? 0;
      if (now >= nextAllowed) {
        slots.set(account, now + interval);
        return Promise.resolve({ data: { reserved: true, wait_ms: 0 }, error: null });
      }
      return Promise.resolve({
        data: { reserved: false, wait_ms: nextAllowed - now },
        error: null,
      });
    }
    case "get_sender_slot_wait_ms": {
      const nextAllowed = slots.get(String(args.target_account_id)) ?? 0;
      return Promise.resolve({ data: Math.max(0, nextAllowed - now), error: null });
    }
    case "claim_next_email_message": {
      const campaign = (store["email_campaigns"] ?? []).find(
        (c) =>
          c.id === args.target_campaign_id && c.user_id === args.target_user_id,
      );
      if (!campaign || !["queued", "sending"].includes(campaign.status as string))
        return Promise.resolve({ data: null, error: null });
      const message = (store["email_messages"] ?? []).find(
        (m) =>
          m.campaign_id === campaign.id &&
          m.user_id === args.target_user_id &&
          m.status === "queued" &&
          (m.next_attempt_at == null || (m.next_attempt_at as number) <= now),
      );
      if (!message) return Promise.resolve({ data: null, error: null });
      message.status = "sending";
      message.attempt_count = Number(message.attempt_count ?? 0) + 1;
      message.updated_at = new Date(now).toISOString();
      campaign.status = "sending";
      campaign.started_at = campaign.started_at ?? new Date(now).toISOString();
      campaign.queued_count = Math.max(0, Number(campaign.queued_count ?? 0) - 1);
      campaign.sending_count = Number(campaign.sending_count ?? 0) + 1;
      return Promise.resolve({ data: message, error: null });
    }
    case "finalize_email_message": {
      const message = (store["email_messages"] ?? []).find(
        (m) => m.id === args.target_message_id,
      );
      if (!message || message.status !== "sending")
        return Promise.resolve({ data: false, error: null });
      const campaign = (store["email_campaigns"] ?? []).find(
        (c) => c.id === message.campaign_id,
      )!;
      if (args.succeeded) {
        message.status = "sent";
        message.sent_at = new Date(now).toISOString();
        message.provider_message_id = args.provider_id ?? null;
        campaign.sent_count = Number(campaign.sent_count ?? 0) + 1;
      } else {
        message.status = "failed";
        message.error_code = args.failure_code ?? null;
        message.error_message = args.failure_message ?? null;
        campaign.failed_count = Number(campaign.failed_count ?? 0) + 1;
      }
      campaign.sending_count = Math.max(0, Number(campaign.sending_count ?? 0) - 1);
      if (
        Number(campaign.queued_count ?? 0) + Number(campaign.sending_count ?? 0) === 0
      ) {
        campaign.status =
          Number(campaign.failed_count ?? 0) === 0
            ? "completed"
            : Number(campaign.sent_count ?? 0) > 0
              ? "partially_failed"
              : "failed";
        campaign.completed_at = new Date(now).toISOString();
      }
      return Promise.resolve({ data: true, error: null });
    }
    case "retry_email_message": {
      const message = (store["email_messages"] ?? []).find(
        (m) => m.id === args.target_message_id,
      );
      if (!message || message.status !== "sending")
        return Promise.resolve({ data: false, error: null });
      message.status = "queued";
      message.error_code = args.retry_code ?? null;
      message.error_message = args.retry_message ?? null;
      message.next_attempt_at = now + 60_000; // real RPC default: 60s
      const campaign = (store["email_campaigns"] ?? []).find(
        (c) => c.id === message.campaign_id,
      )!;
      campaign.sending_count = Math.max(0, Number(campaign.sending_count ?? 0) - 1);
      campaign.queued_count = Number(campaign.queued_count ?? 0) + 1;
      return Promise.resolve({ data: true, error: null });
    }
    case "reserve_email_capacity":
      return Promise.resolve({ data: USAGE, error: null });
    case "release_email_capacity":
    case "get_daily_usage_snapshot":
    case "cancel_queued_campaign":
    case "activate_quota_upgrade":
      return Promise.resolve({ data: null, error: null });
    default:
      return Promise.resolve({ data: null, error: null });
  }
}

function makeChain(table: string) {
  const filters: Array<(row: Row) => boolean> = [];
  let deleteMode = false;
  let countMode = false;
  const all = () =>
    (store[table] ?? []).filter((row) => filters.every((f) => f(row)));
  const runDelete = () => {
    const matched = all();
    const list = store[table] ?? [];
    for (const row of matched) {
      const index = list.indexOf(row);
      if (index >= 0) list.splice(index, 1);
    }
    // Schema: email_messages.campaign_id ON DELETE CASCADE.
    if (table === "email_campaigns") {
      const ids = new Set(matched.map((row) => row.id));
      const messages = store["email_messages"] ?? [];
      for (let i = messages.length - 1; i >= 0; i -= 1)
        if (ids.has(messages[i].campaign_id)) messages.splice(i, 1);
    }
    return { data: matched, error: null };
  };
  const chain: Record<string | symbol, unknown> = new Proxy({}, {
    get(_target, prop) {
      if (typeof prop !== "string") return undefined;
      switch (prop) {
        case "eq":
          return (column: string, value: string | number) => {
            if (deleteMode) deletedFrom.push(table);
            filters.push((row) => row[column] === value);
            return chain;
          };
        case "in":
          return (column: string, values: string[]) => {
            filters.push((row) => values.includes(String(row[column])));
            return chain;
          };
        case "lt":
          return (column: string, value: string) => {
            filters.push((row) => String(row[column] ?? "") < value);
            return chain;
          };
        case "order":
        case "limit":
          return () => chain;
        case "select":
          return (_columns: string, opts?: { count?: string; head?: boolean }) => {
            countMode = Boolean(opts?.count);
            return chain;
          };
        case "single":
          return async () => {
            const matched = all();
            return {
              data: matched[0] ?? null,
              error: matched[0] ? null : { message: "PGRST116: no rows" },
            };
          };
        case "maybeSingle":
          return async () => ({ data: all()[0] ?? null, error: null });
        case "insert":
          return (payload: Row | Row[]) => {
            const rowsToInsert = Array.isArray(payload) ? payload : [payload];
            const stamped = rowsToInsert.map((row, i) => {
              const withId: Row = row.id
                ? row
                : { ...row, id: `${table}-${Math.random().toString(36).slice(2)}${i}` };
              (store[table] ??= []).push(withId);
              return withId;
            });
            const result: Record<string | symbol, unknown> = {};
            result.select = () => ({
              single: async () => ({ data: stamped[0] ?? null, error: null }),
            });
            result.then = (ok?: unknown, err?: unknown) =>
              Promise.resolve({ data: stamped, error: null }).then(
                ok as never,
                err as never,
              );
            return result;
          };
        case "delete":
          return () => {
            deleteMode = true;
            return chain;
          };
        case "then":
          return (ok?: unknown, err?: unknown) =>
            Promise.resolve(
              deleteMode
                ? runDelete()
                : countMode
                  ? { data: null, count: all().length, error: null }
                  : { data: all(), error: null },
            ).then(ok as never, err as never);
        default:
          return undefined;
      }
    },
  });
  return chain;
}

vi.mock("@/lib/auth", () => ({
  getCurrentUserAndProfile: vi.fn(),
}));

vi.mock("@/lib/email-providers", () => ({
  createEmailProvider: async () => ({
    sendEmail: async (input: { to: string }) => sendBehavior(input.to),
  }),
}));

vi.mock("@/lib/application-drafts", () => ({
  assertDraftOwnership: async (userId: string, draftId: string) => {
    const draft = (store["application_drafts"] ?? []).find(
      (row) => row.id === draftId && row.user_id === userId,
    );
    if (!draft) throw new Error("Draft not found.");
    return draft;
  },
  assertSenderOwnership: async (userId: string, accountId: string) => {
    const account = (store["email_accounts"] ?? []).find(
      (row) => row.id === accountId && row.user_id === userId && row.is_active,
    );
    if (!account) throw new Error("Connected sender account not found.");
    return account;
  },
  sanitizeEmailHtml: (html: string) => html,
  htmlToText: (html: string) => html,
  validateRecipientList: (
    recipients: Array<{ email: string; companyName?: string | null }>,
  ) =>
    recipients.map((recipient) => ({
      email: recipient.email.trim().toLowerCase(),
      company_name: recipient.companyName?.trim() || null,
      validation_status: "valid" as const,
    })),
  createStoragePath: (userId: string, draftId: string, filename: string) =>
    `${userId}/${draftId}/${filename}`,
  ALLOWED_ATTACHMENT_TYPES: new Set(["application/pdf"]),
  MAX_ATTACHMENT_SIZE: 10 * 1024 * 1024,
}));

const {
  createCampaign,
  deleteCampaign,
  getSenderSlotWaitMs,
  processCampaignBatch,
} = await import("@/lib/email-campaigns");
const { getCurrentUserAndProfile } = await import("@/lib/auth");
import {
  clampSendIntervalMs,
  HARD_MIN_SEND_INTERVAL_MS,
  MAX_SEND_INTERVAL_MS,
  MIN_SEND_INTERVAL_MS,
  sendIntervalMs,
} from "@/lib/email-rate-limit";

const USER = { id: "user-1", email: "u@example.test" };
const TERMINAL = ["completed", "partially_failed", "failed", "cancelled"];

function seedAccount(id: string, email: string, overrides: Row = {}) {
  (store["email_accounts"] ??= []).push({
    id,
    user_id: USER.id,
    provider: "gmail",
    email_address: email,
    is_active: true,
    oauth_token: "encrypted-token-value",
    oauth_refresh_token: "encrypted-refresh-value",
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    last_used_at: null,
    ...overrides,
  });
}

function seedCampaign(campaignId: string, draftId: string, overrides: Row = {}) {
  (store["email_campaigns"] ??= []).push({
    id: campaignId,
    user_id: USER.id,
    draft_id: draftId,
    email_account_id: "account-1",
    usage_date: "2026-10-02",
    status: "queued",
    total_recipients: 0,
    queued_count: 0,
    sending_count: 0,
    sent_count: 0,
    failed_count: 0,
    cancelled_count: 0,
    reserved_count: 0,
    created_at: new Date().toISOString(),
    started_at: null,
    completed_at: null,
    ...overrides,
  });
}

function seedDraft(draftId: string) {
  (store["application_drafts"] ??= []).push({
    id: draftId,
    user_id: USER.id,
    goal: "ausbildung",
    sender_email_account_id: "account-1",
    subject: `Bewerbung ${draftId}`,
    body_html: "<p>Text</p>",
    body_text: "Text",
    opportunity_key: null,
    opportunity_title: null,
    opportunity_company: null,
    opportunity_source_url: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
}

function seedMessage(campaignId: string, index: number) {
  (store["email_messages"] ??= []).push({
    id: `${campaignId}-m${index}`,
    campaign_id: campaignId,
    user_id: USER.id,
    recipient_email: `${campaignId.toLowerCase()}-${index}@example.de`,
    company_name: null,
    subject: "Bewerbung",
    status: "queued",
    attempt_count: 0,
    next_attempt_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
}

/** Seed a full sendable campaign (draft + N recipients + messages). */
function seedSendableCampaign(campaignId: string, count: number) {
  seedDraft(`draft-${campaignId}`);
  seedCampaign(campaignId, `draft-${campaignId}`);
  for (let i = 0; i < count; i += 1) seedMessage(campaignId, i);
  const campaign = (store["email_campaigns"] as Row[]).find(
    (c) => c.id === campaignId,
  )!;
  campaign.queued_count = count;
  campaign.total_recipients = count;
  campaign.reserved_count = count;
}

/** Like the real drain loop: bounded batches until the campaign settles.
 *  A campaign that was deleted mid-drain is a legitimate terminal state —
 *  the engine throws "Campaign not found." and the driver stops. */
async function drainUntilDone(campaignId: string, maxTicks = 24) {
  for (let tick = 0; tick < maxTicks; tick += 1) {
    let result: { processed: number; status: string };
    try {
      result = await processCampaignBatch(USER.id, campaignId, 5);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "Campaign not found."
      )
        return;
      throw error;
    }
    if (TERMINAL.includes(result.status)) return;
  }
}

/** Pump fake time (timers + microtasks) until the condition holds. */
async function pumpUntil(
  condition: () => boolean,
  maxFakeMs = 600_000,
  stepMs = 500,
) {
  let elapsed = 0;
  while (!condition() && elapsed < maxFakeMs) {
    await vi.advanceTimersByTimeAsync(stepMs);
    elapsed += stepMs;
  }
}

async function settle(promise: Promise<unknown>, maxFakeMs = 600_000) {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await pumpUntil(() => settled, maxFakeMs);
  return promise; // rethrows if it rejected
}

beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key];
  slots.clear();
  slotCalls.length = 0;
  rpcNames.length = 0;
  deletedFrom.length = 0;
  sends.length = 0;
  sendBehavior = async (to) => {
    sends.push({ at: Date.now(), to });
    return { providerMessageId: `msg-${sends.length}` };
  };
  vi.mocked(getCurrentUserAndProfile).mockResolvedValue({
    user: USER,
    profile: { account_status: "active" },
  } as never);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("interval configuration (pure)", () => {
  it("the default is a fixed 6000ms (no randomization at launch)", () => {
    expect(MIN_SEND_INTERVAL_MS).toBe(6000);
    expect(sendIntervalMs()).toBe(6000);
    expect(MAX_SEND_INTERVAL_MS).toBe(6000);
    // Deterministic: the configured minimum IS the maximum.
    expect(sendIntervalMs()).toBe(sendIntervalMs());
  });

  it("5000ms is allowed, 4999ms is impossible (clamped up)", () => {
    expect(clampSendIntervalMs(5000)).toBe(5000);
    expect(clampSendIntervalMs(4999)).toBe(5000);
    expect(clampSendIntervalMs(4999.9)).toBe(5000);
    expect(clampSendIntervalMs(1)).toBe(5000);
    expect(clampSendIntervalMs(0)).toBe(5000);
    expect(clampSendIntervalMs(Number.NaN)).toBe(6000);
  });

  it("any interval is confined to 5000–6000ms", () => {
    for (const value of [
      -1, 0, 1, 4000, 4999, 5000, 5250, 5500, 5999, 6000, 6001, 9000, 100000,
    ]) {
      const clamped = clampSendIntervalMs(value);
      expect(clamped).toBeGreaterThanOrEqual(5000);
      expect(clamped).toBeLessThanOrEqual(6000);
    }
    expect(HARD_MIN_SEND_INTERVAL_MS).toBe(5000);
  });

  it("the database enforces the same 5000ms floor (defense in depth)", () => {
    const sql = readFileSync(
      "supabase/migrations/20261005000000_sender_rate_limit.sql",
      "utf8",
    );
    expect(sql).toContain("min_interval_ms < 5000");
    expect(sql).toContain("min_interval_ms := 5000");
    // …and the reservation is one conditional update (atomic check-and-set).
    expect(sql).toContain("next_allowed_at <= now()");
  });
});

describe("sender slot pacing (worker orchestration, fake timers)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-02T10:00:00Z"));
  });

  it("one message sends normally — and only after reserving the slot", async () => {
    seedAccount("account-1", "sender1@example.com");
    seedSendableCampaign("campaign-A", 1);
    const result = await settle(processCampaignBatch(USER.id, "campaign-A"));
    expect(sends).toHaveLength(1);
    expect(result).toEqual({ processed: 1, status: "completed" });
    const message = store["email_messages"][0];
    expect(message.status).toBe("sent");
    // The slot was reserved BEFORE the claim (see the rpc order).
    const firstReserve = rpcNames.indexOf("reserve_sender_slot");
    const firstClaim = rpcNames.indexOf("claim_next_email_message");
    expect(firstReserve).toBeGreaterThanOrEqual(0);
    expect(firstReserve).toBeLessThan(firstClaim);
    // …with the fixed default interval.
    expect(slotCalls.every((call) => call.interval === 6000)).toBe(true);
    expect(slotCalls.every((call) => call.account === "account-1")).toBe(true);
  });

  it("message N+1 never starts before 5 seconds after message N (6s default)", async () => {
    seedAccount("account-1", "sender1@example.com");
    seedSendableCampaign("campaign-A", 3);
    await settle(processCampaignBatch(USER.id, "campaign-A"));
    expect(sends).toHaveLength(3);
    for (let i = 1; i < sends.length; i += 1) {
      const gap = sends[i].at - sends[i - 1].at;
      expect(gap).toBeGreaterThanOrEqual(5000); // the hard guarantee
      expect(gap).toBeGreaterThanOrEqual(6000); // the fixed default
    }
  });

  it("two campaigns on the SAME Gmail account share one rate limit", async () => {
    seedAccount("account-1", "sender1@example.com");
    seedSendableCampaign("campaign-A", 3);
    seedSendableCampaign("campaign-B", 3);
    await settle(Promise.all([
      drainUntilDone("campaign-A"),
      drainUntilDone("campaign-B"),
    ]));
    expect(sends).toHaveLength(6);
    // One global, account-wide sequence — every consecutive pair is
    // spaced, regardless of which campaign it belongs to.
    const ordered = [...sends].sort((a, b) => a.at - b.at);
    for (let i = 1; i < ordered.length; i += 1)
      expect(ordered[i].at - ordered[i - 1].at).toBeGreaterThanOrEqual(5000);
    // No duplicate send: every recipient was sent exactly once.
    expect(new Set(ordered.map((s) => s.to)).size).toBe(6);
    expect(store["email_messages"].every((m) => m.status === "sent")).toBe(true);
  });

  it("three campaigns × 20 recipients on ONE account stay serialized", async () => {
    seedAccount("account-1", "sender1@example.com");
    for (const id of ["campaign-A", "campaign-B", "campaign-C"])
      seedSendableCampaign(id, 20);
    await settle(
      Promise.all([
        drainUntilDone("campaign-A", 40),
        drainUntilDone("campaign-B", 40),
        drainUntilDone("campaign-C", 40),
      ]),
      1_500_000,
    );
    expect(sends).toHaveLength(60);
    const ordered = [...sends].sort((a, b) => a.at - b.at);
    for (let i = 1; i < ordered.length; i += 1)
      expect(ordered[i].at - ordered[i - 1].at).toBeGreaterThanOrEqual(5000);
    expect(new Set(ordered.map((s) => s.to)).size).toBe(60);
    for (const id of ["campaign-A", "campaign-B", "campaign-C"]) {
      const campaign = (store["email_campaigns"] as Row[]).find(
        (c) => c.id === id,
      )!;
      expect(campaign.status).toBe("completed");
    }
  });

  it("Gmail account A does not block Gmail account B", async () => {
    seedAccount("account-1", "sender1@example.com");
    seedAccount("account-2", "sender2@example.com");
    seedSendableCampaign("campaign-A", 2);
    seedSendableCampaign("campaign-B", 2);
    (store["email_campaigns"] as Row[]).find((c) => c.id === "campaign-B")!
      .email_account_id = "account-2";
    await settle(Promise.all([
      drainUntilDone("campaign-A"),
      drainUntilDone("campaign-B"),
    ]));
    expect(sends).toHaveLength(4);
    // Both accounts start at (nearly) the same instant — independent slots.
    const firstA = sends.find((s) => s.to.startsWith("campaign-a"))!;
    const firstB = sends.find((s) => s.to.startsWith("campaign-b"))!;
    expect(Math.abs(firstA.at - firstB.at)).toBeLessThan(1000);
    // …while each account still paces its own messages.
    for (const prefix of ["campaign-a", "campaign-b"]) {
      const own = sends.filter((s) => s.to.startsWith(prefix)).sort((a, b) => a.at - b.at);
      expect(own[1].at - own[0].at).toBeGreaterThanOrEqual(5000);
    }
  });

  it("multiple workers on the SAME campaign never double-send", async () => {
    // Two "tabs" draining the same campaign at the same time.
    seedAccount("account-1", "sender1@example.com");
    seedSendableCampaign("campaign-A", 4);
    await settle(Promise.all([
      drainUntilDone("campaign-A"),
      drainUntilDone("campaign-A"),
    ]));
    expect(sends).toHaveLength(4);
    const ordered = [...sends].sort((a, b) => a.at - b.at);
    for (let i = 1; i < ordered.length; i += 1)
      expect(ordered[i].at - ordered[i - 1].at).toBeGreaterThanOrEqual(5000);
    expect(new Set(ordered.map((s) => s.to)).size).toBe(4);
  });

  it("a reload (fresh batch) does NOT reset the sender limit", async () => {
    seedAccount("account-1", "sender1@example.com");
    seedSendableCampaign("campaign-A", 3);
    const firstBatch = processCampaignBatch(USER.id, "campaign-A", 1);
    // Let the first message go, then stop (simulating a reload/kill).
    await pumpUntil(() => sends.length >= 1, 30_000);
    expect(sends).toHaveLength(1);
    // A brand-new call ("new tab") starts while the slot is still busy.
    const secondBatch = processCampaignBatch(USER.id, "campaign-A", 5);
    await settle(Promise.all([firstBatch, secondBatch]));
    expect(sends).toHaveLength(3);
    const ordered = [...sends].sort((a, b) => a.at - b.at);
    for (let i = 1; i < ordered.length; i += 1)
      expect(ordered[i].at - ordered[i - 1].at).toBeGreaterThanOrEqual(5000);
  });

  it("a message waiting for the slot is never failed, sent, or deleted", async () => {
    seedAccount("account-1", "sender1@example.com");
    seedSendableCampaign("campaign-A", 2);
    // Another account's traffic holds the slot far into the future.
    slots.set("account-1", Date.now() + 600_000);
    const result = await settle(processCampaignBatch(USER.id, "campaign-A"));
    expect(result).toEqual({ processed: 0, status: "queued" });
    expect(sends).toHaveLength(0);
    // The messages are still `queued` — untouched, still processable.
    expect(
      store["email_messages"].every((m) => m.status === "queued"),
    ).toBe(true);
    // Nothing was claimed, finalized, retried or deleted.
    expect(rpcNames).not.toContain("claim_next_email_message");
    expect(rpcNames).not.toContain("finalize_email_message");
    expect(rpcNames).not.toContain("retry_email_message");
    expect(deletedFrom).toHaveLength(0);
    expect(store["email_messages"]).toHaveLength(2);
  });

  it("the waiting state is exposed as real data (getSenderSlotWaitMs)", async () => {
    seedAccount("account-1", "sender1@example.com");
    seedSendableCampaign("campaign-A", 1);
    const batch = processCampaignBatch(USER.id, "campaign-A");
    // Right after the (only) send, the account slot is held for the next
    // interval — the wait is > 0 and read straight from the slot row.
    await pumpUntil(() => sends.length >= 1, 30_000);
    const waitWhileBusy = await getSenderSlotWaitMs(USER.id, "campaign-A");
    expect(waitWhileBusy).toBeGreaterThan(0);
    // …and it decays to 0 once the interval has elapsed.
    await pumpUntil(
      () => (slots.get("account-1") ?? 0) <= Date.now(),
      30_000,
    );
    expect(await getSenderSlotWaitMs(USER.id, "campaign-A")).toBe(0);
    await settle(batch);
  });

  it("429/5xx are NOT sent — they go through the existing retry path", async () => {
    seedAccount("account-1", "sender1@example.com");
    seedSendableCampaign("campaign-A", 1);
    let attempts = 0;
    sendBehavior = async () => {
      attempts += 1;
      if (attempts === 1)
        throw {
          code: "provider_temporary",
          message: "429 rate limited",
          temporary: true,
          reconnect: false,
        };
      sends.push({ at: Date.now(), to: "campaign-a-0@example.de" });
      return { providerMessageId: "msg-retry" };
    };
    // Tick 1: attempt fails → re-queued with the 60s retry delay.
    await settle(processCampaignBatch(USER.id, "campaign-A"));
    expect(attempts).toBe(1);
    expect(sends).toHaveLength(0); // the 429 attempt never counts as sent
    expect(rpcNames).toContain("retry_email_message");
    expect((store["email_messages"][0] as Row).status).toBe("queued");
    // Tick 2 (after the delay): the retry goes out through the slot again.
    await settle(drainUntilDone("campaign-A"), 300_000);
    expect(attempts).toBe(2);
    expect(sends).toHaveLength(1); // the failed attempt never "sent"
    expect(rpcNames).toContain("retry_email_message");
    expect((store["email_messages"][0] as Row).status).toBe("sent");
    // The retry happened AFTER the 60s re-queue delay (and thus ≥ 5s).
    expect(sends[0].at).toBeGreaterThanOrEqual(Date.parse("2026-10-02T10:00:00Z") + 60_000);
  });

  it("a permanent failure finalizes as failed — no infinite loop", async () => {
    seedAccount("account-1", "sender1@example.com");
    seedSendableCampaign("campaign-A", 1);
    sendBehavior = async () => {
      throw {
        code: "authentication",
        message: "permission denied",
        temporary: false,
        reconnect: true,
      };
    };
    const result = await settle(processCampaignBatch(USER.id, "campaign-A"));
    expect(result).toEqual({ processed: 1, status: "failed" });
    expect(sends).toHaveLength(0);
    expect(rpcNames).not.toContain("retry_email_message");
    expect(rpcNames.filter((n) => n === "finalize_email_message")).toHaveLength(1);
    expect((store["email_messages"][0] as Row).status).toBe("failed");
  });

  it("creating a new campaign mid-send cannot exceed the sender limit", async () => {
    seedAccount("account-1", "sender1@example.com");
    seedSendableCampaign("campaign-A", 3);
    const driver = drainUntilDone("campaign-A");
    await pumpUntil(() => sends.length >= 1, 30_000); // A is pacing now
    // …and the user creates Campaign B on the SAME account mid-flight.
    seedDraft("draft-campaign-B");
    for (let i = 0; i < 3; i += 1)
      (store["application_draft_recipients"] ??= []).push({
        id: `draft-campaign-B-r${i}`,
        draft_id: "draft-campaign-B",
        email: `campaign-b-${i}@example.de`,
        company_name: null,
        validation_status: "valid",
        created_at: new Date().toISOString(),
      });
    const created = await createCampaign({
      draftId: "draft-campaign-B",
      senderAccountId: "account-1",
      goal: "ausbildung",
      recipientEmails: [],
    });
    // A fresh, independent campaign — its 3 messages joined the queue.
    expect(created.campaignId).not.toBe("campaign-A");
    expect(store["email_campaigns"]).toHaveLength(2);
    await settle(
      Promise.all([driver, drainUntilDone(created.campaignId)]),
      900_000,
    );
    expect(sends).toHaveLength(6);
    const ordered = [...sends].sort((a, b) => a.at - b.at);
    for (let i = 1; i < ordered.length; i += 1)
      expect(ordered[i].at - ordered[i - 1].at).toBeGreaterThanOrEqual(5000);
  });

  it("deleting a campaign never breaks the other campaigns' limit", async () => {
    seedAccount("account-1", "sender1@example.com");
    seedSendableCampaign("campaign-A", 1); // finishes quickly
    seedSendableCampaign("campaign-B", 4); // keeps pacing
    const driverA = drainUntilDone("campaign-A");
    const driverB = drainUntilDone("campaign-B");
    // Wait until A has completed and B is mid-send.
    await pumpUntil(
      () =>
        (store["email_campaigns"] as Row[]).find((c) => c.id === "campaign-A")!
          .status === "completed" && sends.length >= 1,
      300_000,
    );
    const slotBefore = slots.get("account-1") ?? 0;
    await deleteCampaign(USER.id, "campaign-A");
    // The slot is account-level state — deletion leaves it intact.
    expect(slots.get("account-1")).toBe(slotBefore);
    expect(deletedFrom).not.toContain("email_sender_slots");
    await settle(Promise.all([driverA, driverB]), 900_000);
    const bSends = sends
      .filter((s) => s.to.startsWith("campaign-b"))
      .sort((a, b) => a.at - b.at);
    expect(bSends).toHaveLength(4);
    for (let i = 1; i < bSends.length; i += 1)
      expect(bSends[i].at - bSends[i - 1].at).toBeGreaterThanOrEqual(5000);
  });

  it("never touches email_accounts, tokens, credits, or quota", async () => {
    seedAccount("account-1", "sender1@example.com");
    seedSendableCampaign("campaign-A", 2);
    const accountBefore = JSON.stringify(store["email_accounts"]);
    await settle(drainUntilDone("campaign-A"));
    expect(JSON.stringify(store["email_accounts"])).toBe(accountBefore);
    // Only the engine's own RPCs ran — nothing else at all.
    const allowed = new Set([
      "reserve_sender_slot",
      "get_sender_slot_wait_ms",
      "claim_next_email_message",
      "finalize_email_message",
      "retry_email_message",
    ]);
    expect(rpcNames.every((name) => allowed.has(name))).toBe(true);
  });
});

describe("UI + wiring (source of truth)", () => {
  const LIB = readFileSync("src/lib/email-campaigns.ts", "utf8");
  const PAGE = readFileSync("src/app/applications/campaign/[id]/page.tsx", "utf8");
  const SETTINGS = readFileSync("src/app/settings/email/page.tsx", "utf8");
  const ACTIONS = readFileSync(
    "src/app/applications/campaign/[id]/actions.ts",
    "utf8",
  );

  it("the worker reserves the slot BEFORE claiming (no check-then-act)", () => {
    const loop = LIB.slice(
      LIB.indexOf("export async function processCampaignBatch"),
      LIB.indexOf("export async function getCampaign"),
    );
    const reserveAt = loop.indexOf("reserveSenderSlot(");
    const claimAt = loop.indexOf("claim_next_email_message");
    expect(reserveAt).toBeGreaterThanOrEqual(0);
    expect(reserveAt).toBeLessThan(claimAt);
    // …and a busy slot stops the batch without claiming (messages stay queued).
    expect(loop).toContain("if (!slotFree) break;");
    // The old fixed 250ms micro-pacing is gone — the slot is the only pacer.
    expect(loop).not.toContain("setTimeout(resolve, 250)");
  });

  it("logs are safe: structured, and never carry tokens or content", () => {
    expect(LIB).toContain("[EMAIL_RATE_LIMIT]");
    expect(LIB).toContain("action=${action}");
    expect(LIB).toContain('logRateLimit("slot_reserved"');
    expect(LIB).toContain('logRateLimit("waiting"');
    expect(LIB).toContain('logRateLimit("send_allowed"');
    const logFn = LIB.slice(
      LIB.indexOf("function logRateLimit"),
      LIB.indexOf("Smart Sending — reserve"),
    );
    expect(logFn).not.toContain("token");
    expect(logFn).not.toContain("secret");
    expect(logFn).not.toContain("recipient_email");
    expect(logFn).not.toContain("body_html");
  });

  it("the campaign page shows the REAL waiting state (no fake progress)", () => {
    expect(PAGE).toContain("getSenderSlotWaitMs(user.id, id)");
    expect(PAGE).toContain("Waiting for sending slot…");
    expect(PAGE).toContain("Sending…");
    // The state is conditional on the actual slot read, not invented.
    expect(PAGE).toContain("senderSlotWaitMs > 0");
  });

  it("the drain action reports the slot wait to the monitor", () => {
    expect(ACTIONS).toContain("getSenderSlotWaitMs(user.id, campaignId)");
    expect(ACTIONS).toContain("slotWaitMs");
  });

  it("email settings shows Smart Sending — enabled, 5–6s, no lowerable control", () => {
    expect(SETTINGS).toContain("Smart Sending");
    expect(SETTINGS).toContain("Enabled");
    expect(SETTINGS).toContain("5–6 seconds");
    expect(SETTINGS).toContain("6 seconds");
    expect(SETTINGS).toContain("5 seconds");
    expect(SETTINGS).toContain("minimum 5-second interval");
    // No slider / number input that could push the interval below 5s.
    expect(SETTINGS).not.toContain('type="range"');
    expect(SETTINGS).not.toContain("setInterval");
  });

  it("OAuth, token refresh, credits and quota code paths are untouched", () => {
    const rate = LIB.slice(
      LIB.indexOf("function logRateLimit"),
      LIB.indexOf("export async function processCampaignBatch"),
    );
    expect(rate).not.toMatch(/search-credits|tavily|gemini/i);
    expect(rate).not.toContain("refresh_token");
    expect(rate).not.toContain("encrypt");
    expect(rate).not.toContain("token");
    // The engine's provider path (auth + send) is the same as before.
    expect(LIB).toContain("await provider.sendEmail(");
    expect(LIB).toContain('admin.rpc("finalize_email_message"');
  });
});
