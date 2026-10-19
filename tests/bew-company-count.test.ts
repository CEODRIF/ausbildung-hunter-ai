/**
 * Bewerbung Automation — user-controlled company count (feature spec).
 *
 * The campaign's company total was frozen at creation (the seeded row
 * count — "Total: 10" for the default). Now the user controls a TARGET
 * (the persisted `requested_count`) through a −/+ stepper with direct
 * numeric entry, and the UI always shows the ACTUAL entries vs that
 * target. The target is a goal, not a quota: changing it never creates,
 * fills or deletes application rows.
 *
 * Pinned here:
 *   A. the pure rules — clamp, terminal detection, the shared 1..100
 *      validation (boundary values: 1, 10, 25, 50, 100, 0, −5, 101, NaN,
 *      fractions, empty),
 *   B. the engine `setBewCompanyCount` against an in-memory fake DB —
 *      ownership, locks (sending / terminal), the two GENUINE limits
 *      (1 / 100 = platform daily cap, inside the DB CHECK 0..100), no row
 *      seeding on ANY outcome, and a failed write surfacing SAVE_FAILED,
 *   C. the server action contract (re-auth, FormData mapping, stable
 *      payload),
 *   D. the SSR first paint — the stepper shows the persisted target and
 *      the actual-vs-target line ("12 von 50 Unternehmen eingegeben"),
 *      and "Ziel erreicht" when they agree.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/* eslint-disable @typescript-eslint/no-explicit-any */

/* ------------------------------------------------------------------ *\
 * A. Pure rules (no I/O — real module, static import)
 * ------------------------------------------------------------------ */
import {
  BEW_MAX_COUNT,
  BEW_MIN_COUNT,
  clampCompanyCount,
  isBewCampaignTerminal,
  validateCompanyCount,
} from "@/lib/bewerbung-automation";

describe("A. pure count rules", () => {
  it("the range is 1..100 (the platform cap) — no fixed 10 anywhere", () => {
    expect(BEW_MIN_COUNT).toBe(1);
    expect(BEW_MAX_COUNT).toBe(100);
  });

  describe("clampCompanyCount", () => {
    it("keeps every in-range value as-is", () => {
      for (const n of [1, 10, 25, 50, 100]) expect(clampCompanyCount(n)).toBe(n);
    });
    it("pins out-of-range values to the GENUINE edges", () => {
      expect(clampCompanyCount(0)).toBe(1);
      expect(clampCompanyCount(-5)).toBe(1);
      expect(clampCompanyCount(-Infinity)).toBe(1);
      expect(clampCompanyCount(101)).toBe(100);
      expect(clampCompanyCount(1000)).toBe(100);
      expect(clampCompanyCount(Infinity)).toBe(100);
    });
    it("truncates fractions and pins NaN to the minimum", () => {
      expect(clampCompanyCount(1.9)).toBe(1);
      expect(clampCompanyCount(50.9)).toBe(50);
      expect(clampCompanyCount(NaN)).toBe(1);
    });
  });

  describe("validateCompanyCount (the shared client+server rule)", () => {
    it("accepts the spec's test values 1, 10, 25, 50, 100", () => {
      for (const n of [1, 10, 25, 50, 100])
        expect(validateCompanyCount(n)).toEqual({ ok: true, value: n });
      // Form values arrive as strings.
      expect(validateCompanyCount("25")).toEqual({ ok: true, value: 25 });
    });
    it("rejects empty, negative, fractional, non-numeric and over-cap values", () => {
      expect(validateCompanyCount("")).toEqual({ ok: false, error: "empty" });
      expect(validateCompanyCount(null)).toEqual({ ok: false, error: "empty" });
      expect(validateCompanyCount(0)).toEqual({ ok: false, error: "too-small" });
      expect(validateCompanyCount(-5)).toEqual({ ok: false, error: "too-small" });
      expect(validateCompanyCount(1.5)).toEqual({ ok: false, error: "not-integer" });
      expect(validateCompanyCount("abc")).toEqual({ ok: false, error: "not-integer" });
      expect(validateCompanyCount(101)).toEqual({ ok: false, error: "too-large" });
      expect(validateCompanyCount(1000)).toEqual({ ok: false, error: "too-large" });
    });
  });

  describe("isBewCampaignTerminal", () => {
    it("marks exactly the closed series states", () => {
      for (const s of ["completed", "partially_failed", "cancelled"])
        expect(isBewCampaignTerminal(s)).toBe(true);
      for (const s of ["draft", "generating", "sending"])
        expect(isBewCampaignTerminal(s)).toBe(false);
    });
  });
});

/* ------------------------------------------------------------------ *\
 * B. Engine — setBewCompanyCount (in-memory fake DB, real engine code)
 * ------------------------------------------------------------------ */

