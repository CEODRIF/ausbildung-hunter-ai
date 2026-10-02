import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * Company & Email Discovery — Phase 1 (UI + types + run model).
 *
 * Covers:
 *  - the shared zod parameter schema (the contract between UI, API and
 *    DB — target bounds, beginn union, goal, defaults, unknown-field
 *    stripping);
 *  - the pure beginn helpers;
 *  - discoveryLimits() defaults + env overrides (server config, no
 *    hardcoded UI numbers);
 *  - the run store against a mocked admin client (lifecycle + idempotent
 *    records: create/get/start/cancel/recordCompany/recordCompanyEmail).
 */

const { createAdminClient } = await import("@/lib/supabase/admin");
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(),
}));

import {
  DISCOVERY_TARGET_DEFAULT,
  DISCOVERY_TARGET_MAX,
  DISCOVERY_TARGET_MIN,
  beginnLabelOf,
  beginnRequiresDocumentedStart,
  discoveryLimits,
  discoveryRunParamsSchema,
  type DiscoveryBeginn,
} from "@/lib/company-discovery/types";
import {
  cancelDiscoveryRun,
  createDiscoveryRun,
  getDiscoveryRun,
  recordCompany,
  recordCompanyEmail,
  startDiscoveryRun,
} from "@/lib/company-discovery/runs";

// ---------------------------------------------------------------------------
// Parameter schema
// ---------------------------------------------------------------------------

describe("discoveryRunParamsSchema", () => {
  const valid = {
    field: "Marketing / E-Commerce",
    role: "Kaufmann im E-Commerce",
    beginn: { mode: "year", year: 2027 } as DiscoveryBeginn,
    goal: "ausbildung",
    targetCompanies: 100,
    onlyPublicEmail: true,
  };

  it("accepts a complete valid payload", () => {
    const parsed = discoveryRunParamsSchema.parse(valid);
    expect(parsed).toEqual(valid);
  });

  it("applies documented defaults (goal, target, onlyPublicEmail)", () => {
    const parsed = discoveryRunParamsSchema.parse({
      field: "IT",
      role: "Fachinformatiker",
      beginn: { mode: "from_now" },
    });
    expect(parsed.goal).toBe("ausbildung");
    expect(parsed.targetCompanies).toBe(DISCOVERY_TARGET_DEFAULT);
    expect(parsed.onlyPublicEmail).toBe(true);
  });

  it("rejects a target outside the bounded range or non-integer", () => {
    for (const bad of [5, 501, 10.5, Number.NaN]) {
      expect(() =>
        discoveryRunParamsSchema.parse({ ...valid, targetCompanies: bad }),
      ).toThrow(z.ZodError);
    }
    expect(
      discoveryRunParamsSchema.parse({ ...valid, targetCompanies: DISCOVERY_TARGET_MIN }).targetCompanies,
    ).toBe(DISCOVERY_TARGET_MIN);
    expect(
      discoveryRunParamsSchema.parse({ ...valid, targetCompanies: DISCOVERY_TARGET_MAX }).targetCompanies,
    ).toBe(DISCOVERY_TARGET_MAX);
  });

  it("rejects empty field / role", () => {
    expect(() =>
      discoveryRunParamsSchema.parse({ ...valid, field: "   " }),
    ).toThrow(z.ZodError);
    expect(() =>
      discoveryRunParamsSchema.parse({ ...valid, role: "" }),
    ).toThrow(z.ZodError);
  });

  it("validates every beginn mode and rejects malformed values", () => {
    expect(
      discoveryRunParamsSchema.parse({ ...valid, beginn: { mode: "from_now" } }).beginn,
    ).toEqual({ mode: "from_now" });
    expect(
      discoveryRunParamsSchema.parse({ ...valid, beginn: { mode: "date", date: "2027-08-01" } }).beginn,
    ).toEqual({ mode: "date", date: "2027-08-01" });
    expect(
      discoveryRunParamsSchema.parse({ ...valid, beginn: { mode: "month", month: "2027-08" } }).beginn,
    ).toEqual({ mode: "month", month: "2027-08" });

    for (const bad of [
      { mode: "date", date: "08/01/2027" },
      { mode: "date", date: "2027-8-1" },
      { mode: "month", month: "2027-8" },
      { mode: "month", month: "August 2027" },
      { mode: "year", year: 2023 },
      { mode: "year", year: 2101 },
      { mode: "year", year: "2027" },
      { mode: "week", week: 32 },
    ]) {
      expect(() =>
        discoveryRunParamsSchema.parse({ ...valid, beginn: bad }),
      ).toThrow(z.ZodError);
    }
  });

  it("accepts all three goals and rejects anything else", () => {
    for (const goal of ["ausbildung", "arbeit", "both"]) {
      expect(discoveryRunParamsSchema.parse({ ...valid, goal }).goal).toBe(goal);
    }
    expect(() =>
      discoveryRunParamsSchema.parse({ ...valid, goal: "job" }),
    ).toThrow(z.ZodError);
  });

  it("strips unknown fields (the server never trusts extras)", () => {
    const parsed = discoveryRunParamsSchema.parse({
      ...valid,
      evil: "arbitrary-url",
      credits: 9999,
    });
    expect(parsed).not.toHaveProperty("evil");
    expect(parsed).not.toHaveProperty("credits");
  });
});

