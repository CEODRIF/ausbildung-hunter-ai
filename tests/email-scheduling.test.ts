import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Production-ready email scheduling — the feature contract.
 *
 *  - A scheduled campaign is a `queued` campaign whose messages carry
 *    `next_attempt_at = scheduled_at`; the EXISTING claim predicates
 *    (verified against the migration sources below) make early sending
 *    impossible for every worker, poller and browser tab.
 *  - The quota is reserved against the SCHEDULED date (reserve_email_capacity_on),
 *    so finalize/cancel/release (all usage_date-driven) work unchanged.
 *  - The server action re-runs the same pure wall-clock → UTC conversion as
 *    the browser preview, rejects past times against the SERVER clock, and
 *    requires explicit resolution of DST folds.
 *  - reschedule_campaign is atomic (row lock + status guard) and refuses
 *    once sending started.
 *  - Stale recovery must not cancel a campaign that is merely waiting for
 *    its (future) instant; a campaign whose instant passed long ago
 *    (scheduler down) is still recovered.
 *  - The durable trigger: Vercel Cron → /api/cron/email-scheduler (bounded,
 *    fail-closed auth, atomic claims) + a gated GitHub Actions fallback
 *    driving the same engine through the existing internal endpoints.
 */

type Row = Record<string, unknown>;

interface RpcError {
  message: string;
}
interface FakeDb {
  tables: Record<string, Row[]>;
  rpcLog: Array<{ name: string; args: Row }>;
  rpcErrorFor?: string | null;
  rpcErrorMessage?: string;
  insertErrorFor?: string | null;
  rescheduleResult?: boolean;
}

function makeDb(
  overrides: Partial<{
    draft: Row;
    recipients: Row[];
    accounts: Row[];
    campaigns: Row[];
    messages: Row[];
    rpcErrorFor: string | null;
    rpcErrorMessage: string;
    insertErrorFor: string | null;
    rescheduleResult: boolean;
  }> = {},
): FakeDb {
  return {
    tables: {
      application_drafts: [
        overrides.draft ?? {
          id: "draft-1",
          user_id: "user-1",
          subject: "Bewerbung um einen Ausbildungsplatz",
          body_html: "<p>Hallo</p>",
          body_text: "Hallo",
          sender_email_account_id: "account-1",
        },
      ],
      application_draft_recipients:
        overrides.recipients ?? [
          { draft_id: "draft-1", email: "a@example.de", company_name: "A" },
          { draft_id: "draft-1", email: "b@example.de", company_name: null },
        ],
      email_accounts:
        overrides.accounts ?? [
          {
            id: "account-1",
            user_id: "user-1",
            provider: "gmail",
            email: "me@example.test",
            is_active: true,
          },
        ],
      email_campaigns: overrides.campaigns ?? [],
      email_messages: overrides.messages ?? [],
      activity_logs: [],
    },
    rpcLog: [],
    rpcErrorFor: overrides.rpcErrorFor ?? null,
    rpcErrorMessage: overrides.rpcErrorMessage ?? "daily_quota_exceeded",
    insertErrorFor: overrides.insertErrorFor ?? null,
    rescheduleResult: overrides.rescheduleResult ?? true,
  };
}

