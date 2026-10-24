/**
 * F1 — saved_applications capacity (items quota) enforcement, engine level.
 *
 * The REAL entitlement service (checkSavedApplicationCapacity /
 * assertSavedApplicationCapacity) is loaded UNMOCKED; only the Supabase
 * client boundary is in-memory. The harness implements two things that
 * mirror migration 20261123000000's semantics EXACTLY:
 *
 *   1. the advisory `check_saved_application_capacity` RPC —
 *        used + max(newCount, 0) > limit  →  'exceeded'
 *        (so used + newCount == limit is still 'ok'),
 *        used excludes the rows of `p_replace_campaign_id`,
 *        limit NULL → 'unmetered', limit <= 0 → 'disabled';
 *   2. a SIMULATION of the `enforce_saved_application_capacity` trigger —
 *        the BEFORE trigger sees the table in its PRE-state (an INSERT's row
 *        is not counted yet; an UPDATE's row is still in its old, empty
 *        form), so the projected total is always currentContent + 1 and the
 *        statement rolls back with `saved_application_capacity_exceeded`
 *        when it would exceed the limit.
 *
 * HONESTY NOTE (no PostgreSQL in this sandbox): the trigger simulation is
 * single-threaded — it proves the DECISION RULE and the stable-code mapping,
 * NOT real row-lock serialization. True concurrent-commit safety is only
 * provable on a real database (see the staging verification procedure,
 * workspace artifact). The concurrency suites below inject the pre-check→
 * insert race deterministically and assert the backstop admits exactly one
 * winner.
 *
 * Covered: the three commercial plans (limits anchored to COMMERCIAL_PLANS),
 * the exact boundary, retry after a denial, concurrent saves, and
 * subscription-verification failure (fail closed → SAVE_FAILED, never
 * "plenty of room").
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { COMMERCIAL_SUB_ROW, COMMERCIAL_PLAN_ROW } from "./helpers";

/* eslint-disable @typescript-eslint/no-explicit-any */

type Row = Record<string, any>;

const { COMMERCIAL_PLANS } = await import("@/lib/billing/commercial-plans");
const { dictionaries } = await import("@/lib/i18n/dictionaries");

interface CapacityCall {
  userId: string;
  newCount: number;
  replaceCampaignId: string | null;
  status: string;
}

interface DB {
  bew_campaigns: Row[];
  bew_applications: Row[];
  /** Entitlement lookups (the REAL service resolves them on every write):
   *  seeded per test — see seedCommercial below. 2026-10-24 fix: without a
   *  verified active commercial subscription the application-layer policy
   *  gate denies saved_applications (limit 0) BEFORE the RPC. */
  subscriptions: Row[];
  billing_plans: Row[];
  /** Per-user saved_applications limit: 0 = disabled, >0 = limit. ABSENT =
   *  unmetered (plan_feature_limit returns NULL → legacy/free behavior). */
  capacity: Map<string, number | null>;
  /** Failure injection for the capacity RPC (subscription-verification fail). */
  capacityRpcFail: "error" | "throw" | "malformed" | null;
  /** When set, the capacity RPC holds before RESOLVING (the verdict was
   *  already computed) — lets a test land a concurrent write inside the
   *  pre-check→insert window and prove the trigger backstop. */
  holdPrecheck: Promise<unknown> | null;
  /** Deletes issued on bew_applications (a denial must never delete). */
  appDeletes: number;
  /** Every advisory pre-check that reached the RPC, with the verdict. */
  capacityCalls: CapacityCall[];
}

const USER = "user-1";
const CAMPAIGN = "camp-1";
const NOW = () => new Date().toISOString();

function freshDb(): DB {
  return {
    bew_campaigns: [],
    bew_applications: [],
    subscriptions: [],
    billing_plans: [],
    capacity: new Map(),
    capacityRpcFail: null,
    holdPrecheck: null,
    appDeletes: 0,
    capacityCalls: [],
  };
}

/** Verified active commercial subscriber whose plan matrix sets
 *  saved_applications to `limit` — the application policy gate and the
 *  mirrored RPC must agree on the same number. */
function seedCommercial(limit: number) {
  db.subscriptions.push({ ...COMMERCIAL_SUB_ROW, user_id: USER });
  db.billing_plans.push({
    ...COMMERCIAL_PLAN_ROW,
    feature_limits: { saved_applications: limit },
  });
  db.capacity.set(USER, limit);
}

/** Commercial subscriber whose plan matrix has NO saved_applications entry
 *  (gate limit null → the RPC decides): keeps the SQL 'disabled' /
 *  'unmetered' branches under test. */
function seedCommercialWithoutKey() {
  db.subscriptions.push({ ...COMMERCIAL_SUB_ROW, user_id: USER });
  db.billing_plans.push({ ...COMMERCIAL_PLAN_ROW, feature_limits: {} });
}