// ---------------------------------------------------------------------------
// Beginn helpers
// ---------------------------------------------------------------------------

describe("beginn helpers", () => {
  it("labels every mode with its machine value", () => {
    expect(beginnLabelOf({ mode: "from_now" })).toBe("from_now");
    expect(beginnLabelOf({ mode: "date", date: "2027-08-01" })).toBe("2027-08-01");
    expect(beginnLabelOf({ mode: "month", month: "2027-08" })).toBe("2027-08");
    expect(beginnLabelOf({ mode: "year", year: 2027 })).toBe("2027");
  });

  it("only concrete modes require a documented start (missing → reject later)", () => {
    expect(beginnRequiresDocumentedStart({ mode: "from_now" })).toBe(false);
    expect(beginnRequiresDocumentedStart({ mode: "date", date: "2027-08-01" })).toBe(true);
    expect(beginnRequiresDocumentedStart({ mode: "month", month: "2027-08" })).toBe(true);
    expect(beginnRequiresDocumentedStart({ mode: "year", year: 2027 })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Server-side limits
// ---------------------------------------------------------------------------

describe("discoveryLimits", () => {
  const ENV_KEYS = [
    "DISCOVERY_MAX_CANDIDATES",
    "DISCOVERY_MAX_COMPANIES_TO_RESOLVE",
    "DISCOVERY_MAX_CONCURRENT",
    "DISCOVERY_MAX_TAVILY_QUERIES",
    "DISCOVERY_MAX_RUNTIME_MS",
  ];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("has conservative defaults (never hardcoded in the UI)", () => {
    expect(discoveryLimits()).toEqual({
      maxCandidates: 1000,
      maxCompaniesToResolve: 500,
      maxConcurrent: 5,
      maxTavilyQueries: 30,
      maxPagesPerCompany: 4,
      maxRuntimeMs: 10 * 60 * 1000,
    });
  });

  it("is tunable via server env vars; invalid values fall back", () => {
    process.env.DISCOVERY_MAX_CANDIDATES = "250";
    process.env.DISCOVERY_MAX_CONCURRENT = "abc";
    const limits = discoveryLimits();
    expect(limits.maxCandidates).toBe(250);
    expect(limits.maxConcurrent).toBe(5); // invalid → fallback
  });
});

// ---------------------------------------------------------------------------
// Run store (mocked Supabase admin client)
// ---------------------------------------------------------------------------

interface TerminalResult {
  data?: unknown;
  error?: unknown;
}

interface ChainMock {
  from: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  in: ReturnType<typeof vi.fn>;
  single: ReturnType<typeof vi.fn>;
  maybeSingle: ReturnType<typeof vi.fn>;
}

/**
 * A chainable fake query. `terminals` is the sequence of results returned
 * by the terminal calls (single/maybeSingle) in call order — e.g. a
 * select-then-insert flow needs [existenceResult, insertResult].
 */
function makeChain(terminals: TerminalResult[]): ChainMock {
  let terminalIndex = 0;
  const resolveTerminal = () => {
    const value = terminals[Math.min(terminalIndex, terminals.length - 1)];
    terminalIndex += 1;
    return Promise.resolve(value);
  };
  const chain: Record<string, unknown> = {
    single: vi.fn(resolveTerminal),
    maybeSingle: vi.fn(resolveTerminal),
    eq: vi.fn(),
    in: vi.fn(),
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    upsert: vi.fn(),
  };
  for (const key of ["eq", "in", "select", "insert", "update", "upsert"]) {
    chain[key] = vi.fn().mockReturnValue(chain);
  }
  return {
    from: vi.fn().mockReturnValue(chain),
    insert: chain.insert as ChainMock["insert"],
    update: chain.update as ChainMock["update"],
    upsert: chain.upsert as ChainMock["upsert"],
    select: chain.select as ChainMock["select"],
    eq: chain.eq as ChainMock["eq"],
    in: chain.in as ChainMock["in"],
    single: chain.single as ChainMock["single"],
    maybeSingle: chain.maybeSingle as ChainMock["maybeSingle"],
  };
}

/** Every created admin client gets the chain of its own terminal sequence. */
let chains: ChainMock[] = [];
function mockClients(...clientTerminals: TerminalResult[][]) {
  chains = [];
  let call = 0;
  vi.mocked(createAdminClient).mockImplementation(() => {
    const idx = Math.min(call, clientTerminals.length - 1);
    call += 1;
    const chain = makeChain(clientTerminals[idx]);
    chains.push(chain);
    return { from: vi.fn().mockReturnValue(chain) } as never;
  });
}

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    run_id: "11111111-1111-4111-8111-111111111111",
    user_id: "22222222-2222-4222-8222-222222222222",
    params: {
      field: "Marketing / E-Commerce",
      role: "Kaufmann im E-Commerce",
      beginn: { mode: "year", year: 2027 },
      goal: "ausbildung",
      targetCompanies: 100,
      onlyPublicEmail: true,
    },
    status: "pending",
    target_companies: 100,
    found_companies: 0,
    offers_analyzed: 0,
    unique_companies: 0,
    duplicates_removed: 0,
    companies_rejected: 0,
    sources: [],
    credits_charged: 0,
    error: null,
    created_at: "2026-10-02T10:00:00.000Z",
    started_at: null,
    finished_at: null,
    updated_at: "2026-10-02T10:00:00.000Z",
    ...overrides,
  };
}

const USER_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "11111111-1111-4111-8111-111111111111";

const VALID_PARAMS = {
  field: "Marketing / E-Commerce",
  role: "Kaufmann im E-Commerce",
  beginn: { mode: "year", year: 2027 },
  goal: "ausbildung",
  targetCompanies: 100,
  onlyPublicEmail: true,
};

describe("run store", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("createDiscoveryRun inserts a pending run with the validated params", async () => {
    mockClients([{ data: runRow(), error: null }]);
    const run = await createDiscoveryRun(USER_ID, {
      ...VALID_PARAMS,
      field: "  Marketing / E-Commerce  ", // trimmed by the schema
    });
    expect(chains[0].insert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: USER_ID,
        status: "pending",
        target_companies: 100,
        sources: [],
      }),
    );
    expect(
      (chains[0].insert.mock.calls[0]![0] as { params: { field: string } }).params.field,
    ).toBe("Marketing / E-Commerce");
    expect(run.runId).toBe(RUN_ID);
    expect(run.status).toBe("pending");
    expect(run.progress.targetCompanies).toBe(100);
    expect(run.progress.status).toBe("pending");
    expect(run.progress.sources).toEqual([]);
    expect(run.creditsCharged).toBe(0);
  });

  it("createDiscoveryRun rejects invalid params WITHOUT any insert", async () => {
    mockClients([{ data: runRow(), error: null }]);
    await expect(
      createDiscoveryRun(USER_ID, { ...VALID_PARAMS, targetCompanies: 2500 }),
    ).rejects.toThrow(z.ZodError);
    // No client was ever created → no insert could have happened.
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("createDiscoveryRun throws a controlled error on DB failure", async () => {
    mockClients([{ data: null, error: { message: "boom" } }]);
    await expect(
      createDiscoveryRun(USER_ID, {
        field: "IT",
        role: "Dev",
        beginn: { mode: "from_now" },
      }),
    ).rejects.toThrow(/boom/);
  });

  it("getDiscoveryRun maps the row (incl. real source status) and null on error", async () => {
    const row = runRow({
      status: "running",
      offers_analyzed: 348,
      sources: [
        { id: "arbeitsagentur", status: "ok", candidates: 200 },
        { id: "tavily", status: "unavailable" },
      ],
    });
    mockClients([{ data: row, error: null }]);
    const run = await getDiscoveryRun(RUN_ID, USER_ID);
    expect(run?.status).toBe("running");
    expect(run?.progress.offersAnalyzed).toBe(348);
    expect(run?.progress.sources).toEqual([
      { id: "arbeitsagentur", status: "ok", candidates: 200 },
      { id: "tavily", status: "unavailable" },
    ]);

    mockClients([{ data: null, error: { message: "nope" } }]);
    expect(await getDiscoveryRun(RUN_ID, USER_ID)).toBeNull();
  });

  it("startDiscoveryRun moves pending → running and sets started_at", async () => {
    mockClients([{ data: runRow({ status: "running", started_at: "2026-10-02T10:01:00.000Z" }), error: null }]);
    const run = await startDiscoveryRun(RUN_ID, USER_ID);
    expect(chains[0].update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "running" }),
    );
    expect((chains[0].update.mock.calls[0]![0] as { started_at: unknown }).started_at).toBeTruthy();
    expect(chains[0].eq).toHaveBeenCalledWith("status", "pending");
    expect(run.status).toBe("running");
  });

  it("startDiscoveryRun is idempotent when the run is already running", async () => {
    // First client: the guarded update matched nothing (already running).
    // Second client: the re-read returns the running row.
    mockClients([{ data: null, error: null }], [{ data: runRow({ status: "running" }), error: null }]);
    const run = await startDiscoveryRun(RUN_ID, USER_ID);
    expect(run.status).toBe("running");
  });

  it("cancelDiscoveryRun is a no-op for terminal runs (no update issued)", async () => {
    mockClients([{ data: runRow({ status: "cancelled" }), error: null }]);
    const run = await cancelDiscoveryRun(RUN_ID, USER_ID);
    expect(run.status).toBe("cancelled");
    expect(chains[0].update).not.toHaveBeenCalled();
  });

  it("cancelDiscoveryRun cancels a running run with a status-guarded update", async () => {
    mockClients([{ data: runRow({ status: "running" }), error: null }], [
      { data: runRow({ status: "cancelled", finished_at: "2026-10-02T10:02:00.000Z" }), error: null },
    ]);
    const run = await cancelDiscoveryRun(RUN_ID, USER_ID);
    // The update is guarded so a finishing orchestrator wins the race.
    expect(chains[1].in).toHaveBeenCalledWith("status", ["pending", "running"]);
    expect(chains[1].update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "cancelled" }),
    );
    expect(run.status).toBe("cancelled");
  });

  it("cancelDiscoveryRun throws for an unknown run", async () => {
    mockClients([{ data: null, error: null }]);
    await expect(cancelDiscoveryRun(RUN_ID, USER_ID)).rejects.toThrow(
      /not found/i,
    );
  });

  it("recordCompany returns created=false when the company is already in the run", async () => {
    // Existence select returns the row → no insert, no duplicate.
    mockClients([{ data: { id: "company-uuid" }, error: null }]);
    const result = await recordCompany(RUN_ID, {
      companyKey: "siemens",
      companyName: "Siemens AG",
      websiteUrl: "https://siemens.com",
      websiteSourceUrl: null,
      role: "Elektroniker",
      field: "Technik",
      offerType: "ausbildung",
      city: "München",
      state: "BY",
      beginn: "2027-08-01",
      salaryLabel: null,
      offerSource: "BA",
      offerUrl: "https://example.test/offer",
      status: "accepted",
    });
    expect(result).toEqual({ companyId: "company-uuid", created: false });
    expect(chains[0].insert).not.toHaveBeenCalled();
  });

  it("recordCompany inserts a NEW company (created=true) with the counting facts", async () => {
    // Existence select → null; insert → the new id.
    mockClients([{ data: null, error: null }, { data: { id: "company-new" }, error: null }]);
    const result = await recordCompany(RUN_ID, {
      companyKey: "abc",
      companyName: "ABC GmbH",
      websiteUrl: null,
      websiteSourceUrl: null,
      role: null,
      field: "Marketing",
      offerType: "arbeit",
      city: "Berlin",
      state: null,
      beginn: null,
      salaryLabel: "1150 €",
      offerSource: "Ausbildung.de",
      offerUrl: "https://ausbildung.example.test/1",
      status: "accepted",
    });
    expect(result).toEqual({ companyId: "company-new", created: true });
    expect(chains[0].insert).toHaveBeenCalledWith(
      expect.objectContaining({
        run_id: RUN_ID,
        company_key: "abc",
        status: "accepted",
        salary_label: "1150 €",
      }),
    );
  });

  it("recordCompanyEmail upserts idempotently keyed by (company_id, email)", async () => {
    mockClients([{ data: null, error: null }]);
    await recordCompanyEmail(
      "company-uuid",
      "ausbildung@abc.de",
      "https://abc.de/impressum",
      "impressum",
      "high",
    );
    expect(chains[0].upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        company_id: "company-uuid",
        email: "ausbildung@abc.de",
        email_source_url: "https://abc.de/impressum",
        email_source_type: "impressum",
        confidence: "high",
      }),
      expect.objectContaining({ onConflict: "company_id,email", ignoreDuplicates: true }),
    );
  });
});