function makeChain(db: FakeDb, table: string) {
  const filters: Array<(row: Row) => boolean> = [];
  const matched = () =>
    (db.tables[table] ?? []).filter((row) => filters.every((f) => f(row)));
  const asPromise = (result: { data: unknown; error: RpcError | null }) =>
    Promise.resolve(result);
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.in = (column: string, values: string[]) => {
    filters.push((row) => values.includes(String(row[column])));
    return chain;
  };
  chain.eq = (column: string, value: unknown) => {
    filters.push((row) => row[column] === value);
    return chain;
  };
  const terminalSelect = () => asPromise({ data: matched(), error: null });
  chain.order = () => terminalSelect();
  chain.lt = (column: string, value: string) => {
    filters.push((row) => String(row[column] ?? "") < value);
    return terminalSelect();
  };
  chain.single = async () => {
    const row = matched()[0] ?? null;
    return {
      data: row,
      error: row ? null : { message: "PGRST116: no rows returned" },
    };
  };
  chain.maybeSingle = async () => ({ data: matched()[0] ?? null, error: null });
  chain.insert = (payload: Row | Row[]) => {
    const list = Array.isArray(payload) ? payload : [payload];
    if (db.insertErrorFor === table) {
      return asPromise({
        data: null,
        error: { message: "insert failed" },
      });
    }
    const stamped = list.map((row) => ({
      id: `gen-${Math.random().toString(36).slice(2)}`,
      ...row,
    }));
    (db.tables[table] ??= []).push(...stamped);
    const result: Record<string, unknown> = {};
    result.select = () => result;
    result.single = async () => ({ data: stamped[0] ?? null, error: null });
    result.then = (resolve: (value: unknown) => void, reject: (e: unknown) => void) =>
      asPromise({ data: stamped, error: null }).then(resolve, reject);
    return result;
  };
  chain.delete = () => {
    const del: Record<string, unknown> = {};
    del.eq = (column: string, value: unknown) => {
      filters.push((row) => row[column] === value);
      return del;
    };
    del.then = (resolve: (value: unknown) => void) => {
      const list = db.tables[table] ?? [];
      const removed = list.filter((row) => filters.every((f) => f(row)));
      db.tables[table] = list.filter((row) => !filters.every((f) => f(row)));
      return asPromise({ data: removed, error: null }).then(resolve);
    };
    return del;
  };
  return chain;
}

function makeClient(db: FakeDb) {
  return {
    from: (table: string) => makeChain(db, table),
    rpc: async (name: string, args: Row) => {
      db.rpcLog.push({ name, args });
      if (db.rpcErrorFor === name)
        return { data: null, error: { message: db.rpcErrorMessage ?? "boom" } };
      switch (name) {
        case "reserve_email_capacity":
          return {
            data: {
              date: "2026-01-10",
              daily_limit: 100,
              emails_sent: 0,
              emails_reserved: 2,
              remaining: 98,
            },
            error: null,
          };
        case "reserve_email_capacity_on":
          return {
            data: {
              date: args.on_date,
              daily_limit: 100,
              emails_sent: 0,
              emails_reserved: 2,
              remaining: 98,
            },
            error: null,
          };
        case "reschedule_campaign": {
          const ok = db.rescheduleResult ?? true;
          if (ok) {
            // Mirror the real RPC: apply the move to the campaign row.
            const row = (db.tables.email_campaigns ?? []).find(
              (r) => r.id === args.target_campaign_id,
            );
            if (row) {
              row.scheduled_at = args.new_scheduled_at;
              row.timezone = args.new_timezone;
              row.usage_date = args.new_usage_date;
            }
          }
          return { data: ok, error: null };
        }
        case "cancel_queued_campaign":
          return { data: true, error: null };
        case "finalize_email_message":
          return { data: false, error: null };
        default:
          return { data: null, error: null };
      }
    },
  };
}

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getCurrentUserAndProfile: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), {
      digest: `NEXT_REDIRECT;replace;${url};307;`,
    });
  }),
}));

const { createAdminClient } = await import("@/lib/supabase/admin");
const { getCurrentUserAndProfile } = await import("@/lib/auth");
const { redirect } = await import("next/navigation");

function useDb(db: FakeDb) {
  vi.mocked(createAdminClient).mockReturnValue(makeClient(db) as never);
  vi.mocked(getCurrentUserAndProfile).mockResolvedValue({
    user: { id: "user-1", email: "u@example.test" },
    profile: { account_status: "active" },
  } as never);
}