type Row = Record<string, any>;
type TableKey =
  | "bew_campaigns"
  | "bew_applications"
  | "bew_documents"
  | "bew_campaign_documents"
  | "email_accounts";

interface DB {
  bew_campaigns: Row[];
  bew_applications: Row[];
  bew_documents: Row[];
  bew_campaign_documents: Row[];
  email_accounts: Row[];
  /** Tables whose UPDATE should fail (simulates a broken DB write). */
  updateFailTables: Set<string>;
}

const USER = "user-1";
const TODAY = new Date().toISOString().slice(0, 10);

function freshDb(): DB {
  return {
    bew_campaigns: [
      {
        id: "camp-1",
        user_id: USER,
        email_account_id: "acct-1",
        purpose: "ausbildung",
        status: "draft",
        requested_count: 10,
        valid_count: 10,
        total_count: 10,
        generated_count: 0,
        sent_count: 0,
        failed_count: 0,
        excluded_count: 0,
        usage_date: TODAY,
        created_at: new Date().toISOString(),
        started_at: null,
        completed_at: null,
      },
      // A foreign campaign (ownership must reject it).
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
    bew_applications: Array.from({ length: 10 }, (_, i) => ({
      id: `app-${i + 1}`,
      campaign_id: "camp-1",
      user_id: USER,
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
      next_attempt_at: null,
      provider_message_id: null,
      sent_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })),
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
    const matched = rows();
    if (state.terminal === "single") return { data: matched[0] ?? null, error: null };
    if (state.terminal === "maybeSingle") return { data: matched[0] ?? null, error: null };
    return { data: matched, error: null };
  }

  const chain: any = {
    eq(col: string, val: any) {
      state.filters.push({ col, val });
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
    rpc: async () => ({ data: null, error: null }),
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
  createEmailProvider: async () => ({ sendEmail: async () => ({ providerMessageId: "m" }) }),
}));
vi.mock("@/lib/application-drafts", () => ({
  sanitizeEmailHtml: (h: string) => h,
  htmlToText: (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
}));
vi.mock("@/lib/ai-provider", () => ({
  createAIProvider: () => ({ generateText: async () => "Text." }),
}));
vi.mock("@/lib/ai-service", () => ({
  reserveAIUsage: async () => undefined,
  storagePath: (userId: string, filename: string) => `${userId}/${filename}`,
}));
vi.mock("@/lib/pdf-extract", () => ({ extractPdfText: async () => "" }));
vi.mock("mammoth", () => ({ default: { extractRawText: async () => ({ value: "docx" }) } }));

const { setBewCompanyCount } = await import("@/lib/bewerbung-engine");

function campaignRow(): Row {
  const row = db.bew_campaigns.find((c) => c.id === "camp-1");
  if (!row) throw new Error("no campaign in fake db");
  return row;
}

function rowsSnapshot(): any[] {
  return db.bew_applications.map((r) => ({ ...r }));
}

beforeEach(() => {
  db = freshDb();
});

describe("B. engine setBewCompanyCount", () => {
  it("sets requested_count (50) and leaves EVERY application row untouched", async () => {
    const before = rowsSnapshot();
    const other = campaignRow();
    const beforeCampaign: Row = { ...other };

    const row = await setBewCompanyCount(USER, "camp-1", 50);

    expect(row.requested_count).toBe(50);
    expect(campaignRow().requested_count).toBe(50);
    // Only the target column moved — counters, status and dates are intact.
    const after = campaignRow();
    for (const key of Object.keys(beforeCampaign)) {
      if (key === "requested_count") continue;
      expect(after[key]).toEqual(beforeCampaign[key]);
    }
    // NO fake rows: the application set is byte-identical.
    expect(db.bew_applications).toEqual(before);
  });

  it.each([
    [1, "the minimum"],
    [10, "the old default"],
    [25, "a mid value"],
    [100, "the platform cap"],
  ])("accepts %i (%s)", async (n) => {
    const row = await setBewCompanyCount(USER, "camp-1", n);
    expect(row.requested_count).toBe(n);
  });

  it.each([
    [0, "zero"],
    [-5, "a negative"],
    [101, "just above the cap"],
    [1000, "far above the cap"],
    [1.5, "a fraction"],
    [NaN, "NaN"],
    [Infinity, "Infinity"],
  ])("rejects %s with INVALID_COUNT and changes nothing", async (n) => {
    const before = campaignRow();
    await expect(setBewCompanyCount(USER, "camp-1", n)).rejects.toThrow("INVALID_COUNT");
    expect(campaignRow()).toEqual(before);
  });

  it("rejects a foreign campaign id (ownership)", async () => {
    await expect(setBewCompanyCount(USER, "camp-other", 20)).rejects.toThrow("NOT_FOUND");
  });

  it("rejects an unknown campaign id", async () => {
    await expect(setBewCompanyCount(USER, "nope", 20)).rejects.toThrow("NOT_FOUND");
  });

  it.each(["completed", "partially_failed", "cancelled"])(
    "rejects a terminal campaign (%s) with CAMPAIGN_CLOSED",
    async (status) => {
      campaignRow().status = status;
      await expect(setBewCompanyCount(USER, "camp-1", 20)).rejects.toThrow("CAMPAIGN_CLOSED");
      expect(campaignRow().requested_count).toBe(10);
    },
  );

  it("rejects a campaign with a send in flight with APPLICATION_LOCKED", async () => {
    campaignRow().status = "sending";
    await expect(setBewCompanyCount(USER, "camp-1", 20)).rejects.toThrow("APPLICATION_LOCKED");
    expect(campaignRow().requested_count).toBe(10);
  });

  it("surfaces a failed DB write as SAVE_FAILED (no silent failure)", async () => {
    db.updateFailTables.add("bew_campaigns");
    await expect(setBewCompanyCount(USER, "camp-1", 20)).rejects.toThrow("SAVE_FAILED");
    expect(campaignRow().requested_count).toBe(10); // unchanged
  });

  it("never seeds rows when moving UP or DOWN (target ≠ quota)", async () => {
    const before = rowsSnapshot();
    await setBewCompanyCount(USER, "camp-1", 80); // far above the 10 rows
    expect(db.bew_applications).toEqual(before);
    await setBewCompanyCount(USER, "camp-1", 2); // far below — no deletes either
    expect(db.bew_applications).toEqual(before);
  });
});

/* ------------------------------------------------------------------ *\
 * C. Server action — auth + FormData → engine 1:1 (stable codes)
 * ------------------------------------------------------------------ */

const authState = { user: null as null | { id: string }, profile: null as null | Record<string, any> };
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
/**
 * The actions module imports the whole engine surface — stub every named
 * export it pulls (the contract test only exercises `setBewCompanyCount`;
 * the others just need to exist as stable, callable mocks).
 */
vi.doMock("@/lib/bewerbung-engine", () => {
  const stub = (name: string) =>
    vi.fn(async (...args: unknown[]) => {
      engineMockCalls.push({ fn: name, args });
      return undefined;
    });
  return {
    BEW_MAX_BATCH: 5,
    attachBewDocument: stub("attachBewDocument"),
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
    setBewCompanyCount: vi.fn(async (userId: string, campaignId: string, count: number) => {
      engineMockCalls.push({ fn: "setBewCompanyCount", args: [userId, campaignId, count] });
      return { id: campaignId, requested_count: count };
    }),
    setCampaignSender: stub("setCampaignSender"),
    startBewSend: stub("startBewSend"),
    updateBewApplicationFields: stub("updateBewApplicationFields"),
    updateBewCampaignEmail: stub("updateBewCampaignEmail"),
    updateBewLetter: stub("updateBewLetter"),
  };
});

const { bewSetCompanyCount } = await import("@/app/bewerbung-automation/actions");

describe("C. action bewSetCompanyCount", () => {
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
    fd.set("count", "25");
    await expect(bewSetCompanyCount(fd)).rejects.toThrow("NEXT_REDIRECT");
    expect(engineMockCalls).toHaveLength(0);
  });

  it("maps FormData → engine arguments 1:1 and returns the confirmed value", async () => {
    const fd = new FormData();
    fd.set("campaignId", "camp-1");
    fd.set("count", "25");
    const res = await bewSetCompanyCount(fd);
    expect(engineMockCalls).toEqual([
      { fn: "setBewCompanyCount", args: [USER, "camp-1", 25] },
    ]);
    expect(res).toEqual({ campaignId: "camp-1", requestedCount: 25 });
  });

  it("lets the engine's stable error codes through (server re-validates)", async () => {
    const realSet = vi.mocked(
      await import("@/lib/bewerbung-engine").then((m) => m.setBewCompanyCount),
    );
    realSet.mockRejectedValueOnce(new Error("INVALID_COUNT"));
    const fd = new FormData();
    fd.set("campaignId", "camp-1");
    fd.set("count", "101");
    await expect(bewSetCompanyCount(fd)).rejects.toThrow("INVALID_COUNT");
  });
});

