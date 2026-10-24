/**
 * Bewerbung Automation — round-trip profiling of the interactive flows.
 *
 * WHAT IS MEASURED (and how)
 *   Every Supabase query / RPC / auth call in the flow is a NETWORK ROUND
 *   TRIP (RTT) — a real wait on the order of 20–80 ms in production. This
 *   harness replaces the Supabase admin client, the auth layer and the usage
 *   RPC with INSTRUMENTED fakes: each call resolves after exactly
 *   `RTT_MS` (25 ms — a documented simulation, not a production number) and
 *   increments two counters:
 *
 *     - rtt:   total round trips the flow performs;
 *     - waves: critical-path depth — a query that starts while others are
 *              still in flight shares their wave; a query that starts only
 *              after all previous ones settled is a new wave. Sequential
 *              awaits therefore each cost one wave, Promise.all does not.
 *
 *   `wallMs` is the measured wall time (≈ waves × RTT_MS on this harness),
 *   i.e. the time the user waits on network before the flow can answer —
 *   before any client-side fix, that wait is what blocks the UI update.
 *
 *   Auth cost: each SERVER ACTION re-authenticates via
 *   getCurrentUserAndProfile = `auth.getUser()` (1 RTT) + `profiles`
 *   select (1 RTT) — modeled as two hops, exactly like src/lib/auth.ts.
 *
 * FLOWS
 *   F1 createBewCampaign            — the "+ New series" create (engine)
 *   F2 getBewCampaignView           — the view poll / refresh (engine)
 *   F3 new-series (client sequence) — F1 + F2 back-to-back, as the client
 *                                      did before the fix (two actions)
 *   F3b new-series (fixed)          — createBewCampaignView, ONE action
 *   F4 updateBewApplicationFields   — the per-row Save (engine)
 *   F5 row-save (client sequence)   — F4 + F2 (the `await refresh()` the
 *                                      client ran after EVERY row save)
 *
 * The harness is deterministic (single-threaded, fixed latency): the RTT
 * and wave counts below are exact structural facts about the code, and the
 * wall times are the measured product with the 25 ms simulation.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { COMMERCIAL_SUB_ROW, COMMERCIAL_PLAN_ROW } from "./helpers";

/* eslint-disable @typescript-eslint/no-explicit-any */

const RTT_MS = 25;

const perf = { rtt: 0, waves: 0, active: 0 };
function resetPerf() {
  perf.rtt = 0;
  perf.waves = 0;
  perf.active = 0;
}
async function hop() {
  if (perf.active === 0) perf.waves += 1;
  perf.active += 1;
  perf.rtt += 1;
  await new Promise((r) => setTimeout(r, RTT_MS));
  perf.active -= 1;
}

/* ------------------------------------------------------------------ *\
 * In-memory fake (same surface as bew-wizard-navigation.test.ts),
 * instrumented with hop() at every query / RPC.
 * ------------------------------------------------------------------ */

type Row = Record<string, any>;
type TableKey =
  | "bew_campaigns"
  | "bew_applications"
  | "bew_documents"
  | "bew_campaign_documents"
  | "email_accounts"
  | "subscriptions"
  | "billing_plans";

interface DB {
  bew_campaigns: Row[];
  bew_applications: Row[];
  bew_documents: Row[];
  bew_campaign_documents: Row[];
  email_accounts: Row[];
  /** Entitlement lookups: USER is a verified active commercial subscriber
   *  (2026-10-24 fix — the row-save capacity gate now resolves the
   *  subscription; two extra measured SELECTs per empty→content save). */
  subscriptions: Row[];
  billing_plans: Row[];
}

const DEFAULTS: Partial<Record<TableKey, Row>> = {
  bew_campaigns: {
    email_account_id: null,
    purpose: "ausbildung",
    status: "draft",
    requested_count: 0,
    valid_count: 0,
    total_count: 0,
    generated_count: 0,
    sent_count: 0,
    failed_count: 0,
    excluded_count: 0,
    usage_date: new Date().toISOString().slice(0, 10),
    created_at: new Date().toISOString(),
    started_at: null,
    completed_at: null,
    position_title: null,
    position_brief: null,
    employer_facts: null,
  },
  bew_applications: {
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
    next_attempt_at: null,
    provider_message_id: null,
    sent_at: null,
    position_title: null,
    position_brief: null,
    employer_facts: null,
  },
};