const USER_ID = "user-1";
const RECIPIENTS = [
  { email: "a@example.de", companyName: "A" },
  { email: "b@example.de", companyName: null },
];

const BASELINE = "2026-01-10T12:00:00.000Z";

// ─────────────────────────────────────────────────────────────────────────
// 1. Engine: createCampaign with scheduling
// ─────────────────────────────────────────────────────────────────────────
describe("createCampaign — scheduled sends are queued, gated and quota-true", () => {
  it("reserves the SCHEDULED date, stores canonical UTC + IANA zone, gates every message at the instant", async () => {
    const { createCampaign } = await import("@/lib/email-campaigns");
    const db = makeDb();
    useDb(db);
    const result = await createCampaign({
      draftId: "draft-1",
      senderAccountId: "account-1",
      goal: "ausbildung",
      recipientEmails: RECIPIENTS,
      scheduling: {
        utcIso: "2026-11-25T13:35:00.000Z",
        timeZone: "Europe/Berlin",
        usageDate: "2026-11-25",
      },
    });
    expect(result.campaignId).toBeTruthy();
    const rpcNames = db.rpcLog.map((entry) => entry.name);
    expect(rpcNames).toContain("reserve_email_capacity_on");
    expect(rpcNames).not.toContain("reserve_email_capacity");
    expect(
      db.rpcLog.find((entry) => entry.name === "reserve_email_capacity_on")
        ?.args.on_date,
    ).toBe("2026-11-25");
    const campaign = db.tables.email_campaigns[0];
    expect(campaign.status).toBe("queued");
    expect(campaign.scheduled_at).toBe("2026-11-25T13:35:00.000Z");
    expect(campaign.timezone).toBe("Europe/Berlin");
    // The capacity lifecycle must run against the scheduled date.
    expect(campaign.usage_date).toBe("2026-11-25");
    const messages = db.tables.email_messages;
    expect(messages).toHaveLength(2);
    for (const message of messages) {
      expect(message.status).toBe("queued");
      // THE due-gate: claimable only at/after the instant.
      expect(message.next_attempt_at).toBe("2026-11-25T13:35:00.000Z");
    }
    expect(db.tables.activity_logs[0].activity_type).toBe("campaign_created");
  });

  it("keeps the IMMEDIATE path byte-for-byte unchanged (no scheduling fields)", async () => {
    const { createCampaign } = await import("@/lib/email-campaigns");
    const db = makeDb();
    useDb(db);
    await createCampaign({
      draftId: "draft-1",
      senderAccountId: "account-1",
      goal: "ausbildung",
      recipientEmails: RECIPIENTS,
    });
    const rpcNames = db.rpcLog.map((entry) => entry.name);
    expect(rpcNames).toContain("reserve_email_capacity");
    expect(rpcNames).not.toContain("reserve_email_capacity_on");
    const campaign = db.tables.email_campaigns[0];
    expect(campaign.scheduled_at).toBeUndefined();
    expect(campaign.timezone).toBeUndefined();
    expect(campaign.usage_date).toBe("2026-01-10");
    for (const message of db.tables.email_messages)
      expect(message.next_attempt_at).toBeNull();
  });

  it("rejects a scheduled send when the scheduled DATE lacks quota — nothing is created", async () => {
    const { createCampaign } = await import("@/lib/email-campaigns");
    const db = makeDb({ rpcErrorFor: "reserve_email_capacity_on" });
    useDb(db);
    await expect(
      createCampaign({
        draftId: "draft-1",
        senderAccountId: "account-1",
        goal: "ausbildung",
        recipientEmails: RECIPIENTS,
        scheduling: {
          utcIso: "2026-11-25T13:35:00.000Z",
          timeZone: "Europe/Berlin",
          usageDate: "2026-11-25",
        },
      }),
    ).rejects.toThrow("Daily email quota exceeded.");
    expect(db.tables.email_campaigns).toHaveLength(0);
    expect(db.tables.email_messages).toHaveLength(0);
  });

  it("rolls back the scheduled reservation when message creation fails (no quota leak, draft intact)", async () => {
    const { createCampaign } = await import("@/lib/email-campaigns");
    const db = makeDb({ insertErrorFor: "email_messages" });
    useDb(db);
    await expect(
      createCampaign({
        draftId: "draft-1",
        senderAccountId: "account-1",
        goal: "ausbildung",
        recipientEmails: RECIPIENTS,
        scheduling: {
          utcIso: "2026-11-25T13:35:00.000Z",
          timeZone: "Europe/Berlin",
          usageDate: "2026-11-25",
        },
      }),
    ).rejects.toThrow("Unable to queue campaign messages.");
    expect(db.tables.email_campaigns).toHaveLength(0);
    const release = db.rpcLog.find((entry) =>
      entry.name === "release_email_capacity",
    );
    expect(release?.args.reservation_date).toBe("2026-11-25");
    // A failed schedule must not touch the draft (it stays editable).
    expect(db.tables.application_drafts).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. Server action: scheduleApplications (server clock is authoritative)
// ─────────────────────────────────────────────────────────────────────────
describe("scheduleApplications — server-authoritative validation (through the real engine, fake DB)", () => {
  let action: typeof import("@/app/applications/new/schedule-action");
  let db: FakeDb;

  beforeEach(async () => {
    db = makeDb();
    useDb(db);
    vi.mocked(redirect).mockClear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(BASELINE));
    action = await import("@/app/applications/new/schedule-action");
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const createdCampaigns = () => db.tables.email_campaigns;

  function scheduleForm(overrides: Record<string, string> = {}) {
    const data = new FormData();
    data.set("draftId", "draft-1");
    data.set("senderAccountId", "account-1");
    data.set("goal", "ausbildung");
    data.set("recipients", JSON.stringify(RECIPIENTS));
    data.set("scheduleYear", "2026");
    data.set("scheduleMonth", "1");
    data.set("scheduleDay", "11");
    data.set("scheduleHour", "10");
    data.set("scheduleMinute", "0");
    data.set("scheduleTimezone", "UTC");
    data.set("dstResolution", "");
    for (const [key, value] of Object.entries(overrides)) data.set(key, value);
    return data;
  }

  it("schedules a valid future time: persists the UTC instant, NO immediate batch", async () => {
    await expect(action.scheduleApplications(scheduleForm())).rejects.toThrow(
      "NEXT_REDIRECT",
    );
    const campaign = createdCampaigns()[0];
    expect(campaign).toBeTruthy();
    expect(campaign.scheduled_at).toBe("2026-01-11T10:00:00.000Z");
    expect(campaign.timezone).toBe("UTC");
    expect(campaign.usage_date).toBe("2026-01-11");
    for (const message of db.tables.email_messages)
      expect(message.next_attempt_at).toBe("2026-01-11T10:00:00.000Z");
    // The browser is not part of the send: nothing is drained here —
    // no sender-slot work happened on this request.
    expect(
      db.rpcLog.some((entry) =>
        ["reserve_sender_slot", "claim_next_email_message"].includes(
          entry.name,
        ),
      ),
    ).toBe(false);
    expect(redirect).toHaveBeenCalledWith(
      expect.stringMatching(/^\/applications\/campaign\/\S+\?scheduled=1$/),
    );
  });

  it("rejects a PAST time against the server clock (no campaign created)", async () => {
    await expect(
      action.scheduleApplications(
        scheduleForm({ scheduleDay: "10", scheduleHour: "11" }),
      ),
    ).rejects.toThrow(/not in the future/i);
    expect(createdCampaigns()).toHaveLength(0);
    expect(db.tables.email_messages).toHaveLength(0);
  });

  it("rejects a NONEXISTENT DST time (Berlin spring gap 29.03.2026 02:30)", async () => {
    await expect(
      action.scheduleApplications(
        scheduleForm({
          scheduleMonth: "3",
          scheduleDay: "29",
          scheduleHour: "2",
          scheduleMinute: "30",
          scheduleTimezone: "Europe/Berlin",
        }),
      ),
    ).rejects.toThrow(/does not exist/i);
    expect(createdCampaigns()).toHaveLength(0);
  });

  it("rejects an AMBIGUOUS DST time without explicit resolution (Berlin fall fold 25.10.2026 02:30)", async () => {
    await expect(
      action.scheduleApplications(
        scheduleForm({
          scheduleMonth: "10",
          scheduleDay: "25",
          scheduleHour: "2",
          scheduleMinute: "30",
          scheduleTimezone: "Europe/Berlin",
        }),
      ),
    ).rejects.toThrow(/occurs twice/i);
    expect(createdCampaigns()).toHaveLength(0);
  });

  it("schedules the fold at the user's EXPLICITLY chosen occurrence", async () => {
    const endForm = scheduleForm({
      scheduleMonth: "10",
      scheduleDay: "25",
      scheduleHour: "2",
      scheduleMinute: "30",
      scheduleTimezone: "Europe/Berlin",
      dstResolution: "end", // second occurrence → CET (+1) → 01:30Z
    });
    await expect(action.scheduleApplications(endForm)).rejects.toThrow(
      "NEXT_REDIRECT",
    );
    expect(createdCampaigns()[0].scheduled_at).toBe("2026-10-25T01:30:00.000Z");

    const startForm = scheduleForm({
      scheduleMonth: "10",
      scheduleDay: "25",
      scheduleHour: "2",
      scheduleMinute: "30",
      scheduleTimezone: "Europe/Berlin",
      dstResolution: "start", // first occurrence → CEST (+2) → 00:30Z
    });
    await expect(action.scheduleApplications(startForm)).rejects.toThrow(
      "NEXT_REDIRECT",
    );
    expect(createdCampaigns()[1].scheduled_at).toBe("2026-10-25T00:30:00.000Z");
  });

  it("rejects an unknown timezone (allow-list is the contract)", async () => {
    await expect(
      action.scheduleApplications(
        scheduleForm({ scheduleTimezone: "Mars/Olympus" }),
      ),
    ).rejects.toThrow(/Unknown timezone/i);
    expect(createdCampaigns()).toHaveLength(0);
  });

  it("rejects a malformed recipient payload before any scheduling logic", async () => {
    await expect(
      action.scheduleApplications(
        scheduleForm({ recipients: "{not json" }),
      ),
    ).rejects.toThrow("Invalid recipient list.");
    expect(createdCampaigns()).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Engine: rescheduleCampaign (atomic, refused once started)
// ─────────────────────────────────────────────────────────────────────────
describe("rescheduleCampaign — atomic, ownership-scoped, pre-start only", () => {
  const scheduledCampaign = (overrides: Row = {}): Row => ({
    id: "campaign-1",
    user_id: USER_ID,
    draft_id: "draft-1",
    email_account_id: "account-1",
    usage_date: "2026-11-25",
    status: "queued",
    started_at: null,
    created_at: "2026-10-11T10:00:00.000Z",
    scheduled_at: "2026-11-25T13:35:00.000Z",
    timezone: "Europe/Berlin",
    ...overrides,
  });

  it("moves the campaign through the RPC and logs the change", async () => {
    const { rescheduleCampaign } = await import("@/lib/email-campaigns");
    const db = makeDb({ campaigns: [scheduledCampaign()] });
    useDb(db);
    const updated = await rescheduleCampaign(USER_ID, "campaign-1", {
      utcIso: "2026-11-26T08:00:00.000Z",
      timeZone: "Europe/Berlin",
      usageDate: "2026-11-26",
    });
    const rpc = db.rpcLog.find((entry) =>
      entry.name === "reschedule_campaign",
    );
    expect(rpc).toBeTruthy();
    expect(rpc?.args).toMatchObject({
      target_user_id: USER_ID,
      target_campaign_id: "campaign-1",
      new_scheduled_at: "2026-11-26T08:00:00.000Z",
      new_timezone: "Europe/Berlin",
      new_usage_date: "2026-11-26",
    });
    expect(updated.scheduled_at).toBe("2026-11-26T08:00:00.000Z");
    expect(updated.usage_date).toBe("2026-11-26");
    expect(db.tables.activity_logs[0].activity_type).toBe(
      "campaign_rescheduled",
    );
  });

  it("surfaces a clear error when the send already started (RPC false)", async () => {
    const { rescheduleCampaign } = await import("@/lib/email-campaigns");
    const db = makeDb({
      campaigns: [scheduledCampaign()],
      rescheduleResult: false,
    });
    useDb(db);
    await expect(
      rescheduleCampaign(USER_ID, "campaign-1", {
        utcIso: "2026-11-26T08:00:00.000Z",
        timeZone: "Europe/Berlin",
        usageDate: "2026-11-26",
      }),
    ).rejects.toThrow(/can no longer be rescheduled/i);
  });

  it("enforces ownership — a foreign campaign is not found", async () => {
    const { rescheduleCampaign } = await import("@/lib/email-campaigns");
    const db = makeDb({
      campaigns: [scheduledCampaign({ user_id: "someone-else" })],
    });
    useDb(db);
    await expect(
      rescheduleCampaign("user-1", "campaign-1", {
        utcIso: "2026-11-26T08:00:00.000Z",
        timeZone: "Europe/Berlin",
        usageDate: "2026-11-26",
      }),
    ).rejects.toThrow("Campaign not found.");
    expect(
      db.rpcLog.some((entry) => entry.name === "reschedule_campaign"),
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4. Stale recovery: the 24h TTL must respect the schedule
// ─────────────────────────────────────────────────────────────────────────
describe("recoverStaleCampaigns — scheduled campaigns are not prematurely cancelled", () => {
  const daysAgo = (days: number) =>
    new Date(Date.now() - days * 86_400_000).toISOString();
  const hoursAgo = (hours: number) =>
    new Date(Date.now() - hours * 3_600_000).toISOString();
  const daysAhead = (days: number) =>
    new Date(Date.now() + days * 86_400_000).toISOString();

  it("keeps a FUTURE-scheduled campaign alive even 3 days after creation", async () => {
    const { recoverStaleCampaigns } = await import("@/lib/email-campaigns");
    const db = makeDb({
      campaigns: [
        {
          id: "campaign-1",
          user_id: USER_ID,
          draft_id: "draft-1",
          email_account_id: "account-1",
          usage_date: "2026-01-13",
          status: "queued",
          started_at: null,
          created_at: daysAgo(3),
          scheduled_at: daysAhead(2),
          timezone: "Europe/Berlin",
        },
      ],
    });
    useDb(db);
    const result = await recoverStaleCampaigns(USER_ID, "campaign-1");
    expect(result.staleCampaignCancelled).toBe(false);
    expect(
      db.rpcLog.some((entry) => entry.name === "cancel_queued_campaign"),
    ).toBe(false);
    expect(result.status).toBe("queued");
  });

  it("cancels a scheduled campaign whose instant passed 25h ago (scheduler was down)", async () => {
    const { recoverStaleCampaigns } = await import("@/lib/email-campaigns");
    const db = makeDb({
      campaigns: [
        {
          id: "campaign-1",
          user_id: USER_ID,
          draft_id: "draft-1",
          email_account_id: "account-1",
          usage_date: daysAgo(1).slice(0, 10),
          status: "queued",
          started_at: null,
          created_at: daysAgo(3),
          scheduled_at: hoursAgo(25),
          timezone: "Europe/Berlin",
        },
      ],
    });
    useDb(db);
    const result = await recoverStaleCampaigns(USER_ID, "campaign-1");
    expect(result.staleCampaignCancelled).toBe(true);
    expect(
      db.rpcLog.some((entry) => entry.name === "cancel_queued_campaign"),
    ).toBe(true);
  });

  it("still applies the created_at TTL to immediate (unscheduled) campaigns", async () => {
    const { recoverStaleCampaigns } = await import("@/lib/email-campaigns");
    const db = makeDb({
      campaigns: [
        {
          id: "campaign-1",
          user_id: USER_ID,
          draft_id: "draft-1",
          email_account_id: "account-1",
          usage_date: daysAgo(2).slice(0, 10),
          status: "queued",
          started_at: null,
          created_at: daysAgo(2),
          scheduled_at: null,
          timezone: null,
        },
      ],
    });
    useDb(db);
    const result = await recoverStaleCampaigns(USER_ID, "campaign-1");
    expect(result.staleCampaignCancelled).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 5. Source guards: durable trigger, migration, claim predicates, UI wiring
// ─────────────────────────────────────────────────────────────────────────
describe("durable trigger and schema (source-level guarantees)", () => {
  const CRON_ROUTE = readFileSync(
    "src/app/api/cron/email-scheduler/route.ts",
    "utf8",
  );
  const VERCEL_JSON = JSON.parse(readFileSync("vercel.json", "utf8")) as {
    crons: Array<{ path: string; schedule: string }>;
  };
  const WORKFLOW = readFileSync(
    ".github/workflows/email-scheduler.yml",
    "utf8",
  );
  const MIGRATION = readFileSync(
    "supabase/migrations/20261011000000_campaign_scheduling.sql",
    "utf8",
  );
  const ENGINE_SQL = readFileSync(
    "supabase/migrations/20260927030000_email_sending_engine.sql",
    "utf8",
  );
  const WORKER_SQL = readFileSync(
    "supabase/migrations/20261003000000_durable_worker.sql",
    "utf8",
  );
  const COMPOSER = readFileSync(
    "src/components/application-composer.tsx",
    "utf8",
  );
  const CAMPAIGN_PAGE = readFileSync(
    "src/app/applications/campaign/[id]/page.tsx",
    "utf8",
  );

  it("the cron endpoint is bounded, fail-closed and secret-safe", () => {
    // Auth: server secret, timing-safe, fail closed when unset.
    expect(CRON_ROUTE).toContain("process.env.CRON_SECRET");
    expect(CRON_ROUTE).toContain("timingSafeEqual");
    expect(CRON_ROUTE).toContain("return false; // fail closed");
    // Bounded work per tick (both a round cap and a wall budget).
    expect(CRON_ROUTE).toMatch(/const MAX_ROUNDS = 3/);
    expect(CRON_ROUTE).toContain("SOFT_BUDGET_MS");
    // The engine, not a new implementation: claim + existing batch runner.
    expect(CRON_ROUTE).toContain("claim_next_pending_campaign");
    expect(CRON_ROUTE).toContain("processCampaignBatch(");
    expect(CRON_ROUTE).not.toContain("createEmailProvider");
    // No secret material in logs: only counters.
    expect(CRON_ROUTE).toContain("[EMAIL_SCHEDULER] tick done");
    expect(CRON_ROUTE).not.toContain("console.log(configured)");
    expect(CRON_ROUTE).not.toContain("console.log(supplied)");
    expect(CRON_ROUTE).not.toContain("NEXT_PUBLIC");
  });

  it("vercel.json registers the scheduler every minute", () => {
    expect(VERCEL_JSON.crons).toContainEqual({
      path: "/api/cron/email-scheduler",
      schedule: "* * * * *",
    });
  });

  it("the GitHub fallback is OFF by default and drives the same engine", () => {
    expect(WORKFLOW).toContain("EMAIL_SCHEDULER_GH == 'true'");
    expect(WORKFLOW).toContain('cron: "*/5 * * * *"');
    expect(WORKFLOW).toContain("secrets.EMAIL_WORKER_SECRET");
    expect(WORKFLOW).toContain("/api/internal/email-worker/claim");
    expect(WORKFLOW).toContain("/api/internal/email-worker\"");
    // Fails loudly when the secret is missing — never an unauthenticated tick.
    expect(WORKFLOW).toContain("::error::EMAIL_WORKER_SECRET is not set");
    // Bounded: 3 rounds.
    expect(WORKFLOW).toContain("for round in 1 2 3");
  });

  it("the migration is additive: two columns, service-role-only RPCs, no enum or RLS changes", () => {
    expect(MIGRATION).toContain("add column if not exists scheduled_at timestamptz");
    expect(MIGRATION).toContain("add column if not exists timezone text");
    expect(MIGRATION).toContain("create or replace function public.reserve_email_capacity_on");
    expect(MIGRATION).toContain("create or replace function public.reschedule_campaign");
    expect(MIGRATION).toContain(
      "grant execute on function public.reserve_email_capacity_on(uuid, integer, date) to service_role",
    );
    expect(MIGRATION).toContain(
      "grant execute on function public.reschedule_campaign(uuid, uuid, timestamptz, text, date) to service_role",
    );
    expect(MIGRATION).toContain(
      "revoke execute on function public.reschedule_campaign(uuid, uuid, timestamptz, text, date) from public, anon, authenticated",
    );
    // No status machine changes, no policy changes.
    expect(MIGRATION).not.toContain("create type");
    expect(MIGRATION).not.toContain("alter type");
    expect(MIGRATION).not.toContain("create policy");
    expect(MIGRATION).not.toContain("drop policy");
  });

  it("reschedule_campaign is guarded: future-only, queued-only, row-locked, atomic quota move", () => {
    expect(MIGRATION).toContain("new_scheduled_at <= timezone('utc', now())");
    expect(MIGRATION).toContain("campaign_row.status <> 'queued'");
    expect(MIGRATION).toContain("for update;");
    // Same-date reschedules must not double-reserve; date moves release+reserve in one transaction.
    expect(MIGRATION).toContain("campaign_row.usage_date <> new_usage_date");
    expect(MIGRATION).toContain("daily_quota_exceeded");
    expect(MIGRATION).toContain(
      "set next_attempt_at = new_scheduled_at",
    );
  });

  it("the existing claim predicates make early sending impossible (the due-gate)", () => {
    // Message-level claim (engine) and campaign-level discovery (durable
    // worker) BOTH require the message to be due — scheduled campaigns
    // carry next_attempt_at = scheduled_at, so they are invisible before.
    expect(ENGINE_SQL).toContain(
      "m.next_attempt_at is null or m.next_attempt_at <= timezone('utc', now())",
    );
    expect(WORKER_SQL).toMatch(
      /m\.next_attempt_at is null\s+or m\.next_attempt_at <= timezone\('utc', now\(\)\)/,
    );
  });

  it("the composer keeps Send-now as the default and reuses the existing action", () => {
    expect(COMPOSER).toContain('useState<"now" | "schedule">("now")');
    expect(COMPOSER).toContain("action={sendApplications}");
    expect(COMPOSER).toContain("action={scheduleApplications}");
    expect(COMPOSER).toContain("ScheduleForm");
  });

  it("the campaign page shows the schedule and hides manual processing while it is in the future", () => {
    expect(CAMPAIGN_PAGE).toContain('t("account.scheduledBanner"');
    expect(CAMPAIGN_PAGE).toContain("scheduleFuture");
    expect(CAMPAIGN_PAGE).toContain("{!scheduleFuture && (");
    expect(CAMPAIGN_PAGE).toContain("rescheduleCampaignAction");
    expect(CAMPAIGN_PAGE).toContain("ScheduleForm");
  });
});