let db: DB;

/* ------------------- In-memory Supabase-style query builder ------------------- */

const contentOf = (r: Row) => (r.company_name ?? "").trim() !== "";

const contentCount = (userId: string) =>
  db.bew_applications.filter((r) => r.user_id === userId && contentOf(r))
    .length;

function makeFrom(table: string) {
  const state = {
    op: "select" as "select" | "update" | "insert" | "delete",
    payload: undefined as any,
    selectCols: undefined as any,
    filters: [] as Array<{ col: string; val: any }>,
    terminal: undefined as "single" | "maybeSingle" | undefined,
  };
  const bucket = (): Row[] =>
    (db as unknown as Record<string, Row[]>)[table] ?? [];
  function rows(): Row[] {
    let out = bucket().slice();
    for (const f of state.filters)
      out = out.filter((r: Row) => r[f.col] === f.val);
    return out;
  }
  async function run(): Promise<any> {
    if (state.op === "insert") {
      const items = Array.isArray(state.payload)
        ? state.payload
        : [state.payload];
      if (table === "bew_applications") {
        // TRIGGER SIMULATION — the per-row BEFORE trigger fires in statement
        // order; earlier rows of the same statement are visible to later
        // rows (running count). A raise rolls back the WHOLE statement.
        const running: Record<string, number> = {};
        for (const r of items) {
          if (!contentOf(r)) continue; // empty rows consume no capacity
          const limit = db.capacity.get(r.user_id) ?? null;
          if (limit === null) continue; // unmetered — keep legacy behavior
          if (limit <= 0)
            return {
              data: null,
              error: {
                message: "saved_application_capacity_exceeded (limit disabled)",
              },
            };
          const used = contentCount(r.user_id) + (running[r.user_id] ?? 0);
          if (used + 1 > limit)
            return {
              data: null,
              error: { message: "saved_application_capacity_exceeded" },
            };
          running[r.user_id] = (running[r.user_id] ?? 0) + 1;
        }
      }
      const ins = items.map((r) => ({
        ...r,
        id: r.id ?? `id-${Math.random()}`,
      }));
      bucket().push(...ins);
      return state.terminal === "single"
        ? { data: ins[0], error: null }
        : { data: ins, error: null };
    }
    if (state.op === "update") {
      const matched = rows();
      if (table === "bew_applications") {
        // TRIGGER SIMULATION — only an empty→content transition is metered;
        // the BEFORE trigger sees the row still in its OLD (empty) form, so
        // it is not in the count: projected = currentContent + 1.
        for (const m of matched) {
          const oldEmpty = (m.company_name ?? "").trim() === "";
          if (
            !oldEmpty ||
            !contentOf({ company_name: state.payload?.company_name })
          )
            continue;
          const limit = db.capacity.get(m.user_id) ?? null;
          if (limit === null) continue;
          if (limit <= 0)
            return {
              data: null,
              error: {
                message: "saved_application_capacity_exceeded (limit disabled)",
              },
            };
          if (contentCount(m.user_id) + 1 > limit)
            return {
              data: null,
              error: { message: "saved_application_capacity_exceeded" },
            };
        }
      }
      for (const m of matched) Object.assign(m, state.payload);
      if (state.terminal) return { data: matched[0] ?? null, error: null };
      return { data: matched, error: null };
    }
    if (state.op === "delete") {
      if (table === "bew_applications") db.appDeletes += rows().length;
      const matched = new Set(rows());
      const rec = db as unknown as Record<string, Row[]>;
      rec[table] = (rec[table] ?? []).filter((r: Row) => !matched.has(r));
      return { data: null, error: null };
    }
    const matched = rows();
    if (state.terminal) return { data: matched[0] ?? null, error: null };
    return { data: matched, error: null };
  }
  const chain: any = {
    eq: (col: string, val: any) => (state.filters.push({ col, val }), chain),
    select: (cols?: any) => ((state.selectCols = cols), chain),
    limit: () => chain,
    order: () => chain,
    insert: (p: any) => ((state.op = "insert"), (state.payload = p), chain),
    update: (p: any) => ((state.op = "update"), (state.payload = p), chain),
    delete: () => ((state.op = "delete"), chain),
    single: () => ((state.terminal = "single"), chain),
    maybeSingle: () => ((state.terminal = "maybeSingle"), chain),
    then(onF?: any, onR?: any) {
      return run().then(onF, onR);
    },
  };
  return chain;
}

