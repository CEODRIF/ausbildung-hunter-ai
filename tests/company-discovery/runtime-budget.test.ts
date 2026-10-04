import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * MAX_RUNTIME (§19): the run's wall-clock budget must ACTUALLY stop the work —
 * both loops that can outlive it:
 *
 *  1. A long single phase (dozens of company email passes) stops MID-PHASE:
 *     the run finishes from its measured counters as an honest `partial`, and
 *     the companies counted before the gate are never lost;
 *  2. The agentic search loop (planner → provider → next batch) cannot run
 *     past the budget: the provider stops being asked even though the planner
 *     would keep planning — no infinite loop.
 *
 * Everything is offline and deterministic: stubbed fetch, stubbed provider,
 * injected clock (`deps.now`) — no real waiting, no network.
 */

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  finishOutcome: null as unknown,
  companies: [] as Row[],
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from(table: string) {
      const rows = () => (state.db[table] ??= []);
      const api: Record<string, unknown> = {};
      const chain = () => api;
      for (const key of ["select", "eq", "in", "order", "limit", "not", "update", "insert", "upsert"]) {
        api[key] = chain;
      }
      api.maybeSingle = async () => ({ data: rows()[0] ?? null, error: null });
      api.single = async () => ({ data: rows()[0] ?? null, error: null });
      api.then = (resolveThen: (value: unknown) => unknown) =>
        resolveThen({ data: rows(), error: null });
      (api.insert as unknown) = (values: Row | Row[]) => {
        const list = Array.isArray(values) ? values : [values];
        if (table === "discovery_companies") state.companies.push(...list);
        rows().push(...list);
        return {
          select: () => ({
            single: async () => ({ data: { id: `company-${state.companies.length}` }, error: null }),
            maybeSingle: async () => ({ data: list[0] ?? null, error: null }),
          }),
          then: (r: (v: unknown) => unknown) => r({ data: list, error: null }),
        };
      };
      (api.update as unknown) = () => ({
        eq: () => ({
          eq: () => ({
            eq: () => ({
              in: () => ({
                select: () => ({
                  maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
                }),
              }),
            }),
          }),
        }),
      });
      return api;
    },
  }),
}));

vi.mock("@/lib/company-discovery/runs", async () => {
  const actual = await vi.importActual<typeof import("@/lib/company-discovery/runs")>(
    "@/lib/company-discovery/runs",
  );
  return {
    ...actual,
    getDiscoveryRun: vi.fn(),
    startDiscoveryRun: vi.fn(),
    finishDiscoveryRun: vi.fn(async (_id: string, _uid: string, outcome: unknown) => {
      state.finishOutcome = outcome;
      return { runId: "r", status: "partial" };
    }),
    setRunCounters: vi.fn(async () => undefined),
    recordCandidates: vi.fn(async () => undefined),
    recordCompany: vi.fn(async () => ({ companyId: "c", created: true })),
    recordCompanyEmail: vi.fn(async () => "e"),
  };
});

import { createFetchContext } from "@/lib/company-discovery/fetch-guard";
import { runDiscoveryPipeline } from "@/lib/company-discovery/search";
import type { DiscoveryRun, DiscoveryRunParams } from "@/lib/company-discovery/types";
import type { OpportunityWindow } from "@/lib/opportunities/types";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";

const RUN_PARAMS: DiscoveryRunParams = {
  field: "Marketing / E-Commerce",
  role: "Kaufmann im E-Commerce",
  beginn: { mode: "from_now" },
  goal: "ausbildung",
  targetCompanies: 10,
  onlyPublicEmail: true,
};

