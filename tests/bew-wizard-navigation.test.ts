/**
 * Bewerbung Automation — step-1 → step-2 navigation regression (PR #32 bug).
 *
 * PRODUCTION SYMPTOM
 *   On /bewerbung-automation the user imported 10 companies, the UI reported
 *   "10 entries imported, 10 valid" and every row showed "Open" — yet there
 *   was no way to advance to the Documents step.
 *
 * ROOT CAUSES (all three are pinned by this suite)
 *   1. The migration attached the shared set_updated_at() trigger to
 *      bew_campaigns — a table with NO updated_at column — so EVERY campaign
 *      UPDATE failed with 42703 ("column updated_at does not exist"). The
 *      engine ignored update errors, so the post-import `valid_count = 10`
 *      never persisted: the step-2 gate (valid_count >= 1) stayed locked
 *      forever while the import itself reported success.
 *   2. Even on a healthy DB, `refreshCampaignCounters` overwrote
 *      valid_count with a generation-STATUS sum (generated+queued+sending+
 *      sent). Editing any row while all rows were still `pending` would
 *      therefore re-lock step 1. valid_count is now derived from the ROW
 *      VALUES (name + valid e-mail), per the column's documented contract.
 *   3. The wizard's only navigation was a small stepper chip — no visible
 *      "Continue to Documents" button, and no explanation of a disabled
 *      state. The Companies step now renders an explicit, accessible
 *      button, disabled ONLY for a real reason (no valid rows / save in
 *      flight / campaign locked by an active send), with the reason shown.
 *
 * No real e-mail, no real Supabase, no real AI: the engine runs against an
 * in-memory fake (same harness style as bew-send-engine.test.ts), the client
 * is SSR-rendered (renderToString) exactly as the page's first paint.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// The in-memory fake below mimics a DYNAMIC Supabase proxy builder; its
// surface is intentionally untyped (shape-proof against the real chains).
/* eslint-disable @typescript-eslint/no-explicit-any */

/* ------------------------------------------------------------------ *
 * In-memory fake (engine side)
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
  /** Tables whose UPDATE should fail (simulates the 42703 trigger bug). */
  updateFailTables: Set<string>;
}

/** DB column defaults the real schema guarantees (NOT NULL DEFAULT …). */
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
    updateFailTables: new Set(),
  };
}

const USER = "user-1";

