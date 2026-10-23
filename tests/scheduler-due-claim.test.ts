import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Scheduler due-claim semantics — the production investigation
 * ("scheduled campaign not processed, cron returns queue-empty").
 *
 * These tests model the EXACT merged SQL predicates (supabase/migrations):
 *  - claim_next_pending_campaign (20261003000000_durable_worker.sql):
 *      c.status in ('queued','sending') AND EXISTS(queued message with
 *      next_attempt_at IS NULL or <= now()), order by created_at limit 1.
 *  - claim_next_email_message (20260927030000_email_sending_engine.sql):
 *      queued + due + active campaign, order by created_at, FOR UPDATE
 *      SKIP LOCKED, then the atomic status flip to 'sending'.
 * The fake performs the flip SYNCHRONOUSLY inside the RPC call (as the
 * Postgres transaction does), which is what makes double-claiming
 * structurally impossible under interleaved workers.
 *
 * Covered: future scheduled campaign → NOT claimable before the instant;
 * transition to due → claimed and processed; repeated AND concurrent
 * ticks → every message claimed exactly once, sent exactly once.
 * No email is actually sent: the provider is mocked and ONLY call COUNTS
 * are asserted (never addresses or content).
 */

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  getCurrentUserAndProfile: vi.fn(),
}));
vi.mock("@/lib/email-providers", () => ({
  createEmailProvider: vi.fn(),
}));

const { createAdminClient } = await import("@/lib/supabase/admin");
const { getCurrentUserAndProfile } = await import("@/lib/auth");
const { createEmailProvider } = await import("@/lib/email-providers");
const {
  createCampaign,
  processCampaignBatch,
} = await import("@/lib/email-campaigns");

type Row = Record<string, unknown>;
interface RpcCall {
  name: string;
  args: Row;
}
interface FakeDb {
  tables: Record<string, Row[]>;
  rpcLog: RpcCall[];
}

const BASELINE = Date.parse("2026-10-11T12:00:00.000Z");
const RECIPIENT_COUNT = 8;

function makeDb(): FakeDb {
  const db: FakeDb = {
    tables: {
      application_drafts: [
        {
          id: "draft-1",
          user_id: "user-1",
          subject: "Bewerbung",
          body_html: "<p>Hallo</p>",
          body_text: "Hallo",
          sender_email_account_id: "account-1",
        },
      ],
      email_accounts: [
        {
          id: "account-1",
          user_id: "user-1",
          provider: "gmail",
          email: "me@example.test",
          is_active: true,
        },
      ],
      application_draft_recipients: Array.from(
        { length: RECIPIENT_COUNT },
        (_, i) => ({
          id: `recipient-${i + 1}`,
          draft_id: "draft-1",
          user_id: "user-1",
          email: `recipient${i + 1}@example.test`,
          company_name: null,
          created_at: new Date(BASELINE - 1000).toISOString(),
        }),
      ),
      email_campaigns: [],
      email_messages: [],
      daily_usage: [],
      activity_logs: [],
    },
    rpcLog: [],
  };
  return db;
}

function findCampaign(db: FakeDb, id: unknown): Row | undefined {
  return (db.tables.email_campaigns ?? []).find((r) => r.id === id);
}
function findMessage(db: FakeDb, id: unknown): Row | undefined {
  return (db.tables.email_messages ?? []).find((r) => r.id === id);
}

/** Implements the merged claim/finalize RPCs (see file header) + the
 *  bookkeeping RPCs the engine touches. */
