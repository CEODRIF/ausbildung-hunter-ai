import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * Checkpoint ordering of the discovery pipeline.
 *
 * Production incident: the run shares the route's serverless invocation
 * budget (Vercel `maxDuration`) and can be killed at any instant; a kill
 * erases everything that has not been persisted yet. The highest-value
 * phase — the Internet Discovery (Tavily) layer — must therefore be
 * collected AND checkpointed BEFORE any other discovery work (the portal
 * adapters, BA), so that a kill at any later point can never erase its
 * results.
 *
 * Deterministic and fully offline: fetch, DNS and the search provider are
 * stubbed — no third-party site is ever contacted.
 */

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  rows: {} as Record<string, Row[]>,
  finish: null as unknown,
  /** Every persisted progress flush, in write order (each entry = the
   *  `sources` payload of one `setRunCounters` call). */
  checkpoints: [] as Array<Array<Record<string, unknown>>>,
  /** Global event order across adapters, BA, checkpoints and the email
   *  phase — the observable contract these tests assert on. */
  order: [] as string[],
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from(table: string) {
      const rows = () => (state.rows[table] ??= []);
      const api: Record<string, unknown> = {};
      for (const key of ["select", "eq", "in", "order", "limit", "not", "update"]) {
        api[key] = () => api;
      }
      api.maybeSingle = async () => ({ data: rows()[0] ?? null, error: null });
      api.single = async () => ({ data: rows()[0] ?? null, error: null });
      api.then = (r: (v: unknown) => unknown) => r({ data: rows(), error: null });
      api.insert = (values: Row | Row[]) => {
        const list = Array.isArray(values) ? values : [values];
        rows().push(...list);
        return {
          select: () => ({
            single: async () => ({ data: { id: "company-x" }, error: null }),
            maybeSingle: async () => ({ data: list[0] ?? null, error: null }),
          }),
          then: (r: (v: unknown) => unknown) => r({ data: list, error: null }),
        };
      };
      api.upsert = (values: Row | Row[]) => {
        const list = Array.isArray(values) ? values : [values];
        rows().push(...list);
        return {
          select: () => ({ maybeSingle: async () => ({ data: { id: "email-x" }, error: null }) }),
          then: (r: (v: unknown) => unknown) => r({ data: list, error: null }),
        };
      };
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
    finishDiscoveryRun: vi.fn(async (_r: string, _u: string, outcome: unknown) => {
      state.order.push("finish");
      state.finish = outcome;
      return { runId: "r", status: "partial" };
    }),
    setRunCounters: vi.fn(async (_r: string, _u: string, _c: unknown, sources: unknown) => {
      state.order.push("checkpoint");
      // Deep-copy: in production every write serializes the rows to the
      // database (an independent snapshot); the in-memory row objects are
      // patched in place by later phases, so the captured checkpoint must
      // be frozen at write time.
      state.checkpoints.push(structuredClone((sources ?? []) as Array<Record<string, unknown>>));
    }),
    recordCandidates: vi.fn(async () => undefined),
    recordCompany: vi.fn(async () => {
      state.order.push("company");
      return { companyId: "c", completed: true };
    }),
    recordCompanyEmail: vi.fn(async () => "e"),
  };
});

import type { OfferSourceAdapter } from "@/lib/company-discovery/adapter";
import { createSearchAdapter } from "@/lib/company-discovery/adapters";
import { createFetchContext } from "@/lib/company-discovery/fetch-guard";
import { runDiscoveryPipeline } from "@/lib/company-discovery/search";
import { sourceById } from "@/lib/company-discovery/sources";
import { type DiscoveryRun } from "@/lib/company-discovery/types";
import { BA_SOURCE_ID, BaFetchFailure } from "@/lib/opportunities/search";
import type { OpportunityWindow } from "@/lib/opportunities/types";
import { getWebSearchClient } from "@/lib/web-search";