function freshDb(): DB {
  return {
    bew_campaigns: [],
    bew_applications: [],
    bew_documents: [],
    bew_campaign_documents: [],
    email_accounts: [
      {
        id: "acct-1",
        user_id: USER,
        email: "sender@gmail.com",
        is_active: true,
        requires_reconnect: false,
        created_at: new Date().toISOString(),
      },
    ],
    subscriptions: [{ ...COMMERCIAL_SUB_ROW, user_id: USER }],
    billing_plans: [{ ...COMMERCIAL_PLAN_ROW }],
  };
}

const USER = "user-1";
let db: DB = freshDb();

function makeFrom(table: TableKey) {
  const state = {
    op: "select" as string,
    payload: undefined as any,
    filters: [] as Array<{ col: string; val: any }>,
    inFilters: [] as Array<{ col: string; values: any[] }>,
    orderBy: [] as Array<{ col: string; ascending: boolean }>,
    limitN: undefined as number | undefined,
    selectOpts: undefined as any,
    terminal: undefined as "single" | "maybeSingle" | undefined,
  };

  function rows(): Row[] {
    let out = (db[table] ?? []).slice();
    for (const f of state.filters) out = out.filter((r) => r[f.col] === f.val);
    for (const f of state.inFilters)
      out = out.filter((r) => f.values.includes(r[f.col]));
    if (state.orderBy.length) {
      out.sort((a, b) => {
        for (const o of state.orderBy) {
          const dir = o.ascending ? 1 : -1;
          if (a[o.col] < b[o.col]) return -1 * dir;
          if (a[o.col] > b[o.col]) return 1 * dir;
        }
        return 0;
      });
    }
    if (state.limitN != null) out = out.slice(0, state.limitN);
    return out;
  }

  async function run(): Promise<any> {
    await hop(); // ONE network round trip per query.
    if (state.op === "insert") {
      const items = Array.isArray(state.payload)
        ? state.payload
        : [state.payload];
      const inserted = items.map((r) => ({
        ...DEFAULTS[table],
        ...r,
        id: r.id ?? `id-${Math.random()}`,
      }));
      (db[table] ??= []).push(...inserted);
      if (state.terminal === "single")
        return { data: inserted[0], error: null };
      return { data: inserted, error: null };
    }
    if (state.op === "update") {
      const matched = rows();
      for (const m of matched) Object.assign(m, state.payload);
      if (state.terminal === "single")
        return { data: matched[0] ?? null, error: null };
      if (state.terminal === "maybeSingle")
        return { data: matched[0] ?? null, error: null };
      return { data: matched, error: null };
    }
    if (state.op === "delete") {
      const matched = rows();
      (db[table] as Row[]) = (db[table] ?? []).filter(
        (r) => !matched.includes(r),
      );
      return { data: null, error: null };
    }
    const matched = rows();
    if (state.selectOpts?.count)
      return {
        data: state.selectOpts.head ? null : matched,
        error: null,
        count: matched.length,
      };
    if (state.terminal === "single")
      return { data: matched[0] ?? null, error: null };
    if (state.terminal === "maybeSingle")
      return { data: matched[0] ?? null, error: null };
    return { data: matched, error: null };
  }

  const chain: any = {
    eq(col: string, val: any) {
      state.filters.push({ col, val });
      return chain;
    },
    in(col: string, values: any[]) {
      state.inFilters.push({ col, values });
      return chain;
    },
    order(col: string, o?: { ascending?: boolean }) {
      state.orderBy.push({ col, ascending: o?.ascending ?? true });
      return chain;
    },
    limit(n: number) {
      state.limitN = n;
      return chain;
    },
    select(_cols?: string, opts?: any) {
      state.selectOpts = opts;
      return chain;
    },
    insert(payload: any) {
      state.op = "insert";
      state.payload = payload;
      return chain;
    },
    update(payload: any) {
      state.op = "update";
      state.payload = payload;
      return chain;
    },
    delete() {
      state.op = "delete";
      return chain;
    },
    single() {
      state.terminal = "single";
      return chain;
    },
    maybeSingle() {
      state.terminal = "maybeSingle";
      return chain;
    },
    then(onF?: any, onR?: any) {
      return run().then(onF, onR);
    },
  };
  return chain;
}