/* ------------------------------------------------------------------ *\
 * D. SSR first paint — the stepper shows persisted target + actual gap
 * ------------------------------------------------------------------ */

/* Section D mocks the ACTION MODULE for the client (the SSR render must not
   call the server) — scoped via doMock + resetModules so the REAL actions
   above (section C) stay untouched. */
vi.doMock("@/app/bewerbung-automation/actions", () => ({
  bewCancelSend: vi.fn(async () => ({ cancelled: 0 })),
  bewCreateCampaign: vi.fn(async () => ({ campaignId: "c", count: 10 })),
  bewCreateCampaignView: vi.fn(async () => null),
  bewGetView: vi.fn(async () => null),
  bewRefreshSend: vi.fn(async () => null),
  bewSetCompanyCount: vi.fn(async () => ({ campaignId: "c1", requestedCount: 50 })),
}));
vi.doMock("next/link", async () => {
  const React = await import("react");
  return { default: (props: any) => React.createElement("a", props, props.children) };
});
vi.resetModules();

const React = await import("react");
const { renderToString } = await import("react-dom/server");
const { I18nProvider } = await import("@/lib/i18n");
const { BewerbungAutomation } = await import(
  "@/components/bewerbung-automation/client"
);

function appRow(
  seq: number,
  fields: { name?: string; email?: string; status?: string } = {},
): any {
  return {
    id: `app-${seq}`,
    seq,
    company_name: fields.name ?? `Company ${seq}`,
    contact_name: null,
    company_email: fields.email ?? `hr@company-${seq}.de`,
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

function renderWizard(
  applications: any[],
  campaign: { requestedCount?: number; status?: string } = {},
): string {
  const view: any = {
    campaign: {
      id: "c1",
      user_id: USER,
      email_account_id: "acct-1",
      purpose: "ausbildung",
      status: campaign.status ?? "draft",
      requested_count: campaign.requestedCount ?? applications.length,
      valid_count: applications.length,
      total_count: applications.length,
      generated_count: 0,
      sent_count: 0,
      failed_count: 0,
      excluded_count: 0,
      usage_date: TODAY,
      created_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
    },
    applications,
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
      userName: "Max",
      userEmail: "max@example.com",
    }),
  );
  return renderToString(tree);
}

