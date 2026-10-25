/**
 * Application Automation — subscription/entitlement enforcement (engine level).
 *
 * Regression suite for the reported critical bug: "Application Automation
 * remains usable after the subscription is cancelled or revoked."
 *
 * ROOT CAUSE: the series-creation entry point (`createBewCampaignCore`) and
 * the letter-generation entry point (`generateBewLetters`) had NO
 * automation-entitlement gate — the paid feature was gated ONLY at send
 * start and at claim time. A canceled / expired subscriber could create
 * series and generate letters; only the final send was rejected.
 *
 * This suite drives the ENGINE directly (the exact code a direct server-
 * action call runs — no client state involved) with the REAL entitlement
 * service and an in-memory admin client, and pins:
 *   A. an active eligible subscriber creates a series and passes the
 *      generation gate;
 *   B. a CANCELED subscription (even with a FUTURE period end — the
 *      documented billing contract ends entitlements AT cancellation)
 *      cannot create or generate; nothing is persisted on denial;
 *   C. an EXPIRED subscription (active row, period end in the past) is
 *      denied on every fresh call — no cache, no stale page state;
 *   D. quota exhaustion (eligible user, meter full) denies with
 *      AUTOMATION_QUOTA_EXHAUSTED (distinct from a plan denial);
 *   E. an unreadable subscription state fails CLOSED (AUTOMATION_
 *      UNAVAILABLE, nothing persisted);
 *   F. the legacy 'free' row carries no automation entitlement;
 *   G. revocation keeps the saved series stored and readable (no data
 *      deletion), resolution is fresh on every call (revocation takes
 *      effect immediately; reactivation restores access immediately).
 *
 * The SEND-side enforcement (the `startBewSend` gate and the per-row
 * reserve at CLAIM time — which also covers the cron / background drain)
 * is pinned by tests/bew-send-engine.test.ts (`automationDeny` fixture).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { COMMERCIAL_PLAN_ROW } from "./helpers";

/* eslint-disable @typescript-eslint/no-explicit-any */

type Row = Record<string, any>;

interface DB {
  profiles: Row[];
  email_accounts: Row[];
  bew_campaigns: Row[];
  bew_applications: Row[];
  subscriptions: Row[];
  billing_plans: Row[];
  /** Automation meter usage (the feature_quota_status answer). */
  meterUsed: number;
  /** Simulate a DB failure on the subscriptions read (fail-closed path). */
  failSubscriptions: boolean;
}

const USER = "user-1";

/** A subscription row with sane defaults; each test overrides the state. */
function subRow(over: Record<string, unknown> = {}): Row {
  return {
    user_id: USER,
    plan: "premium_monthly",
    status: "active",
    provider: "mock",
    current_period_start: "2026-10-01T00:00:00.000Z",
    current_period_end: "2027-01-01T00:00:00.000Z",
    canceled_at: null,
    trial_activated_at: null,
    ...over,
  };
}

function freshDb(
  sub: Row | null,
  opts: { meterUsed?: number; failSubscriptions?: boolean } = {},
): DB {
  return {
    profiles: [], // no profile → the generation gate denial is provable
    email_accounts: [], // no sender → create resolves a null account (fine)
    bew_campaigns: [],
    bew_applications: [],
    subscriptions: sub ? [sub] : [],
    billing_plans: [{ ...COMMERCIAL_PLAN_ROW }],
    meterUsed: opts.meterUsed ?? 0,
    failSubscriptions: opts.failSubscriptions ?? false,
  };
}

let db: DB;