/** Minimal chainable query builder over the in-memory tables. */
function makeFrom(db: DB, table: TableKey) {
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
    for (const f of state.inFilters) out = out.filter((r) => f.values.includes(r[f.col]));
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
    if (state.op === "insert") {
      const items = Array.isArray(state.payload) ? state.payload : [state.payload];
      const inserted = items.map((r) => ({
        ...DEFAULTS[table],
        ...r,
        id: r.id ?? `id-${Math.random()}`,
      }));
      (db[table] ??= []).push(...inserted);
      if (state.terminal === "single") return { data: inserted[0], error: null };
      return { data: inserted, error: null };
    }
    if (state.op === "update") {
      if (db.updateFailTables.has(table)) {
        // Mirrors PostgreSQL 42703 (the exact failure the broken trigger
        // caused on the real database).
        return {
          data: null,
          error: {
            message: `column "updated_at" of relation "${table}" does not exist`,
          },
        };
      }
      const matched = rows();
      for (const m of matched) Object.assign(m, state.payload);
      if (state.terminal === "single") return { data: matched[0] ?? null, error: null };
      if (state.terminal === "maybeSingle") return { data: matched[0] ?? null, error: null };
      if (state.selectOpts) return { data: null, error: null, count: matched.length };
      return { data: matched, error: null };
    }
    if (state.op === "delete") {
      const matched = rows();
      (db[table] as Row[]) = (db[table] ?? []).filter((r) => !matched.includes(r));
      return { data: null, error: null };
    }
    // select
    const matched = rows();
    if (state.selectOpts?.count)
      return { data: state.selectOpts.head ? null : matched, error: null, count: matched.length };
    if (state.terminal === "single") return { data: matched[0] ?? null, error: null };
    if (state.terminal === "maybeSingle") return { data: matched[0] ?? null, error: null };
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

let db: DB;

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => makeFrom(db, table as TableKey),
    rpc: async () => ({ data: null, error: null }),
    storage: { from: () => ({ upload: async () => ({ error: null }) }) },
  }),
}));
vi.mock("@/lib/email-campaigns", () => ({
  getUsageSnapshot: async () => ({
    date: new Date().toISOString().slice(0, 10),
    emails_sent: 0,
    emails_reserved: 0,
    daily_limit: 50,
    remaining: 50,
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

const {
  createBewCampaign,
  excludeBewApplication,
  getBewCampaignView,
  saveBewCompanies,
  updateBewApplicationFields,
} = await import("@/lib/bewerbung-engine");

function campaign(): Row {
  const row = db.bew_campaigns.find((c) => c.user_id === USER);
  if (!row) throw new Error("no campaign in fake db");
  return row;
}

function apps(): Row[] {
  return db.bew_applications
    .filter((a) => a.campaign_id === campaign().id)
    .sort((a, b) => a.seq - b.seq);
}

function validRecords(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    companyName: `Company ${i + 1}`,
    companyEmail: `hr@company-${i + 1}.de`,
    contactName: null,
    companyAddress: null,
  }));
}

/* ------------------------------------------------------------------ *
 * A. Engine — the import must COMMIT to the wizard state it unlocks
 * ------------------------------------------------------------------ */

describe("engine: importing valid companies commits the step-1 gate state", () => {
  beforeEach(() => {
    db = freshDb();
  });

  it("a fresh campaign starts with empty pending rows and valid_count = 0", async () => {
    await createBewCampaign({ userId: USER, count: 10, purpose: "ausbildung" });
    expect(apps()).toHaveLength(10);
    expect(apps().every((a) => a.status === "pending")).toBe(true);
    expect(campaign().valid_count).toBe(0);
  });

  it("saveBewCompanies persists rows AND the valid_count the wizard gates on", async () => {
    const campaignRow = await createBewCampaign({ userId: USER, count: 10, purpose: "ausbildung" });
    await saveBewCompanies(USER, campaignRow.id, validRecords(10));

    // The rows landed (this is what the user saw as "10 entries, all Open").
    expect(apps()).toHaveLength(10);
    expect(apps().every((a) => a.status === "pending")).toBe(true);
    expect(apps()[0].company_name).toBe("Company 1");
    expect(apps()[0].company_email).toBe("hr@company-1.de");

    // THE REGRESSION: the counter write must land in the same operation —
    // with the broken trigger it silently did not, and the view kept
    // reporting valid_count = 0 forever.
    expect(campaign().total_count).toBe(10);
    expect(campaign().valid_count).toBe(10);

    // And the view the wizard polls must agree.
    const view = await getBewCampaignView(USER, campaignRow.id);
    expect(view?.campaign.valid_count).toBe(10);
    expect(view?.applications).toHaveLength(10);
  });

  it("a failed campaign counter update FAILS THE SAVE (no silent success)", async () => {
    const campaignRow = await createBewCampaign({ userId: USER, count: 10, purpose: "ausbildung" });
    // Simulate the 42703 trigger failure on the real database.
    db.updateFailTables.add("bew_campaigns");
    await expect(saveBewCompanies(USER, campaignRow.id, validRecords(10))).rejects.toThrow(
      "SAVE_FAILED",
    );
  });

  it("editing a row while all rows are pending does NOT zero valid_count (drift regression)", async () => {
    const campaignRow = await createBewCampaign({ userId: USER, count: 10, purpose: "ausbildung" });
    await saveBewCompanies(USER, campaignRow.id, validRecords(10));
    const third = apps()[2];

    // A plain edit (the engine resets the row to pending and refreshes the
    // counters). The old counter formula (generated+queued+sending+sent)
    // would have dropped valid_count to 0 here and re-locked the wizard.
    await updateBewApplicationFields(USER, third.id, {
      companyName: "Company 3",
      companyEmail: "hr@company-3.de",
      contactName: "Herr Neuester",
      companyAddress: null,
    });

    expect(campaign().valid_count).toBe(10);
    expect(apps()[2].contact_name).toBe("Herr Neuester");
  });

  it("a genuinely broken row lowers valid_count — and excluded rows never count", async () => {
    const campaignRow = await createBewCampaign({ userId: USER, count: 10, purpose: "ausbildung" });
    await saveBewCompanies(USER, campaignRow.id, validRecords(10));
    const [first, third] = apps();

    // Row 3 loses its recipient → 9 valid.
    await updateBewApplicationFields(USER, third.id, {
      companyName: "Company 3",
      companyEmail: "not-an-email",
      contactName: null,
      companyAddress: null,
    });
    expect(campaign().valid_count).toBe(9);

    // Row 1 excluded by the user → 8 valid (excluded never counts).
    await excludeBewApplication(USER, first.id);
    expect(campaign().valid_count).toBe(8);
  });
});

/* ------------------------------------------------------------------ *
 * B. Client — the Companies step must offer a VISIBLE, EXPLAINED way
 *    to advance (SSR-rendered exactly like the page's first paint)
 * ------------------------------------------------------------------ */

vi.mock("@/app/bewerbung-automation/actions", () => ({
  bewCancelSend: vi.fn(async () => ({ cancelled: 0 })),
  bewCreateCampaign: vi.fn(async () => ({ campaignId: "c", count: 10 })),
  bewGetView: vi.fn(async () => null),
}));
vi.mock("next/navigation", () => ({
  redirect: () => {
    throw new Error("NEXT_REDIRECT");
  },
  // The smart input (inside the wizard) calls useRouter() for the
  // expired-session /login navigation; the bare node SSR below has no
  // app-router context, so the hook is stubbed.
  useRouter: () => ({
    push: () => {},
    replace: () => {},
    back: () => {},
    forward: () => {},
    refresh: () => {},
    prefetch: () => {},
  }),
}));
vi.mock("next/link", async () => {
  const React = await import("react");
  return { default: (props: any) => React.createElement("a", props, props.children) };
});

const React = await import("react");
const { renderToString } = await import("react-dom/server");
const { I18nProvider } = await import("@/lib/i18n");
const {
  BewerbungAutomation,
  isCompanyRowComplete,
} = await import("@/components/bewerbung-automation/client");

function appRow(
  seq: number,
  fields: { name?: string; email?: string; status?: string },
): any {
  return {
    id: `app-${seq}`,
    seq,
    company_name: fields.name ?? "",
    contact_name: null,
    company_email: fields.email ?? "",
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
  appsList: any[],
  campaign: { validCount?: number; status?: string } = {},
): string {
  const view: any = {
    campaign: {
      id: "c1",
      user_id: USER,
      email_account_id: "acct-1",
      purpose: "ausbildung",
      status: campaign.status ?? "draft",
      requested_count: appsList.length,
      valid_count: campaign.validCount ?? 0,
      total_count: appsList.length,
      generated_count: 0,
      sent_count: 0,
      failed_count: 0,
      excluded_count: 0,
      usage_date: new Date().toISOString().slice(0, 10),
      created_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
    },
    applications: appsList,
    documents: [],
    usage: { remaining: 50, daily_limit: 50 },
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

/** Extract the <button> whose content contains `label`. */
function buttonWith(html: string, label: string): string | null {
  const idx = html.indexOf(label);
  if (idx === -1) return null;
  const start = html.lastIndexOf("<button", idx);
  const end = html.indexOf("</button>", idx);
  if (start === -1 || end === -1) return null;
  return html.slice(start, end + "</button>".length);
}

describe("client: the Companies step exposes a visible, explained way forward", () => {
  it("isCompanyRowComplete follows the row rule (name + valid e-mail, active rows only)", () => {
    expect(
      isCompanyRowComplete({ status: "pending", company_name: "ACME", company_email: "hr@acme.de" }),
    ).toBe(true);
    expect(
      isCompanyRowComplete({ status: "pending", company_name: "", company_email: "hr@acme.de" }),
    ).toBe(false);
    expect(
      isCompanyRowComplete({ status: "pending", company_name: "ACME", company_email: "bad" }),
    ).toBe(false);
    // Excluded / cancelled rows never count, even when complete.
    expect(
      isCompanyRowComplete({ status: "excluded", company_name: "ACME", company_email: "hr@acme.de" }),
    ).toBe(false);
    expect(
      isCompanyRowComplete({ status: "cancelled", company_name: "ACME", company_email: "hr@acme.de" }),
    ).toBe(false);
  });

  it("AFTER AN IMPORT (rows valid, counter column still 0) the continue button is VISIBLE and ENABLED — the exact production repro", () => {
    // 10 imported companies, all pending/valid — while the broken DB left
    // campaign.valid_count at 0 (the reported symptom: rows "Open", no way
    // forward). The gate must now unlock from the rows themselves.
    const appsList = validRecords(10).map((r, i) =>
      appRow(i + 1, { name: r.companyName, email: r.companyEmail }),
    );
    const html = renderWizard(appsList, { validCount: 0 });

    const button = buttonWith(html, "Zu den Dokumenten"); // default (de) first paint
    expect(button, "the continue button must be rendered").not.toBeNull();
    expect(button!.includes("disabled="), "must not be disabled after a valid import").toBe(false);
    // No blocked-reason line while the step is ready.
    expect(html.includes('id="bew-continue-blocked"')).toBe(false);
  });

  it("with NO valid entry the button is disabled AND the exact reason is shown", () => {
    const appsList = [
      appRow(1, { name: "Name Only" }),
      appRow(2, { email: "orphan@nowhere.de" }),
      appRow(3, {}),
    ];
    const html = renderWizard(appsList, { validCount: 0 });

    const button = buttonWith(html, "Zu den Dokumenten");
    expect(button).not.toBeNull();
    expect(button!.includes("disabled=")).toBe(true);
    expect(
      html.includes(
        "0 von 3 Einträgen gültig — jeder Eintrag braucht einen Firmennamen und eine gültige E-Mail-Adresse.",
      ),
      "the exact reason must be rendered next to the button",
    ).toBe(true);
  });

  it("while a send is in progress the button is disabled with the lock reason", () => {
    const appsList = validRecords(5).map((r, i) =>
      appRow(i + 1, { name: r.companyName, email: r.companyEmail, status: "sent" }),
    );
    const html = renderWizard(appsList, { validCount: 5, status: "sending" });

    const button = buttonWith(html, "Zu den Dokumenten");
    expect(button).not.toBeNull();
    expect(button!.includes("disabled=")).toBe(true);
    expect(html.includes("Der Versand läuft — die Einträge sind gesperrt.")).toBe(true);
  });
});