function rpcImpl(db: FakeDb) {
  return (name: string, args: Row) => {
    const now = Date.now();
    const iso = new Date(now).toISOString();
    db.rpcLog.push({ name, args });
    switch (name) {
      case "reserve_email_capacity":
      case "reserve_email_capacity_on":
        return {
          data: {
            date:
              name === "reserve_email_capacity_on"
                ? (args.on_date as string)
                : new Date(now).toISOString().slice(0, 10),
            daily_limit: 100,
            emails_sent: 0,
            emails_reserved: 1,
            remaining: 99,
          },
          error: null,
        };
      case "release_email_capacity":
        return { data: null, error: null };
      case "get_daily_usage_snapshot":
        return {
          data: {
            date: new Date(now).toISOString().slice(0, 10),
            emails_sent: 0,
            daily_limit: 100,
          },
          error: null,
        };
      // ── 20261003 durable worker: campaign-level discovery ──
      case "claim_next_pending_campaign": {
        const ready = (db.tables.email_campaigns ?? [])
          .filter((c) => c.status === "queued" || c.status === "sending")
          .filter((c) =>
            (db.tables.email_messages ?? []).some(
              (m) =>
                m.campaign_id === c.id &&
                m.status === "queued" &&
                (m.next_attempt_at == null ||
                  Date.parse(String(m.next_attempt_at)) <= now),
            ),
          )
          .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))[0];
        return {
          data: ready
            ? { user_id: ready.user_id, campaign_id: ready.id }
            : { user_id: null, campaign_id: null },
          error: null,
        };
      }
      // ── 20260927 engine: message-level atomic claim ──
      case "claim_next_email_message": {
        const c = findCampaign(db, args.target_campaign_id);
        if (!c || (c.status !== "queued" && c.status !== "sending"))
          return { data: null, error: null };
        const candidate = (db.tables.email_messages ?? [])
          .filter(
            (m) =>
              m.user_id === args.target_user_id &&
              m.campaign_id === args.target_campaign_id &&
              m.status === "queued" &&
              (m.next_attempt_at == null ||
                Date.parse(String(m.next_attempt_at)) <= now),
          )
          .sort((a, b) =>
            String(a.created_at).localeCompare(String(b.created_at)),
          )[0];
        if (!candidate) return { data: null, error: null };
        // The real RPC's UPDATE ... FOR UPDATE SKIP LOCKED ... RETURNING,
        // collapsed to its observable effect (atomic in the transaction).
        candidate.status = "sending";
        candidate.attempt_count = (Number(candidate.attempt_count ?? 0)) + 1;
        candidate.updated_at = iso;
        c.status = "sending";
        c.started_at = c.started_at ?? iso;
        c.queued_count = Math.max(0, Number(c.queued_count ?? 0) - 1);
        c.sending_count = Number(c.sending_count ?? 0) + 1;
        return { data: { ...candidate }, error: null };
      }
      // ── engine: finalize (sending → terminal + counters) ──
      case "finalize_email_message": {
        const m = findMessage(db, args.target_message_id);
        if (!m || m.status !== "sending") return { data: false, error: null };
        m.status = args.succeeded ? "sent" : "failed";
        m.updated_at = iso;
        const c = findCampaign(db, m.campaign_id);
        if (c) {
          c.sending_count = Math.max(0, Number(c.sending_count ?? 0) - 1);
          if (args.succeeded) c.sent_count = Number(c.sent_count ?? 0) + 1;
          else c.failed_count = Number(c.failed_count ?? 0) + 1;
          const active = (db.tables.email_messages ?? []).filter(
            (x) =>
              x.campaign_id === c.id &&
              (x.status === "queued" || x.status === "sending"),
          ).length;
          if (active === 0) {
            c.status = "completed";
            c.ended_at = iso;
          }
          c.updated_at = iso;
        }
        return { data: true, error: null };
      }
      case "retry_email_message": {
        const m = findMessage(db, args.target_message_id);
        if (m) {
          m.status = "queued";
          m.next_attempt_at = new Date(now + 60_000).toISOString();
          m.updated_at = iso;
        }
        return { data: true, error: null };
      }
      case "reserve_sender_slot":
        // Test isolation: the slot is always free (the slot's own atomicity
        // is covered by dedicated rate-limit tests).
        return { data: { reserved: true, wait_ms: 0 }, error: null };
      case "cancel_queued_campaign": {
        const c = findCampaign(db, args.target_campaign_id);
        if (!c) return { data: false, error: null };
        for (const m of db.tables.email_messages ?? [])
          if (m.campaign_id === c.id && m.status === "queued")
            m.status = "cancelled";
        c.status = "cancelled";
        c.ended_at = iso;
        return { data: true, error: null };
      }
      default:
        return { data: null, error: null };
    }
  };
}