describe("D. SSR — the user-controlled target on the Companies step", () => {
  it("shows the stepper with the PERSISTED target (50) and the actual gap (12 entered)", () => {
    const html = renderWizard(
      Array.from({ length: 12 }, (_, i) => appRow(i + 1)),
      { requestedCount: 50 },
    );
    expect(html).toContain("Unternehmens-Ziel");
    // The −/+ stepper and the direct-entry input (value = persisted target).
    expect(html).toContain("Unternehmens-Ziel verringern");
    expect(html).toContain("Unternehmens-Ziel erhöhen");
    expect(html).toContain('value="50"');
    // Target ≠ actual → the difference is explicit.
    expect(html).toContain("12 von 50 Unternehmen eingegeben");
    // The platform cap is explained as the ONLY maximum.
    expect(html).not.toContain("Maximal 10 Unternehmen");
  });

  it("shows 'Ziel erreicht' when actual and target agree (12 of 12)", () => {
    const html = renderWizard(
      Array.from({ length: 12 }, (_, i) => appRow(i + 1)),
      { requestedCount: 12 },
    );
    expect(html).toContain('value="12"');
    expect(html).toContain("Ziel erreicht");
    expect(html).not.toContain("Unternehmen eingegeben");
  });

  it("keeps the real total in the campaign summary (data-driven, not 10)", () => {
    const html = renderWizard(
      Array.from({ length: 12 }, (_, i) => appRow(i + 1)),
      { requestedCount: 50 },
    );
    // "Gesendet: 0 · Fehlgeschlagen: 0 · Alle: 12" — actual, not the target.
    expect(html).toContain("Alle: 12");
  });

  it("locks the stepper while a send is in flight (disabled, no gap confusion)", () => {
    const html = renderWizard(
      Array.from({ length: 12 }, (_, i) => appRow(i + 1, { status: "queued" })),
      { requestedCount: 50, status: "sending" },
    );
    expect(html).toContain("Unternehmens-Ziel");
    // The input + both buttons are present but disabled.
    const inputTag =
      html.match(/<input[^>]*Gewünschte Anzahl an Unternehmen \(Ziel\)[^>]*>/)?.[0] ?? "";
    expect(inputTag).toContain('value="50"');
    expect(inputTag).toContain("disabled");
    const buttons = html.match(/Unternehmens-Ziel (verringern|erhöhen)/g) ?? [];
    expect(buttons).toHaveLength(2);
  });

  it("counts only ACTIVE rows as entered (excluded rows do not count)", () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      i < 7 ? appRow(i + 1) : appRow(i + 1, { status: "excluded" }),
    );
    const html = renderWizard(rows, { requestedCount: 50 });
    expect(html).toContain("7 von 50 Unternehmen eingegeben");
  });
});