/** The capacity RPC — read side of migration 20261123000000, mirrored 1:1. */
async function capacityRpc(
  args: Record<string, unknown>,
): Promise<{ data: any; error: any }> {
  const userId = String(args["p_user_id"] ?? "");
  const newCount = Number(args["p_new_count"] ?? 0);
  const replace =
    args["p_replace_campaign_id"] == null
      ? null
      : String(args["p_replace_campaign_id"]);
  if (db.capacityRpcFail === "throw") throw new Error("simulated client throw");
  if (db.capacityRpcFail === "error")
    return { data: null, error: { message: "simulated rpc error" } };
  if (db.capacityRpcFail === "malformed")
    return {
      data: [{ status: "garbage", plan_limit: "x", used: "y", remaining: "z" }],
      error: null,
    };
  // used EXCLUDES the rows of the replace campaign (its slots are freed by
  // the same operation that deletes them first).
  const used = db.bew_applications.filter(
    (r) =>
      r.user_id === userId &&
      contentOf(r) &&
      (replace === null || r.campaign_id !== replace),
  ).length;
  const limit = db.capacity.get(userId) ?? null;
  let row: Row;
  if (limit === null) {
    row = { status: "unmetered", plan_limit: null, used, remaining: null };
  } else if (limit <= 0) {
    row = { status: "disabled", plan_limit: limit, used, remaining: 0 };
  } else if (used + Math.max(newCount, 0) > limit) {
    row = { status: "exceeded", plan_limit: limit, used, remaining: 0 };
  } else {
    row = {
      status: "ok",
      plan_limit: limit,
      used,
      remaining: Math.max(limit - used - Math.max(newCount, 0), 0),
    };
  }
  db.capacityCalls.push({
    userId,
    newCount,
    replaceCampaignId: replace,
    status: row.status,
  });
  // Hold BEFORE resolving so a test can land a concurrent write inside the
  // pre-check→insert window (the trigger must then be the one that decides).
  if (db.holdPrecheck) await db.holdPrecheck;
  return { data: [row], error: null };
}

vi.doMock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: makeFrom,
    rpc: async (fn: string, args: Record<string, unknown> = {}) => {
      if (fn === "check_saved_application_capacity") return capacityRpc(args);
      return { data: null, error: null };
    },
    storage: {
      from: () => ({
        download: async () => ({
          data: { arrayBuffer: async () => new Uint8Array([1]).buffer },
          error: null,
        }),
        upload: async () => ({ error: null }),
        remove: async () => ({ error: null }),
      }),
    },
  }),
}));
vi.doMock("@/lib/ai-provider", () => ({
  createAIProvider: () => ({ generateText: async () => "x" }),
}));
vi.doMock("@/lib/ai-service", () => ({
  reserveAIUsage: async () => {},
  storagePath: () => "x",
}));
vi.doMock("@/lib/pdf-extract", () => ({ extractPdfText: async () => "" }));
vi.doMock("@/lib/application-drafts", () => ({
  sanitizeEmailHtml: (h: string) => h,
  htmlToText: (h: string) => h,
}));
vi.doMock("@/lib/email-campaigns", () => ({
  getUsageSnapshot: async () => ({ remaining: 10, daily_limit: 50 }),
  reserveSenderSlot: async () => true,
}));
vi.doMock("@/lib/email-providers", () => ({
  createEmailProvider: async () => ({
    sendEmail: async () => ({ ok: true, id: "m" }),
  }),
}));
vi.doMock("@/lib/bew-letter-pdf", () => ({
  BEW_ATTACHMENT_BUCKET: "b",
  ensureLetterPdf: async () => {},
  deleteLetterPdf: async () => {},
  letterPdfStoragePath: () => "p",
}));
vi.doMock("mammoth", () => ({
  default: { extractRawText: async () => ({ value: "docx" }) },
}));
vi.doMock("@/lib/contact-name-support", () => ({
  hasApplicantProfileColumns: () => Promise.resolve(true),
}));

const {
  addBewCompany,
  saveBewCompanies,
  updateBewApplicationFields,
  resetBewPositionColumnsProbe,
} = await import("@/lib/bewerbung-engine");

/* ------------------- Seeds ------------------- */

function seedCampaign(id: string = CAMPAIGN, status = "draft") {
  db.bew_campaigns.push({
    id,
    user_id: USER,
    email_account_id: "acct-1",
    purpose: "ausbildung",
    status,
    requested_count: 3,
    valid_count: 0,
    total_count: 0,
    generated_count: 0,
    sent_count: 0,
    failed_count: 0,
    excluded_count: 0,
    usage_date: NOW().slice(0, 10),
    created_at: NOW(),
    started_at: null,
    completed_at: null,
  });
}

let seqCounter = 0;
function seedApp(campaignId: string, over: Partial<Row> = {}): Row {
  seqCounter += 1;
  const app: Row = {
    id: `app-${seqCounter}`,
    campaign_id: campaignId,
    user_id: USER,
    seq: seqCounter,
    company_name: "",
    contact_name: null,
    company_email: "",
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
    created_at: NOW(),
    updated_at: NOW(),
    ...over,
  };
  db.bew_applications.push(app);
  return app;
}

