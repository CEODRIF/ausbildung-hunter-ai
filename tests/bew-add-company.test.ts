/**
 * addBewCompany (smart-input "Auto-organize") — engine integration tests with
 * an in-memory Supabase-style builder (no real DB, no real e-mail).
 *
 * Pins the data-integrity contract:
 *   - ONE new row at seq = max(seq)+1, all existing rows byte-identical
 *     (no delete, no update, no letter reset);
 *   - the FULL extracted job description is persisted (never truncated);
 *   - stable error codes for every failure mode (never a generic error);
 *   - duplicate e-mails (active rows) are rejected, excluded rows may be
 *     re-added; the 100-row cap holds;
 *   - the position-brief schema probe degrades gracefully (no position keys).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/* eslint-disable @typescript-eslint/no-explicit-any */

type Row = Record<string, any>;

interface DB {
  bew_campaigns: Row[];
  bew_applications: Row[];
  positionColumnsBroken: boolean;
  /** Records every delete issued on bew_applications (must stay empty). */
  appDeletes: number;
}

const USER = "user-1";
const OTHER = "user-2";
const CAMPAIGN = "camp-1";
const NOW = () => new Date().toISOString();

function freshDb(): DB {
  return {
    bew_campaigns: [],
    bew_applications: [],
    positionColumnsBroken: false,
    appDeletes: 0,
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
    if (state.op === "insert") {
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
      if (table === "bew_applications") db.appDeletes += rows().length;
      const matched = new Set(rows());
      const rec = db as unknown as Record<string, Row[]>;
      rec[table] = (rec[table] ?? []).filter((r: Row) => !matched.has(r));
      return { data: null, error: null };
    }
    // select — simulate the pending 20261115000000 migration state.
    if (
      db.positionColumnsBroken &&
      table === "bew_campaigns" &&
      state.selectCols === "position_title"
    ) {
      return { data: null, error: { message: "42703: column does not exist" } };
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
    then: (onF?: any, onR?: any) => run().then(onF, onR),
  };
  return chain;
}

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

const { addBewCompany, resetBewPositionColumnsProbe } = await import(
  "@/lib/bewerbung-engine"
);

/* ------------------- Seeds ------------------- */

function seedCampaign(status = "draft") {
  db.bew_campaigns.push({
    id: CAMPAIGN,
    user_id: USER,
    email_account_id: "acct-1",
    purpose: "ausbildung",
    status,
    requested_count: 3,
    valid_count: 1,
    total_count: 3,
    generated_count: 1,
    sent_count: 0,
    failed_count: 0,
    excluded_count: 1,
    usage_date: NOW().slice(0, 10),
    created_at: NOW(),
    started_at: null,
    completed_at: null,
  });
}

function seedApp(seq: number, over: Partial<Row> = {}) {
  db.bew_applications.push({
    id: `app-${seq}`,
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
    created_at: NOW(),
    updated_at: NOW(),
    ...over,
  });
}

/** The complete Kälte- und Klimatechnik ad (same shape as the parser tests). */
const KAELTE_AD = [
  "Informationen zur Bewerbung",
  "Amberger Kühltechnik GmbH",
  "Frau Stefanie Bernklau",
  "Dr.-Aigner-Str. 15",
  "92224 Amberg, Oberpfalz",
  "Telefon: +49 9621 472983",
  "E-Mail: bernklaustefanie@amberger-kuehltechnik.de",
  "",
  "Ausbildung: Mechatroniker/in - Kältetechnik",
  "Beschreibung: Als Mechatroniker für Kältetechnik planst, montierst und wartest du Anlagen der Kälte- und Klimatechnik. Du sorgst dafür, dass die Kälteanlagen beim Kunden einwandfrei funktionieren.",
].join("\n");

async function expectCode(fn: () => Promise<unknown>, code: string) {
  await expect(fn()).rejects.toThrow(code);
}

beforeEach(() => {
  db = freshDb();
  resetBewPositionColumnsProbe();
});

/* ------------------- Happy path ------------------- */

describe("addBewCompany — happy path", () => {
  it("appends ONE row at maxSeq+1 with the extracted fields, full brief intact", async () => {
    seedCampaign();
    seedApp(1, {
      company_name: "Alpha GmbH",
      company_email: "jobs@alpha.de",
      status: "generated",
      body_html: "<p>Letter A</p>",
      subject: "Bewerbung um einen Ausbildungsplatz bei Alpha GmbH",
    });
    seedApp(2); // empty pending row
    seedApp(5, { company_name: "Old GmbH", company_email: "old@old.de", status: "excluded" });

    const row = await addBewCompany(USER, CAMPAIGN, KAELTE_AD);

    // New row: next seq after the gap (max seq 5 → 6).
    expect(row.seq).toBe(6);
    expect(row.company_name).toBe("Amberger Kühltechnik GmbH");
    expect(row.company_email).toBe("bernklaustefanie@amberger-kuehltechnik.de");
    expect(row.contact_name).toBe("Frau Stefanie Bernklau");
    expect(row.company_address).toBe("Dr.-Aigner-Str. 15, 92224 Amberg, Oberpfalz");
    expect(row.subject).toBe(
      "Bewerbung um einen Ausbildungsplatz bei Amberger Kühltechnik GmbH",
    );
    expect(row.status).toBe("pending");
    expect(row.position_title).toBe("Mechatroniker/in - Kältetechnik");
    // The FULL description, verbatim (title not mixed in, nothing truncated).
    expect(row.position_brief).toBe(
      "Als Mechatroniker für Kältetechnik planst, montierst und wartest du Anlagen der Kälte- und Klimatechnik. Du sorgst dafür, dass die Kälteanlagen beim Kunden einwandfrei funktionieren.",
    );
    // Verified employer facts are never auto-filled.
    expect(row.employer_facts).toBeNull();

    // Exactly one row added; nothing deleted.
    expect(db.bew_applications).toHaveLength(4);
    expect(db.appDeletes).toBe(0);
  });

  it("leaves PREVIOUS rows byte-identical (incl. a generated letter)", async () => {
    seedCampaign();
    seedApp(1, {
      id: "app-A",
      company_name: "Alpha GmbH",
      company_email: "jobs@alpha.de",
      status: "generated",
      body_html: "<p>Letter A</p>",
      body_text: "Letter A",
    });
    const before = JSON.stringify(db.bew_applications.slice());

    await addBewCompany(USER, CAMPAIGN, KAELTE_AD);

    // One extra row (the new one); the original row is byte-identical.
    expect(db.bew_applications).toHaveLength(2);
    const original = db.bew_applications.find((r) => r.id === "app-A");
    expect(JSON.stringify(original)).toBe(JSON.stringify(JSON.parse(before)[0]));
    expect(original?.body_html).toBe("<p>Letter A</p>");
    expect(original?.status).toBe("generated");
  });

  it("refreshes the campaign counters after the append", async () => {
    seedCampaign();
    seedApp(1, {
      company_name: "Alpha GmbH",
      company_email: "jobs@alpha.de",
      status: "generated",
    });
    seedApp(2);
    seedApp(3, { company_name: "Old GmbH", company_email: "old@old.de", status: "excluded" });

    await addBewCompany(USER, CAMPAIGN, KAELTE_AD);

    const campaign = db.bew_campaigns[0];
    expect(campaign.total_count).toBe(4);
    // valid = rows with name + valid e-mail, excluding excluded/cancelled:
    // Alpha (valid) + new (valid); empty row and excluded row don't count.
    expect(campaign.valid_count).toBe(2);
  });

  it("adds two SEQUENTIAL ads as two independent rows (test 9)", async () => {
    seedCampaign();
    seedApp(1);

    const adB =
      "Beta Kältebau GmbH\ninfo@beta-kaeltebau.de\nBeschreibung: Wir bauen Kühlanlagen für Supermärkte und betreuen sie vor Ort.";
    const first = await addBewCompany(USER, CAMPAIGN, KAELTE_AD);
    const second = await addBewCompany(USER, CAMPAIGN, adB);

    expect(first.seq).toBe(2);
    expect(second.seq).toBe(3);
    expect(first.id).not.toBe(second.id);
    expect(second.company_name).toBe("Beta Kältebau GmbH");
    expect(second.company_email).toBe("info@beta-kaeltebau.de");
    // Row 1 is untouched by the second add.
    expect(db.bew_applications.find((r) => r.id === first.id)?.company_name).toBe(
      "Amberger Kühltechnik GmbH",
    );
  });
});

/* ------------------- Duplicates & limits ------------------- */

describe("addBewCompany — duplicates, caps, gates", () => {
  it("rejects a DUPLICATE e-mail on an active row (no new row)", async () => {
    seedCampaign();
    seedApp(1, { company_name: "Alpha GmbH", company_email: "jobs@alpha.de" });

    await expectCode(
      () => addBewCompany(USER, CAMPAIGN, "Beta GmbH\nJobs@Alpha.DE"),
      "DUPLICATE_COMPANY",
    );
    expect(db.bew_applications).toHaveLength(1);
  });

  it("allows re-adding an e-mail whose only previous row is EXCLUDED", async () => {
    seedCampaign();
    seedApp(1, {
      company_name: "Old GmbH",
      company_email: "old@old.de",
      status: "excluded",
    });

    const row = await addBewCompany(USER, CAMPAIGN, "Old GmbH\nold@old.de");
    expect(row.seq).toBe(2);
    expect(row.status).toBe("pending");
  });

  it("rejects beyond the 100-row cap (COUNT_EXCEEDED)", async () => {
    seedCampaign();
    for (let i = 1; i <= 100; i++) {
      seedApp(i, { company_name: `C${i} GmbH`, company_email: `c${i}@c.de` });
    }
    await expectCode(
      () => addBewCompany(USER, CAMPAIGN, "New GmbH\nnew@new.de"),
      "COUNT_EXCEEDED",
    );
    expect(db.bew_applications).toHaveLength(100);
  });

  it("rejects terminal campaigns (CAMPAIGN_CLOSED)", async () => {
    for (const status of ["completed", "partially_failed", "cancelled"]) {
      db = freshDb();
      resetBewPositionColumnsProbe();
      seedCampaign(status);
      await expectCode(
        () => addBewCompany(USER, CAMPAIGN, KAELTE_AD),
        "CAMPAIGN_CLOSED",
      );
    }
  });

  it("rejects while a send is in flight (CAMPAIGN_SENDING)", async () => {
    seedCampaign("sending");
    await expectCode(
      () => addBewCompany(USER, CAMPAIGN, KAELTE_AD),
      "CAMPAIGN_SENDING",
    );
  });

  it("rejects a foreign / unknown campaign (NOT_FOUND)", async () => {
    seedCampaign();
    await expectCode(() => addBewCompany(OTHER, CAMPAIGN, KAELTE_AD), "NOT_FOUND");
    await expectCode(
      () => addBewCompany(USER, "camp-missing", KAELTE_AD),
      "NOT_FOUND",
    );
  });

  it("rejects empty and oversized payloads (INVALID_PAYLOAD)", async () => {
    seedCampaign();
    await expectCode(() => addBewCompany(USER, CAMPAIGN, "   "), "INVALID_PAYLOAD");
    await expectCode(
      () => addBewCompany(USER, CAMPAIGN, "A".repeat(20_001)),
      "INVALID_PAYLOAD",
    );
  });

  it("maps parse failures to their stable codes", async () => {
    seedCampaign();
    await expectCode(
      () => addBewCompany(USER, CAMPAIGN, "jobs@nowhere.de"),
      "PARSE_NO_COMPANY",
    );
    await expectCode(
      () => addBewCompany(USER, CAMPAIGN, "NoMail GmbH\nKein Kontakt."),
      "PARSE_NO_EMAIL",
    );
    await expectCode(
      () => addBewCompany(USER, CAMPAIGN, "Bad GmbH\nE-Mail: info@bad"),
      "PARSE_INVALID_EMAIL",
    );
    await expectCode(
      () =>
        addBewCompany(
          USER,
          CAMPAIGN,
          `Big GmbH\nbig@big.de\nBeschreibung: ${"x".repeat(4001)}`,
        ),
      "POSITION_TOO_LONG",
    );
    expect(db.bew_applications).toHaveLength(0);
  });
});

/* ------------------- Schema-probe degradation ------------------- */

describe("addBewCompany — position-brief probe", () => {
  it("inserts WITHOUT the position columns when the migration is pending", async () => {
    seedCampaign();
    seedApp(1);
    // Simulate a DB where 20261115000000 has not been applied.
    await addBewCompany(USER, CAMPAIGN, KAELTE_AD); // warms the probe (true)
    resetBewPositionColumnsProbe();
    db.positionColumnsBroken = true;

    const row = await addBewCompany(USER, CAMPAIGN, "Beta GmbH\ninfo@beta.de");
    expect("position_title" in row).toBe(false);
    expect("position_brief" in row).toBe(false);
    expect("employer_facts" in row).toBe(false);
    expect(row.company_name).toBe("Beta GmbH");
  });
});