beforeEach(() => {
  state.db = {};
  state.finishOutcome = null;
  state.companies = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function baseRun(): DiscoveryRun {
  return {
    runId: RUN_ID,
    status: "pending",
    params: RUN_PARAMS,
    progress: {
      status: "pending",
      targetCompanies: 10,
      foundCompanies: 0,
      offersAnalyzed: 0,
      uniqueCompanies: 0,
      duplicatesRemoved: 0,
      companiesRejected: 0,
      emailsFound: 0,
      noPublicEmail: 0,
      sourcesBlocked: 0,
      companiesProcessed: 0,
      currentQuery: null,
      currentSource: null,
      currentStrategy: null,
      sources: [],
    },
    creditsCharged: 0,
    error: null,
    createdAt: "2026-10-03T10:00:00.000Z",
    startedAt: null,
    finishedAt: null,
  };
}

/** One BA opportunity; every company publishes an email on its impressum. */
function opportunity(index: number): import("@/lib/opportunities/types").Opportunity {
  return {
    id: `arbeitsagentur:${index}-S`,
    goal: "ausbildung" as const,
    title: "Ausbildung Kaufmann im E-Commerce",
    company_name: `Musterbetrieb ${index} GmbH`,
    location_detail: { city: "Köln", region: "Nordrhein-Westfalen", country: "DE", postal_code: "50667" },
    valid_from: "2027-08-01",
    salary: { label: "1150 €" },
    source_name: "Bundesagentur für Arbeit",
    source_url: `https://www.arbeitsagentur.de/jobsuche/jobdetail/${index}`,
    contact: { email: `bewerbung@agentur-${index}.de`, phone: null, name: null },
    enrichment: {
      website_url: `https://firma-${index}.de`,
      website_source: `https://firma-${index}.de/impressum`,
      email: null,
    },
  } as unknown as import("@/lib/opportunities/types").Opportunity;
}

/** An empty BA scan (the test's run has nothing left in the window). */
function emptyScan(): () => Promise<OpportunityWindow> {
  return async () =>
    ({
      mode: "scan",
      window: [],
      total: 0,
      scan_truncated: false,
      exhausted: true,
      degraded: false,
      filter_counts: { any: 0, today: 0, yesterday: 0, week: 0, twoWeeks: 0, fourWeeks: 0 },
    } as unknown as OpportunityWindow);
}

/**
 * Offline fetch: robots allowed; the named companies' `/impressum` pages
 * publish a real email; every other page is an honest empty page.
 */
function mockFetchFor(emailHosts: readonly number[]) {
  const calls: string[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);
    if (url.includes("/robots.txt")) {
      return new Response("User-agent: *\nDisallow:\n", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }
    const host = new URL(url).hostname;
    const index = Number(host.replace(/\D/g, ""));
    if (url.endsWith("/impressum") && emailHosts.includes(index)) {
      return new Response(
        `<html><body>Impressum — Musterbetrieb ${index} GmbH, Köln. Kontakt: bewerbung@firma-${index}.de</body></html>`,
        { status: 200, headers: { "content-type": "text/html" } },
      );
    }
    return new Response(
      `<html><body>Keine Angebote gefunden.</body></html>`,
      { status: 200, headers: { "content-type": "text/html" } },
    );
  });
  vi.stubGlobal("fetch", impl);
  return { impl: impl as unknown as typeof fetch, calls };
}

describe("MAX_RUNTIME — the budget ACTUALLY stops the work (§19)", () => {
  it("stops a long phase MID-RUN — the run finishes as an honest partial and keeps the counted companies", async () => {
    const seeds = Array.from({ length: 30 }, (_, i) => opportunity(i));
    const window = async (): Promise<OpportunityWindow> =>
      ({
        mode: "scan",
        window: seeds,
        total: seeds.length,
        scan_truncated: false,
        exhausted: true,
        degraded: false,
        filter_counts: { any: seeds.length, today: 0, yesterday: 0, week: 0, twoWeeks: 0, fourWeeks: 0 },
      } as unknown as OpportunityWindow);
    const { impl } = mockFetchFor(Array.from({ length: 30 }, (_, i) => i));
    vi.stubEnv("DISCOVERY_MAX_RUNTIME_MS", "3000");
    vi.stubEnv("DISCOVERY_MAX_EMAIL_SITE_PASSES", "30");

    // The injected clock advances 500ms PER GATE CHECK: the 3000ms budget
    // elapses after a handful of offers were processed — MID-PHASE, with
    // offers left in the queue. (Without the gate the loop would run all 30.)
    let t = 0;

    const store = await import("@/lib/company-discovery/runs");
    const run = baseRun();
    vi.mocked(store.getDiscoveryRun).mockResolvedValue(run);
    vi.mocked(store.startDiscoveryRun).mockResolvedValue(run);

    await runDiscoveryPipeline(RUN_ID, USER_ID, {
      window,
      adapters: [],
      searchClient: null,
      fetchContext: createFetchContext({
        fetchImpl: impl,
        isPublicHost: async () => true,
        sleep: async () => undefined,
      }),
      isCancelled: async () => false,
      now: () => (t += 500),
    });

    const outcome = state.finishOutcome as {
      status: string;
      foundCompanies: number;
      offersAnalyzed: number;
      companiesProcessed: number;
      emailsFound: number;
      noPublicEmail: number;
      sourcesBlocked: number;
    };
    // The run FINISHED (not stuck, not killed): an honest `partial` …
    expect(outcome.status).toBe("partial");
    // …because the budget really stopped the phase: only a minority of the
    // 30 queued offers was processed …
    expect(outcome.offersAnalyzed).toBeGreaterThanOrEqual(2);
    expect(outcome.offersAnalyzed).toBeLessThan(30);
    // …and the companies counted BEFORE the gate were kept, never lost …
    expect(outcome.foundCompanies).toBeGreaterThanOrEqual(1);
    expect(outcome.foundCompanies).toBeLessThan(30);
    // …with the §4.8 outcome invariant intact for everything processed.
    expect(outcome.emailsFound + outcome.noPublicEmail + outcome.sourcesBlocked).toBe(
      outcome.companiesProcessed,
    );
    expect(outcome.companiesProcessed).toBe(outcome.offersAnalyzed);
  });

  it("the agentic search loop cannot run past the budget — the provider is not asked again (no infinite loop)", async () => {
    const { impl } = mockFetchFor([]);
    vi.stubEnv("DISCOVERY_MAX_RUNTIME_MS", "4000");
    // A deliberately WIDE query budget: the clock must be what closes the
    // loop, not the query budget.
    vi.stubEnv("DISCOVERY_MAX_SEARCH_QUERIES", "100");

    const providerCalls: string[] = [];
    const offerSearchClient = {
      name: "tavily" as const,
      search: async (query: string) => {
        providerCalls.push(query);
        return []; // zero results forever — the planner keeps planning
      },
    };

    // 500ms per clock read → the 4000ms budget trips after a few batches.
    let t = 0;

    const store = await import("@/lib/company-discovery/runs");
    const run = baseRun();
    vi.mocked(store.getDiscoveryRun).mockResolvedValue(run);
    vi.mocked(store.startDiscoveryRun).mockResolvedValue(run);

    await runDiscoveryPipeline(RUN_ID, USER_ID, {
      window: emptyScan(),
      offerSearchClient,
      searchClient: null,
      fetchContext: createFetchContext({
        fetchImpl: impl,
        isPublicHost: async () => true,
        sleep: async () => undefined,
      }),
      isCancelled: async () => false,
      now: () => (t += 500),
    });

    const outcome = state.finishOutcome as {
      status: string;
      foundCompanies: number;
    };
    // The run finished honestly (0 companies, target 10) …
    expect(outcome.status).toBe("partial");
    expect(outcome.foundCompanies).toBe(0);
    // …the loop really RAN (real planned batches reached the provider) …
    expect(providerCalls.length).toBeGreaterThan(0);
    // …and it STOPPED far below the wide query budget: the runtime gate
    // closed the loop, so it can never spin forever.
    expect(providerCalls.length).toBeLessThan(100);
  });
});
