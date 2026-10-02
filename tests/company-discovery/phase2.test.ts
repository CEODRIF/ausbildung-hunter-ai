import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BaFetchFailure, buildMatchers } from "@/lib/opportunities/providers/arbeitsagentur";
import type { Opportunity, OpportunitySearchParams, OpportunityWindow } from "@/lib/opportunities/types";

/**
 * Company & Email Discovery — Phase 2 (candidate discovery over the
 * EXISTING Opportunities/BA engine).
 *
 * The store (runs.ts) is mocked (it is tested in phase1.test.ts); the
 * window provider is injected: an "engine emulator" that applies the REAL
 * provider matchers (buildMatchers) to seeded raw offers — so goal
 * consistency, role tokens and beginn now/month are verified with the
 * production logic, while date/year gates, dedupe, target stop, budgets,
 * source failure and cancellation are verified on the pipeline itself.
 */

vi.mock("@/lib/company-discovery/runs", () => ({
  getDiscoveryRun: vi.fn(),
  startDiscoveryRun: vi.fn(),
  setRunCounters: vi.fn(),
  recordCandidates: vi.fn(),
  recordCompany: vi.fn(),
  finishDiscoveryRun: vi.fn(),
}));

import * as store from "@/lib/company-discovery/runs";
import type { CompanyRecord, FinishRunOutcome } from "@/lib/company-discovery/runs";
import { runDiscoveryPipeline } from "@/lib/company-discovery/search";
import {
  candidateFromOpportunity,
  companyFactsFromOpportunity,
  discoveryBeginnGate,
  goalPasses,
  mapToSearchParams,
} from "@/lib/company-discovery/normalize";
import { companyKeyOf, isUsableCompanyName } from "@/lib/company-discovery/dedupe";
import type {
  DiscoveryCandidate,
  DiscoveryRun,
  DiscoveryRunParams,
  DiscoverySourceStatus,
} from "@/lib/company-discovery/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";

/** Minimal but fully-typed normalized opportunity (search-filters pattern). */
function mkOpp(overrides: Record<string, unknown>): Opportunity {
  return {
    id: "arbeitsagentur:X-S",
    provider: "arbeitsagentur",
    external_id: "X-S",
    source_name: "Bundesagentur für Arbeit",
    source_url: "https://www.arbeitsagentur.test/jobbundle/bundle/1",
    source_type: "official_source",
    additional_sources: [],
    source_ids: [],
    enrichment: null,
    application_url: null,
    aggregator_url: null,
    title: "Ausbildung als Kaufmann im E-Commerce (m/w/d)",
    goal: "ausbildung",
    stellenangebotsart: "AUSBILDUNG",
    company_name: "Siemens AG",
    company_url: null,
    location: "10115 Berlin",
    location_detail: {
      city: "Berlin",
      region: "Berlin",
      country: "Deutschland",
      postal_code: "10115",
    },
    distance_km: null,
    latitude: null,
    longitude: null,
    profession: "Kaufmann im E-Commerce",
    alternative_professions: [],
    description: null,
    tasks: [],
    requirements: [],
    employment_type: "Full-time",
    home_office: null,
    career_change_friendly: null,
    salary: { amount: 1150, unit: "monthly", label: "1.150 €" },
    training_type: "AUSBILDUNG",
    education_requirement: null,
    valid_from: "2027-08-01",
    application_deadline: null,
    posted_at: "2026-10-01T00:00:00.000Z",
    updated_at: null,
    retrieved_at: "2026-10-02T00:00:00.000Z",
    contact: null,
    required_skills: [],
    preferred_skills: [],
    required_languages: [],
    extracted_keywords: [],
    match: null,
    ...overrides,
  } as unknown as Opportunity;
}

/** A job posting (goal arbeit) that still satisfies the role matcher. */
function mkJob(overrides: Record<string, unknown>): Opportunity {
  return mkOpp({
    id: "arbeitsagentur:J1-S",
    external_id: "J1-S",
    title: "Kaufmann im E-Commerce (m/w/d)",
    goal: "arbeit",
    stellenangebotsart: "ARBEIT",
    training_type: null,
    ...overrides,
  });
}