/* ------------------- In-memory Supabase-style query builder ------------------- */
function makeFrom(table: string) {
  const state = {
    op: "select" as "select" | "update" | "insert" | "delete" | "upsert",
    payload: undefined as any,
    filters: [] as Array<{ col: string; val: any }>,
    inFilters: [] as Array<{ col: string; values: any[] }>,
    orderBy: [] as Array<{ col: string; ascending: boolean }>,
    limitN: undefined as number | undefined,
    terminal: undefined as "single" | "maybeSingle" | undefined,
  };
  const bucket = (): Row[] => ((db as unknown as Record<string, Row[]>)[table] ?? []);
  function rows(): Row[] {
    let out = bucket().slice();
    for (const f of state.filters) out = out.filter((r: Row) => r[f.col] === f.val);
    for (const f of state.inFilters) out = out.filter((r: Row) => f.values.includes(r[f.col]));
    if (state.orderBy.length)
      out.sort((a: Row, b: Row) => {
        for (const o of state.orderBy) {
          const dir = o.ascending ? 1 : -1;
          if (a[o.col] < b[o.col]) return -1 * dir;
          if (a[o.col] > b[o.col]) return 1 * dir;
        }
        return 0;
      });
    if (state.limitN != null) out = out.slice(0, state.limitN);
    return out;
  }
  async function run(): Promise<any> {
    // A simulated DB failure on the subscriptions read (the fail-closed
    // entitlement path — resolveSubscription reports lookupFailed).
    if (table === "subscriptions" && db.failSubscriptions) {
      return { data: null, error: { message: "simulated database failure" } };
    }
    if (state.op === "insert") {
      const items = Array.isArray(state.payload) ? state.payload : [state.payload];
      const ins = items.map((r) => ({ ...r, id: r.id ?? `id-${Math.random()}` }));
      ((db as unknown as Record<string, Row[]>)[table] ??= []).push(...ins);
      return state.terminal === "single" ? { data: ins[0], error: null } : { data: ins, error: null };
    }
    if (state.op === "update") {
      const matched = rows();
      for (const m of matched) Object.assign(m, state.payload);
      if (state.terminal) return { data: matched[0] ?? null, error: null };
      return { data: matched, error: null };
    }
    if (state.op === "delete") {
      const matched = new Set(rows());
      const rec = db as unknown as Record<string, Row[]>;
      rec[table] = (rec[table] ?? []).filter((r) => !matched.has(r));
      return { data: null, error: null };
    }
    const matched = rows();
    if (state.terminal) return { data: matched[0] ?? null, error: null };
    return { data: matched, error: null };
  }
  const chain: any = {
    eq: (col: string, val: any) => (state.filters.push({ col, val }), chain),
    in: (col: string, values: any[]) => (state.inFilters.push({ col, values }), chain),
    is: (col: string, val: any) => (state.filters.push({ col, val }), chain),
    order: (col: string, o?: { ascending?: boolean }) => (state.orderBy.push({ col, ascending: o?.ascending ?? true }), chain),
    limit: (n: number) => (state.limitN = n, chain),
    select: () => chain,
    insert: (p: any) => ((state.op = "insert"), (state.payload = p), chain),
    update: (p: any) => ((state.op = "update"), (state.payload = p), chain),
    delete: () => ((state.op = "delete"), chain),
    single: () => ((state.terminal = "single"), chain),
    maybeSingle: () => ((state.terminal = "maybeSingle"), chain),
    then: (onF?: any, onR?: any) => run().then(onF, onR),
  };
  return chain;
}

vi.doMock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => makeFrom(table),
    // The automation meter read (the entitlement gate + the view's usage
    // snapshot). The subscriptions / billing_plans SELECTS ride the
    // in-memory tables above — the REAL entitlement service is used
    // (nothing about it is stubbed in this suite).
    rpc: (fn: string) =>
      Promise.resolve(
        fn === "feature_quota_status"
          ? { data: { used: db.meterUsed, resets_at: null }, error: null }
          : { data: null, error: null },
      ),
    storage: { from: () => ({ upload: async () => ({ error: null }) }) },
  }),
}));
vi.doMock("@/lib/email-campaigns", () => ({
  getUsageSnapshot: async () => ({
    date: new Date().toISOString().slice(0, 10),
    emails_sent: 0,
    emails_reserved: 0,
    daily_limit: 50,
    remaining: 50,
  }),
  reserveSenderSlot: async () => true,
}));

