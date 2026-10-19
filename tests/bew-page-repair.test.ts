/**
 * Full Page Audit & Repair — regression suite for /bewerbung-automation.
 *
 * Pins the root-cause fixes of the recurring problems:
 *
 *   A1. `sent` rows are TERMINAL, not "in flight" — the engine's
 *       BEW_IN_FLIGHT lock no longer contains them, so a finished row can be
 *       excluded/edited again (it can no longer be stuck forever showing
 *       "being processed" next to a "Ready" pill), while queued/sending rows
 *       stay locked for the duration of a real send.
 *   A2. The page error banner is dismissible (no permanently pinned error).
 *   B1. `reclaimStaleSending` settles rows stuck in `sending` after a
 *       crash: a 15-minute lease on the claim-stamped `updated_at` moves
 *       them to `needs_attention` (ambiguous = NO auto-retry, no
 *       double-send) and the campaign counters settle. Fresh in-flight rows
 *       and already-`sent` rows are untouched.
 *   C1. The client recovers the stable code from the DIGEST when the
 *       RSC→client boundary re-wraps the thrown error (no silent UNKNOWN).
 *   C2. `resolveBewError` — the single client error resolution — navigates
 *       to /login on an expired session (re-authentication is never shown as
 *       an operation failure) and localizes stable codes everywhere.
 *   C3. Server actions keep the withStableError contract: redirects
 *       propagate, known codes pass through clean, unexpected failures
 *       become the action's fallback code (internals never cross the
 *       boundary).
 *   C4. Missing/stale ids are NOT fake successes: bewUpdateLetter and
 *       bewRestoreApplication throw NOT_FOUND for a vanished row.
 *
 * In-memory Supabase-style builder (no real DB, no real e-mail) + SSR
 * renderToString assertions for the UI states.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/* eslint-disable @typescript-eslint/no-explicit-any */

type Row = Record<string, any>;

interface DB {
  bew_campaigns: Row[];
  bew_applications: Row[];
  /** Fault injection: the next select returns an error. */
  failSelect: boolean;
  /** Fault injection: the next insert returns an error. */
  failInsert: boolean;
}

const USER = "user-1";
const OTHER = "user-2";
const CAMPAIGN = "camp-1";
const NOW = () => new Date().toISOString();
const MIN = 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function freshDb(): DB {
  return {
    bew_campaigns: [],
    bew_applications: [],
    failSelect: false,
    failInsert: false,
  };
}

let db: DB;