/** Minimal faithful PostgREST-ish chain over the fake tables. */
function makeChain(db: FakeDb, table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  const matched = () =>
    (db.tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
  const terminalSelect = () =>
    Promise.resolve({ data: matched(), error: null });
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = (col: string, val: unknown) => {
    filters.push((r) => r[col] === val);
    return chain;
  };
  chain.in = (col: string, vals: unknown[]) => {
    filters.push((r) => (vals as unknown[]).includes(r[col]));
    return chain;
  };
  chain.lt = (col: string, val: unknown) => {
    filters.push((r) => String(r[col] ?? "") < String(val));
    return terminalSelect();
  };
  chain.order = () => terminalSelect();
  chain.single = async () => {
    const first = matched()[0];
    return first
      ? { data: first, error: null }
      : { data: null, error: { message: "PGRST116: no rows" } };
  };
  chain.insert = (payload: Row | Row[]) => {
    const list = Array.isArray(payload) ? payload : [payload];
    // Column defaults the real schema provides (so assertions on
    // never-touched counters see 0, not undefined):
    const defaults: Row =
      table === "email_campaigns"
        ? {
            sent_count: 0,
            failed_count: 0,
            sending_count: 0,
            started_at: null,
            ended_at: null,
          }
        : table === "email_messages"
          ? { attempt_count: 0, provider_message_id: null }
          : {};
    const stamped = list.map((r, i) => ({
      id: `gen-${table}-${(db.tables[table] ?? []).length + i + 1}`,
      created_at: new Date(Date.now()).toISOString(),
      updated_at: new Date(Date.now()).toISOString(),
      ...defaults,
      ...r,
    }));
    (db.tables[table] ??= []).push(...stamped);
    const result: Record<string, unknown> = {
      select: () => result,
      single: async () => ({ data: stamped[0] ?? null, error: null }),
    };
    result.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
      Promise.resolve({ data: stamped, error: null }).then(resolve, reject);
    return result;
  };
  chain.delete = () => {
    const del: Record<string, unknown> = {};
    del.eq = (col: string, val: unknown) => {
      filters.push((r) => r[col] === val);
      return del;
    };
    del.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
      const rows = db.tables[table] ?? [];
      db.tables[table] = rows.filter((r) => !filters.every((f) => f(r)));
      return Promise.resolve({ data: null, error: null }).then(resolve, reject);
    };
    return del;
  };
  return chain;
}

function makeClient(db: FakeDb) {
  return {
    from: (table: string) => makeChain(db, table),
    rpc: (name: string, args: Row) => Promise.resolve(rpcImpl(db)(name, args)),
  };
}