const engine = await import("@/lib/bewerbung-engine");

/** Seed an owned campaign + two pending rows (the generate tests). */
function seedCampaign(): string {
  const id = "camp-1";
  db.bew_campaigns.push({
    id,
    user_id: USER,
    email_account_id: null,
    purpose: "ausbildung",
    status: "draft",
    requested_count: 2,
    valid_count: 0,
    total_count: 2,
    generated_count: 0,
    sent_count: 0,
    failed_count: 0,
    excluded_count: 0,
    usage_date: new Date().toISOString().slice(0, 10),
    created_at: new Date().toISOString(),
    started_at: null,
    completed_at: null,
    email_subject: null,
    email_body_html: null,
  });
  for (const seq of [1, 2]) {
    db.bew_applications.push({
      id: `app-${seq}`,
      campaign_id: id,
      user_id: USER,
      seq,
      company_name: "",
      company_email: "",
      contact_name: null,
      company_address: null,
      subject: "",
      body_html: "",
      body_text: "",
      status: "pending",
      error_code: null,
      error_message: null,
      attempt_count: 0,
    });
  }
  return id;
}

const ACTIVE = subRow();
/** Canceled WITH a future period end — the billing contract (Phase 12)
 *  ends entitlements AT cancellation; the period end grants nothing. */
const CANCELED = subRow({ status: "canceled", canceled_at: "2026-10-25T00:00:00.000Z" });
/** Active row whose period end is in the past (computed expiry). */
const EXPIRED = subRow({
  current_period_end: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
});
/** The historical free row: a valid selection that grants nothing. */
const FREE = subRow({ plan: "free" });

beforeEach(() => {
  engine.resetBewPositionColumnsProbe();
  engine.resetBewSchemaProbe();
});

describe("A. an active eligible subscriber uses Application Automation", () => {
  it("creates a series (the gate passes; the structure is persisted)", async () => {
    db = freshDb(ACTIVE);
    const row = await engine.createBewCampaign({
      userId: USER,
      count: 10,
      purpose: "ausbildung",
    });
    expect(row.requested_count).toBe(10);
    expect(db.bew_campaigns).toHaveLength(1);
    expect(db.bew_applications).toHaveLength(10); // the seeded rows
  });

  it("passes the generation gate (reaches the profile check, rows untouched)", async () => {
    db = freshDb(ACTIVE);
    const campaignId = seedCampaign();
    // No profile row → the FIRST post-gate check (applicant completeness)
    // fires. Reaching it proves the automation gate let the eligible
    // subscriber through; the denial code would be AUTOMATION_* instead.
    await expect(
      engine.generateBewLetters(USER, campaignId, {} as any),
    ).rejects.toThrow("PROFILE_INCOMPLETE");
    for (const app of db.bew_applications) expect(app.status).toBe("pending");
  });
});

describe("B. a canceled subscription (revocation) cannot create or execute", () => {
  it("cannot create a series — even with a FUTURE period end (the billing contract)", async () => {
    db = freshDb(CANCELED);
    await expect(
      engine.createBewCampaign({ userId: USER, count: 10, purpose: "ausbildung" }),
    ).rejects.toThrow("AUTOMATION_DISABLED");
    expect(db.bew_campaigns).toHaveLength(0);
    expect(db.bew_applications).toHaveLength(0); // nothing persisted
  });

  it("cannot generate letters (rows are never claimed)", async () => {
    db = freshDb(CANCELED);
    const campaignId = seedCampaign();
    await expect(
      engine.generateBewLetters(USER, campaignId, {} as any),
    ).rejects.toThrow("AUTOMATION_DISABLED");
    for (const app of db.bew_applications) expect(app.status).toBe("pending");
  });
});