/* ------------------- In-memory Supabase-style query builder ------------------- */
function makeFrom(table: string) {
  const state = {
    op: "select" as "select" | "update" | "insert" | "delete",
    payload: undefined as any,
    selectCols: undefined as any,
    filters: [] as Array<{ col: string; val: any; kind: "eq" | "is" | "lt" }>,
    terminal: undefined as "single" | "maybeSingle" | undefined,
  };
  const bucket = (): Row[] => (db as unknown as Record<string, Row[]>)[table] ?? [];
  function matches(r: Row, f: { col: string; val: any; kind: "eq" | "is" | "lt" }): boolean {
    if (f.kind === "eq") return r[f.col] === f.val;
    if (f.kind === "is") return r[f.col] === f.val; // is(col, null) → col IS NULL
    // lt — ISO timestamps compare lexicographically = chronologically.
    return typeof r[f.col] === "string" && r[f.col] < String(f.val);
  }
  function rows(): Row[] {
    let out = bucket().slice();
    for (const f of state.filters) out = out.filter((r) => matches(r, f));
    return out;
  }
  async function run(): Promise<any> {
    if (state.op === "insert") {
      if (db.failInsert) return { data: null, error: { message: "500: insert failed" } };
      const items = Array.isArray(state.payload) ? state.payload : [state.payload];
      const ins = items.map((r) => ({ ...r, id: r.id ?? `id-${Math.random()}` }));
      ((db as unknown as Record<string, Row[]>)[table] ??= []).push(...ins);
      return state.terminal === "single"
        ? { data: ins[0], error: null }
        : { data: ins, error: null };
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
    if (db.failSelect) return { data: null, error: { message: "500: select failed" } };
    const matched = rows();
    if (state.terminal) return { data: matched[0] ?? null, error: null };
    return { data: matched, error: null };
  }
  const chain: any = {
    eq: (col: string, val: any) => (state.filters.push({ col, val, kind: "eq" }), chain),
    is: (col: string, val: any) => (state.filters.push({ col, val, kind: "is" }), chain),
    lt: (col: string, val: any) => (state.filters.push({ col, val, kind: "lt" }), chain),
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
// Engine module dependencies (unused by the tested paths, kept hermetic).
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

const {
  excludeBewApplication,
  reclaimStaleSending,
  resetBewPositionColumnsProbe,
  updateBewApplicationFields,
} = await import("@/lib/bewerbung-engine");
const {
  bewRestoreApplication,
  bewUpdateCompany,
  bewUpdateLetter,
} = await import("@/app/bewerbung-automation/actions");
const {
  bewErrorCode,
  isNextRedirectError,
  resolveBewError,
} = await import("@/components/bewerbung-automation/types");
const { createAdminClient } = await import("@/lib/supabase/admin");
const { translate } = await import("@/lib/i18n");
const { DEFAULT_LANGUAGE, dictionaries } = await import("@/lib/i18n/dictionaries");
const React = await import("react");
const { renderToString } = await import("react-dom/server");
const { RowStatus } = await import("@/components/bewerbung-automation/companies-step");
const { ErrorLine } = await import("@/components/bewerbung-automation/client");

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

function seedApp(id: string, seq: number, over: Partial<Row> = {}) {
  db.bew_applications.push({
    id,
    campaign_id: CAMPAIGN,
    user_id: USER,
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
    updated_at: NOW(),
    position_title: null,
    position_brief: null,
    employer_facts: null,
    ...over,
  });
}

function fd(applicationId: string, extra: Record<string, string> = {}): FormData {
  const f = new FormData();
  f.set("applicationId", applicationId);
  for (const [k, v] of Object.entries(extra)) f.set(k, v);
  return f;
}

beforeEach(() => {
  db = freshDb();
  resetBewPositionColumnsProbe();
  authMock.mockClear();
  authMock.mockResolvedValue({
    user: { id: USER },
    profile: { account_status: "active" },
  });
});

/* ------------------------------------------------------------------ *
 * A1. Terminal `sent` rows are not locked (the screenshot bug)
 * ------------------------------------------------------------------ */

describe("A1 — `sent` rows settle out of the processing lock", () => {
  it("a sent row can be excluded again (soft delete, counters refreshed)", async () => {
    seedCampaign("sending");
    seedApp("app-21", 21, {
      status: "sent",
      sent_at: NOW(),
      provider_message_id: "m-1",
    });
    seedApp("app-2", 2, { company_name: "A", company_email: "a@a.de", status: "generated" });

    const result = await excludeBewApplication(USER, "app-21");

    expect(result).not.toBeNull();
    expect(result!.status).toBe("excluded");
    // The other rows are untouched…
    expect(db.bew_applications.find((r) => r.id === "app-2")!.status).toBe("generated");
    // …and the campaign counters settle from the row truth.
    const camp = db.bew_campaigns[0];
    expect(camp.excluded_count).toBe(1);
    expect(camp.sent_count).toBe(0);
    expect(camp.total_count).toBe(2);
  });

  it("a sent row can be edited (the recipient change invalidates its letter)", async () => {
    seedCampaign("completed");
    seedApp("app-21", 21, { status: "sent", sent_at: NOW() });

    const updated = await updateBewApplicationFields(USER, "app-21", {
      companyName: "Kälte Nord GmbH",
      companyEmail: "jobs@kaelte-nord.de",
      contactName: null,
      companyAddress: null,
    });

    expect(updated).not.toBeNull();
    expect(updated!.company_name).toBe("Kälte Nord GmbH");
    // A changed recipient resets the letter (the row can be regenerated +
    // re-sent — it is no longer frozen at "sent").
    expect(updated!.status).toBe("pending");
  });

  it.each(["queued", "sending"] as const)(
    "an in-flight %s row stays locked (exclusion rejected, row untouched)",
    async (status) => {
      seedCampaign("sending");
      seedApp("app-5", 5, { status, company_name: "Q", company_email: "q@q.de" });

      await expect(excludeBewApplication(USER, "app-5")).rejects.toThrow("APPLICATION_LOCKED");

      expect(db.bew_applications.find((r) => r.id === "app-5")!.status).toBe(status);
    },
  );

  it("a queued row stays locked for edits too", async () => {
    seedCampaign("sending");
    seedApp("app-5", 5, { status: "queued", company_name: "Q", company_email: "q@q.de" });

    await expect(
      updateBewApplicationFields(USER, "app-5", {
        companyName: "Q",
        companyEmail: "q@q.de",
        contactName: null,
        companyAddress: null,
      }),
    ).rejects.toThrow("APPLICATION_LOCKED");
  });
});

/* ------------------------------------------------------------------ *
 * B1. Crash recovery for rows stuck in `sending`
 * ------------------------------------------------------------------ */

describe("B1 — reclaimStaleSending settles stuck sends (15-min lease)", () => {
  it("a stale sending row (claim > 15 min old) becomes needs_attention + send_stale", async () => {
    seedCampaign("sending");
    seedApp("app-stale", 1, {
      status: "sending",
      attempt_count: 1,
      updated_at: ago(16 * MIN),
      sent_at: null,
    });
    seedApp("app-done", 2, { status: "sent", sent_at: NOW() });

    const reclaimed = await reclaimStaleSending(createAdminClient(), USER, CAMPAIGN);

    expect(reclaimed).toBe(1);
    const row = db.bew_applications.find((r) => r.id === "app-stale")!;
    expect(row.status).toBe("needs_attention");
    expect(row.error_code).toBe("send_stale");
    // The campaign counters settle (a needs_attention row keeps the campaign
    // open — by design, the user sees the problem row and acts explicitly).
    const camp = db.bew_campaigns[0];
    expect(camp.failed_count).toBe(1);
    expect(camp.sent_count).toBe(1);
  });

  it("fresh in-flight rows are untouched (no double-send risk)", async () => {
    seedCampaign("sending");
    seedApp("app-fresh", 1, {
      status: "sending",
      attempt_count: 1,
      updated_at: ago(2 * MIN),
      sent_at: null,
    });

    const reclaimed = await reclaimStaleSending(createAdminClient(), USER, CAMPAIGN);

    expect(reclaimed).toBe(0);
    expect(db.bew_applications.find((r) => r.id === "app-fresh")!.status).toBe("sending");
  });

  it("sent rows are untouched even with an old updated_at", async () => {
    seedCampaign("completed");
    seedApp("app-sent", 1, {
      status: "sent",
      sent_at: ago(16 * MIN),
      updated_at: ago(16 * MIN),
    });

    const reclaimed = await reclaimStaleSending(createAdminClient(), USER, CAMPAIGN);

    expect(reclaimed).toBe(0);
    expect(db.bew_applications.find((r) => r.id === "app-sent")!.status).toBe("sent");
  });

  it("is idempotent — a second run reclaims nothing", async () => {
    seedCampaign("sending");
    seedApp("app-stale", 1, {
      status: "sending",
      updated_at: ago(16 * MIN),
      sent_at: null,
    });

    expect(await reclaimStaleSending(createAdminClient(), USER, CAMPAIGN)).toBe(1);
    expect(await reclaimStaleSending(createAdminClient(), USER, CAMPAIGN)).toBe(0);
  });

  it("only touches the given user's rows of the given campaign", async () => {
    seedCampaign("sending");
    seedApp("app-other-user", 1, {
      user_id: OTHER,
      status: "sending",
      updated_at: ago(16 * MIN),
      sent_at: null,
    });
    seedApp("app-mine", 2, {
      status: "sending",
      updated_at: ago(16 * MIN),
      sent_at: null,
    });

    const reclaimed = await reclaimStaleSending(createAdminClient(), USER, CAMPAIGN);

    expect(reclaimed).toBe(1);
    expect(db.bew_applications.find((r) => r.id === "app-other-user")!.status).toBe("sending");
    expect(db.bew_applications.find((r) => r.id === "app-mine")!.status).toBe("needs_attention");
  });
});

/* ------------------------------------------------------------------ *
 * C3/C4. Action error contracts — no generic errors, no fake success
 * ------------------------------------------------------------------ */

describe("C3/C4 — server actions keep the stable-error contract", () => {
  it("bewUpdateLetter on a missing/stale id throws NOT_FOUND (never a fake success)", async () => {
    seedCampaign();
    await expect(bewUpdateLetter(fd("app-gone", { bodyHtml: "<p>x</p>" }))).rejects.toThrow(
      "NOT_FOUND",
    );
  });

  it("bewUpdateLetter on a real row returns the saved row", async () => {
    seedCampaign();
    seedApp("app-1", 1);
    const row = await bewUpdateLetter(fd("app-1", { subject: "Neu", bodyHtml: "<p>y</p>" }));
    expect(row.id).toBe("app-1");
    expect(row.subject).toBe("Neu");
  });

  it("bewRestoreApplication on a missing/stale id throws NOT_FOUND (was a fake {ok:true})", async () => {
    seedCampaign();
    await expect(bewRestoreApplication(fd("app-gone"))).rejects.toThrow("NOT_FOUND");
  });

  it("bewRestoreApplication restores an excluded row and reports it", async () => {
    seedCampaign();
    seedApp("app-1", 1, { status: "excluded" });
    const res = await bewRestoreApplication(fd("app-1"));
    expect(res).toEqual({ ok: true, restored: true });
    expect(db.bew_applications.find((r) => r.id === "app-1")!.status).toBe("generated");
  });

  it("an expired session propagates the redirect (it is never swallowed)", async () => {
    seedCampaign();
    seedApp("app-1", 1);
    authMock.mockResolvedValue({ user: null, profile: null });

    let thrown: unknown;
    try {
      await bewUpdateCompany(fd("app-1", { payload: JSON.stringify({
        companyName: "A",
        companyEmail: "a@a.de",
        contactName: null,
        companyAddress: null,
      }) }));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect(isNextRedirectError(thrown)).toBe(true);
  });

  it("an unexpected persistence failure becomes the fallback code, no internals", async () => {
    seedCampaign();
    seedApp("app-1", 1);
    db.failSelect = true; // lookup fails with a raw "500: select failed"

    let thrown: unknown;
    try {
      await bewUpdateCompany(fd("app-1", { payload: JSON.stringify({
        companyName: "A",
        companyEmail: "a@a.de",
        contactName: null,
        companyAddress: null,
      }) }));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    // The engine maps a lookup failure to the stable SAVE_FAILED code…
    expect((thrown as Error).message).toBe("SAVE_FAILED");
    // …and the raw provider text never crosses the boundary.
    expect((thrown as Error).message).not.toContain("500");
    expect((thrown as Error).message).not.toContain("select failed");
  });

  it("a raw insert failure in bewSaveCompanies degrades to SAVE_FAILED, not the provider text", async () => {
    const { bewSaveCompanies } = await import("@/app/bewerbung-automation/actions");
    seedCampaign();
    db.failInsert = true;

    let thrown: unknown;
    try {
      const f = new FormData();
      f.set("campaignId", CAMPAIGN);
      f.set("records", JSON.stringify([{ companyName: "A", companyEmail: "a@a.de" }]));
      await bewSaveCompanies(f);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("SAVE_FAILED");
  });
});

/* ------------------------------------------------------------------ *
 * C1/C2. Client error resolution (pure units)
 * ------------------------------------------------------------------ */

const t = (k: string) => translate(DEFAULT_LANGUAGE, k);

describe("C1 — bewErrorCode recovers the stable code (message or digest)", () => {
  it("reads the code from the message (the normal withStableError path)", () => {
    expect(bewErrorCode(new Error("DELETE_FAILED"))).toBe("DELETE_FAILED");
    expect(bewErrorCode(new Error("APPLICATION_LOCKED"))).toBe("APPLICATION_LOCKED");
  });

  it("falls back to the digest when the boundary re-wrapped the error", () => {
    const wrapped = new Error("An error occurred on the server.");
    (wrapped as Error & { digest?: string }).digest = "SAVE_FAILED";
    expect(bewErrorCode(wrapped)).toBe("SAVE_FAILED");
  });

  it("keeps the DOCUMENT_* prefix contract (message and digest)", () => {
    expect(bewErrorCode(new Error("DOCUMENT_TOO-LARGE"))).toBe("DOCUMENT_TOO-LARGE");
    const wrapped = new Error("boom");
    (wrapped as Error & { digest?: string }).digest = "DOCUMENT_EMPTY";
    expect(bewErrorCode(wrapped)).toBe("DOCUMENT_EMPTY");
  });

  it("reserves UNKNOWN for genuinely unmapped errors", () => {
    expect(bewErrorCode(new Error("something-else"))).toBe("UNKNOWN");
    expect(bewErrorCode("not an Error")).toBe("UNKNOWN");
    expect(bewErrorCode(null)).toBe("UNKNOWN");
  });
});

describe("C2 — resolveBewError: one resolution for the whole page", () => {
  it("an expired session navigates to /login and shows NOTHING", () => {
    const nav = vi.fn();
    const redirect = new Error("NEXT_REDIRECT");
    (redirect as Error & { digest?: string }).digest = "NEXT_REDIRECT;replace;/login;307;";
    expect(resolveBewError(redirect, t, (p) => nav(p))).toBeNull();
    expect(nav).toHaveBeenCalledTimes(1);
    expect(nav).toHaveBeenCalledWith("/login");
  });

  it("a stable code becomes its localized message (de reference)", () => {
    const msg = resolveBewError(new Error("NOT_FOUND"), t);
    expect(msg).toBe(t("bewauto.err.NOT_FOUND"));
    expect(msg).not.toBe(t("bewauto.err.UNKNOWN"));
  });

  it("a re-wrapped stable code still localizes (no silent UNKNOWN)", () => {
    const wrapped = new Error("An error occurred on the server.");
    (wrapped as Error & { digest?: string }).digest = "DUPLICATE_COMPANY";
    expect(resolveBewError(wrapped, t)).toBe(t("bewauto.err.DUPLICATE_COMPANY"));
  });

  it("an unmapped error gets the actionable UNKNOWN message", () => {
    expect(resolveBewError(new Error("weird"), t)).toBe(t("bewauto.err.UNKNOWN"));
  });

  it("without a navigate callback the redirect still returns null", () => {
    const redirect = new Error("NEXT_REDIRECT");
    (redirect as Error & { digest?: string }).digest = "NEXT_REDIRECT;replace;/login;307;";
    expect(resolveBewError(redirect, t)).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * A2 + UI. SSR assertions on the repaired states
 * ------------------------------------------------------------------ */

describe("UI states (SSR)", () => {
  it("a sent row shows `Sent`/`Gesendet`, not `Ready`/`Bereit` (the conflation from the screenshot)", () => {
    const de = renderToString(
      React.createElement(RowStatus, {
        app: { status: "sent", error_code: null },
        emailOk: true,
        nameOk: true,
        t,
      }),
    );
    expect(de).toContain(t("bewauto.rowSent"));
    expect(de).not.toContain(t("bewauto.rowReady"));

    const en = renderToString(
      React.createElement(RowStatus, {
        app: { status: "sent", error_code: null },
        emailOk: true,
        nameOk: true,
        t: (k: string) => translate("en", k),
      }),
    );
    expect(en).toContain(translate("en", "bewauto.rowSent"));
    expect(en).not.toContain(translate("en", "bewauto.rowReady"));
  });

  it("a generated row keeps the `Ready`/`Bereit` label", () => {
    const de = renderToString(
      React.createElement(RowStatus, {
        app: { status: "generated", error_code: null },
        emailOk: true,
        nameOk: true,
        t,
      }),
    );
    expect(de).toContain(t("bewauto.rowReady"));
    expect(de).not.toContain(t("bewauto.rowSent"));
  });

  it("the page error banner is dismissible (A2: no permanently pinned error)", () => {
    const withDismiss = renderToString(
      React.createElement(ErrorLine, {
        message: "msg",
        onDismiss: () => {},
        dismissLabel: t("bewauto.dismissError"),
      }),
    );
    expect(withDismiss).toContain(t("bewauto.dismissError"));

    const readOnly = renderToString(React.createElement(ErrorLine, { message: "msg" }));
    expect(readOnly).not.toContain(t("bewauto.dismissError"));
  });

  it("rowSent + dismissError exist in all four languages (localized states)", () => {
    for (const lang of ["de", "en", "fr", "ar"] as const) {
      const bew = (dictionaries[lang] as any).bewauto;
      expect(bew.rowSent, `rowSent missing in ${lang}`).toBeTruthy();
      expect(bew.dismissError, `dismissError missing in ${lang}`).toBeTruthy();
    }
  });
});