const RUN_PARAMS: DiscoveryRunParams = {
  field: "Marketing / E-Commerce",
  role: "Kaufmann im E-Commerce",
  beginn: { mode: "year", year: 2027 },
  goal: "ausbildung",
  targetCompanies: 100,
  // The seeded offers publish no address, and these tests cover the CANDIDATE
  // ENGINE (dedupe, gates, target stop, budgets, partial results). The
  // onlyPublicEmail counting rule has its own coverage (email-discovery.test.ts
  // + the reject path below), so the engine tests ask for "all companies".
  onlyPublicEmail: false,
};

function baseRun(overrides: Partial<DiscoveryRun> = {}): DiscoveryRun {
  return {
    runId: RUN_ID,
    status: "pending",
    params: RUN_PARAMS,
    progress: {
      status: "pending",
      targetCompanies: RUN_PARAMS.targetCompanies,
      foundCompanies: 0,
      offersAnalyzed: 0,
      uniqueCompanies: 0,
      duplicatesRemoved: 0,
      companiesRejected: 0,
      emailsFound: 0,
      noPublicEmail: 0,
      sourcesBlocked: 0,
      sources: [],
    },
    creditsCharged: 0,
    error: null,
    createdAt: "2026-10-02T10:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

/**
 * Engine emulator: seeds are RAW source offers; the returned window applies
 * the REAL provider matchers (goal consistency, role tokens, beginn
 * now/month, …) exactly like fetchOpportunityWindow does.
 */
function engineWindow(
  seeds: Opportunity[],
  mode: "scan" | "upstream" = "scan",
) {
  const calls: OpportunitySearchParams[] = [];
  const fn = async (params: OpportunitySearchParams): Promise<OpportunityWindow> => {
    calls.push(params);
    const filtered = seeds.filter((s) => buildMatchers(params).every((m) => m(s)));
    if (mode === "scan") {
      return {
        mode,
        window: filtered,
        total: filtered.length,
        scan_truncated: false,
        exhausted: true,
        degraded: false,
        filter_counts: null,
      };
    }
    const start = (params.page - 1) * params.pageSize;
    return {
      mode,
      window: filtered.slice(start, start + params.pageSize),
      total: filtered.length,
      scan_truncated: false,
      exhausted: true,
      degraded: false,
      filter_counts: null,
    };
  };
  return { fn, calls };
}

// ---------------------------------------------------------------------------
// Company identity (dedupe)
// ---------------------------------------------------------------------------

describe("companyKeyOf — deterministic, conservative identity", () => {
  it("merges the Siemens family into ONE key", () => {
    expect(companyKeyOf("Siemens AG")).toBe("siemens");
    expect(companyKeyOf("SIEMENS AG")).toBe("siemens");
    expect(companyKeyOf("Siemens")).toBe("siemens");
    expect(companyKeyOf("Siemens Deutschland")).toBe("siemens");
    expect(companyKeyOf("Siemens Deutschland GmbH")).toBe("siemens");
  });

  it("merges case/umlaut variants and legal forms (Bosch, Müller e.K.)", () => {
    expect(companyKeyOf("Bosch GmbH")).toBe("bosch");
    expect(companyKeyOf("BOSCH AG")).toBe("bosch");
    expect(companyKeyOf("Klaus Müller e.K.")).toBe(companyKeyOf("Klaus Müller"));
    // NFD-stripped: "Müller" → "Muller"
    expect(companyKeyOf("Klaus Müller e.K.")).toBe("klausmuller");
  });

  it("NEVER merges different companies on similarity (Bau vs Bauen)", () => {
    expect(companyKeyOf("Bau AG")).toBe("bau");
    expect(companyKeyOf("Bauen GmbH")).toBe("bauen");
    expect(companyKeyOf("Bau AG")).not.toBe(companyKeyOf("Bauen GmbH"));
    expect(companyKeyOf("Siemens Games")).not.toBe(companyKeyOf("Siemens AG"));
  });

  it("protects short cores (no stub keys)", () => {
    // "AG" alone: stripping would leave a stub → full normalized fallback.
    expect(companyKeyOf("AG")).toBe("ag");
    expect(companyKeyOf(null)).toBe("");
    expect(companyKeyOf("  ")).toBe("");
  });
});

describe("isUsableCompanyName — no employer, no company (never invented)", () => {
  it("accepts real employer names", () => {
    expect(isUsableCompanyName("Siemens AG")).toBe(true);
    expect(isUsableCompanyName("ABC Handelsgesellschaft")).toBe(true);
  });

  it("rejects stubs, pure numbers and generic non-employer labels", () => {
    expect(isUsableCompanyName("AB")).toBe(false);
    expect(isUsableCompanyName("12345")).toBe(false);
    expect(isUsableCompanyName("Unbekannt")).toBe(false);
    expect(isUsableCompanyName("Bewerbung")).toBe(false);
    expect(isUsableCompanyName(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Parameter mapping (discovery → existing BA search)
// ---------------------------------------------------------------------------

describe("goalPasses / mapToSearchParams", () => {
  it("maps each goal to its concrete passes", () => {
    expect(goalPasses("ausbildung")).toEqual(["ausbildung"]);
    expect(goalPasses("arbeit")).toEqual(["arbeit"]);
    expect(goalPasses("both")).toEqual(["ausbildung", "arbeit"]);
  });

  it("field → keyword, role → role (engine matcher), match is NEVER requested", () => {
    const sp = mapToSearchParams(RUN_PARAMS, "ausbildung");
    expect(sp.keyword).toBe(RUN_PARAMS.field);
    expect(sp.role).toBe(RUN_PARAMS.role);
    expect(sp.goal).toBe("ausbildung");
    expect(sp.match).toBe(false);
    expect(sp.pageSize).toBe(50);
    expect(sp.sort).toBe("relevance");
    expect(sp.freshness).toBe("any");
  });

  it("maps every beginn mode (from_now/month to the engine, date/year to the gate)", () => {
    expect(mapToSearchParams({ ...RUN_PARAMS, beginn: { mode: "from_now" } }, "ausbildung").beginn).toBe("now");
    expect(mapToSearchParams({ ...RUN_PARAMS, beginn: { mode: "month", month: "2027-08" } }, "ausbildung").beginn).toBe("2027-08");
    expect(mapToSearchParams({ ...RUN_PARAMS, beginn: { mode: "date", date: "2027-08-01" } }, "ausbildung").beginn).toBe("any");
    expect(mapToSearchParams(RUN_PARAMS, "ausbildung").beginn).toBe("any"); // year → gate
  });
});

describe("discoveryBeginnGate (date/year — documented valid_from only)", () => {
  const item = (valid_from: string | null) => ({ valid_from });

  it("date mode: exact documented date only, missing → false", () => {
    expect(discoveryBeginnGate(item("2027-08-01T00:00:00Z"), { mode: "date", date: "2027-08-01" })).toBe(true);
    expect(discoveryBeginnGate(item("2027-08-02"), { mode: "date", date: "2027-08-01" })).toBe(false);
    expect(discoveryBeginnGate(item(null), { mode: "date", date: "2027-08-01" })).toBe(false);
  });

  it("year mode: exact year only, missing → false", () => {
    expect(discoveryBeginnGate(item("2027-12-31"), { mode: "year", year: 2027 })).toBe(true);
    expect(discoveryBeginnGate(item("2026-01-01"), { mode: "year", year: 2027 })).toBe(false);
    expect(discoveryBeginnGate(item(null), { mode: "year", year: 2027 })).toBe(false);
  });

  it("from_now/month are engine-applied → the gate passes them through", () => {
    expect(discoveryBeginnGate(item(null), { mode: "from_now" })).toBe(true);
    expect(discoveryBeginnGate(item("2026-01-01"), { mode: "month", month: "2027-08" })).toBe(true);
  });
});

describe("candidate / company fact extraction", () => {
  const opp = mkOpp({
    id: "arbeitsagentur:42-S",
    external_id: "42-S",
    location_detail: { city: "Berlin", region: "Berlin", country: "DE", postal_code: "10115" },
    valid_from: "2027-08-01T00:00:00Z",
  });

  it("candidate keeps the stable provider ref and compact facts (no PII)", () => {
    expect(candidateFromOpportunity(opp)).toEqual({
      candidateRef: "arbeitsagentur:42-S",
      title: opp.title,
      companyName: "Siemens AG",
      city: "Berlin",
      goal: "ausbildung",
      beginn: "2027-08-01",
      salaryLabel: "1.150 €",
      url: opp.source_url,
    });
  });

  it("company facts map region → state and keep provenance URLs", () => {
    const facts = companyFactsFromOpportunity(opp, RUN_PARAMS, "siemens");
    expect(facts).toEqual({
      companyKey: "siemens",
      companyName: "Siemens AG",
      role: RUN_PARAMS.role,
      field: RUN_PARAMS.field,
      offerType: "ausbildung",
      city: "Berlin",
      state: "Berlin",
      beginn: "2027-08-01",
      salaryLabel: "1.150 €",
      offerSource: "Bundesagentur für Arbeit",
      offerUrl: opp.source_url,
    });
  });
});

// ---------------------------------------------------------------------------
// Pipeline (store mocked, window injected)
// ---------------------------------------------------------------------------

describe("runDiscoveryPipeline", () => {
  let run: DiscoveryRun;
  let finishOutcome: FinishRunOutcome | null;
  let counterSnapshots: Array<Record<string, unknown>>;
  let recordedCompanies: CompanyRecord[];
  let recordedCandidates: DiscoveryCandidate[];

  beforeEach(() => {
    run = baseRun();
    finishOutcome = null;
    counterSnapshots = [];
    recordedCompanies = [];
    recordedCandidates = [];
    vi.mocked(store.getDiscoveryRun).mockReset().mockResolvedValue(run);
    vi.mocked(store.startDiscoveryRun).mockReset().mockResolvedValue(run);
    vi.mocked(store.setRunCounters).mockReset().mockImplementation(
      async (_id: string, _uid: string, counters: Record<string, unknown>) => {
        counterSnapshots.push(counters);
      },
    );
    vi.mocked(store.recordCandidates).mockReset().mockImplementation(
      async (_id: string, candidates: DiscoveryCandidate[]) => {
        recordedCandidates.push(...candidates);
      },
    );
    vi.mocked(store.recordCompany).mockReset().mockImplementation(
      async (_id: string, company: CompanyRecord) => {
        recordedCompanies.push(company);
        return { companyId: `cmp-${recordedCompanies.length}`, created: true };
      },
    );
    vi.mocked(store.finishDiscoveryRun).mockReset().mockImplementation(
      async (_id: string, _uid: string, outcome: FinishRunOutcome) => {
        finishOutcome = outcome;
        return baseRun({ status: outcome.status });
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  const runPipeline = (
    window: (p: OpportunitySearchParams) => Promise<OpportunityWindow>,
    deps: Record<string, unknown> = {},
  ) =>
    runDiscoveryPipeline(RUN_ID, USER_ID, {
      window,
      // Offline and deterministic: no portal adapter and no search provider is
      // requested — the network is never touched by these tests.
      adapters: [],
      searchClient: null,
      isPublicHost: async () => true,
      ...deps,
    });

  it("3 offers / same company (4 name variants) → 1 company, 2 duplicates", async () => {
    const seeds = [
      mkOpp({ id: "arbeitsagentur:A1-S", company_name: "Siemens AG", location_detail: { city: "Berlin", region: "Berlin", country: "DE", postal_code: "10115" } }),
      mkOpp({ id: "arbeitsagentur:A2-S", company_name: "SIEMENS AG", location_detail: { city: "Hamburg", region: "Hamburg", country: "DE", postal_code: "20095" } }),
      mkOpp({ id: "arbeitsagentur:A3-S", company_name: "Siemens Deutschland", location_detail: { city: "München", region: "Bayern", country: "DE", postal_code: "80331" } }),
    ];
    const { fn } = engineWindow(seeds);
    await runPipeline(fn);
    expect(recordedCompanies).toHaveLength(1);
    expect(recordedCompanies[0].companyKey).toBe("siemens");
    expect(finishOutcome).toMatchObject({
      status: "partial",
      foundCompanies: 1,
      uniqueCompanies: 1,
      duplicatesRemoved: 2,
      offersAnalyzed: 3,
    });
    expect(recordedCandidates).toHaveLength(3);
  });

  it("Siemens + Bosch → 2 companies", async () => {
    const seeds = [
      mkOpp({ id: "arbeitsagentur:B1-S", company_name: "Siemens AG" }),
      mkOpp({ id: "arbeitsagentur:B2-S", company_name: "Bosch GmbH" }),
    ];
    const { fn } = engineWindow(seeds);
    await runPipeline(fn);
    expect(recordedCompanies).toHaveLength(2);
    expect(finishOutcome).toMatchObject({ status: "partial", foundCompanies: 2 });
  });

  it("goal=Ausbildung: a Job offer in the window is never counted (defense in depth)", async () => {
    // A window that does NOT emulate the engine's goal filter — the pipeline
    // itself must still reject the contradicting row.
    const fn = async () => ({
      mode: "scan" as const,
      window: [mkJob({ id: "arbeitsagentur:J9-S", company_name: "JobCo GmbH" })],
      total: 1,
      scan_truncated: false,
      exhausted: true,
      degraded: false,
      filter_counts: null,
    });
    await runPipeline(fn);
    expect(recordedCompanies).toHaveLength(0);
    expect(finishOutcome).toMatchObject({ status: "partial", foundCompanies: 0, offersAnalyzed: 1 });
  });

  it("both = two passes (Ausbildung then Job), each goal's offers counted", async () => {
    const seeds = [
      mkOpp({ id: "arbeitsagentur:C1-S", company_name: "Siemens AG" }),
      mkJob({ id: "arbeitsagentur:C2-S", company_name: "Bosch GmbH" }),
    ];
    const { fn, calls } = engineWindow(seeds);
    run = baseRun({ params: { ...RUN_PARAMS, goal: "both" } });
    vi.mocked(store.getDiscoveryRun).mockResolvedValue(run);
    const result = await runPipeline(fn, {});
    expect(calls.map((c) => c.goal)).toEqual(["ausbildung", "arbeit"]);
    expect(recordedCompanies).toHaveLength(2);
    expect(finishOutcome).toMatchObject({ status: "partial", foundCompanies: 2 });
    expect(result.status).toBe("partial");
  });

  it("role-relevance: an offer with no role overlap is excluded (engine matcher)", async () => {
    const seeds = [
      mkOpp({ id: "arbeitsagentur:D1-S", company_name: "Siemens AG" }),
      // Unrelated occupation: fails the role token matcher (no "e", …).
      mkOpp({
        id: "arbeitsagentur:D2-S",
        company_name: "Bäckerei Müller",
        profession: "Bäcker",
        title: "Ausbildung zum Bäcker in der Bäckerei",
      }),
    ];
    const { fn } = engineWindow(seeds);
    await runPipeline(fn);
    expect(recordedCompanies.map((c) => c.companyKey)).toEqual(["siemens"]);
    expect(finishOutcome).toMatchObject({ foundCompanies: 1, offersAnalyzed: 1 });
  });

  it("beginn=year: only offers documented for that year count; missing start → rejected", async () => {
    const seeds = [
      mkOpp({ id: "arbeitsagentur:E1-S", company_name: "Alpha GmbH", valid_from: "2027-08-01" }),
      mkOpp({ id: "arbeitsagentur:E2-S", company_name: "Beta GmbH", valid_from: "2026-09-01" }),
      mkOpp({ id: "arbeitsagentur:E3-S", company_name: "Gamma GmbH", valid_from: null }),
    ];
    const { fn } = engineWindow(seeds); // engine beginn "any" for year mode
    await runPipeline(fn);
    expect(recordedCompanies.map((c) => c.companyKey)).toEqual(["alpha"]);
    expect(finishOutcome).toMatchObject({
      foundCompanies: 1,
      companiesRejected: 2, // Beta (2026) + Gamma (undocumented)
      offersAnalyzed: 3,
      status: "partial",
    });
  });

  it("beginn=month: the engine matcher keeps only that calendar month", async () => {
    const params: DiscoveryRunParams = {
      ...RUN_PARAMS,
      beginn: { mode: "month", month: "2027-08" },
    };
    const { fn } = engineWindow([
      mkOpp({ id: "arbeitsagentur:F1-S", company_name: "Alpha GmbH", valid_from: "2027-08-15" }),
      mkOpp({ id: "arbeitsagentur:F2-S", company_name: "Beta GmbH", valid_from: "2027-09-15" }),
    ]);
    // params must come from the run — patch the mocked run
    run = baseRun({ params });
    vi.mocked(store.getDiscoveryRun).mockResolvedValue(run);
    await runPipeline(fn);
    expect(recordedCompanies.map((c) => c.companyKey)).toEqual(["alpha"]);
  });

  it("beginn=from_now: only documented future starts pass (deterministic far dates)", async () => {
    const params: DiscoveryRunParams = { ...RUN_PARAMS, beginn: { mode: "from_now" } };
    const { fn } = engineWindow([
      mkOpp({ id: "arbeitsagentur:G1-S", company_name: "Future GmbH", valid_from: "2031-01-01" }),
      mkOpp({ id: "arbeitsagentur:G2-S", company_name: "Past GmbH", valid_from: "2019-01-01" }),
    ]);
    run = baseRun({ params });
    vi.mocked(store.getDiscoveryRun).mockResolvedValue(run);
    await runPipeline(fn);
    expect(recordedCompanies.map((c) => c.companyKey)).toEqual(["future"]);
  });

  it("target stop: target=10 → exactly 10 companies, even though 30 exist", async () => {
    const seeds = Array.from({ length: 30 }, (_, i) =>
      mkOpp({ id: `arbeitsagentur:T${i}-S`, company_name: `Company ${String.fromCharCode(65 + (i % 26))} ${i} GmbH` }),
    );
    const { fn, calls } = engineWindow(seeds);
    run = baseRun({ params: { ...RUN_PARAMS, targetCompanies: 10 } });
    vi.mocked(store.getDiscoveryRun).mockResolvedValue(run);
    await runPipeline(fn);
    expect(recordedCompanies).toHaveLength(10);
    expect(calls).toHaveLength(1); // single window (scan), no extra fetch
    expect(finishOutcome).toMatchObject({ status: "completed", foundCompanies: 10 });
    expect(finishOutcome).toMatchObject({ offersAnalyzed: 10 });
  });

  it("upstream pagination: keeps fetching pages until the target is reached", async () => {
    // 120 distinct companies, upstream mode (page-sliced), target 70.
    const seeds = Array.from({ length: 120 }, (_, i) =>
      mkOpp({ id: `arbeitsagentur:P${i}-S`, company_name: `PageCo ${i} GmbH` }),
    );
    const { fn, calls } = engineWindow(seeds, "upstream");
    run = baseRun({ params: { ...RUN_PARAMS, targetCompanies: 70 } });
    vi.mocked(store.getDiscoveryRun).mockResolvedValue(run);
    await runPipeline(fn);
    // Collection walks the bounded upstream pages (3 × 50 for 120 items —
    // the engine's own pagination, budget-capped); COUNTING stops at 70.
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.every((c) => c.goal === "ausbildung")).toBe(true);
    expect(recordedCompanies).toHaveLength(70);
    expect(finishOutcome).toMatchObject({ status: "completed", foundCompanies: 70 });
  });

  it("no fake results: 7 real companies for a target of 100 → partial with 7", async () => {
    const seeds = Array.from({ length: 7 }, (_, i) =>
      mkOpp({ id: `arbeitsagentur:Q${i}-S`, company_name: `RealCo ${i} GmbH` }),
    );
    const { fn } = engineWindow(seeds);
    await runPipeline(fn);
    expect(finishOutcome).toMatchObject({
      status: "partial",
      foundCompanies: 7,
      offersAnalyzed: 7,
    });
  });

  it("source failure in one pass (both): the other pass still runs", async () => {
    const seeds = [mkJob({ id: "arbeitsagentur:S2-S", company_name: "JobCo GmbH" })];
    const { fn: arbeitFn } = engineWindow(seeds);
    const fn = async (params: OpportunitySearchParams): Promise<OpportunityWindow> => {
      if (params.goal === "ausbildung") {
        throw new BaFetchFailure("blocked", {
          kind: "BLOCKED_OR_CHALLENGED",
          status: 403,
          attempts: 3,
        });
      }
      return arbeitFn(params);
    };
    run = baseRun({ params: { ...RUN_PARAMS, goal: "both" } });
    vi.mocked(store.getDiscoveryRun).mockResolvedValue(run);
    await runPipeline(fn);
    expect(finishOutcome).toMatchObject({ status: "partial", foundCompanies: 1 });
    const sources = finishOutcome?.sources as DiscoverySourceStatus[];
    // One pass delivered → the source is "ok" (the run is not failed).
    expect(sources[0]).toMatchObject({ id: "bundesagentur", status: "ok", candidates: 1 });
  });

  it("all passes failed → run failed, source unavailable, honest zero", async () => {
    const fn = async () => {
      throw new BaFetchFailure("blocked", {
        kind: "BLOCKED_OR_CHALLENGED",
        status: 403,
        attempts: 3,
      });
    };
    run = baseRun({ params: { ...RUN_PARAMS, goal: "both" } });
    vi.mocked(store.getDiscoveryRun).mockResolvedValue(run);
    await runPipeline(fn);
    expect(finishOutcome).toMatchObject({
      status: "failed",
      foundCompanies: 0,
      offersAnalyzed: 0,
    });
    const sources = finishOutcome?.sources as DiscoverySourceStatus[];
    expect(sources[0]).toMatchObject({ id: "bundesagentur", status: "unavailable" });
    expect(typeof (finishOutcome?.error as string)).toBe("string");
  });

  it("cancellation: a cancelled run never starts the next pass and never finishes over it", async () => {
    const seeds = [mkOpp({ id: "arbeitsagentur:K1-S", company_name: "Alpha GmbH" })];
    const { fn, calls } = engineWindow(seeds);
    // The cancel write lands between the initial read and the final read
    // (a separate request, as in production): first read → still pending,
    // every later read → cancelled.
    run = baseRun({ params: { ...RUN_PARAMS, goal: "both" } });
    let gets = 0;
    vi.mocked(store.getDiscoveryRun).mockImplementation(async () => {
      gets += 1;
      return gets >= 2 ? baseRun({ status: "cancelled" }) : run;
    });
    // Probe before pass 1 → not yet cancelled; probe before pass 2 →
    // cancelled: pass 2 must never start, and no finish is written over it.
    const isCancelled = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const result = await runPipeline(fn, { isCancelled });
    expect(calls).toHaveLength(1); // only the first pass ran
    expect(isCancelled).toHaveBeenCalledTimes(2);
    expect(store.finishDiscoveryRun).not.toHaveBeenCalled();
    // The pipeline returns the authoritative (cancelled) store state.
    expect(result.status).toBe("cancelled");
  });

  it("server budget: DISCOVERY_MAX_CANDIDATES caps offers analyzed (target lowered to match)", async () => {
    vi.stubEnv("DISCOVERY_MAX_CANDIDATES", "8");
    const seeds = Array.from({ length: 10 }, (_, i) =>
      mkOpp({ id: `arbeitsagentur:L${i}-S`, company_name: i % 2 === 0 ? "Even GmbH" : "Odd GmbH" }),
    );
    const { fn } = engineWindow(seeds);
    await runPipeline(fn);
    // Budget 8 → at most 8 offers analyzed, at most 2 distinct companies.
    expect(finishOutcome).toMatchObject({ offersAnalyzed: 8 });
    expect(finishOutcome).toMatchObject({ foundCompanies: 2 });
    expect(finishOutcome).toMatchObject({ status: "partial" }); // 2 < lowered target 8
  });

  it("a terminal run is never re-executed", async () => {
    const seeds = [mkOpp({ id: "arbeitsagentur:Z1-S" })];
    const { fn, calls } = engineWindow(seeds);
    run = baseRun({ status: "completed" });
    vi.mocked(store.getDiscoveryRun).mockResolvedValue(run);
    const result = await runPipeline(fn);
    expect(result.status).toBe("completed");
    expect(calls).toHaveLength(0);
    expect(store.startDiscoveryRun).not.toHaveBeenCalled();
    expect(store.finishDiscoveryRun).not.toHaveBeenCalled();
  });

  it("counters written to the store are the REAL measured values", async () => {
    const seeds = [
      mkOpp({ id: "arbeitsagentur:M1-S", company_name: "Siemens AG" }),
      mkOpp({ id: "arbeitsagentur:M2-S", company_name: "Siemens AG" }),
      mkOpp({ id: "arbeitsagentur:M3-S", company_name: "Bosch GmbH", valid_from: "2026-01-01" }),
    ];
    const { fn } = engineWindow(seeds);
    await runPipeline(fn);
    const last = counterSnapshots[counterSnapshots.length - 1];
    // Siemens (M1) counted; M2 is its duplicate; Bosch (M3) fails the
    // beginn=2027 gate (documented 2026-01-01) → rejected.
    expect(last).toMatchObject({
      foundCompanies: 1,
      offersAnalyzed: 3,
      uniqueCompanies: 1,
      duplicatesRemoved: 1,
      companiesRejected: 1,
    });
  });
});
