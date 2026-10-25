/**
 * Bewerbung Automation — growing a campaign to 100 REAL company rows.
 *
 * The series used to hold exactly the rows seeded at creation (or an import
 * replacement) — the "Add rows" control + `addBewCompanyRows` engine write
 * grows an EXISTING campaign with real `bew_applications` rows (empty
 * pending, seq continuing, counters recomputed) up to the 100 platform cap.
 *
 * Pinned here:
 *   A. the engine against an in-memory fake DB — the batch lands as real,
 *      editable, persisted rows (seq 11..50, empty pending), the counters
 *      recompute, the cap clamps the batch / rejects a full campaign
 *      (CAMPAIGN_FULL), invalid batches reject (INVALID_COUNT), the
 *      terminal/sending/ownership locks hold, and a failed insert surfaces
 *      SAVE_FAILED with nothing written,
 *   B. the server action contract (re-auth, FormData mapping, stable codes),
 *   C. the SSR first paint — the add-rows control is REMOVED from the
 *      simplified workflow (no batch input, no Add button, no cap hint),
 *      while the engine/action contract above (A/B) is unchanged.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { COMMERCIAL_SUB_ROW, COMMERCIAL_PLAN_ROW } from "./helpers";

/* eslint-disable @typescript-eslint/no-explicit-any */

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
   *  (2026-10-24 fix — fail-closed non-commercial matrix). */
  subscriptions: Row[];
  billing_plans: Row[];
  /** Tables whose INSERT should fail (simulates a broken DB write). */
  insertFailTables: Set<string>;
  /** Tables whose UPDATE should fail. */
  updateFailTables: Set<string>;
}

const USER = "user-1";
const TODAY = new Date().toISOString().slice(0, 10);
let idSeq = 0;

function makeApp(
  campaignId: string,
  seq: number,
  fields: { name?: string; email?: string; status?: string } = {},
): Row {
  return {
    id: `app-${campaignId}-${seq}`,
    campaign_id: campaignId,
    user_id: USER,
    seq,
    company_name: fields.name ?? (seq <= 10 ? `Company ${seq}` : ""),
    contact_name: null,
    company_email: fields.email ?? (seq <= 10 ? `hr@company-${seq}.de` : ""),
    company_address: null,
    subject: "",
    body_html: "",
    body_text: "",
    status: fields.status ?? "pending",
    error_code: null,
    error_message: null,
    attempt_count: 0,
    provider_message_id: null,
    sent_at: null,
  };
}

function freshDb(rowCount = 10): DB {
  return {
    bew_campaigns: [
      {
        id: "camp-1",
        user_id: USER,
        email_account_id: "acct-1",
        purpose: "ausbildung",
        status: "draft",
        requested_count: rowCount,
        valid_count: rowCount,
        total_count: rowCount,
        generated_count: 0,
        sent_count: 0,
        failed_count: 0,
        excluded_count: 0,
        usage_date: TODAY,
        created_at: new Date().toISOString(),
        started_at: null,
        completed_at: null,
      },
      {
        id: "camp-other",
        user_id: "user-other",
        email_account_id: null,
        purpose: "arbeit",
        status: "draft",
        requested_count: 3,
        valid_count: 3,
        total_count: 3,
        generated_count: 0,
        sent_count: 0,
        failed_count: 0,
        excluded_count: 0,
        usage_date: TODAY,
        created_at: new Date().toISOString(),
        started_at: null,
        completed_at: null,
      },
    ],
    bew_applications: Array.from({ length: rowCount }, (_, i) =>
      makeApp("camp-1", i + 1),
    ),
    bew_documents: [],
    bew_campaign_documents: [],
    email_accounts: [
      {
        id: "acct-1",
        user_id: USER,
        email: "sender@gmail.com",
        is_active: true,
        requires_reconnect: false,
      },
    ],
    subscriptions: [{ ...COMMERCIAL_SUB_ROW, user_id: USER }],
    billing_plans: [{ ...COMMERCIAL_PLAN_ROW }],
    insertFailTables: new Set<string>(),
    updateFailTables: new Set<string>(),
  };
}

