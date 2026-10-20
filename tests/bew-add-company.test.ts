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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* eslint-disable @typescript-eslint/no-explicit-any */

type Row = Record<string, any>;

interface DB {
  bew_campaigns: Row[];
  bew_applications: Row[];
  positionColumnsBroken: boolean;
  /** Simulates the pending 20261117000000 migration (no smart columns). */
  smartColumnsBroken: boolean;
  /** Simulates the pending 20261121000000 migration (no ad-date columns). */
  dateColumnsBroken: boolean;
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
    smartColumnsBroken: false,
    dateColumnsBroken: false,
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
    // select — simulate the pending 20261117000000 migration state.
    if (
      db.smartColumnsBroken &&
      table === "bew_applications" &&
      state.selectCols === "company_phone"
    ) {
      return { data: null, error: { message: "42703: column does not exist" } };
    }
    // select — simulate the pending 20261121000000 migration state.
    if (
      db.dateColumnsBroken &&
      table === "bew_applications" &&
      state.selectCols === "start_date"
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

const {
  addBewCompany,
  checkBewSmartInput,
  resetBewPositionColumnsProbe,
  resetBewSmartColumnsProbe,
  resetBewAdDateColumnsProbe,
} = await import("@/lib/bewerbung-engine");

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
  resetBewSmartColumnsProbe();
  resetBewAdDateColumnsProbe();
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

  it("ACCEPTS terminal campaigns (series state is decoupled from company entry)", async () => {
    // The old contract rejected these (CAMPAIGN_CLOSED); now a new company
    // can be appended to any owned series — a terminal one is reopened and
    // the counter re-derives the active state from the rows.
    for (const status of ["completed", "partially_failed", "cancelled"]) {
      db = freshDb();
      resetBewPositionColumnsProbe();
      seedCampaign(status);
      const row = await addBewCompany(USER, CAMPAIGN, KAELTE_AD);
      expect(row.seq, status).toBe(1);
      expect(row.status, status).toBe("pending");
      expect(db.bew_campaigns[0].status, status).toBe("generating"); // reopened
      expect(db.bew_campaigns[0].total_count, status).toBe(1);
    }
  });

  it("ACCEPTS a campaign while a send is in flight (row stays pending, send untouched)", async () => {
    seedCampaign("sending");
    seedApp(1, { company_name: "Alpha GmbH", company_email: "jobs@alpha.de", status: "queued" });
    const row = await addBewCompany(USER, CAMPAIGN, KAELTE_AD);
    expect(row.seq).toBe(2);
    expect(row.status).toBe("pending"); // not claimed by the in-flight batch
    expect(db.bew_campaigns[0].status).toBe("sending"); // in-flight state preserved
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

/* ------------------- Regression: the real Seco Kältetechnik ad ------------------- */

// Keep in sync with SECO_FULL_AD in tests/bew-ad-parser.test.ts — the exact
// advertisement that triggered the reported bug (prefix on the company,
// contact/address "not found", navigation text inside the description).
const SECO_AD = [
  "Mechatroniker:in Kältetechnik (m/w/d)",
  "",
  "Unternehmensdarstellung: Seco Kältetechnik GmbH",
  "",
  "Stellenbeschreibung",
  "Seco Kältetechnik sucht engagierte Auszubildende für das Handwerk der Kälte- und Klimatechnik.",
  "Du montierst, wartest und reparierst Kälteanlagen bei Kunden und im Außendienst.",
  "",
  "Wir bieten",
  "Rabatte für Mitarbeitende",
  "Weiterbildungen",
  "Betriebliche Altersvorsorge",
  "Dienstwagen",
  "Parkmöglichkeiten",
  "Gute Verkehrsanbindung",
  "Moderne technische Ausstattung",
  "Die aufgeführten Vorteile für Mitarbeitende können je nach Abteilung und Position variieren.",
  "Alle Stellen anzeigen in neuem Tab öffnen",
  "Webseiten",
  "Webpage",
  "Homepage",
  "Social Media Seiten",
  "",
  "Kontaktadresse",
  "Seco Kältetechnik GmbH",
  "Frau Christina Brandenburg – Personalreferentin",
  "Herzogstr. 28",
  "44807 Bochum",
  "",
  "Telefon: +49 234 90437014",
  "E-Mail: christina.brandenburg@secokaelte.de",
].join("\n");

describe("addBewCompany — Seco Kältetechnik real ad (regression, MOCKED DB)", () => {
  it("persists exactly ONE new row with the clean fields (no prefix, contact, combined address, exact e-mail)", async () => {
    seedCampaign();

    const row = await addBewCompany(USER, CAMPAIGN, SECO_AD);

    // Exactly one row created, nothing deleted.
    expect(db.bew_applications).toHaveLength(1);
    expect(db.appDeletes).toBe(0);
    // The persisted values (the server re-parse is the source of truth):
    expect(row.company_name).toBe("Seco Kältetechnik GmbH"); // NO "Unternehmensdarstellung:" prefix
    expect(row.company_email).toBe("christina.brandenburg@secokaelte.de");
    expect(row.contact_name).toBe("Frau Christina Brandenburg – Personalreferentin");
    expect(row.company_address).toBe("Herzogstr. 28, 44807 Bochum");
    expect(row.status).toBe("pending");
    expect(row.employer_facts).toBeNull(); // never auto-filled
    // The meaningful description (tasks + benefits) is preserved…
    expect(row.position_brief).toContain("Rabatte für Mitarbeitende");
    expect(row.position_brief).toContain("Betriebliche Altersvorsorge");
    // …portal navigation and the contact block are NOT description text.
    expect(row.position_brief).not.toContain("Alle Stellen anzeigen");
    expect(row.position_brief).not.toContain("Kontaktadresse");
    expect(row.position_brief).not.toContain("christina.brandenburg@secokaelte.de");
  });

  it("a valid e-mail that is only SUGGESTED (unverified) is persisted — not auto-rejected", async () => {
    seedCampaign();
    const text = [
      "Seco Kältetechnik GmbH",
      "Beschreibung: Wir suchen Verstärkung im Außendienst für die Wartung von Kälteanlagen.",
      "Bewerbung per Mail an christina.brandenburg@secokaelte.de",
    ].join("\n");

    const row = await addBewCompany(USER, CAMPAIGN, text);

    expect(row.company_email).toBe("christina.brandenburg@secokaelte.de");
    expect(db.bew_applications).toHaveLength(1);
  });
});

/* ------------------- Regression: company entry is decoupled from the series state ------------------- */

describe("addBewCompany — series state is NOT a prerequisite (regression, MOCKED DB)", () => {
  it("COMPLETED series: a new company is appended at the BOTTOM, history untouched, series reopened", async () => {
    seedCampaign("completed");
    db.bew_campaigns[0].completed_at = NOW(); // a terminal series carries its stamp
    seedApp(1, {
      company_name: "Alpha GmbH",
      company_email: "jobs@alpha.de",
      status: "sent",
      sent_at: NOW(),
      body_html: "<p>Letter A</p>",
    });
    seedApp(2, { company_name: "Beta GmbH", company_email: "jobs@beta.de", status: "sent", sent_at: NOW() });
    const historyBefore = JSON.stringify(db.bew_applications.slice());

    const row = await addBewCompany(USER, CAMPAIGN, KAELTE_AD);

    // The new row lands at the bottom (max seq + 1) as a plain pending row…
    expect(row.seq).toBe(3);
    expect(row.status).toBe("pending");
    expect(db.bew_applications).toHaveLength(3);
    // …every historical row stays byte-identical (no delete, no rewrite)…
    const historyAfter = db.bew_applications.filter((r) => r.id !== row.id);
    expect(JSON.stringify(historyAfter)).toBe(historyBefore);
    expect(db.appDeletes).toBe(0);
    // …and the terminal state is REOPENED: the counter re-derives the
    // exact state from the rows (a fresh pending row → "generating") and
    // the stale completion stamp is cleared.
    const campaign = db.bew_campaigns[0];
    expect(campaign.status).toBe("generating");
    expect(campaign.completed_at).toBeNull();
    expect(campaign.total_count).toBe(3);
    expect(campaign.sent_count).toBe(2); // history intact in the counters too
  });

  it("SENDING series: a new company is appended, the in-flight send keeps its state", async () => {
    seedCampaign("sending");
    seedApp(1, { company_name: "Alpha GmbH", company_email: "jobs@alpha.de", status: "queued" });
    seedApp(2, { company_name: "Beta GmbH", company_email: "jobs@beta.de", status: "sent", sent_at: NOW() });

    const row = await addBewCompany(USER, CAMPAIGN, KAELTE_AD);

    // Appended at the bottom, NOT pulled into the in-flight batch…
    expect(row.seq).toBe(3);
    expect(row.status).toBe("pending");
    // …and the counter keeps "sending" while a row is in flight.
    const campaign = db.bew_campaigns[0];
    expect(campaign.status).toBe("sending");
    expect(campaign.total_count).toBe(3);
    expect(db.appDeletes).toBe(0);
  });

  it("PARTIALLY_FAILED series: reopened by new work (same contract as completed)", async () => {
    seedCampaign("partially_failed");
    db.bew_campaigns[0].completed_at = NOW();
    seedApp(1, { company_name: "Alpha GmbH", company_email: "jobs@alpha.de", status: "sent", sent_at: NOW() });
    seedApp(2, { company_name: "Beta GmbH", company_email: "jobs@beta.de", status: "failed" });

    await addBewCompany(USER, CAMPAIGN, KAELTE_AD);

    const campaign = db.bew_campaigns[0];
    expect(campaign.status).toBe("generating"); // the pending row re-activates it
    expect(campaign.completed_at).toBeNull();
    expect(db.bew_applications).toHaveLength(3);
  });

  it("authentication and ownership stay enforced (a foreign COMPLETED series is still NOT_FOUND)", async () => {
    seedCampaign("completed");
    await expectCode(() => addBewCompany(OTHER, CAMPAIGN, KAELTE_AD), "NOT_FOUND");
    expect(db.bew_applications).toHaveLength(0); // nothing was written
    // A nonexistent campaign id is still NOT_FOUND as well.
    await expectCode(() => addBewCompany(USER, "nope", KAELTE_AD), "NOT_FOUND");
  });

  it("duplicate protection and the 100-row cap still hold on a COMPLETED series", async () => {
    seedCampaign("completed");
    seedApp(1, { company_name: "Amberger Kühltechnik GmbH", company_email: "bernklaustefanie@amberger-kuehltechnik.de", status: "sent", sent_at: NOW() });
    await expectCode(() => addBewCompany(USER, CAMPAIGN, KAELTE_AD), "DUPLICATE_COMPANY");

    for (let i = 2; i <= 100; i++) {
      seedApp(i, { company_name: `GmbH ${i}`, company_email: `jobs${i}@x.de`, status: "sent", sent_at: NOW() });
    }
    await expectCode(() => addBewCompany(USER, CAMPAIGN, "Gamma GmbH\ninfo@gamma.de\nBeschreibung: Test."), "COUNT_EXCEEDED");
    expect(db.bew_applications).toHaveLength(100); // nothing appended past the cap
  });
});


/* ------------------- Reviewed fields (the user-verified confirm step) ------------------- */

function reviewedFields(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  const f = (value: string, status: string = "extracted") => ({ value, status });
  return {
    companyName: f("Amberger Kühltechnik GmbH"),
    companyEmail: f("bernklaustefanie@amberger-kuehltechnik.de"),
    contactName: f("Frau Stefanie Bernklau"),
    companyAddress: f("Dr.-Aigner-Str. 15, 92224 Amberg, Oberpfalz"),
    companyPhone: f("+49 9621 472983"),
    companyIndustry: f("HVAC & Refrigeration — Kältetechnik"),
    positionTitle: f("Mechatroniker/in - Kältetechnik"),
    positionBrief: f(
      "Als Mechatroniker für Kältetechnik planst, montierst und wartest du Anlagen der Kälte- und Klimatechnik. Du sorgst dafür, dass die Kälteanlagen beim Kunden einwandfrei funktionieren.",
    ),
    startDate: f("01.09.2027"),
    endDate: f("31.07.2030"),
    deadline: f("30.06.2027"),
    tooLongInput: false,
    ...over,
  };
}

describe("addBewCompany — reviewed fields (what the user reviewed is persisted)", () => {
  it("persists the EXACT reviewed values, incl. the three ad dates", async () => {
    seedCampaign();
    const row = await addBewCompany(USER, CAMPAIGN, KAELTE_AD, reviewedFields());
    expect(row.company_phone).toBe("+49 9621 472983");
    expect(row.company_industry).toBe("HVAC & Refrigeration — Kältetechnik");
    expect(row.company_name).toBe("Amberger Kühltechnik GmbH");
    expect(row.company_email).toBe("bernklaustefanie@amberger-kuehltechnik.de");
    // The user reviewed "01.09.2027" although the source says 01.08.2027 —
    // the form value is the truth (user-verified contract).
    expect(row.start_date).toBe("01.09.2027");
    expect(row.end_date).toBe("31.07.2030");
    expect(row.application_deadline).toBe("30.06.2027");
  });

  it("USER-CORRECTED values (not in the source) are persisted — the user verified them", async () => {
    seedCampaign();
    const ad = "Omega GmbH\ninfo@omega.de\nruf mich unter 0151/9876543 an\nBeschreibung: Wir suchen Verstärkung.";
    // None of these values appears in `ad` — the user read the extraction,
    // corrected it and confirmed. The new contract trusts the form (no
    // grounding at confirm time; anti-fabrication lives in the AI pre-fill).
    const corrected = reviewedFields({
      companyName: f2("Omega Kälte GmbH"),
      companyEmail: f2("jobs@omega.de"),
      contactName: f2("", "missing"),
      companyAddress: f2("", "missing"),
      companyPhone: f2("+49 9999 000000"),
      companyIndustry: f2("Skilled Trades"),
      positionTitle: f2("", "missing"),
      positionBrief: f2("Wir suchen Verstärkung."),
      startDate: f2("01.09.2027"),
      endDate: f2("", "missing"),
      deadline: f2("30.06.2027"),
    });
    const row = await addBewCompany(USER, CAMPAIGN, ad, corrected);
    expect(row.company_name).toBe("Omega Kälte GmbH");
    expect(row.company_email).toBe("jobs@omega.de");
    expect(row.company_phone).toBe("+49 9999 000000");
    expect(row.company_industry).toBe("Skilled Trades");
    expect(row.start_date).toBe("01.09.2027");
    expect(row.end_date ?? null).toBeNull();
    expect(row.application_deadline).toBe("30.06.2027");
  });

  it("a malformed reviewed payload is rejected with INVALID_PAYLOAD (never a silent re-parse)", async () => {
    seedCampaign();
    // An invalid e-mail in the reviewed form (user typo) must be sent back to
    // the form — not swapped out for a deterministically re-parsed one.
    const bad = reviewedFields({ companyEmail: f2("not-an-email") });
    await expectCode(() => addBewCompany(USER, CAMPAIGN, KAELTE_AD, bad), "INVALID_PAYLOAD");
    expect(db.bew_applications).toHaveLength(0); // nothing was written
  });

  it("empty text + valid reviewed → the FORM alone is persisted", async () => {
    seedCampaign();
    // The user may have cleared the paste box after reviewing — the reviewed
    // form is the source of truth, the text is only kept for the flag.
    const row = await addBewCompany(USER, CAMPAIGN, "", reviewedFields());
    expect(row.company_name).toBe("Amberger Kühltechnik GmbH");
    expect(row.company_email).toBe("bernklaustefanie@amberger-kuehltechnik.de");
    expect(row.start_date).toBe("01.09.2027");
  });

  it("legacy call (no reviewed) still persists the deterministic phone (no AI needed)", async () => {
    seedCampaign();
    const row = await addBewCompany(USER, CAMPAIGN, KAELTE_AD);
    expect(row.company_phone).toBe("+49 9621 472983"); // labeled, verbatim
    expect(row.company_industry ?? null).toBeNull(); // deterministic never classifies
  });

  it("migration pending (no smart columns): degrades gracefully, NO 42703", async () => {
    db.smartColumnsBroken = true;
    seedCampaign();
    const row = await addBewCompany(USER, CAMPAIGN, KAELTE_AD, reviewedFields());
    // The row is persisted WITHOUT the smart columns (keys absent).
    expect(row.company_name).toBe("Amberger Kühltechnik GmbH");
    expect(row.company_phone).toBeUndefined();
    expect(row.company_industry).toBeUndefined();
  });

  it("migration pending (no ad-date columns): dates degrade gracefully, NO 42703", async () => {
    db.dateColumnsBroken = true;
    seedCampaign();
    const row = await addBewCompany(USER, CAMPAIGN, KAELTE_AD, reviewedFields());
    expect(row.company_name).toBe("Amberger Kühltechnik GmbH");
    // The date keys are ABSENT (not null) — the insert never mentions them.
    expect(row.start_date).toBeUndefined();
    expect(row.end_date).toBeUndefined();
    expect(row.application_deadline).toBeUndefined();
  });
});

function f2(value: string, status: string = "extracted") {
  return { value, status };
}

/* ------------------- checkBewSmartInput (the server "Check information") ------------------- */

describe("checkBewSmartInput — server-side analysis, no persistence", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GEMINI_SMART_INPUT_API_KEY;
    delete process.env.GEMINI_SMART_INPUT_MODEL;
  });

  it("no credentials → deterministic parse + issues, and NOTHING is written", async () => {
    seedCampaign();
    seedApp(1, { company_name: "Alpha GmbH", company_email: "jobs@alpha.de", status: "pending" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { parsed, issues, diagnostic } = await checkBewSmartInput(USER, CAMPAIGN, KAELTE_AD);
    expect(fetchMock).not.toHaveBeenCalled(); // no AI without the dedicated key
    expect(parsed.companyName.value).toBe("Amberger Kühltechnik GmbH");
    expect(parsed.companyPhone.value).toBe("+49 9621 472983");
    expect(issues).toEqual([]);
    expect(db.bew_applications).toHaveLength(1); // the check writes nothing
    // Non-sensitive diagnostic propagates to the action/UI (owner can tell a
    // production fallback apart from a successful extraction without logs).
    expect(diagnostic).toBe("no-key");
  });

  it("AI http failure → the SAFE upstream detail propagates (actionable, never raw)", async () => {
    // Production repro 2026-10-20: the owner saw "http-4xx" with no reason.
    // The detail carries the allowlisted provider status + sanitized
    // message so the next live test pinpoints key / schema / quota.
    process.env.GEMINI_SMART_INPUT_API_KEY = "test-dedicated-key-0123456789";
    seedCampaign();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 400,
              message: "API key not valid. Please pass a valid API key.",
              status: "API_KEY_INVALID",
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const { parsed, issues, diagnostic, diagnosticDetail } = await checkBewSmartInput(
      USER,
      CAMPAIGN,
      KAELTE_AD,
    );
    expect(diagnostic).toBe("http-400");
    expect(diagnosticDetail).toBe("API_KEY_INVALID: API key not valid. Please pass a valid API key.");
    // The deterministic floor is intact (the workflow never breaks).
    expect(parsed.companyName.value).toBe("Amberger Kühltechnik GmbH");
    expect(issues).toEqual([]);
  });

  it("dedicated key + valid AI response → merged (AI-enhanced) parsed result", async () => {
    process.env.GEMINI_SMART_INPUT_API_KEY = "test-dedicated-key-0123456789";
    seedCampaign();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        company_name: "Amberger Kühltechnik GmbH",
                        contact_name: "Frau Stefanie Bernklau",
                        contact_role: null,
                        company_address: "Dr.-Aigner-Str. 15, 92224 Amberg, Oberpfalz",
                        emails: [
                          {
                            value: "bernklaustefanie@amberger-kuehltechnik.de",
                            context: "employer",
                          },
                        ],
                        phones: [
                          { value: "+49 9621 472983", context: "employer" },
                        ],
                        position_title: "Mechatroniker/in - Kältetechnik",
                        position_brief:
                          "Als Mechatroniker für Kältetechnik planst, montierst und wartest du Anlagen der Kälte- und Klimatechnik. Du sorgst dafür, dass die Kälteanlagen beim Kunden einwandfrei funktionieren.",
                        industry: {
                          category: "HVAC & Refrigeration",
                          subcategory: "Kältetechnik",
                          confidence: "high",
                        },
                      }),
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );
    const { parsed, issues, diagnostic } = await checkBewSmartInput(USER, CAMPAIGN, KAELTE_AD);
    expect(issues).toEqual([]);
    // AI-enhanced fields present in the frozen review surface.
    expect(parsed.companyIndustry.value).toBe("HVAC & Refrigeration — Kältetechnik");
    expect(parsed.companyIndustry.status).toBe("extracted");
    expect(parsed.companyPhone.value).toBe("+49 9621 472983");
    expect(db.bew_applications).toHaveLength(0); // still: no write
    expect(diagnostic).toBe("ai"); // the AI step actually ran (mocked provider)
  });

  it("dedicated key + API failure (500) → deterministic fallback, no throw, no write", async () => {
    process.env.GEMINI_SMART_INPUT_API_KEY = "test-dedicated-key-0123456789";
    seedCampaign();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    const { parsed, issues, diagnostic } = await checkBewSmartInput(USER, CAMPAIGN, KAELTE_AD);
    expect(issues).toEqual([]);
    expect(parsed.companyName.value).toBe("Amberger Kühltechnik GmbH");
    expect(parsed.companyIndustry.status).toBe("missing"); // AI failed → no industry
    expect(db.bew_applications).toHaveLength(0);
    expect(diagnostic).toBe("http-500"); // provider failure surfaced, no internal detail
  });

  it("provider diagnostics propagate: 401 / timeout / placeholder key (never throws, never writes)", async () => {
    seedCampaign();
    process.env.GEMINI_SMART_INPUT_API_KEY = "test-dedicated-key-0123456789";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 401 })));
    expect((await checkBewSmartInput(USER, CAMPAIGN, KAELTE_AD)).diagnostic).toBe("http-401");
    const timeout = Object.assign(new Error("aborted"), { name: "TimeoutError" });
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw timeout;
    }));
    expect((await checkBewSmartInput(USER, CAMPAIGN, KAELTE_AD)).diagnostic).toBe("timeout");
    process.env.GEMINI_SMART_INPUT_API_KEY = "your-key-placeholder-123";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const out = await checkBewSmartInput(USER, CAMPAIGN, KAELTE_AD);
    expect(out.diagnostic).toBe("placeholder-key");
    expect(fetchMock).not.toHaveBeenCalled(); // a placeholder key never costs a call
    expect(db.bew_applications).toHaveLength(0);
  });

  it("empty text → INVALID_PAYLOAD issue, over-limit → deterministic rejection without an AI call", async () => {
    seedCampaign();
    const empty = await checkBewSmartInput(USER, CAMPAIGN, "   ");
    expect(empty.issues).toContain("INVALID_PAYLOAD");
    expect(empty.diagnostic).toBeNull(); // AI step not even attempted
    const longAd = "Gamma GmbH\ninfo@gamma.de\n" + "x".repeat(21_000);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const long = await checkBewSmartInput(USER, CAMPAIGN, longAd);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(long.issues).toContain("INVALID_PAYLOAD");
    expect(long.diagnostic).toBeNull();
  });

  it("duplicate e-mail (active row) → DUPLICATE_COMPANY; foreign campaign → NOT_FOUND", async () => {
    seedCampaign();
    seedApp(1, {
      company_name: "Amberger Kühltechnik GmbH",
      company_email: "bernklaustefanie@amberger-kuehltechnik.de",
      status: "pending",
    });
    const { issues } = await checkBewSmartInput(USER, CAMPAIGN, KAELTE_AD);
    expect(issues).toContain("DUPLICATE_COMPANY");

    await expect(
      checkBewSmartInput(OTHER, CAMPAIGN, KAELTE_AD),
    ).rejects.toThrow("NOT_FOUND");
  });
});