/* ------------------------------------------------------------------ *\
 * Mocks: admin client, auth (2 RTT), usage RPC (1 RTT)
 * ------------------------------------------------------------------ */

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => makeFrom(table as TableKey),
    rpc: async (fn: string) => {
      await hop();
      // F1 (saved_applications): an empty→content save makes ONE extra RPC
      // round-trip — the advisory capacity pre-check. It is counted exactly
      // like any other hop; "unmetered" keeps the gate out of the perf
      // contract (covered by tests/saved-applications-capacity.test.ts).
      if (fn === "check_saved_application_capacity") {
        return {
          data: [
            { status: "unmetered", plan_limit: null, used: 0, remaining: null },
          ],
          error: null,
        };
      }
      return { data: null, error: null };
    },
    storage: { from: () => ({ upload: async () => ({ error: null }) }) },
  }),
}));

vi.mock("@/lib/auth", () => ({
  getCurrentUserAndProfile: async () => {
    // auth.getUser() + profiles select — two sequential round trips,
    // exactly like src/lib/auth.ts:104-115.
    await hop();
    await hop();
    return {
      user: { id: USER },
      profile: { id: USER, full_name: "Max", account_status: "active" },
    };
  },
}));

vi.mock("@/lib/email-campaigns", () => ({
  getUsageSnapshot: async () => {
    await hop();
    return {
      date: new Date().toISOString().slice(0, 10),
      emails_sent: 0,
      emails_reserved: 0,
      daily_limit: 50,
      remaining: 50,
    };
  },
  reserveSenderSlot: async () => true,
}));

vi.mock("@/lib/email-providers", () => ({
  createEmailProvider: async () => ({
    sendEmail: async () => ({ providerMessageId: "m" }),
  }),
}));
vi.mock("@/lib/application-drafts", () => ({
  sanitizeEmailHtml: (h: string) => h,
  htmlToText: (h: string) =>
    h
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
}));
vi.mock("@/lib/ai-provider", () => ({
  createAIProvider: () => ({ generateText: async () => "Text." }),
}));
vi.mock("@/lib/ai-service", () => ({
  reserveAIUsage: async () => undefined,
  storagePath: (userId: string, filename: string) => `${userId}/${filename}`,
}));
vi.mock("@/lib/pdf-extract", () => ({ extractPdfText: async () => "" }));
vi.mock("mammoth", () => ({
  default: { extractRawText: async () => ({ value: "docx" }) },
}));

const engine = await import("@/lib/bewerbung-engine");

/* ------------------------------------------------------------------ *\
 * Measurement helpers
 * ------------------------------------------------------------------ */

interface Measured {
  rtt: number;
  waves: number;
  wallMs: number;
}

async function measure(
  label: string,
  fn: () => Promise<unknown>,
): Promise<Measured> {
  resetPerf();
  const t0 = performance.now();
  await fn();
  const wallMs = performance.now() - t0;
  const m: Measured = {
    rtt: perf.rtt,
    waves: perf.waves,
    wallMs: Math.round(wallMs),
  };
  console.log(
    `[perf] ${label.padEnd(34)} rtt=${String(m.rtt).padStart(2)}  waves=${String(m.waves).padStart(2)}  wall=${String(m.wallMs).padStart(4)} ms  (@ ${RTT_MS} ms/RTT simulated)`,
  );
  return m;
}

function seedCampaign(count = 10) {
  db.bew_campaigns.push({
    ...DEFAULTS.bew_campaigns,
    id: "camp-1",
    user_id: USER,
    requested_count: count,
  });
  for (let i = 1; i <= count; i++) {
    db.bew_applications.push({
      ...DEFAULTS.bew_applications,
      id: `app-${i}`,
      campaign_id: "camp-1",
      user_id: USER,
      seq: i,
      company_name: i === 1 ? "Muster GmbH" : "",
      company_email: i === 1 ? "jobs@muster.de" : "",
    });
  }
}