let db: DB;

/** Minimal chainable query builder over the in-memory tables. */
function makeFrom(table: TableKey) {
  const state = {
    op: "select" as string,
    payload: undefined as any,
    filters: [] as Array<{ col: string; val: any }>,
    terminal: undefined as "single" | "maybeSingle" | undefined,
    selectOpts: undefined as any,
  };

  function rows(): Row[] {
    let out = (db[table] ?? []).slice();
    for (const f of state.filters) out = out.filter((r) => r[f.col] === f.val);
    return out;
  }

  async function run(): Promise<any> {
    if (state.op === "insert") {
      if (db.insertFailTables.has(table)) {
        return { data: null, error: { message: "db insert failed" } };
      }
      const incoming: Row[] = Array.isArray(state.payload)
        ? state.payload
        : [state.payload];
      for (const r of incoming) {
        if (!r.id) r.id = `${table}-${++idSeq}`;
        (db[table] as Row[]).push(r);
      }
      return { data: incoming, error: null };
    }
    if (state.op === "update") {
      if (db.updateFailTables.has(table)) {
        return { data: null, error: { message: "db write failed" } };
      }
      const matched = rows();
      for (const m of matched) Object.assign(m, state.payload);
      if (state.terminal === "single" || state.terminal === "maybeSingle")
        return { data: matched[0] ?? null, error: null };
      return { data: matched, error: null };
    }
    if (state.op === "delete") {
      const keep = (db[table] ?? []).filter(
        (r) => !rows().includes(r),
      ) as Row[];
      db[table] = keep;
      return { data: null, error: null };
    }
    const matched = rows();
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
    order() {
      return chain;
    },
    select(_cols?: string, opts?: any) {
      state.selectOpts = opts;
      return chain;
    },
    update(payload: any) {
      state.op = "update";
      state.payload = payload;
      return chain;
    },
    insert(payload: any) {
      state.op = "insert";
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

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => makeFrom(table as TableKey),
    // F1 (saved_applications): real entitlement service;
    // updateBewApplicationFields does an advisory capacity pre-check on
    // empty→content fills — "unmetered" keeps the gate out of this suite.
    rpc: async (fn: string) =>
      fn === "check_saved_application_capacity"
        ? {
            data: [
              {
                status: "unmetered",
                plan_limit: null,
                used: 0,
                remaining: null,
              },
            ],
            error: null,
          }
        : { data: null, error: null },
    storage: { from: () => ({ upload: async () => ({ error: null }) }) },
  }),
}));
vi.mock("@/lib/email-campaigns", () => ({
  getUsageSnapshot: async () => ({
    date: TODAY,
    emails_sent: 0,
    emails_reserved: 0,
    daily_limit: 100,
    remaining: 100,
  }),
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

const { addBewCompanyRows, getBewCampaignView, updateBewApplicationFields } =
  await import("@/lib/bewerbung-engine");

function campaignRow(): Row {
  const row = db.bew_campaigns.find((c) => c.id === "camp-1");
  if (!row) throw new Error("no campaign in fake db");
  return row;
}

beforeEach(() => {
  db = freshDb();
});

describe("A. engine addBewCompanyRows", () => {
  it("adds 40 REAL rows to a 10-row campaign → 50, seq 11..50, empty pending", async () => {
    const res = await addBewCompanyRows(USER, "camp-1", 40);
    expect(res).toEqual({ added: 40, total: 50 });

    const apps = db.bew_applications;
    expect(apps).toHaveLength(50);
    const seqs = apps.map((r) => r.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));

    // The new rows are byte-shaped like the creation seeds: EMPTY pending.
    for (const r of apps.slice(10)) {
      expect(r.campaign_id).toBe("camp-1");
      expect(r.user_id).toBe(USER);
      expect(r.company_name).toBe("");
      expect(r.company_email).toBe("");
      expect(r.contact_name).toBeNull();
      expect(r.company_address).toBeNull();
      expect(r.status).toBe("pending");
    }
    // The existing 10 rows are untouched.
    expect(apps.slice(0, 10).map((r) => r.company_email)).toEqual(
      Array.from({ length: 10 }, (_, i) => `hr@company-${i + 1}.de`),
    );
    // Counters recomputed: total 50, valid stays 10 (empty rows count as
    // NOTHING — requirement: an empty row is not a completed company).
    expect(campaignRow().total_count).toBe(50);
    expect(campaignRow().valid_count).toBe(10);
    // Existing counter semantics: any pending row puts the campaign in
    // "generating" (it is awaiting letter generation), never terminal.
    expect(campaignRow().status).toBe("generating");
  });

  it("grows a 10-row campaign straight to the 100 cap (batch clamped)", async () => {
    const res = await addBewCompanyRows(USER, "camp-1", 100);
    expect(res).toEqual({ added: 90, total: 100 });
    expect(db.bew_applications).toHaveLength(100);
    expect(campaignRow().total_count).toBe(100);
  });

  it("rejects a full (100-row) campaign with CAMPAIGN_FULL and adds nothing", async () => {
    db = freshDb(100);
    await expect(addBewCompanyRows(USER, "camp-1", 10)).rejects.toThrow(
      "CAMPAIGN_FULL",
    );
    expect(db.bew_applications).toHaveLength(100);
  });

  it.each([
    [0, "zero"],
    [-1, "a negative"],
    [101, "just above the cap"],
    [1.5, "a fraction"],
    [NaN, "NaN"],
  ])("rejects an invalid batch %s with INVALID_COUNT", async (n) => {
    await expect(
      addBewCompanyRows(USER, "camp-1", n as number),
    ).rejects.toThrow("INVALID_COUNT");
    expect(db.bew_applications).toHaveLength(10);
  });

  it.each(["completed", "partially_failed", "cancelled"])(
    "rejects a terminal campaign (%s) with CAMPAIGN_CLOSED",
    async (status) => {
      campaignRow().status = status;
      await expect(addBewCompanyRows(USER, "camp-1", 5)).rejects.toThrow(
        "CAMPAIGN_CLOSED",
      );
      expect(db.bew_applications).toHaveLength(10);
    },
  );

  it("rejects a campaign with a send in flight with APPLICATION_LOCKED", async () => {
    campaignRow().status = "sending";
    await expect(addBewCompanyRows(USER, "camp-1", 5)).rejects.toThrow(
      "APPLICATION_LOCKED",
    );
    expect(db.bew_applications).toHaveLength(10);
  });

  it("enforces ownership (foreign and unknown campaign ids)", async () => {
    await expect(addBewCompanyRows(USER, "camp-other", 5)).rejects.toThrow(
      "NOT_FOUND",
    );
    await expect(addBewCompanyRows(USER, "nope", 5)).rejects.toThrow(
      "NOT_FOUND",
    );
    expect(db.bew_applications).toHaveLength(10);
  });

  it("surfaces a failed insert as SAVE_FAILED (atomic — nothing written)", async () => {
    db.insertFailTables.add("bew_applications");
    await expect(addBewCompanyRows(USER, "camp-1", 5)).rejects.toThrow(
      "SAVE_FAILED",
    );
    expect(db.bew_applications).toHaveLength(10);
    expect(campaignRow().total_count).toBe(10); // counters untouched
  });

  it("the added rows are FIRST-CLASS: editable, saved, counted and in the view", async () => {
    await addBewCompanyRows(USER, "camp-1", 2); // → rows 11, 12
    const last = db.bew_applications.find((r) => r.seq === 12);
    expect(last).toBeDefined();

    // Fill row 12 through the EXISTING per-row save path.
    const lastId = last!.id;
    await updateBewApplicationFields(USER, lastId, {
      companyName: "Neue Firma GmbH",
      companyEmail: "jobs@neuefirma.de",
      contactName: null,
      companyAddress: null,
    });

    const saved = db.bew_applications.find((r) => r.id === lastId)!;
    expect(saved.company_name).toBe("Neue Firma GmbH");
    expect(saved.company_email).toBe("jobs@neuefirma.de");
    // valid_count now counts the filled row (11 valid of 12 total).
    expect(campaignRow().valid_count).toBe(11);
    expect(campaignRow().total_count).toBe(12);

    // The view (what Review/Send consume) exposes all 12 rows in seq order.
    const view = await getBewCampaignView(USER, "camp-1");
    expect(view).not.toBeNull();
    expect(view!.applications).toHaveLength(12);
    expect(view!.applications.map((a) => a.seq)).toEqual(
      Array.from({ length: 12 }, (_, i) => i + 1),
    );
  });
});

/* ------------------------------------------------------------------ *\
 * B. Server action — auth + FormData → engine 1:1
 * ------------------------------------------------------------------ */

const authState = {
  user: null as null | { id: string },
  profile: null as null | Record<string, any>,
};
vi.mock("next/navigation", () => ({
  redirect: () => {
    throw new Error("NEXT_REDIRECT");
  },
  // The smart input (inside the wizard) calls useRouter() for the
  // expired-session /login navigation; stub it for the bare node SSR.
  useRouter: () => ({
    push: () => {},
    replace: () => {},
    back: () => {},
    forward: () => {},
    refresh: () => {},
    prefetch: () => {},
  }),
}));
vi.mock("@/lib/auth", () => ({
  getCurrentUserAndProfile: async () => ({
    user: authState.user,
    profile: authState.profile,
  }),
}));

const engineMockCalls: Array<{ fn: string; args: unknown[] }> = [];
vi.doMock("@/lib/bewerbung-engine", () => {
  const stub = (name: string) =>
    vi.fn(async (...args: unknown[]) => {
      engineMockCalls.push({ fn: name, args });
      return undefined;
    });
  return {
    BEW_MAX_BATCH: 5,
    attachBewDocument: stub("attachBewDocument"),
    addBewCompanyRows: vi.fn(
      async (userId: string, campaignId: string, count: number) => {
        engineMockCalls.push({
          fn: "addBewCompanyRows",
          args: [userId, campaignId, count],
        });
        return { added: count, total: 10 + count };
      },
    ),
    cancelBewSend: stub("cancelBewSend"),
    createBewCampaign: stub("createBewCampaign"),
    createBewCampaignView: stub("createBewCampaignView"),
    detachBewDocument: stub("detachBewDocument"),
    excludeBewApplication: stub("excludeBewApplication"),
    generateBewLetters: stub("generateBewLetters"),
    getBewCampaignView: stub("getBewCampaignView"),
    listBewDocuments: stub("listBewDocuments"),
    processBewSendBatch: stub("processBewSendBatch"),
    rescheduleBewSend: stub("rescheduleBewSend"),
    restoreBewApplication: stub("restoreBewApplication"),
    saveBewCompanies: stub("saveBewCompanies"),
    setBewCompanyCount: stub("setBewCompanyCount"),
    setCampaignSender: stub("setCampaignSender"),
    startBewSend: stub("startBewSend"),
    updateBewApplicationFields: stub("updateBewApplicationFields"),
    updateBewCampaignEmail: stub("updateBewCampaignEmail"),
    updateBewLetter: stub("updateBewLetter"),
  };
});

const { bewAddCompanyRows } =
  await import("@/app/bewerbung-automation/actions");

describe("B. action bewAddCompanyRows", () => {
  beforeEach(() => {
    engineMockCalls.length = 0;
    authState.user = { id: USER };
    authState.profile = { id: USER, account_status: "active" };
  });

  it("requires an authenticated, active user (redirect otherwise)", async () => {
    authState.user = null;
    authState.profile = null;
    const fd = new FormData();
    fd.set("campaignId", "camp-1");
    fd.set("count", "40");
    await expect(bewAddCompanyRows(fd)).rejects.toThrow("NEXT_REDIRECT");
    expect(engineMockCalls).toHaveLength(0);
  });

  it("maps FormData → engine arguments 1:1 and returns the confirmed numbers", async () => {
    const fd = new FormData();
    fd.set("campaignId", "camp-1");
    fd.set("count", "40");
    const res = await bewAddCompanyRows(fd);
    expect(engineMockCalls).toEqual([
      { fn: "addBewCompanyRows", args: [USER, "camp-1", 40] },
    ]);
    expect(res).toEqual({ campaignId: "camp-1", added: 40, total: 50 });
  });

  it("lets the stable error codes through (CAMPAIGN_FULL)", async () => {
    const realAdd = vi.mocked(
      (await import("@/lib/bewerbung-engine")).addBewCompanyRows,
    );
    realAdd.mockRejectedValueOnce(new Error("CAMPAIGN_FULL"));
    const fd = new FormData();
    fd.set("campaignId", "camp-1");
    fd.set("count", "5");
    await expect(bewAddCompanyRows(fd)).rejects.toThrow("CAMPAIGN_FULL");
  });
});

/* ------------------------------------------------------------------ *\
 * C. SSR first paint — the add-rows control on the Companies step
 * ------------------------------------------------------------------ */

vi.doMock("@/app/bewerbung-automation/actions", () => ({
  bewCancelSend: vi.fn(async () => ({ cancelled: 0 })),
  bewCreateCampaign: vi.fn(async () => ({ campaignId: "c", count: 10 })),
  bewCreateCampaignView: vi.fn(async () => null),
  bewGetView: vi.fn(async () => null),
  bewRefreshSend: vi.fn(async () => null),
  bewSetCompanyCount: vi.fn(async () => ({
    campaignId: "c1",
    requestedCount: 50,
  })),
  bewAddCompanyRows: vi.fn(async () => ({
    campaignId: "c1",
    added: 10,
    total: 100,
  })),
}));
vi.doMock("next/link", async () => {
  const React = await import("react");
  return {
    default: (props: any) => React.createElement("a", props, props.children),
  };
});
vi.resetModules();

const React = await import("react");
const { renderToString } = await import("react-dom/server");
const { I18nProvider } = await import("@/lib/i18n");
const { BewerbungAutomation } =
  await import("@/components/bewerbung-automation/client");

function renderWizard(
  rows: number,
  campaign: { status?: string; requested?: number } = {},
): string {
  const view: any = {
    campaign: {
      id: "c1",
      user_id: USER,
      email_account_id: "acct-1",
      purpose: "ausbildung",
      status: campaign.status ?? "draft",
      requested_count: campaign.requested ?? rows,
      valid_count: rows,
      total_count: rows,
      generated_count: 0,
      sent_count: 0,
      failed_count: 0,
      excluded_count: 0,
      usage_date: TODAY,
      created_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
    },
    applications: Array.from({ length: rows }, (_, i) => ({
      id: `app-${i + 1}`,
      seq: i + 1,
      company_name: `Company ${i + 1}`,
      contact_name: null,
      company_email: `hr@company-${i + 1}.de`,
      company_address: null,
      subject: "",
      body_html: "",
      body_text: "",
      status: "pending",
      error_code: null,
      error_message: null,
      attempt_count: 0,
      provider_message_id: null,
      sent_at: null,
    })),
    documents: [],
    usage: { remaining: 100, daily_limit: 100 },
    senderEmail: "sender@gmail.com",
  };
  const tree = React.createElement(
    I18nProvider,
    null,
    React.createElement(BewerbungAutomation, {
      schemaOk: true,
      initialView: view,
      initialLoadError: false,
      userName: "Max",
      userEmail: "max@example.com",
    }),
  );
  return renderToString(tree);
}

describe("C. SSR — the add-rows control is removed from the workflow", () => {
  it("no longer offers the batch control (any number of rows)", () => {
    const html = renderWizard(12);
    expect(html).not.toContain("Zeilen hinzufügen");
    expect(html).not.toContain("Hinzufügen</button>");
    expect(html).not.toContain("Anzahl der hinzuzufügenden Zeilen");
  });

  it("stays removed at the 100-row cap (no cap hint either)", () => {
    const html = renderWizard(100);
    expect(html).not.toContain("Zeilen hinzufügen");
    expect(html).not.toContain("100 / 100");
  });

  it("stays removed while a send is in flight", () => {
    const html = renderWizard(12, { status: "sending" });
    expect(html).not.toContain("Zeilen hinzufügen");
    expect(html).not.toContain("Anzahl der hinzuzufügenden Zeilen");
  });
});
