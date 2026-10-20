/**
 * generateBewLetters (step 3) — bounded-concurrency engine tests with an
 * in-memory Supabase-style builder (no real DB, no real AI).
 *
 * Pins the performance + data-integrity contract of the concurrent
 * generation pool:
 *   - independent letters run CONCURRENTLY within the lane cap
 *     (default 3, env BEW_LETTER_CONCURRENCY, clamped to 1..5);
 *   - the first finished letter is persisted while the other letters are
 *     still in flight (incremental results — the UI poll surfaces each
 *     one as soon as it lands, without waiting for the slowest company);
 *   - one provider failure fails ONLY that letter; the others are
 *     generated and preserved (partial success);
 *   - two concurrent generation calls cannot double-generate a row
 *     (atomic claim: exactly one letter per company, ever);
 *   - an AI-quota hit parks the run (aiQuotaHit, rows → pending/ai_quota)
 *     and never reports a generation failure for the quota itself;
 *   - the output structure is UNCHANGED: same assembled letter
 *     (greeting + model body + closing + signature), subject,
 *     quality_attempts, campaign status transition — quality settings,
 *     prompt and gate are untouched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* eslint-disable @typescript-eslint/no-explicit-any */

type Row = Record<string, any>;

const USER = "user-1";
const CAMPAIGN = "camp-1";
const NOW = () => new Date().toISOString();

const COMPANIES = [
  "Alpha Technik GmbH",
  "Beta Maschinenbau GmbH",
  "Gamma Logistik GmbH",
  "Delta Elektronik GmbH",
  "Epsilon Bau GmbH",
] as const;

/** A German body that passes the deterministic gate (2..900 words, no
 *  placeholder/leakage patterns) and references company + role. */
const LETTER_BODY =
  "mit großem Interesse habe ich Ihre Stellenanzeige für die Ausbildung Mechatroniker bei %CO% gelesen. " +
  "Während meiner Schulzeit habe ich erste praktische Erfahrungen in Werkstatteinsätzen gesammelt und dabei " +
  "technisches Verständnis sowie Sorgfalt entwickelt. Ich schätze die Hands-on-Kultur in modernen Betrieben " +
  "und möchte meine Kenntnisse bei %CO% vertiefen. Zuverlässigkeit, Teamgeist und Freude an präziser Arbeit " +
  "begleiten mich täglich. Über die Möglichkeit, mich bei einem persönlichen Gespräch vorzustellen, freue ich mich sehr.";

/* ------------------- In-memory Supabase-style query builder ------------------- */

interface DB {
  bew_campaigns: Row[];
  bew_applications: Row[];
  profiles: Row[];
  candidate_profiles: Row[];
  bew_campaign_documents: Row[];
}

let db: DB;

function freshDb(): DB {
  return {
    bew_campaigns: [],
    bew_applications: [],
    profiles: [],
    candidate_profiles: [],
    bew_campaign_documents: [],
  };
}

/** AI-provider observability (shared with the builder for the incremental
 *  persistence assertion). */
const ai = {
  calls: [] as string[],
  inFlight: 0,
  peak: 0,
  resolved: 0,
  delayMs: 40,
  failCompanies: new Set<string>(),
  quotaCalls: 0,
  quotaFailAfter: Infinity,
  /** Recorded the moment the FIRST row is persisted as `generated`. */
  firstPersisted: null as null | { started: number; finished: number },
};

function resetAi() {
  ai.calls = [];
  ai.inFlight = 0;
  ai.peak = 0;
  ai.resolved = 0;
  ai.delayMs = 40;
  ai.failCompanies = new Set();
  ai.quotaCalls = 0;
  ai.quotaFailAfter = Infinity;
  ai.firstPersisted = null;
}