let db: FakeDb;
let providerSend: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  db = makeDb();
  vi.mocked(createAdminClient).mockReturnValue(makeClient(db) as never);
  vi.mocked(getCurrentUserAndProfile).mockResolvedValue({
    user: { id: "user-1" },
    profile: { account_status: "active" },
  } as never);
  providerSend = vi.fn(async () => ({ providerMessageId: "pm-1" }));
  vi.mocked(createEmailProvider).mockImplementation(
    async () => ({ sendEmail: providerSend }) as never,
  );
  vi.useFakeTimers();
  vi.setSystemTime(new Date(BASELINE));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("scheduled campaign due-claim lifecycle (merged SQL predicates, faked faithfully)", () => {
  it("a FUTURE scheduled campaign is not claimable before its instant (queue-empty is correct)", async () => {
    const due = new Date(BASELINE + 2 * 3_600_000); // T+2h
    const { campaignId } = await createCampaign({
      draftId: "draft-1",
      senderAccountId: "account-1",
      goal: "ausbildung",
      recipientEmails: Array.from({ length: RECIPIENT_COUNT }, (_, i) => ({
        email: `recipient${i + 1}@example.test`,
      })),
      scheduling: {
        utcIso: due.toISOString(),
        timeZone: "UTC",
        usageDate: due.toISOString().slice(0, 10),
      },
    });
    // Discovery RPC — exactly what /api/cron/email-scheduler calls:
    const { data } = await (
      createAdminClient() as unknown as {
        rpc: (n: string) => Promise<{ data: { campaign_id: string | null } }>;
      }
    ).rpc("claim_next_pending_campaign");
    expect(data.campaign_id).toBeNull();

    // Even a MANUAL direct batch on the exact campaign id processes nothing:
    const result = await processCampaignBatch("user-1", campaignId, 5);
    expect(result.processed).toBe(0);
    expect(providerSend).not.toHaveBeenCalled();
    const campaign = findCampaign(db, campaignId);
    expect(campaign).toBeTruthy();
    expect(campaign!.status).toBe("queued");
    expect(campaign!.started_at).toBeNull();
    for (const m of db.tables.email_messages) {
      expect(m.status).toBe("queued");
      expect(m.next_attempt_at).toBe(due.toISOString());
    }
  });

  it("at the due instant the campaign transitions to claimable and processes", async () => {
    const due = new Date(BASELINE + 2 * 3_600_000);
    const { campaignId } = await createCampaign({
      draftId: "draft-1",
      senderAccountId: "account-1",
      goal: "ausbildung",
      recipientEmails: Array.from({ length: RECIPIENT_COUNT }, (_, i) => ({
        email: `recipient${i + 1}@example.test`,
      })),
      scheduling: {
        utcIso: due.toISOString(),
        timeZone: "UTC",
        usageDate: due.toISOString().slice(0, 10),
      },
    });

    // One second PAST the stored instant — the tick that should see it:
    vi.setSystemTime(new Date(due.getTime() + 1000));
    const admin = createAdminClient() as unknown as {
      rpc: (n: string) => Promise<{
        data: { user_id: string | null; campaign_id: string | null };
      }>;
    };
    const { data } = await admin.rpc("claim_next_pending_campaign");
    expect(data.campaign_id).toBe(campaignId);

    const result = await processCampaignBatch("user-1", campaignId, 5);
    expect(result.processed).toBe(5);
    expect(providerSend).toHaveBeenCalledTimes(5);
    const sent = db.tables.email_messages.filter((m) => m.status === "sent");
    const queued = db.tables.email_messages.filter((m) => m.status === "queued");
    expect(sent).toHaveLength(5);
    expect(queued).toHaveLength(3);
    const campaign = findCampaign(db, campaignId);
    expect(campaign).toBeTruthy();
    expect(campaign!.status).toBe("sending");
    expect(campaign!.started_at).not.toBeNull();
  });

  it("repeated ticks never double-claim or double-send (exactly-once)", async () => {
    const due = new Date(BASELINE + 60_000); // 1 minute out
    const { campaignId } = await createCampaign({
      draftId: "draft-1",
      senderAccountId: "account-1",
      goal: "ausbildung",
      recipientEmails: Array.from({ length: RECIPIENT_COUNT }, (_, i) => ({
        email: `recipient${i + 1}@example.test`,
      })),
      scheduling: {
        utcIso: due.toISOString(),
        timeZone: "UTC",
        usageDate: due.toISOString().slice(0, 10),
      },
    });
    vi.setSystemTime(new Date(due.getTime() + 1000));

    // Tick 1 (batch of 5):
    const r1 = await processCampaignBatch("user-1", campaignId, 5);
    expect(r1.processed).toBe(5);
    // Tick 2: the remaining 3:
    const r2 = await processCampaignBatch("user-1", campaignId, 5);
    expect(r2.processed).toBe(3);
    expect(providerSend).toHaveBeenCalledTimes(RECIPIENT_COUNT);
    // Tick 3: nothing left — and no re-claim of terminal messages:
    const r3 = await processCampaignBatch("user-1", campaignId, 5);
    expect(r3.processed).toBe(0);
    expect(providerSend).toHaveBeenCalledTimes(RECIPIENT_COUNT);

    const campaign = findCampaign(db, campaignId);
    expect(campaign).toBeTruthy();
    expect(campaign!.status).toBe("completed");
    // Exactly-once accounting: every recipient sent once, none failed,
    // claims and finalizations balanced (no double finalize possible —
    // finalize only accepts status 'sending').
    expect(db.tables.email_messages.filter((m) => m.status === "sent")).toHaveLength(
      RECIPIENT_COUNT,
    );
    expect(db.tables.email_messages.filter((m) => m.status === "failed")).toHaveLength(0);
    expect(campaign!.sent_count).toBe(RECIPIENT_COUNT);
    expect(campaign!.failed_count).toBe(0);
  });

  it("concurrent ticks (cron + manual dispatch at the same moment) still send each message exactly once", async () => {
    // Seed a campaign that is already due (mirrors createCampaign's rows):
    const due = BASELINE - 1000;
    const campaign: Row = {
      id: "campaign-due",
      user_id: "user-1",
      draft_id: "draft-1",
      email_account_id: "account-1",
      usage_date: new Date(due).toISOString().slice(0, 10),
      status: "queued",
      started_at: null,
      ended_at: null,
      created_at: new Date(BASELINE - 60_000).toISOString(),
      scheduled_at: new Date(due).toISOString(),
      timezone: "UTC",
      total_recipients: RECIPIENT_COUNT,
      queued_count: RECIPIENT_COUNT,
      sending_count: 0,
      sent_count: 0,
      failed_count: 0,
      reserved_count: RECIPIENT_COUNT,
    };
    db.tables.email_campaigns.push(campaign);
    for (let i = 0; i < RECIPIENT_COUNT; i += 1)
      db.tables.email_messages.push({
        id: `message-${i + 1}`,
        campaign_id: "campaign-due",
        user_id: "user-1",
        recipient_email: `recipient${i + 1}@example.test`,
        company_name: null,
        subject: "Bewerbung",
        status: "queued",
        attempt_count: 0,
        next_attempt_at: new Date(due).toISOString(),
        created_at: new Date(BASELINE - 50_000 + i).toISOString(),
        updated_at: new Date(BASELINE - 50_000 + i).toISOString(),
      });

    // Two workers at the same instant (cron tick + manual "Process batch"):
    const [a, b] = await Promise.all([
      processCampaignBatch("user-1", "campaign-due", 5),
      processCampaignBatch("user-1", "campaign-due", 5),
    ]);
    expect(a.processed + b.processed).toBe(RECIPIENT_COUNT);
    // Every message claimed+sent EXACTLY once despite the overlap:
    expect(providerSend).toHaveBeenCalledTimes(RECIPIENT_COUNT);
    expect(db.tables.email_messages.filter((m) => m.status === "sent")).toHaveLength(
      RECIPIENT_COUNT,
    );
    expect(db.tables.email_messages.filter((m) => m.status === "failed")).toHaveLength(0);
    expect(findCampaign(db, "campaign-due")!.status).toBe("completed");
  });

  it("a campaign whose status left 'queued' (e.g. cancelled) is never claimable again", async () => {
    const due = BASELINE - 1000;
    const campaign: Row = {
      id: "campaign-cancelled",
      user_id: "user-1",
      draft_id: "draft-1",
      email_account_id: "account-1",
      usage_date: new Date(due).toISOString().slice(0, 10),
      status: "cancelled",
      started_at: null,
      ended_at: new Date(due + 5000).toISOString(),
      created_at: new Date(BASELINE - 60_000).toISOString(),
      scheduled_at: new Date(due).toISOString(),
      timezone: "UTC",
      total_recipients: 1,
      queued_count: 0,
      sending_count: 0,
      sent_count: 0,
      failed_count: 0,
      reserved_count: 0,
    };
    db.tables.email_campaigns.push(campaign);
    // A stray queued message must not resurrect the campaign either way
    // (message-level claim requires an active campaign):
    db.tables.email_messages.push({
      id: "message-stray",
      campaign_id: "campaign-cancelled",
      user_id: "user-1",
      recipient_email: "x@example.test",
      company_name: null,
      subject: "Bewerbung",
      status: "queued",
      attempt_count: 0,
      next_attempt_at: new Date(due).toISOString(),
      created_at: new Date(BASELINE - 50_000).toISOString(),
      updated_at: new Date(BASELINE - 50_000).toISOString(),
    });
    const admin = createAdminClient() as unknown as {
      rpc: (n: string) => Promise<{ data: { campaign_id: string | null } }>;
    };
    const { data } = await admin.rpc("claim_next_pending_campaign");
    expect(data.campaign_id).toBeNull();
    const r = await processCampaignBatch("user-1", "campaign-cancelled", 5);
    expect(r.processed).toBe(0);
    expect(providerSend).not.toHaveBeenCalled();
  });
});