describe("C. an expired subscription is denied on every fresh call", () => {
  it("cannot create a series (computed expiry — no job, no cache)", async () => {
    db = freshDb(EXPIRED);
    await expect(
      engine.createBewCampaign({ userId: USER, count: 10, purpose: "ausbildung" }),
    ).rejects.toThrow("AUTOMATION_DISABLED");
    expect(db.bew_campaigns).toHaveLength(0);
  });

  it("cannot generate letters even though the page was previously open (fresh resolution)", async () => {
    db = freshDb(EXPIRED);
    const campaignId = seedCampaign();
    await expect(
      engine.generateBewLetters(USER, campaignId, {} as any),
    ).rejects.toThrow("AUTOMATION_DISABLED");
  });
});

describe("D. quota exhaustion denies with its own stable code", () => {
  it("an eligible subscriber with the automation meter full gets AUTOMATION_QUOTA_EXHAUSTED", async () => {
    // COMMERCIAL_PLAN_ROW grants automation: 250 — the meter reports 250
    // used → remaining 0 → quota_exhausted (NOT a plan denial).
    db = freshDb(ACTIVE, { meterUsed: 250 });
    await expect(
      engine.createBewCampaign({ userId: USER, count: 10, purpose: "ausbildung" }),
    ).rejects.toThrow("AUTOMATION_QUOTA_EXHAUSTED");
    expect(db.bew_campaigns).toHaveLength(0);
  });
});

describe("E. an unreadable subscription state fails closed", () => {
  it("a failed subscriptions read denies with AUTOMATION_UNAVAILABLE and persists nothing", async () => {
    db = freshDb(ACTIVE, { failSubscriptions: true });
    await expect(
      engine.createBewCampaign({ userId: USER, count: 10, purpose: "ausbildung" }),
    ).rejects.toThrow("AUTOMATION_UNAVAILABLE");
    expect(db.bew_campaigns).toHaveLength(0);
    expect(db.bew_applications).toHaveLength(0);
  });
});

describe("F. the legacy free row carries no automation entitlement", () => {
  it("a 'free' row cannot create a series", async () => {
    db = freshDb(FREE);
    await expect(
      engine.createBewCampaign({ userId: USER, count: 10, purpose: "ausbildung" }),
    ).rejects.toThrow("AUTOMATION_DISABLED");
    expect(db.bew_campaigns).toHaveLength(0);
  });
});

describe("G. revocation keeps the data; resolution is fresh on every call", () => {
  it("a revoked user's saved series remains stored and readable", async () => {
    db = freshDb(ACTIVE);
    const campaignId = seedCampaign();
    // Revoke…
    db.subscriptions[0] = { ...CANCELED };
    // …the data is still THERE (no deletion on revocation)…
    const view = await engine.getBewCampaignView(USER, campaignId);
    expect(view).not.toBeNull();
    expect(view!.campaign.id).toBe(campaignId);
    expect(view!.applications).toHaveLength(2);
    // …and the paid operations are denied on it.
    await expect(
      engine.createBewCampaign({ userId: USER, count: 5, purpose: "ausbildung" }),
    ).rejects.toThrow("AUTOMATION_DISABLED");
  });

  it("revocation takes effect immediately and reactivation restores access (no stale state)", async () => {
    db = freshDb(ACTIVE);
    // active → allowed…
    const first = await engine.createBewCampaign({
      userId: USER,
      count: 1,
      purpose: "ausbildung",
    });
    expect(db.bew_campaigns).toHaveLength(1);
    // …revoke → immediately denied (the NEXT call re-resolves fresh)…
    db.subscriptions[0] = { ...CANCELED };
    await expect(
      engine.createBewCampaign({ userId: USER, count: 1, purpose: "ausbildung" }),
    ).rejects.toThrow("AUTOMATION_DISABLED");
    expect(db.bew_campaigns).toHaveLength(1);
    // …reactivate → immediately allowed again.
    db.subscriptions[0] = { ...ACTIVE };
    const second = await engine.createBewCampaign({
      userId: USER,
      count: 1,
      purpose: "ausbildung",
    });
    expect(db.bew_campaigns).toHaveLength(2);
    expect(second.id).not.toBe(first.id);
  });
});
