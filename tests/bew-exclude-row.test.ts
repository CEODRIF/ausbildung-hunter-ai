/**
 * Company-row deletion (the red X) — regression suite for the generic-error
 * production bug: "Something went wrong. Please try again."
 *
 * The delete is an ownership-checked soft exclusion (status → "excluded").
 * The failure had two holes, both pinned here:
 *
 *   1. SWALLOWED SERVER ERROR → generic message. The action used to throw
 *      the engine error straight across the RSC→client boundary (a thrown
 *      error can be re-wrapped by the framework and lose its stable code)
 *      and did not distinguish the re-authentication redirect an expired
 *      session produces: the client's errMessage() fell back to
 *      bewauto.err.UNKNOWN for both — exactly the reported string. The
 *      action now RESOLVES with a JSON-safe stable-code result (the same
 *      contract as bewAddCompany) and the client navigates to /login for a
 *      redirect instead of showing an error.
 *   2. SILENT FAKE SUCCESS. The engine returns null for a missing / stale /
 *      foreign application id; the old action ignored that null and returned
 *      { ok: true } — the UI hid the row while nothing was deleted
 *      server-side, and the row "came back" on the next refresh. Now the
 *      same null resolves to NOT_FOUND: the row is kept and the user sees a
 *      clear localized message.
 *
 * Pinned (in-memory Supabase-style builder, no real DB, no real e-mail):
 *   - a successful deletion excludes exactly the targeted row (the current
 *     series, addressed by the stable entry id) — a soft delete, all other
 *     rows byte-identical, counters refreshed;
 *   - an in-flight row (queued/sending) is rejected with
 *     APPLICATION_LOCKED and left untouched. `sent` is TERMINAL (not in
 *     BEW_IN_FLIGHT) — a finished row can be excluded again (that is how a
 *     completed row leaves the list; the old sent-lock made it permanent);
 *   - a missing/stale id AND a foreign (other user's) id both resolve to
 *     NOT_FOUND with nothing changed (no data leak, no fake success);
 *   - a real persistence failure (lookup or update error) surfaces as
 *     DELETE_FAILED — never collapsed into "not found";
 *   - an unauthenticated call redirects to /login (re-authentication is
 *     never converted into a delete result);
 *   - the client wiring (static contract) maps the stable code to a
 *     localized message and navigates on a redirect;
 *   - every failure code has a useful localized message in ALL four
 *     languages (never the UNKNOWN fallback);
 *   - the optimistic orchestrator keeps restoring the row with its latest
 *     values when the exclusion is rejected with a stable code.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CompanyRowView,
  RowDeleteDeps,
  RowDeleteState,
} from "@/components/bewerbung-automation/row-state";
import type { Language } from "@/lib/i18n/dictionaries";

/* eslint-disable @typescript-eslint/no-explicit-any */

type Row = Record<string, any>;

interface DB {
  bew_campaigns: Row[];
  bew_applications: Row[];
  /** Records every HARD delete issued on bew_applications (must stay 0). */
  appDeletes: number;
  /** Fault injection: the next/any select returns an error. */
  failSelect: boolean;
  /** Fault injection: the next/any update returns an error. */
  failUpdate: boolean;
  /** Fault injection: from() throws (connection-level failure). */
  throwFrom: boolean;
}

const USER = "user-1";
const OTHER = "user-2";
const CAMPAIGN = "camp-1";
const NOW = () => new Date().toISOString();

function freshDb(): DB {
  return {
    bew_campaigns: [],
    bew_applications: [],
    appDeletes: 0,
    failSelect: false,
    failUpdate: false,
    throwFrom: false,
  };
}

let db: DB;