/* ------------------------------------------------------------------ *\
 * A. Individual engine operations
 * ------------------------------------------------------------------ */

describe("F1 createBewCampaign (engine, cold + warm probe)", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("cold (position probe uncached): 4 RTT / 3 waves (probe ∥ default sender)", async () => {
    engine.resetBewPositionColumnsProbe();
    const m = await measure("F1 createBewCampaign (cold)", () =>
      engine.createBewCampaign({
        userId: USER,
        count: 10,
        purpose: "ausbildung",
      }),
    );
    expect(m.rtt).toBe(4); // probe, default sender, campaign insert, seed insert
    expect(m.waves).toBe(3); // (probe ∥ sender) → insert → seed
  });

  it("warm (probe cached after first use in the process): 3 RTT / 3 waves", async () => {
    engine.resetBewPositionColumnsProbe();
    await engine.createBewCampaign({
      userId: USER,
      count: 1,
      purpose: "ausbildung",
    }); // warms
    const m = await measure("F1 createBewCampaign (warm)", () =>
      engine.createBewCampaign({
        userId: USER,
        count: 10,
        purpose: "ausbildung",
      }),
    );
    expect(m.rtt).toBe(3);
    expect(m.waves).toBe(3);
  });
});

describe("F2 getBewCampaignView (engine)", () => {
  beforeEach(() => {
    db = freshDb();
    seedCampaign(10);
  });

  it("4 RTT / 3 waves (apps+docs parallel; sender skipped — seeded campaign has no email_account_id)", async () => {
    const m = await measure("F2 getBewCampaignView", () =>
      engine.getBewCampaignView(USER, "camp-1"),
    );
    expect(m.rtt).toBe(4); // campaign, apps, docs, usage rpc
    expect(m.waves).toBe(3); // campaign → (apps ∥ docs) → usage
  });
});

/* ------------------------------------------------------------------ *\
 * B. The client-visible flows (before / after)
 * ------------------------------------------------------------------ */

describe("F3 '+ New series' — client-visible flow", () => {
  beforeEach(() => {
    db = freshDb();
    engine.resetBewPositionColumnsProbe();
  });

  it("BEFORE: create action + view action back-to-back = 13 RTT / 11 waves", async () => {
    // The old client: `await bewCreateCampaign(fd)` then
    // `await bewGetView(result.campaignId)` — two server actions, each
    // re-authenticating (2 RTT).
    const m = await measure("F3 new-series BEFORE", async () => {
      const { userId } = { userId: USER };
      // action 1: auth + create
      await (async () => {
        const { getCurrentUserAndProfile } = await import("@/lib/auth");
        await getCurrentUserAndProfile();
        return engine.createBewCampaign({
          userId,
          count: 10,
          purpose: "ausbildung",
        });
      })();
      // action 2: auth + view
      const { getCurrentUserAndProfile } = await import("@/lib/auth");
      await getCurrentUserAndProfile();
      const campaign = db.bew_campaigns[db.bew_campaigns.length - 1];
      await engine.getBewCampaignView(USER, campaign.id);
    });
    // 2 auth + 4 cold create (probe ∥ sender, insert, seed) + 2 auth +
    // 5 view (the CREATED campaign carries its default sender → sender read)
    expect(m.rtt).toBe(13);
    expect(m.waves).toBe(11);
  });

  it("AFTER: one createBewCampaignView action = 9 RTT / 7 waves (and the UI already opened)", async () => {
    const m = await measure("F3b new-series AFTER", async () => {
      const { getCurrentUserAndProfile } = await import("@/lib/auth");
      await getCurrentUserAndProfile(); // the single action's auth
      return engine.createBewCampaignView({
        userId: USER,
        count: 10,
        purpose: "ausbildung",
      });
    });
    // 2 auth + (probe ∥ sender) + insert + seed + (apps ∥ docs) + usage.
    // The sender's e-mail is REUSED from the create — no account re-read.
    expect(m.rtt).toBe(9);
    expect(m.waves).toBe(7);
    expect(m.rtt).toBeLessThan(13);
    expect(m.waves).toBeLessThan(11);
  });
});