/** N existing CONTENT rows in `campaignId` (the used slots). */
function seedContent(campaignId: string, n: number) {
  for (let i = 1; i <= n; i++) {
    seedApp(campaignId, {
      company_name: `Company ${i} GmbH`,
      company_email: `jobs${i}@company${i}.de`,
    });
  }
}

/** A parseable ad (same shape as the parser fixtures) with a unique email. */
function adText(i: number): string {
  return [
    "Informationen zur Bewerbung",
    `Neu ${i} GmbH`,
    "Frau Test",
    "Teststr. 1",
    "12345 Stadt",
    "Telefon: +49 123 456",
    `E-Mail: bewerb${i}@neu${i}.de`,
    "",
    "Ausbildung: Mechatroniker/in - Kältetechnik",
    "Beschreibung: Als Mechatroniker für Kältetechnik planst, montierst und wartest du Anlagen der Kälte- und Klimatechnik. Du sorgst dafür, dass die Kälteanlagen beim Kunden einwandfrei funktionieren.",
  ].join("\n");
}

const record = (i: number) => ({
  companyName: `Save ${i} GmbH`,
  companyEmail: `save${i}@save${i}.de`,
  contactName: "",
  companyAddress: "",
});

async function expectCode(fn: () => Promise<unknown>, code: string) {
  await expect(fn()).rejects.toThrow(code);
}