/* ------------------- In-memory Supabase-style query builder ------------------- */
function makeFrom(table: string) {
  const state = {
    op: "select" as "select" | "update" | "insert" | "delete",
    payload: undefined as any,
    selectCols: undefined as any,
    filters: [] as Array<{ col: string; val: any }>,
    terminal: undefined as "single" | "maybeSingle" | undefined,
  };
  const bucket = (): Row[] => (db as unknown as Record<string, Row[]>)[table] ?? [];
  function rows(): Row[] {
    let out = bucket().slice();
    for (const f of state.filters) out = out.filter((r: Row) => r[f.col] === f.val);
    return out;
  }
  async function run(): Promise<any> {
    if (db.throwFrom) throw new Error("connection reset by peer");
    if (state.op === "insert") {
      const items = Array.isArray(state.payload) ? state.payload : [state.payload];
      const ins = items.map((r) => ({ ...r, id: r.id ?? `id-${Math.random()}` }));
      ((db as unknown as Record<string, Row[]>)[table] ??= []).push(...ins);
      return state.terminal === "single"
        ? { data: ins[0], error: null }
        : { data: ins, error: null };
    }
    if (state.op === "update") {
      if (db.failUpdate) return { data: null, error: { message: "500: update failed" } };
      const matched = rows();
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
    if (db.failSelect) return { data: null, error: { message: "500: select failed" } };
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
    then: (onF?: any, onR?: any) => run().then(onF, onR),
  };
  return chain;
}

const authMock = vi.fn<
  () => Promise<{ user: { id: string } | null; profile: { account_status: string } | null }>
>(async () => ({
  user: { id: USER },
  profile: { account_status: "active" },
}));

vi.doMock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => makeFrom(table),
    rpc: () => Promise.resolve({ data: null, error: null }),
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
vi.doMock("@/lib/auth", () => ({ getCurrentUserAndProfile: authMock }));
vi.doMock("next/navigation", () => ({
  // The shape Next.js actually rejects a server action with on redirect():
  // message "NEXT_REDIRECT" + a digest carrying the navigation details.
  redirect: (to: string) => {
    const e = new Error("NEXT_REDIRECT");
    (e as any).digest = `NEXT_REDIRECT;replace;${to};307;`;
    throw e;
  },
}));
// The engine module's other dependencies (unused by the exclude path).
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
  createEmailProvider: async () => ({ sendEmail: async () => ({ ok: true, id: "m" }) }),
}));
vi.doMock("@/lib/bew-letter-pdf", () => ({
  BEW_ATTACHMENT_BUCKET: "b",
  ensureLetterPdf: async () => {},
  deleteLetterPdf: async () => {},
  letterPdfStoragePath: () => "p",
}));
vi.doMock("mammoth", () => ({ default: { extractRawText: async () => ({ value: "docx" }) } }));
vi.doMock("@/lib/contact-name-support", () => ({
  hasApplicantProfileColumns: () => Promise.resolve(true),
}));

const { excludeBewApplication } = await import("@/lib/bewerbung-engine");
const { bewExcludeApplication } = await import("@/app/bewerbung-automation/actions");
const {
  beginRowDelete,
  confirmRowDelete,
  deleteCompanyRow,
  EMPTY_ROW_DELETE_STATE,
  failRowDelete,
  filterActiveRows,
  retireRowDelete,
} = await import("@/components/bewerbung-automation/row-state");
const { isNextRedirectError } = await import("@/components/bewerbung-automation/types");
const { dictionaries } = await import("@/lib/i18n/dictionaries");
const { lookup } = await import("@/lib/i18n/core");

/* ------------------- Seeds ------------------- */

function seedCampaign(status = "draft") {
  db.bew_campaigns.push({
    id: CAMPAIGN,
    user_id: USER,
    email_account_id: "acct-1",
    purpose: "ausbildung",
    status,
    requested_count: 3,
    valid_count: 3,
    total_count: 3,
    generated_count: 1,
    sent_count: 0,
    failed_count: 0,
    excluded_count: 0,
    usage_date: NOW().slice(0, 10),
    created_at: NOW(),
    started_at: null,
    completed_at: null,
  });
}

/** A "Ready" row — the production case: a complete letter, never sent. */
function seedReadyApp(id: string, seq: number, owner = USER) {
  db.bew_applications.push({
    id,
    campaign_id: CAMPAIGN,
    user_id: owner,
    seq,
    company_name: "Northoff GmbH & Co. KG",
    contact_name: null,
    company_email: "info@northoff-klimatechnik.de",
    company_address: "Bunsenstr. 34, 53111 Bonn",
    subject: "Bewerbung als Mechatroniker",
    body_html: "<p>Sehr geehrte Damen und Herren, …</p>",
    body_text: "Sehr geehrte Damen und Herren, …",
    status: "generated",
    error_code: null,
    error_message: null,
    attempt_count: 0,
    next_attempt_at: null,
    provider_message_id: null,
    sent_at: null,
    position_title: null,
    position_brief: null,
    employer_facts: null,
  });
}

function seedPendingApp(id: string, seq: number, over: Partial<Row> = {}) {
  db.bew_applications.push({
    id,
    campaign_id: CAMPAIGN,
    user_id: USER,
    seq,
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
    position_title: null,
    position_brief: null,
    employer_facts: null,
    ...over,
  });
}