describe("F4/F5 per-row Save — client-visible flow", () => {
  beforeEach(() => {
    db = freshDb();
    seedCampaign(10);
    engine.resetBewPositionColumnsProbe();
  });

  it("F4 updateBewApplicationFields (cold): 7 RTT / 6 waves (probe ∥ app select)", async () => {
    const m = await measure("F4 row update (cold)", () =>
      engine.updateBewApplicationFields(USER, "app-1", {
        companyName: "Muster GmbH",
        companyEmail: "new@muster.de",
        contactName: null,
        companyAddress: null,
      }),
    );
    // (probe ∥ app select), campaign(purpose), app update,
    // counter apps, counter campaign, counter update
    expect(m.rtt).toBe(7);
    expect(m.waves).toBe(6);
  });

  it("F4b updateBewApplicationFields (warm): 9 RTT / 9 waves", async () => {
    await engine.updateBewApplicationFields(USER, "app-2", {
      companyName: "Warm GmbH",
      companyEmail: "warm@warm.de",
      contactName: null,
      companyAddress: null,
    }); // warms the probe
    const m = await measure("F4b row update (warm)", () =>
      engine.updateBewApplicationFields(USER, "app-3", {
        companyName: "Kalt GmbH",
        companyEmail: "kalt@kalt.de",
        contactName: null,
        companyAddress: null,
      }),
    );
    // F1: app-3 is an EMPTY→CONTENT fill, so the save carries one extra hop
    // — the advisory saved_applications capacity pre-check (rpc).
    // 2026-10-24 entitlement fix: that pre-check first RESOLVES the
    // subscription (subscriptions select + billing_plans select = 2 more
    // sequential hops) so the plan limit is server-authoritative, not
    // inferred. 7 + 2 = 9.
    expect(m.rtt).toBe(9);
    expect(m.waves).toBe(9);
  });

  it("BEFORE: update action + refresh (getBewCampaignView) = 17 RTT / 16 waves", async () => {
    // Warm the probe first (steady state) so the composite is comparable
    // with the AFTER number. (app-4 is an empty→content fill: it also pays
    // the F1 capacity pre-check hop — unmeasured, like before.)
    await engine.updateBewApplicationFields(USER, "app-4", {
      companyName: "Warmup",
      companyEmail: "warmup@warmup.de",
      contactName: null,
      companyAddress: null,
    });
    const m = await measure("F5 row-save BEFORE", async () => {
      const { getCurrentUserAndProfile } = await import("@/lib/auth");
      await getCurrentUserAndProfile(); // action 1 auth
      await engine.updateBewApplicationFields(USER, "app-5", {
        companyName: "Save Me",
        companyEmail: "save@me.de",
        contactName: null,
        companyAddress: null,
      });
      await getCurrentUserAndProfile(); // action 2 auth (the `await refresh()`)
      await engine.getBewCampaignView(USER, "camp-1");
    });
    // (auth 2 + warm update 9 — incl. the F1 empty→content capacity
    // pre-check hop AND the 2026-10-24 entitlement subscription resolution:
    // subscriptions + billing_plans selects) + (auth 2 + view 4 — seeded
    // campaign has no sender)
    expect(m.rtt).toBe(17);
    expect(m.waves).toBe(16);
  });

  it("AFTER: update action only (no view refetch; probe ∥ app select) = 12 RTT / 11 waves (cold probe)", async () => {
    const m = await measure("F5b row-save AFTER", async () => {
      const { getCurrentUserAndProfile } = await import("@/lib/auth");
      await getCurrentUserAndProfile(); // the single action's auth
      await engine.updateBewApplicationFields(USER, "app-6", {
        companyName: "Save Me",
        companyEmail: "save@me.de",
        contactName: null,
        companyAddress: null,
      });
      // NO getBewCampaignView: the action returns the saved row and the
      // client patches that ONE row into the view.
    });
    // 2 auth + (probe ∥ app) + capacity pre-check (F1, app-6 is
    // empty→content) + the 2026-10-24 entitlement subscription resolution
    // (subscriptions + billing_plans selects) + campaign + update + counter×3
    expect(m.rtt).toBe(12);
    expect(m.waves).toBe(11);
    // And strictly fewer round trips than the BEFORE composite.
    expect(m.rtt).toBeLessThan(17);
    expect(m.waves).toBeLessThan(16);
  });
});