const RUN_ID = "99999999-9999-4999-8999-999999999999";
const USER_ID = "88888888-8888-4888-8888-888888888888";

// ---------------------------------------------------------------------------
// Fixtures (all offline)
// ---------------------------------------------------------------------------

function jobPosting(company: string, website: string, description = ""): string {
  return `<!doctype html><html><head>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"JobPosting","title":"Ausbildung Kauffrau im E-Commerce (m/w/d)","employmentType":"APPRENTICESHIP","description":${JSON.stringify(description)},"hiringOrganization":{"name":${JSON.stringify(company)},"url":${JSON.stringify(website)}},"jobLocation":{"address":{"addressLocality":"Köln"}}}
</script></head><body>Ausbildung bei ${company} in Köln ${description}</body></html>`;
}

const PLAIN_PAGE =
  "<html><body><h1>Doppelt GmbH</h1><p>Telefon 0221 123456. Bitte nutzen Sie unser Kontaktformular.</p></body></html>";

function html(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
}

function plainRobots(): Response {
  return new Response("User-agent: *\nDisallow:\n", {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
}

/** The real Tavily endpoint answered offline, exactly like the provider. */
function tavilyResponse(urls: string[]): Response {
  return new Response(
    JSON.stringify({ results: urls.map((url) => ({ title: url, url, snippet: "" })) }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

type Route = [match: (url: string) => boolean, respond: () => Response];

function makeFetch(routes: Route[], requested: string[]) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    requested.push(url);
    if (url === "https://api.tavily.com/search") state.order.push("tavily");
    for (const [match, respond] of routes) {
      if (match(url)) return respond();
    }
    return html(PLAIN_PAGE);
  });
}

function baseRun(): DiscoveryRun {
  return {
    runId: RUN_ID,
    status: "pending",
    params: {
      field: "Marketing / E-Commerce",
      role: "Kaufmann im E-Commerce",
      beginn: { mode: "from_now" },
      goal: "ausbildung",
      targetCompanies: 5,
      onlyPublicEmail: false,
    },
    progress: {
      status: "pending",
      targetCompanies: 5,
      foundCompanies: 0,
      offersAnalyzed: 0,
      uniqueCompanies: 0,
      duplicatesRemoved: 0,
      companiesRejected: 0,
      emailsFound: 0,
      noPublicEmail: 0,
      sourcesBlocked: 0,
      companiesProcessed: 0,
      sources: [],
    },
    creditsCharged: 0,
    error: null,
    createdAt: "2026-10-03T10:00:00.000Z",
    startedAt: null,
    finishedAt: null,
  };
}

function scanWindow(): OpportunityWindow {
  return {
    mode: "scan",
    window: [],
    total: 0,
    scan_truncated: false,
    exhausted: true,
    degraded: false,
    filter_counts: { any: 0, today: 0, yesterday: 0, week: 0, twoWeeks: 0, fourWeeks: 0 },
  } as unknown as OpportunityWindow;
}

function fakePortalAdapter(): OfferSourceAdapter {
  const source = sourceById("ausbildung-de");
  return {
    id: "ausbildung-de",
    displayName: source?.displayName ?? "ausbildung-de",
    category: "ausbildung",
    policy: "enabled_public",
    async searchOffers() {
      state.order.push("portal");
      return { status: "ok", offers: [] };
    },
  };
}

type FinishShape = {
  status: string;
  foundCompanies: number;
  companiesProcessed: number;
  emailsFound: number;
  noPublicEmail: number;
  sourcesBlocked: number;
  sources: Array<{
    id: string;
    status: string;
    candidates?: number;
    stats?: { queriesExecuted: number; resultsInspected: number };
  }>;
};

function searchRowOf(checkpoint: Array<Record<string, unknown>> | undefined) {
  return checkpoint?.find((s) => s.id === "search-api");
}

/** Offline pipeline seams around the REAL search adapter + REAL provider
 *  client (only the network is stubbed), exactly like production wires it. */
async function startPipeline(window: () => Promise<OpportunityWindow>) {
  const requested: string[] = [];
  const mockFetch = makeFetch(
    [
      [(u) => u === "https://api.tavily.com/search", () => tavilyResponse(["https://doppelt.de/ausbildung/1"])],
      [(u) => u.includes("/robots.txt"), plainRobots],
      [(u) => u === "https://doppelt.de/ausbildung/1", () => html(jobPosting("Doppelt GmbH", "https://doppelt.de"))],
    ],
    requested,
  );
  vi.stubGlobal("fetch", mockFetch);
  const store = await import("@/lib/company-discovery/runs");
  vi.mocked(store.getDiscoveryRun).mockResolvedValue(baseRun());
  vi.mocked(store.startDiscoveryRun).mockResolvedValue(baseRun());

  const savedKey = process.env.TAVILY_API_KEY;
  process.env.TAVILY_API_KEY = "tvly-test-fake-123456";
  const offerClient = getWebSearchClient({ maxRequests: 12 });
  const searchAdapter = createSearchAdapter(offerClient, {}, {
    maxQueries: 2,
    maxResultsPerQuery: 1,
    maxPagesPerQuery: 1,
    maxPagesToFetch: 1,
  });
  const pipeline = runDiscoveryPipeline(RUN_ID, USER_ID, {
    window,
    adapters: [fakePortalAdapter(), searchAdapter],
    searchClient: null,
    offerSearchClient: null,
    fetchContext: createFetchContext({
      fetchImpl: mockFetch as unknown as typeof fetch,
      isPublicHost: async () => true,
      sleep: async () => undefined,
    }),
    isCancelled: async () => false,
  });
  // The env key must not leak into other tests even if the pipeline throws.
  queueMicrotask(() => {
    if (savedKey === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = savedKey;
  });
  return pipeline;
}

beforeEach(() => {
  state.rows = {};
  state.finish = null;
  state.checkpoints = [];
  state.order = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// The ordering contract: Internet Discovery → checkpoint → BA → email
// ---------------------------------------------------------------------------

describe("the discovery pipeline's checkpoint order", () => {
  it("persists Internet Discovery (search-api + stats) BEFORE it touches BA or the portal adapters", async () => {
    await (await startPipeline(async () => {
      state.order.push("ba");
      return scanWindow();
    }));

    // --- the ORDER contract (this test fails if BA ever runs before the
    // internet-discovery checkpoint)
    const tavily = state.order.indexOf("tavily");
    const firstCheckpoint = state.order.indexOf("checkpoint");
    const portal = state.order.indexOf("portal");
    const ba = state.order.indexOf("ba");
    const firstCompany = state.order.indexOf("company");
    expect(tavily).toBeGreaterThanOrEqual(0); // the provider was actually queried
    expect(firstCheckpoint).toBeGreaterThan(tavily); // …and ran before the first checkpoint
    expect(firstCheckpoint).toBeGreaterThanOrEqual(0);
    expect(ba).toBeGreaterThan(firstCheckpoint); // BA only AFTER the internet checkpoint
    expect(portal).toBeGreaterThan(firstCheckpoint); // portals only AFTER the internet checkpoint
    expect(portal).toBeLessThan(ba); // portals still before BA
    expect(firstCompany).toBeGreaterThan(ba); // email resolution only AFTER BA

    // --- the FIRST checkpoint already carries the search layer's honest
    // stats — a kill at any later point cannot erase them
    const checkpoint1 = state.checkpoints[0];
    const searchRow = searchRowOf(checkpoint1);
    expect(searchRow?.status).toBe("ok");
    expect(searchRow?.stats).toMatchObject({ queriesExecuted: 1, resultsInspected: 1 });
    // …and it must NOT claim the BA source ran: it was still `running`.
    expect(checkpoint1?.find((s) => s.id === BA_SOURCE_ID)?.status).toBe("running");

    // --- the finish state keeps everything and the §4.8 invariant holds
    const finish = state.finish as FinishShape;
    expect(finish.foundCompanies).toBe(1);
    expect(finish.sources.find((s) => s.id === "search-api")?.status).toBe("ok");
    expect(
      finish.emailsFound + finish.noPublicEmail + finish.sourcesBlocked,
    ).toBe(finish.companiesProcessed);
  });

  it("BA hangs: the search checkpoint is already persisted before the hang, and the internet-discovery results survive to the finish", async () => {
    let releaseBa: (window: OpportunityWindow) => void = () => undefined;
    const baGate = new Promise<OpportunityWindow>((resolve) => {
      releaseBa = resolve;
    });
    const pipeline = startPipeline(async () => {
      state.order.push("ba-start");
      return baGate;
    });

    // Wait until BA has been REACHED (the hang point) — deterministically.
    await vi.waitFor(
      () => {
        expect(state.order).toContain("ba-start");
      },
      { timeout: 15000 },
    );

    // While BA is hanging: the internet-discovery checkpoint is ALREADY in
    // the database — the search results can no longer be lost.
    expect(state.order.indexOf("checkpoint")).toBeLessThan(state.order.indexOf("ba-start"));
    const checkpoint1 = state.checkpoints[0];
    const searchRow = searchRowOf(checkpoint1);
    expect(searchRow?.status).toBe("ok");
    expect((searchRow?.stats as { queriesExecuted: number })?.queriesExecuted).toBeGreaterThan(0);

    // Release BA (an empty window) and let the run finish per existing
    // behavior — the internet-discovery data must still be there.
    releaseBa(scanWindow());
    await pipeline;

    const finish = state.finish as FinishShape;
    expect(finish).toBeDefined();
    expect(finish.sources.find((s) => s.id === "search-api")?.status).toBe("ok");
    expect(
      finish.sources.find((s) => s.id === "search-api")?.stats?.queriesExecuted,
    ).toBeGreaterThan(0);
    expect(finish.foundCompanies).toBe(1);
    expect(finish.status).toBe("partial"); // existing behavior: found > 0, target missed
    expect(
      finish.emailsFound + finish.noPublicEmail + finish.sourcesBlocked,
    ).toBe(finish.companiesProcessed);
  });

  it("BA fails with BaFetchFailure: search-api stays ok and persisted, BA is honestly reported unavailable, the run ends per existing behavior", async () => {
    await (await startPipeline(async () => {
      state.order.push("ba-fail");
      throw new BaFetchFailure("Bundesagentur could not be reached right now.", {
        kind: "TIMEOUT",
        attempts: 3,
      });
    }));

    // The data was never at risk: the FIRST checkpoint (before BA) already
    // carried the search layer's results.
    expect(state.order.indexOf("checkpoint")).toBeLessThan(state.order.indexOf("ba-fail"));
    const searchRow = searchRowOf(state.checkpoints[0]);
    expect(searchRow?.status).toBe("ok");
    expect((searchRow?.stats as { queriesExecuted: number })?.queriesExecuted).toBeGreaterThan(0);

    const finish = state.finish as FinishShape;
    // BA is reported `unavailable` (all passes failed) — but the run still
    // delivers the internet-discovery company.
    expect(finish.sources.find((s) => s.id === BA_SOURCE_ID)?.status).toBe("unavailable");
    expect(finish.sources.find((s) => s.id === "search-api")?.status).toBe("ok");
    expect(
      finish.sources.find((s) => s.id === "search-api")?.stats?.queriesExecuted,
    ).toBeGreaterThan(0);
    expect(finish.foundCompanies).toBe(1);
    expect(finish.status).toBe("partial"); // existing behavior: found > 0
    expect(
      finish.emailsFound + finish.noPublicEmail + finish.sourcesBlocked,
    ).toBe(finish.companiesProcessed);
  });
});