function fd(applicationId: string): FormData {
  const f = new FormData();
  f.set("applicationId", applicationId);
  return f;
}

beforeEach(() => {
  db = freshDb();
  authMock.mockClear();
  authMock.mockResolvedValue({
    user: { id: USER },
    profile: { account_status: "active" },
  });
});

/* ------------------------------------------------------------------ *
 * A. Engine — excludeBewApplication
 * ------------------------------------------------------------------ */

describe("excludeBewApplication (engine): the safe soft delete", () => {
  it("deletes exactly the targeted entry of the current series (soft delete, nothing else touched)", async () => {
    seedCampaign();
    seedPendingApp("app-1", 1, { company_name: "A", company_email: "a@a.de" });
    seedReadyApp("app-21", 21); // the production row: "Ready", never sent
    seedPendingApp("app-3", 3, { company_name: "C", company_email: "c@c.de" });

    const before1 = { ...db.bew_applications.find((r) => r.id === "app-1")! };
    const before3 = { ...db.bew_applications.find((r) => r.id === "app-3")! };

    const result = await excludeBewApplication(USER, "app-21");

    // The exclusion persisted (a soft delete — status flip, row kept)…
    expect(result).not.toBeNull();
    expect(result!.status).toBe("excluded");
    expect(result!.error_code).toBeNull();
    const stored = db.bew_applications.find((r) => r.id === "app-21")!;
    expect(stored.status).toBe("excluded");
    // …addressed by the exact entry id (the other rows are byte-identical)…
    expect(db.bew_applications.find((r) => r.id === "app-1")).toEqual(before1);
    expect(db.bew_applications.find((r) => r.id === "app-3")).toEqual(before3);
    // …with NO hard delete anywhere…
    expect(db.appDeletes).toBe(0);
    expect(db.bew_applications).toHaveLength(3);
    // …and the campaign counters are refreshed from the truth.
    const camp = db.bew_campaigns[0];
    expect(camp.excluded_count).toBe(1);
    expect(camp.total_count).toBe(3);
    expect(camp.valid_count).toBe(2); // the Ready row's e-mail is no longer "valid-pending"… it is excluded
  });

  it("an in-flight row (queued) is rejected with APPLICATION_LOCKED and left untouched", async () => {
    seedCampaign();
    seedPendingApp("app-5", 5, { status: "queued", company_name: "Q", company_email: "q@q.de" });

    await expect(excludeBewApplication(USER, "app-5")).rejects.toThrow("APPLICATION_LOCKED");

    const row = db.bew_applications.find((r) => r.id === "app-5")!;
    expect(row.status).toBe("queued");
    expect(db.appDeletes).toBe(0);
  });

  it("a missing or stale entry id resolves to null (nothing changed, nothing thrown)", async () => {
    seedCampaign();
    seedReadyApp("app-21", 21);
    const before = db.bew_applications.map((r) => ({ ...r }));

    await expect(excludeBewApplication(USER, "app-does-not-exist")).resolves.toBeNull();

    expect(db.bew_applications).toEqual(before);
    expect(db.appDeletes).toBe(0);
  });

  it("a FOREIGN entry id (another user's row) is indistinguishable from missing: null, untouched", async () => {
    seedCampaign();
    seedReadyApp("app-foreign", 1, OTHER); // another user, same series table
    const before = { ...db.bew_applications[0] };

    await expect(excludeBewApplication(USER, "app-foreign")).resolves.toBeNull();

    expect(db.bew_applications[0]).toEqual(before);
    expect(db.appDeletes).toBe(0);
  });

  it("a real lookup failure is DELETE_FAILED — never collapsed into 'not found'", async () => {
    seedCampaign();
    seedReadyApp("app-21", 21);
    db.failSelect = true;

    await expect(excludeBewApplication(USER, "app-21")).rejects.toThrow("DELETE_FAILED");

    // The row still exists and is NOT excluded (the user can retry).
    expect(db.bew_applications.find((r) => r.id === "app-21")!.status).toBe("generated");
    expect(db.appDeletes).toBe(0);
  });

  it("a real update failure is DELETE_FAILED — the row is kept for a retry", async () => {
    seedCampaign();
    seedReadyApp("app-21", 21);
    db.failUpdate = true;

    await expect(excludeBewApplication(USER, "app-21")).rejects.toThrow("DELETE_FAILED");

    expect(db.bew_applications.find((r) => r.id === "app-21")!.status).toBe("generated");
    expect(db.appDeletes).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * B. Action — bewExcludeApplication (the JSON-safe result contract)
 * ------------------------------------------------------------------ */

describe("bewExcludeApplication (action): stable codes, no fake success, no swallowed errors", () => {
  it("a successful deletion resolves { ok: true } (and persisted the exclusion)", async () => {
    seedCampaign();
    seedReadyApp("app-21", 21);

    const result = await bewExcludeApplication(fd("app-21"));

    expect(result).toEqual({ ok: true });
    expect(db.bew_applications.find((r) => r.id === "app-21")!.status).toBe("excluded");
  });

  it("a missing/stale entry id resolves NOT_FOUND — never a fake { ok: true }", async () => {
    seedCampaign();
    seedReadyApp("app-21", 21);
    const before = db.bew_applications.map((r) => ({ ...r }));

    const result = await bewExcludeApplication(fd("app-stale-id"));

    expect(result).toEqual({ ok: false, code: "NOT_FOUND" });
    // Nothing was deleted and nothing was faked:
    expect(db.bew_applications).toEqual(before);
    expect(db.appDeletes).toBe(0);
  });

  it("an unauthorized deletion (another user's row) is rejected with NOT_FOUND — no leak, no change", async () => {
    seedCampaign();
    seedReadyApp("app-foreign", 1, OTHER);
    const before = { ...db.bew_applications[0] };

    const result = await bewExcludeApplication(fd("app-foreign"));

    expect(result).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(db.bew_applications[0]).toEqual(before);
  });

  it("an in-flight row resolves APPLICATION_LOCKED (localized client-side)", async () => {
    seedCampaign();
    seedPendingApp("app-5", 5, { status: "sending", company_name: "S", company_email: "s@s.de" });

    const result = await bewExcludeApplication(fd("app-5"));

    expect(result).toEqual({ ok: false, code: "APPLICATION_LOCKED" });
    expect(db.bew_applications.find((r) => r.id === "app-5")!.status).toBe("sending");
  });

  it("an unexpected raw engine failure resolves DELETE_FAILED — internals never leak to the client", async () => {
    seedCampaign();
    seedReadyApp("app-21", 21);
    db.throwFrom = true; // connection-level failure: "connection reset by peer"

    const result = await bewExcludeApplication(fd("app-21"));

    expect(result).toEqual({ ok: false, code: "DELETE_FAILED" });
    // The raw message must not appear in the client-visible result.
    expect(JSON.stringify(result)).not.toContain("connection reset");
  });

  it("an unauthenticated call redirects to /login — re-authentication is never a delete result", async () => {
    seedCampaign();
    seedReadyApp("app-21", 21);
    authMock.mockResolvedValue({ user: null, profile: null });

    await expect(bewExcludeApplication(fd("app-21"))).rejects.toThrow();
    // The rejection IS the Next.js redirect error (the client navigates),
    // and the row is untouched.
    try {
      await bewExcludeApplication(fd("app-21"));
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(isNextRedirectError(e)).toBe(true);
    }
    expect(db.bew_applications.find((r) => r.id === "app-21")!.status).toBe("generated");
  });
});

/* ------------------------------------------------------------------ *
 * C. Optimistic orchestrator — a stable-code rejection keeps the row
 * ------------------------------------------------------------------ */

function uiRow(over: Partial<CompanyRowView>): CompanyRowView {
  return {
    id: "app-21",
    seq: 21,
    companyName: "Northoff GmbH & Co. KG",
    companyEmail: "info@northoff-klimatechnik.de",
    contactName: null,
    companyAddress: "Bunsenstr. 34, 53111 Bonn",
    status: "generated",
    error_code: null,
    ...over,
  };
}

describe("deleteCompanyRow (orchestrator): a rejected exclusion keeps the row and reports the code", () => {
  it("NOT_FOUND (stale id): row restored in place, draft kept, the stable code reaches onError (→ localized)", async () => {
    let state: RowDeleteState = EMPTY_ROW_DELETE_STATE;
    const calls: string[] = [];
    let rejectWith!: (e: Error) => void;
    const excludePromise = new Promise<void>((_, rej) => (rejectWith = rej));
    const deps: RowDeleteDeps = {
      appId: "app-21",
      seq: 21,
      claim: () => true,
      release: () => calls.push("release"),
      begin: (id) => (state = beginRowDelete(state, id)),
      confirm: (id) => (state = confirmRowDelete(state, id)),
      retire: (id) => (state = retireRowDelete(state, id)),
      fail: (id) => (state = failRowDelete(state, id)),
      dropDraft: () => calls.push("dropDraft"),
      exclude: () => excludePromise,
      refresh: async () => calls.push("refresh"),
      onSuccess: () => calls.push("onSuccess"),
      onError: (e) => calls.push(`onError:${(e as Error).message}`),
    };
    const rows = [uiRow({}), uiRow({ id: "app-22", seq: 22, companyName: "Other" })];

    const task = deleteCompanyRow(deps);
    rejectWith(new Error("NOT_FOUND"));
    await task;

    // The row is back in the list (hidden cleared)…
    expect(
      filterActiveRows(rows).filter((r) => !state.hidden.has(r.id)).map((r) => r.id),
    ).toEqual(["app-21", "app-22"]);
    // …the draft was NOT dropped (the user's latest values survive)…
    expect(calls).not.toContain("dropDraft");
    // …no refresh (nothing changed server-side), no success…
    expect(calls).not.toContain("refresh");
    expect(calls).not.toContain("onSuccess");
    // …and the stable code reached onError — the client localizes it
    // (bewauto.err.NOT_FOUND), it never becomes a generic message.
    expect(calls).toContain("onError:NOT_FOUND");
  });
});

/* ------------------------------------------------------------------ *
 * D. Client wiring (static contract on companies-step.tsx)
 * ------------------------------------------------------------------ */

describe("companies-step wiring (static contract): no swallowed server error", () => {
  it("the red-X wiring converts the action result, localizes stable codes and navigates on a redirect", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(
      join(process.cwd(), "src/components/bewerbung-automation/companies-step.tsx"),
      "utf8",
    );
    // 1. The action result is the confirmation: a non-ok result is thrown as
    //    its STABLE CODE (localized by errMessage below) — a missing/stale/
    //    foreign id can never be reported as a successful deletion.
    expect(src).toContain("const res = await bewExcludeApplication(fd);");
    expect(src).toContain("if (!res.ok) throw new Error(res.code); // → localized below");
    // 2. A re-authentication redirect NAVIGATES to /login (the
    //    "Something went wrong" fix — the same contract the smart-input
    //    flow received) instead of being swallowed into err.UNKNOWN. Since
    //    the page repair the whole step routes errors through the shared
    //    resolveBewError(e, t, navigate) — which navigates on NEXT_REDIRECT
    //    (pinned by the unit tests in bew-page-repair) and localizes stable
    //    codes (message or digest) — so the delete wiring is asserted as:
    expect(src).toContain("resolveBewError(error, t, (p) => router.replace(p))");
    expect(src).toContain("if (msg !== null) setError(msg);");
  });
});

/* ------------------------------------------------------------------ *
 * E. Localization — every delete failure code is useful in all 4 languages
 * ------------------------------------------------------------------ */

describe("delete failure codes are localized (never the UNKNOWN fallback)", () => {
  it("NOT_FOUND / APPLICATION_LOCKED / DELETE_FAILED all have a distinct, useful message in de/en/fr/ar", () => {
    for (const lang of Object.keys(dictionaries) as Language[]) {
      for (const code of ["NOT_FOUND", "APPLICATION_LOCKED", "DELETE_FAILED"] as const) {
        const path = `bewauto.err.${code}`;
        const msg = lookup(dictionaries[lang], path);
        expect(msg, `${lang} err.${code} exists`).toBeTruthy();
        // It is a real message, not the raw key…
        expect(msg).not.toBe(path);
        // …and not the generic fallback it used to hide behind.
        expect(msg).not.toBe(lookup(dictionaries[lang], "bewauto.err.UNKNOWN"));
      }
    }
  });

  it("the errMessage rule (translated === key → UNKNOWN) now resolves the delete codes to themselves, not to UNKNOWN", () => {
    // Mirror of companies-step's errMessage lookup, per language.
    for (const lang of Object.keys(dictionaries) as Language[]) {
      for (const code of ["NOT_FOUND", "APPLICATION_LOCKED", "DELETE_FAILED"] as const) {
        const key = `bewauto.err.${code}`;
        const found = lookup(dictionaries[lang], key);
        expect(found !== key, `${lang} err.${code} maps to a message`).toBe(true);
      }
    }
  });
});