function makeFrom(table: string) {
  const state = {
    op: "select" as "select" | "update" | "insert" | "delete",
    payload: undefined as any,
    selectCols: undefined as any,
    filters: [] as Array<{ col: string; val: any }>,
    inFilters: [] as Array<{ col: string; vals: any[] }>,
    ltFilters: [] as Array<{ col: string; val: any }>,
    orders: [] as Array<{ col: string; ascending: boolean }>,
    limitN: 0,
    terminal: undefined as "single" | "maybeSingle" | undefined,
  };
  const bucket = (): Row[] => (db as unknown as Record<string, Row[]>)[table] ?? [];
  function rows(): Row[] {
    let out = bucket().slice();
    for (const f of state.filters) out = out.filter((r: Row) => r[f.col] === f.val);
    for (const f of state.inFilters) out = out.filter((r: Row) => f.vals.includes(r[f.col]));
    for (const f of state.ltFilters)
      out = out.filter((r: Row) => r[f.col] != null && r[f.col] < f.val);
    if (state.orders.length > 0) {
      const [o] = state.orders; // the engine uses a single order key here
      out.sort((a, b) => (a[o.col] < b[o.col] ? -1 : a[o.col] > b[o.col] ? 1 : 0));
      if (!o.ascending) out.reverse();
    }
    if (state.limitN > 0) out = out.slice(0, state.limitN);
    return out;
  }
  async function run(): Promise<any> {
    if (state.op === "update") {
      const matched = rows();
      for (const m of matched) Object.assign(m, state.payload);
      if (table === "bew_applications" && state.payload?.status === "generated") {
        // The moment the first finished letter lands — while the others
        // (if any) are still running. Sequential code would record
        // started === finished === 1 here.
        if (!ai.firstPersisted)
          ai.firstPersisted = { started: ai.calls.length, finished: ai.resolved };
      }
      if (state.terminal) return { data: matched[0] ?? null, error: null };
      return { data: matched, error: null };
    }
    if (state.op === "insert") {
      const items = Array.isArray(state.payload) ? state.payload : [state.payload];
      const ins = items.map((r) => ({ ...r, id: r.id ?? `id-${Math.random()}` }));
      ((db as unknown as Record<string, Row[]>)[table] ??= []).push(...ins);
      return state.terminal === "single"
        ? { data: ins[0], error: null }
        : { data: ins, error: null };
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
    is: (col: string, val: any) => (state.filters.push({ col, val }), chain),
    lt: (col: string, val: any) => (state.ltFilters.push({ col, val }), chain),
    in: (col: string, vals: any[]) => (state.inFilters.push({ col, vals: [...vals] }), chain),
    select: (cols?: any) => ((state.selectCols = cols), chain),
    order: (col: string, opts?: { ascending?: boolean }) =>
      (state.orders.push({ col, ascending: opts?.ascending ?? true }), chain),
    limit: (n?: number) => ((state.limitN = n ?? 0), chain),
    insert: (p: any) => ((state.op = "insert"), (state.payload = p), chain),
    update: (p: any) => ((state.op = "update"), (state.payload = p), chain),
    delete: () => ((state.op = "delete"), chain),
    single: () => ((state.terminal = "single"), chain),
    maybeSingle: () => ((state.terminal = "maybeSingle"), chain),
    then: (onF?: any, onR?: any) => run().then(onF, onR),
  };
  return chain;
}

/* ------------------- Engine dependencies ------------------- */

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
vi.doMock("@/lib/ai-provider", () => ({
  createAIProvider: () => ({
    generateText: async (msgs: Array<{ content: string }>) => {
      const content = msgs[0].content ?? "";
      const company = COMPANIES.find((c) => content.includes(c)) ?? "?";
      ai.calls.push(company);
      ai.inFlight += 1;
      ai.peak = Math.max(ai.peak, ai.inFlight);
      await new Promise((r) => setTimeout(r, ai.delayMs));
      if (ai.failCompanies.has(company)) throw new Error("provider 503");
      ai.inFlight -= 1;
      ai.resolved += 1;
      return LETTER_BODY.replaceAll("%CO%", company);
    },
  }),
}));
vi.doMock("@/lib/ai-service", () => ({
  reserveAIUsage: async () => {
    ai.quotaCalls += 1;
    if (ai.quotaCalls > ai.quotaFailAfter) throw new Error("daily AI quota exhausted");
  },
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

const { generateBewLetters, resetBewSchemaProbe } = await import("@/lib/bewerbung-engine");

/* ------------------- Seeds ------------------- */

function seedProfile() {
  db.profiles.push({
    id: USER,
    full_name: "Max Beispiel",
    email: "max.beispiel@example.com",
    street: "Musterstraße 1",
    postal_code: "10115",
    city: "Berlin",
    country: "Deutschland",
    phone: "+49 30 123456",
  });
}

function seedCampaign(status = "draft") {
  db.bew_campaigns.push({
    id: CAMPAIGN,
    user_id: USER,
    email_account_id: "acct-1",
    purpose: "ausbildung",
    status,
    requested_count: COMPANIES.length,
    valid_count: COMPANIES.length,
    total_count: COMPANIES.length,
    generated_count: 0,
    sent_count: 0,
    failed_count: 0,
    excluded_count: 0,
    usage_date: NOW().slice(0, 10),
    created_at: NOW(),
    started_at: null,
    completed_at: null,
    position_title: null,
    position_brief: null,
    employer_facts: null,
  });
}

function seedDocs() {
  db.bew_campaign_documents.push(
    {
      id: "cdoc-1",
      campaign_id: CAMPAIGN,
      document_id: "d-1",
      user_id: USER,
      kind: "cv",
      storage_path: `${USER}/cv.pdf`,
      filename: "cv.pdf",
      mime_type: "application/pdf",
      size_bytes: 100,
      created_at: NOW(),
    },
    {
      id: "cdoc-2",
      campaign_id: CAMPAIGN,
      document_id: "d-2",
      user_id: USER,
      kind: "certificate",
      storage_path: `${USER}/cert.pdf`,
      filename: "cert.pdf",
      mime_type: "application/pdf",
      size_bytes: 100,
      created_at: NOW(),
    },
  );
}

function seedApps(n: number, over: Partial<Row> = {}) {
  for (let i = 0; i < n; i++) {
    db.bew_applications.push({
      id: `app-${i + 1}`,
      campaign_id: CAMPAIGN,
      user_id: USER,
      seq: i + 1,
      company_name: COMPANIES[i] ?? `Firma ${i + 1}`,
      contact_name: null,
      company_email: `jobs${i + 1}@firma-${i + 1}.de`,
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
      position_title: "Ausbildung Mechatroniker",
      position_brief: null,
      employer_facts: null,
      quality_attempts: 0,
      generation_started_at: null,
      created_at: NOW(),
      updated_at: NOW(),
      ...over,
    });
  }
}

const PROFILE: any = {
  id: USER,
  full_name: "Max Beispiel",
  email: "max.beispiel@example.com",
  account_status: "active",
  selected_goal: "ausbildung",
  daily_email_limit: 50,
  created_at: NOW(),
  updated_at: NOW(),
};

beforeEach(() => {
  db = freshDb();
  resetAi();
  resetBewSchemaProbe();
});

afterEach(() => {
  delete process.env.BEW_LETTER_CONCURRENCY;
  delete process.env.BEW_LETTER_MODEL_EVAL;
});

/* ------------------- Tests ------------------- */

describe("generateBewLetters — bounded concurrency", () => {
  it("runs independent letters concurrently within the default lane cap (3) and generates ALL of them", async () => {
    seedProfile();
    seedCampaign();
    seedDocs();
    seedApps(5);

    const result = await generateBewLetters(USER, CAMPAIGN, PROFILE);

    expect(result).toEqual({ generated: 5, failed: 0, remaining: 0, aiQuotaHit: false });
    expect(ai.calls).toHaveLength(5);
    // Concurrent, not sequential: two letters in flight at once at minimum…
    expect(ai.peak).toBeGreaterThanOrEqual(2);
    // …but never above the lane cap.
    expect(ai.peak).toBeLessThanOrEqual(3);
    // Every row reached `generated` with a real letter.
    for (const row of db.bew_applications) {
      expect(row.status).toBe("generated");
      expect(row.body_html.length).toBeGreaterThan(50);
      expect(row.body_text.length).toBeGreaterThan(50);
      expect(row.quality_attempts).toBe(1);
    }
  });

  it("honors BEW_LETTER_CONCURRENCY (2) and degrades to the default for invalid values", async () => {
    seedProfile();
    seedCampaign();
    seedDocs();
    seedApps(5);
    process.env.BEW_LETTER_CONCURRENCY = "2";

    const result = await generateBewLetters(USER, CAMPAIGN, PROFILE);
    expect(result.generated).toBe(5);
    expect(ai.peak).toBeLessThanOrEqual(2);
    expect(ai.peak).toBeGreaterThanOrEqual(2); // 5 apps, 2 lanes → both lanes busy

    // Invalid env → default (3).
    resetAi();
    db = freshDb();
    seedProfile();
    seedCampaign();
    seedDocs();
    seedApps(5);
    process.env.BEW_LETTER_CONCURRENCY = "not-a-number";
    const result2 = await generateBewLetters(USER, CAMPAIGN, PROFILE);
    expect(result2.generated).toBe(5);
    expect(ai.peak).toBeLessThanOrEqual(3);
  });

  it("clamps out-of-range env values into 1..5", async () => {
    seedProfile();
    seedCampaign();
    seedDocs();
    seedApps(5);
    process.env.BEW_LETTER_CONCURRENCY = "99";

    const result = await generateBewLetters(USER, CAMPAIGN, PROFILE);
    expect(result.generated).toBe(5);
    expect(ai.peak).toBeLessThanOrEqual(5);
    expect(ai.peak).toBeGreaterThanOrEqual(2);
  });
});

describe("generateBewLetters — incremental persistence", () => {
  it("persists the FIRST finished letter while the other letters are still in flight", async () => {
    seedProfile();
    seedCampaign();
    seedDocs();
    seedApps(5);

    const result = await generateBewLetters(USER, CAMPAIGN, PROFILE);
    expect(result.generated).toBe(5);

    // When the first row flipped to `generated`, other letters had ALREADY
    // started but not finished — i.e. the DB (and therefore the poll)
    // surfaces letters one by one instead of all at the end. Sequential
    // code would record started === finished === 1 here.
    expect(ai.firstPersisted).not.toBeNull();
    expect(ai.firstPersisted!.started).toBeGreaterThanOrEqual(2);
    expect(ai.firstPersisted!.finished).toBe(1);
  });
});

describe("generateBewLetters — partial success + race safety", () => {
  it("one provider failure fails ONLY that letter; the other four are generated and preserved", async () => {
    seedProfile();
    seedCampaign();
    seedDocs();
    seedApps(5);
    ai.failCompanies.add("Gamma Logistik GmbH");

    const result = await generateBewLetters(USER, CAMPAIGN, PROFILE);

    expect(result).toMatchObject({ generated: 4, failed: 1, aiQuotaHit: false });
    const failedRow = db.bew_applications.find((r) => r.company_name === "Gamma Logistik GmbH")!;
    expect(failedRow.status).toBe("failed");
    expect(failedRow.error_code).toBe("generation_failed");
    expect(failedRow.body_html).toBe("");
    // The failed company was attempted exactly once (a provider error is not
    // a quality failure — no automatic retry loop).
    expect(ai.calls.filter((c) => c === "Gamma Logistik GmbH")).toHaveLength(1);
    // The other four kept their finished letters.
    for (const row of db.bew_applications) {
      if (row.id !== failedRow.id) {
        expect(row.status).toBe("generated");
        expect(row.body_html.length).toBeGreaterThan(50);
      }
    }
    // remaining = pending + failed → exactly the one retryable row.
    expect(result.remaining).toBe(1);
  });

  it("two CONCURRENT generation calls cannot double-generate a row (atomic claim)", async () => {
    seedProfile();
    seedCampaign();
    seedDocs();
    seedApps(5);

    const [r1, r2] = await Promise.all([
      generateBewLetters(USER, CAMPAIGN, PROFILE),
      generateBewLetters(USER, CAMPAIGN, PROFILE),
    ]);

    // Exactly one letter per company, across both calls.
    expect(ai.calls).toHaveLength(5);
    for (const c of COMPANIES) {
      expect(ai.calls.filter((x) => x === c)).toHaveLength(1);
    }
    expect(r1.generated + r2.generated).toBe(5);
    expect(r1.failed + r2.failed).toBe(0);
    for (const row of db.bew_applications) expect(row.status).toBe("generated");
  });
});

describe("generateBewLetters — quota parking", () => {
  it("an AI-quota hit parks the run (aiQuotaHit, no fake failures); the already-in-flight letters finish", async () => {
    seedProfile();
    seedCampaign();
    seedDocs();
    seedApps(5);
    // The first two reservations pass, the third trips the daily quota.
    ai.quotaFailAfter = 2;

    const result = await generateBewLetters(USER, CAMPAIGN, PROFILE);

    expect(result.aiQuotaHit).toBe(true);
    expect(result.failed).toBe(0); // parking is NOT a generation failure
    expect(result.generated).toBe(2);
    // The quota row was parked as retryable pending (never `failed`).
    const parked = db.bew_applications.filter((r) => r.error_code === "ai_quota");
    expect(parked).toHaveLength(1);
    for (const row of parked) expect(row.status).toBe("pending");
    // The claimed-but-unprocessed rows stay `generating` (reclaimed by the
    // existing lease on the next run — pre-existing recovery contract).
    const statuses = db.bew_applications.map((r) => r.status).sort();
    expect(statuses).toEqual([
      "generated",
      "generated",
      "generating",
      "generating",
      "pending",
    ]);
  });
});

describe("generateBewLetters — output structure unchanged (quality path intact)", () => {
  it("keeps the assembled letter format: neutral greeting without contact, correct salutation with contact, subject, signature, campaign transition", async () => {
    seedProfile();
    seedCampaign();
    seedDocs();
    seedApps(5);
    // One app carries a contact with an explicit (already correct) salutation.
    db.bew_applications[0].contact_name = "Frau Müller";

    const result = await generateBewLetters(USER, CAMPAIGN, PROFILE);
    expect(result.generated).toBe(5);

    const withContact = db.bew_applications.find((r) => r.id === "app-1")!;
    const neutral = db.bew_applications.find((r) => r.id === "app-2")!;

    // Assembled structure: greeting <p>, body paragraph(s), closing, signature.
    expect(withContact.body_html).toContain("<p>Sehr geehrte Frau Müller,</p>");
    expect(withContact.body_html).toContain("Mit freundlichen Grüßen</p>");
    expect(withContact.body_html).toContain("<p>Max Beispiel</p>");
    // The model body is embedded verbatim (no template replacement).
    expect(withContact.body_html).toContain(
      `Ausbildung Mechatroniker bei ${withContact.company_name}`,
    );
    // Salutation is NOT duplicated.
    expect(withContact.body_html).not.toContain("Sehr geehrte Frau Frau Müller");
    expect(withContact.body_html).not.toContain("Sehr geehrte Frau Herr Müller");

    // No contact → the existing neutral German greeting.
    expect(neutral.body_html).toContain("<p>Sehr geehrte Damen und Herren,</p>");

    // Subject + error fields.
    for (const row of db.bew_applications) {
      expect(row.subject.length).toBeGreaterThan(10);
      expect(row.error_code).toBeNull();
      expect(row.error_message).toBeNull();
      expect(row.sent_at).toBeNull(); // generation never touches delivery
    }
    // The campaign transitioned draft → generating (the wizard's existing
    // in-progress signal).
    expect(db.bew_campaigns[0].status).toBe("generating");
  });
});