/** Poll until pred() (microtask/macrotask tolerant, bounded). */
async function tickUntil(pred: () => boolean, tries = 100) {
  for (let i = 0; i < tries; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error("tickUntil: condition not reached");
}

beforeEach(() => {
  db = freshDb();
  seqCounter = 0;
  resetBewPositionColumnsProbe();
});

// featureLimits is Partial<Record<...>> (values may be undefined) — normalize
// to null = "key absent from the plan" (the anchor test pins the numbers).
const LIMITS = {
  trial: COMMERCIAL_PLANS.trial.featureLimits.saved_applications ?? null,
  premium_10d:
    COMMERCIAL_PLANS.premium_10d.featureLimits.saved_applications ?? null,
  premium_monthly:
    COMMERCIAL_PLANS.premium_monthly.featureLimits.saved_applications ?? null,
} as const;

/** The same values typed as `number` for seedCommercial: the anchor test
 *  below pins all three to concrete numbers (a null/undefined would fail
 *  it), so the assertion is exact, not a guess. */
const PLAN_LIMIT = {
  trial: LIMITS.trial as number,
  premium_10d: LIMITS.premium_10d as number,
  premium_monthly: LIMITS.premium_monthly as number,
};

/* ============================= A. Plan boundaries ============================= */

describe("A — the three plans at the exact boundary", () => {
  it("anchor: the catalogue says trial 3 / premium_10d 200 / premium_monthly 500", () => {
    // Drift guard: if the product limits change, the boundary tests below
    // change with them (they read LIMITS, but the numbers are pinned here).
    expect(LIMITS.trial).toBe(3);
    expect(LIMITS.premium_10d).toBe(200);
    expect(LIMITS.premium_monthly).toBe(500);
  });

  it("trial (3): the last slot is allowed, the next add is CAPACITY_EXCEEDED", async () => {
    seedCommercial(PLAN_LIMIT.trial);
    seedCampaign();
    seedContent(CAMPAIGN, 2); // used = 2 of 3
    await expect(
      addBewCompany(USER, CAMPAIGN, adText(1)),
    ).resolves.toMatchObject({
      company_name: "Neu 1 GmbH",
    });
    expect(contentCount(USER)).toBe(3); // exactly at the limit
    await expectCode(
      () => addBewCompany(USER, CAMPAIGN, adText(2)),
      "CAPACITY_EXCEEDED",
    );
    expect(contentCount(USER)).toBe(3); // the denial added nothing
  });

  it("trial (3): a full replace of ANOTHER campaign at the boundary", async () => {
    seedCommercial(PLAN_LIMIT.trial);
    seedCampaign();
    seedCampaign("camp-2");
    seedCampaign("camp-3");
    seedContent(CAMPAIGN, 2);
    // used 2 + new 1 == 3 → allowed (the pre-check's ok boundary).
    await expect(
      saveBewCompanies(USER, "camp-2", [record(1)]),
    ).resolves.toMatchObject({
      result: { rows: expect.any(Array) },
    });
    expect(contentCount(USER)).toBe(3);
    // used 3 + new 1 = 4 > 3 → denied BEFORE the destructive delete.
    await expectCode(
      () => saveBewCompanies(USER, "camp-3", [record(2)]),
      "CAPACITY_EXCEEDED",
    );
    expect(contentCount(USER)).toBe(3);
    expect(
      db.bew_applications.filter((r) => r.campaign_id === "camp-3"),
    ).toHaveLength(0);
  });

  it("trial (3): re-saving the SAME campaign frees its own slots (replace semantics)", async () => {
    seedCommercial(PLAN_LIMIT.trial);
    seedCampaign();
    seedContent(CAMPAIGN, 3); // full — but all in the campaign being replaced
    await expect(
      saveBewCompanies(USER, CAMPAIGN, [record(9)]),
    ).resolves.toBeDefined();
    const rows = db.bew_applications.filter((r) => r.campaign_id === CAMPAIGN);
    expect(rows).toHaveLength(1);
    expect(rows[0].company_name).toBe("Save 9 GmbH");
    // The pre-check excluded the replaced campaign's own rows.
    expect(db.capacityCalls).toHaveLength(1);
    expect(db.capacityCalls[0]).toEqual({
      userId: USER,
      newCount: 1,
      replaceCampaignId: CAMPAIGN,
      status: "ok",
    });
  });

  it("premium_10d (200): 199 used → one more fits; the 202nd does not", async () => {
    seedCommercial(PLAN_LIMIT.premium_10d);
    seedCampaign();
    seedCampaign("camp-2");
    seedCampaign("camp-3");
    seedContent(CAMPAIGN, 199);
    await expect(
      saveBewCompanies(USER, "camp-2", [record(1)]),
    ).resolves.toBeDefined();
    expect(contentCount(USER)).toBe(200);
    await expectCode(
      () => saveBewCompanies(USER, "camp-3", [record(2)]),
      "CAPACITY_EXCEEDED",
    );
    expect(contentCount(USER)).toBe(200);
  });

  it("premium_monthly (500): 499 used → one more fits; the 502nd does not", async () => {
    seedCommercial(PLAN_LIMIT.premium_monthly);
    seedCampaign();
    seedCampaign("camp-2");
    seedCampaign("camp-3");
    seedContent(CAMPAIGN, 499);
    await expect(
      saveBewCompanies(USER, "camp-2", [record(1)]),
    ).resolves.toBeDefined();
    expect(contentCount(USER)).toBe(500);
    await expectCode(
      () => saveBewCompanies(USER, "camp-3", [record(2)]),
      "CAPACITY_EXCEEDED",
    );
    expect(contentCount(USER)).toBe(500);
  });

  it("non-commercial (NO subscription): the policy gate denies BEFORE any RPC (2026-10-24 fail-closed)", async () => {
    // The old behavior — free/legacy = 'unmetered' = unlimited saved
    // applications — was the unrestricted-access bug. Now the explicit
    // non-commercial matrix (limit 0) short-circuits in the application
    // layer: no RPC is ever reached and nothing is written.
    seedCampaign();
    await expectCode(
      () => addBewCompany(USER, CAMPAIGN, adText(1)),
      "CAPACITY_EXCEEDED",
    );
    expect(db.bew_applications).toHaveLength(0);
    expect(db.capacityCalls).toHaveLength(0);
  });

  it("unmetered (commercial plan WITHOUT a saved_applications entry): the RPC decides — no limit = legacy unmetered", async () => {
    // capacity unset for USER → plan_feature_limit NULL → 'unmetered'.
    seedCommercialWithoutKey();
    seedCampaign();
    for (let i = 1; i <= 5; i++) {
      await expect(
        addBewCompany(USER, CAMPAIGN, adText(i)),
      ).resolves.toBeDefined();
    }
    expect(contentCount(USER)).toBe(5); // more than the trial limit — allowed
    expect(db.capacityCalls.every((c) => c.status === "unmetered")).toBe(true);
  });

  it("disabled (limit 0): every content write is CAPACITY_EXCEEDED", async () => {
    seedCommercialWithoutKey(); // gate limit null → the RPC reports 'disabled'
    db.capacity.set(USER, 0);
    seedCampaign();
    await expectCode(
      () => addBewCompany(USER, CAMPAIGN, adText(1)),
      "CAPACITY_EXCEEDED",
    );
    expect(db.bew_applications).toHaveLength(0);
    expect(db.capacityCalls).toHaveLength(1); // the RPC was reached and said no
    expect(db.capacityCalls[0].status).toBe("disabled");
  });

  it("disabled (limit 0): even with zero used, a replace is denied", async () => {
    seedCommercialWithoutKey();
    db.capacity.set(USER, 0);
    seedCampaign();
    await expectCode(
      () => saveBewCompanies(USER, CAMPAIGN, [record(1)]),
      "CAPACITY_EXCEEDED",
    );
    expect(db.appDeletes).toBe(0);
  });

  it("empty rows consume NOTHING (growth rows are free at the limit)", async () => {
    seedCommercial(PLAN_LIMIT.trial);
    seedCampaign();
    seedContent(CAMPAIGN, 3); // full
    // A save of the SAME campaign mixing content + empty rows: only the one
    // content row is metered, and the campaign's own slots are freed.
    await expect(
      saveBewCompanies(USER, CAMPAIGN, [
        record(1),
        {
          companyName: "",
          companyEmail: "",
          contactName: "",
          companyAddress: "",
        },
      ]),
    ).resolves.toBeDefined();
    const rows = db.bew_applications.filter((r) => r.campaign_id === CAMPAIGN);
    expect(rows).toHaveLength(2);
    expect(contentCount(USER)).toBe(1);
  });
});

/* ============================= B. Engine wiring ============================= */

describe("B — engine wiring: pre-check args, ordering, transition rules", () => {
  it("addBewCompany pre-checks exactly (userId, 1, null) before the insert", async () => {
    seedCommercial(PLAN_LIMIT.trial);
    seedCampaign();
    seedContent(CAMPAIGN, 2);
    await addBewCompany(USER, CAMPAIGN, adText(1));
    expect(db.capacityCalls).toEqual([
      { userId: USER, newCount: 1, replaceCampaignId: null, status: "ok" },
    ]);
  });

  it("saveBewCompanies counts only CONTENT rows and passes the replace campaign id", async () => {
    seedCommercial(PLAN_LIMIT.trial);
    seedCampaign();
    // 2 content + 1 empty → newCount must be 2.
    await saveBewCompanies(USER, CAMPAIGN, [
      record(1),
      record(2),
      {
        companyName: "   ",
        companyEmail: "",
        contactName: "",
        companyAddress: "",
      },
    ]);
    expect(db.capacityCalls).toEqual([
      { userId: USER, newCount: 2, replaceCampaignId: CAMPAIGN, status: "ok" },
    ]);
  });

  it("a RENAME (content→content) is free — no capacity call", async () => {
    seedCommercial(PLAN_LIMIT.trial);
    seedCampaign();
    seedContent(CAMPAIGN, 3); // full
    const app = db.bew_applications[0];
    await expect(
      updateBewApplicationFields(USER, app.id, {
        companyName: "Renamed GmbH",
        companyEmail: app.company_email,
        contactName: null,
        companyAddress: null,
      }),
    ).resolves.toMatchObject({ company_name: "Renamed GmbH" });
    expect(db.capacityCalls).toHaveLength(0);
    expect(contentCount(USER)).toBe(3);
  });

  it("a CLEAR (content→empty) is free and frees the slot", async () => {
    seedCommercial(PLAN_LIMIT.trial);
    seedCampaign();
    seedContent(CAMPAIGN, 3); // full
    const app = db.bew_applications[0];
    await expect(
      updateBewApplicationFields(USER, app.id, {
        companyName: "",
        companyEmail: "",
        contactName: null,
        companyAddress: null,
      }),
    ).resolves.toBeDefined();
    expect(db.capacityCalls).toHaveLength(0);
    expect(contentCount(USER)).toBe(2);
    // The freed slot is usable again.
    await expect(
      addBewCompany(USER, CAMPAIGN, adText(1)),
    ).resolves.toBeDefined();
    expect(contentCount(USER)).toBe(3);
  });

  it("a save of ZERO content rows never pre-checks (empty-only import)", async () => {
    seedCampaign();
    await saveBewCompanies(USER, CAMPAIGN, [
      {
        companyName: "",
        companyEmail: "",
        contactName: "",
        companyAddress: "",
      },
    ]);
    expect(db.capacityCalls).toHaveLength(0);
    expect(db.bew_applications).toHaveLength(1);
  });

  it("an over-limit REPLACE is denied before the destructive delete (rows stay byte-identical)", async () => {
    seedCommercial(PLAN_LIMIT.trial);
    seedCampaign();
    seedContent(CAMPAIGN, 2);
    const before = JSON.stringify(db.bew_applications);
    // Replace camp-1 with 4 content rows: used(excl. camp-1) = 0 → 0 + 4 = 4 > 3.
    await expectCode(
      () =>
        saveBewCompanies(USER, CAMPAIGN, [
          record(1),
          record(2),
          record(3),
          record(4),
        ]),
      "CAPACITY_EXCEEDED",
    );
    expect(db.appDeletes).toBe(0);
    expect(JSON.stringify(db.bew_applications)).toBe(before);
    expect(db.capacityCalls).toHaveLength(1);
    expect(db.capacityCalls[0].replaceCampaignId).toBe(CAMPAIGN);
    expect(db.capacityCalls[0].status).toBe("exceeded");
  });

  it("trigger backstop — add: a concurrent write inside the pre-check→insert window is rejected at the DB", async () => {
    seedCommercial(PLAN_LIMIT.trial);
    seedCampaign();
    seedContent(CAMPAIGN, 2); // used 2, one slot left
    let release!: () => void;
    db.holdPrecheck = new Promise<void>((r) => (release = r));
    const p = addBewCompany(USER, CAMPAIGN, adText(1));
    await tickUntil(() => db.capacityCalls.length === 1); // pre-check verdict computed (ok)
    // A CONCURRENT writer lands the last slot while our insert is in flight.
    seedContent("camp-rival", 1);
    release();
    await expect(p).rejects.toThrow("CAPACITY_EXCEEDED"); // the trigger marker, not SAVE_FAILED
    expect(contentCount(USER)).toBe(LIMITS.trial); // never limit + 1
    expect(
      db.bew_applications.filter((r) => r.campaign_id === "camp-rival"),
    ).toHaveLength(1);
    // Our own row was NOT written.
    expect(
      db.bew_applications.some((r) => r.company_name === "Neu 1 GmbH"),
    ).toBe(false);
  });

  it("trigger backstop — save: a denied replace never leaves the platform over the limit", async () => {
    seedCommercial(PLAN_LIMIT.trial);
    seedCampaign();
    seedCampaign("camp-2");
    seedContent(CAMPAIGN, 2); // used 2, one slot left
    let release!: () => void;
    db.holdPrecheck = new Promise<void>((r) => (release = r));
    const p = saveBewCompanies(USER, "camp-2", [record(1)]);
    await tickUntil(() => db.capacityCalls.length === 1); // verdict: ok (2 + 1 == 3)
    seedContent("camp-rival", 1); // the rival takes the last slot first
    release();
    await expect(p).rejects.toThrow("CAPACITY_EXCEEDED");
    expect(contentCount(USER)).toBe(LIMITS.trial); // hard ceiling: never limit + 1
    // Pre-existing, documented window: the replace's delete runs before the
    // insert, so a denial HERE leaves camp-2 empty (it started empty — no
    // data was destroyed); with non-empty replaced rows the pre-F1 code had
    // the same non-atomic delete→insert shape (42703 lesson). The trigger
    // guarantees the QUOTA; atomic replace is out of scope for F1.
    expect(
      db.bew_applications.filter((r) => r.campaign_id === "camp-2"),
    ).toHaveLength(0);
    expect(
      db.bew_applications.filter((r) => r.campaign_id === CAMPAIGN),
    ).toHaveLength(2);
  });
});

/* ============================= C. Retry ============================= */

describe("C — retry after a denial", () => {
  it("add: denied → nothing added → free a slot → the SAME add succeeds", async () => {
    seedCommercial(PLAN_LIMIT.trial);
    seedCampaign();
    seedContent(CAMPAIGN, 3); // full
    const before = JSON.stringify(db.bew_applications);
    await expectCode(
      () => addBewCompany(USER, CAMPAIGN, adText(7)),
      "CAPACITY_EXCEEDED",
    );
    expect(JSON.stringify(db.bew_applications)).toBe(before); // denial is a no-op
    // Free a slot (clear is always allowed).
    const app = db.bew_applications[0];
    await updateBewApplicationFields(USER, app.id, {
      companyName: "",
      companyEmail: "",
      contactName: null,
      companyAddress: null,
    });
    // The exact same operation now succeeds.
    await expect(
      addBewCompany(USER, CAMPAIGN, adText(7)),
    ).resolves.toMatchObject({
      company_name: "Neu 7 GmbH",
    });
    expect(contentCount(USER)).toBe(LIMITS.trial);
  });

  it("save: denied replace keeps the old list; after freeing space the retry lands", async () => {
    seedCommercial(PLAN_LIMIT.trial);
    seedCampaign();
    seedCampaign("camp-2");
    seedContent(CAMPAIGN, 3); // full
    await expectCode(
      () => saveBewCompanies(USER, "camp-2", [record(1), record(2)]),
      "CAPACITY_EXCEEDED",
    );
    expect(db.appDeletes).toBe(0);
    expect(
      db.bew_applications.filter((r) => r.campaign_id === "camp-2"),
    ).toHaveLength(0);
    // Free one slot → 2 of 3 used; the retry fits ONE row (2 + 1 == 3).
    const app = db.bew_applications[0];
    await updateBewApplicationFields(USER, app.id, {
      companyName: "",
      companyEmail: "",
      contactName: null,
      companyAddress: null,
    });
    await expect(
      saveBewCompanies(USER, "camp-2", [record(1)]),
    ).resolves.toBeDefined();
    expect(
      db.bew_applications.filter((r) => r.campaign_id === "camp-2"),
    ).toHaveLength(1);
    expect(contentCount(USER)).toBe(LIMITS.trial); // 2 (camp-1) + 1 (camp-2) = 3
  });
});

/* ============================= D. Concurrent saves ============================= */

describe("D — concurrent saves at the boundary (simulated serialized trigger)", () => {
  it("two parallel adds with one slot left: exactly ONE wins, the loser gets CAPACITY_EXCEEDED", async () => {
    seedCommercial(PLAN_LIMIT.trial);
    seedCampaign();
    seedContent(CAMPAIGN, 2); // used 2 of 3
    const a = addBewCompany(USER, CAMPAIGN, adText(1));
    const b = addBewCompany(USER, CAMPAIGN, adText(2));
    const results = await Promise.allSettled([a, b]);
    // Both advisory pre-checks passed (the race the design must survive)…
    expect(db.capacityCalls).toHaveLength(2);
    expect(db.capacityCalls.every((c) => c.status === "ok")).toBe(true);
    // …and the serialized trigger admitted exactly one.
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(Error);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toBe(
      "CAPACITY_EXCEEDED",
    );
    expect(contentCount(USER)).toBe(LIMITS.trial); // hard ceiling: never 4
  });

  it("two parallel empty→content fills with one slot left: exactly ONE wins", async () => {
    seedCommercial(PLAN_LIMIT.trial);
    seedCampaign();
    seedContent(CAMPAIGN, 2); // used 2 of 3
    const e1 = seedApp(CAMPAIGN); // empty row
    const e2 = seedApp(CAMPAIGN); // empty row
    const a = updateBewApplicationFields(USER, e1.id, {
      companyName: "Fill One GmbH",
      companyEmail: "fill1@fill.de",
      contactName: null,
      companyAddress: null,
    });
    const b = updateBewApplicationFields(USER, e2.id, {
      companyName: "Fill Two GmbH",
      companyEmail: "fill2@fill.de",
      contactName: null,
      companyAddress: null,
    });
    const results = await Promise.allSettled([a, b]);
    expect(db.capacityCalls).toHaveLength(2);
    expect(db.capacityCalls.every((c) => c.status === "ok")).toBe(true);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toBe(
      "CAPACITY_EXCEEDED",
    );
    expect(contentCount(USER)).toBe(LIMITS.trial); // hard ceiling: never 4
  });
});

/* ============================= E. Fail closed ============================= */

describe("E — subscription/capacity verification failure fails CLOSED", () => {
  it("rpc error → SAVE_FAILED on add (never treated as 'plenty of room')", async () => {
    seedCommercial(PLAN_LIMIT.trial);
    db.capacityRpcFail = "error";
    seedCampaign();
    await expectCode(
      () => addBewCompany(USER, CAMPAIGN, adText(1)),
      "SAVE_FAILED",
    );
    expect(db.bew_applications).toHaveLength(0);
  });

  it("rpc error → SAVE_FAILED on save, with NO destructive delete", async () => {
    seedCommercial(PLAN_LIMIT.trial);
    db.capacityRpcFail = "error";
    seedCampaign();
    seedContent(CAMPAIGN, 1);
    const before = JSON.stringify(db.bew_applications);
    await expectCode(
      () => saveBewCompanies(USER, CAMPAIGN, [record(9)]),
      "SAVE_FAILED",
    );
    expect(db.appDeletes).toBe(0);
    expect(JSON.stringify(db.bew_applications)).toBe(before);
  });

  it("rpc throw (client failure) → SAVE_FAILED on empty→content fill", async () => {
    seedCommercial(PLAN_LIMIT.trial);
    db.capacityRpcFail = "throw";
    seedCampaign();
    const app = seedApp(CAMPAIGN);
    await expectCode(
      () =>
        updateBewApplicationFields(USER, app.id, {
          companyName: "Fail GmbH",
          companyEmail: "fail@fail.de",
          contactName: null,
          companyAddress: null,
        }),
      "SAVE_FAILED",
    );
    expect(app.company_name).toBe(""); // the row was not modified
  });

  it("malformed payload (unknown status) → SAVE_FAILED", async () => {
    seedCommercial(PLAN_LIMIT.trial);
    db.capacityRpcFail = "malformed";
    seedCampaign();
    await expectCode(
      () => addBewCompany(USER, CAMPAIGN, adText(1)),
      "SAVE_FAILED",
    );
    expect(db.bew_applications).toHaveLength(0);
  });

  it("failure does NOT leak the raw RPC text as a stable code", async () => {
    seedCommercial(PLAN_LIMIT.trial);
    db.capacityRpcFail = "error";
    seedCampaign();
    await expect(addBewCompany(USER, CAMPAIGN, adText(1))).rejects.toThrow(
      /SAVE_FAILED/,
    );
    await expect(addBewCompany(USER, CAMPAIGN, adText(1))).rejects.not.toThrow(
      /simulated rpc error/,
    );
  });
});

/* ============================= F. i18n ============================= */

describe("F — CAPACITY_EXCEEDED is localized in all four languages", () => {
  it("bewauto.err.CAPACITY_EXCEEDED exists and is non-empty for de/en/fr/ar", () => {
    for (const lang of ["de", "en", "fr", "ar"] as const) {
      const msg = dictionaries[lang].bewauto.err.CAPACITY_EXCEEDED;
      expect(typeof msg, `${lang}`).toBe("string");
      expect(msg.trim().length, `${lang}`).toBeGreaterThan(0);
    }
  });
});
