import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * The expanded Internet Discovery radius (brief §3–§17).
 *
 * Deterministic and fully offline (fetch, DNS and the search provider are
 * stubbed — no third-party site is ever contacted):
 *  - the expanded German query families (§4);
 *  - the per-query / per-result / per-run page budgets (§3);
 *  - cross-query company deduplication: 4 different queries → 1 company (§7/§8);
 *  - resilience: success / provider error / CAPTCHA / success (§17);
 *  - the expanded company-site path set under the 6-page cap (§6);
 *  - robots / CAPTCHA / SSRF security (never bypassed);
 *  - email: a literal published address is accepted, nothing is guessed (§12);
 *  - the §4.8 outcome invariant end-to-end.
 */

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  rows: {} as Record<string, Row[]>,
  finish: null as unknown,
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
      state.finish = outcome;
      return { runId: "r", status: "partial" };
    }),
    setRunCounters: vi.fn(async () => undefined),
    recordCandidates: vi.fn(async () => undefined),
    recordCompany: vi.fn(async () => ({ companyId: "c", completed: true })),
    recordCompanyEmail: vi.fn(async () => "e"),
  };
});

import { createSearchAdapter } from "@/lib/company-discovery/adapters";
import { discoverCompanySiteOffers } from "@/lib/company-discovery/company-site";
import { createFetchContext } from "@/lib/company-discovery/fetch-guard";
import {
  AUSBILDUNG_ANCHORS,
  generateSearchQueries,
  isGermanState,
} from "@/lib/company-discovery/queries";
import { runDiscoveryPipeline } from "@/lib/company-discovery/search";
import {
  discoveryFanout,
  discoveryLimits,
  DISCOVERY_FANOUT_CAPS,
  type DiscoveryRun,
} from "@/lib/company-discovery/types";
import type { OpportunitySearchParams, OpportunityWindow } from "@/lib/opportunities/types";
import { getWebSearchClient } from "@/lib/web-search";
import type { WebSearchClient, WebSearchResult } from "@/lib/web-search";

const RUN_ID = "77777777-7777-4777-8777-777777777777";
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

const CAPTCHA_PAGE = "<title>Just a moment…</title>";

function html(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
}

function plainRobots(): Response {
  return new Response("User-agent: *\nDisallow:\n", {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
}

type Route = [match: (url: string) => boolean, respond: () => Response];

function makeFetch(routes: Route[], requested: string[]) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    requested.push(url);
    for (const [match, respond] of routes) {
      if (match(url)) return respond();
    }
    return html(PLAIN_PAGE);
  });
}

function fakeSearchClient(resultsPerCall: WebSearchResult[][], throwsOn: number[] = []) {
  const calls: Array<{ query: string; maxResults: number }> = [];
  let n = 0;
  const client = {
    name: "tavily",
    async search(query: string, maxResults: number): Promise<WebSearchResult[]> {
      const callNo = n;
      n += 1;
      calls.push({ query, maxResults });
      if (throwsOn.includes(callNo)) throw new Error("provider failed");
      const results = resultsPerCall[Math.min(callNo, resultsPerCall.length - 1)] ?? [];
      return results;
    },
  } as unknown as WebSearchClient;
  return { client, calls };
}

function resultOf(url: string): WebSearchResult {
  return { title: url, url, snippet: "" };
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

function emptyWindow(): () => Promise<OpportunityWindow> {
  return async () =>
    ({
      mode: "scan",
      window: [],
      total: 0,
      scan_truncated: false,
      exhausted: true,
      degraded: false,
      filter_counts: { any: 0, today: 0, yesterday: 0, week: 0, twoWeeks: 0, fourWeeks: 0 },
    }) as unknown as OpportunityWindow;
}

const CRITERIA = {
  role: "Kaufmann im E-Commerce",
  keyword: "Marketing / E-Commerce",
  goal: "ausbildung",
} as unknown as Parameters<typeof generateSearchQueries>[0];

/** The same criteria for the adapter, which takes the full search params. */
const ADAPTER_CRITERIA = CRITERIA as unknown as OpportunitySearchParams;

const CRITERIA_CITY = {
  ...CRITERIA,
  location: "Köln",
  cities: [],
} as unknown as Parameters<typeof generateSearchQueries>[0];

const CRITERIA_STATE = {
  ...CRITERIA,
  location: "Nordrhein-Westfalen",
  cities: [],
} as unknown as Parameters<typeof generateSearchQueries>[0];

beforeEach(() => {
  state.rows = {};
  state.finish = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// §4 — the expanded query families
// ---------------------------------------------------------------------------

describe("the expanded query families", () => {
  it("generates 10+ deterministic, deduplicated families for a profession", () => {
    const a = generateSearchQueries(CRITERIA);
    const b = generateSearchQueries(CRITERIA);
    expect(a).toEqual(b); // deterministic
    expect(a.length).toBeGreaterThanOrEqual(10);
    expect(new Set(a).size).toBe(a.length); // duplicates removed
    for (const query of a) {
      expect(query).toContain("Kaufmann im E-Commerce"); // profession included
    }
  });

  it("uses the full German Ausbildung terminology as anchors", () => {
    const all = generateSearchQueries(CRITERIA, {}, 20);
    for (const anchor of AUSBILDUNG_ANCHORS) {
      expect(all.some((q) => q.startsWith(`${anchor} `)), `anchor ${anchor}`).toBe(true);
    }
  });

  it("includes the CITY dimension when the criteria carry a city", () => {
    const withCity = generateSearchQueries(CRITERIA_CITY, {}, 20);
    for (const anchor of ["Ausbildung", "Ausbildungsplatz", "Azubi", "Ausbildungsbetrieb"]) {
      expect(withCity).toContain(`${anchor} Kaufmann im E-Commerce Köln`);
    }
  });

  it("uses the broader 2-anchor family for a recognized Bundesland", () => {
    expect(isGermanState("Nordrhein-Westfalen")).toBe(true);
    expect(isGermanState("Köln")).toBe(false);
    const withState = generateSearchQueries(CRITERIA_STATE, {}, 20);
    expect(withState).toContain("Ausbildung Kaufmann im E-Commerce Nordrhein-Westfalen");
    expect(withState).toContain("Ausbildungsplatz Kaufmann im E-Commerce Nordrhein-Westfalen");
    // The city-specific anchors do NOT apply to a state.
    expect(withState).not.toContain("Azubi Kaufmann im E-Commerce Nordrhein-Westfalen");
  });

  it("falls back to the first selected city when no free-text location is set", () => {
    const withCities = generateSearchQueries(
      { ...CRITERIA, location: "", cities: ["Hamburg"] } as unknown as typeof CRITERIA,
      {},
      20,
    );
    expect(withCities).toContain("Ausbildung Kaufmann im E-Commerce Hamburg");
  });

  it("never issues a generic (unanchored) job query", () => {
    const all = generateSearchQueries(CRITERIA_CITY, { beginnYear: 2027 }, 20);
    expect(all).not.toContain("Kaufmann im E-Commerce");
    expect(all).not.toContain("Marketing / E-Commerce");
    // Every query carries an Ausbildung/Azubi/Lehr anchor or the beginn year.
    for (const query of all) {
      expect(
        AUSBILDUNG_ANCHORS.some((anchor) => query.toLowerCase().includes(anchor.toLowerCase())) ||
          query.includes("2027"),
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// §3/§14 — the validated fan-out configuration
// ---------------------------------------------------------------------------

describe("the fan-out configuration", () => {
  it("documents the hard caps for every radius value", () => {
    expect(DISCOVERY_FANOUT_CAPS).toEqual({
      maxSearchQueries: 20,
      maxSearchResultsPerQuery: 20,
      maxSearchPagesPerQuery: 10,
      maxSearchPagesToFetch: 60,
      maxCompanySiteOfferCompanies: 20,
      maxCompanySiteOfferPages: 8,
    });
    const limits = discoveryLimits();
    const fanout = discoveryFanout();
    expect(fanout.maxSearchQueriesPerRun).toBe(limits.maxSearchQueries);
    expect(fanout.maxResultsPerQuery).toBe(limits.maxSearchResultsPerQuery);
    expect(fanout.maxSearchPagesPerQuery).toBe(limits.maxSearchPagesPerQuery);
    expect(fanout.maxSearchPagesPerRun).toBe(limits.maxSearchPagesToFetch);
    expect(fanout.maxCompanySiteCompaniesPerRun).toBe(limits.maxCompanySiteOfferCompanies);
    expect(fanout.maxCompanySitePagesPerCompany).toBe(limits.maxCompanySiteOfferPages);
    expect(fanout.maxConcurrentCompanies).toBeLessThanOrEqual(5);
    expect(fanout.maxRequestsPerHost).toBe(1);
    expect(fanout.minHostDelayMs).toBeGreaterThanOrEqual(1000);
    expect(fanout.requestTimeoutMs).toBe(10_000);
  });
});

// ---------------------------------------------------------------------------
// §3/§17 — the search adapter's page budgets and provider isolation
// ---------------------------------------------------------------------------

describe("the search adapter budgets", () => {
  const ctx = (requested: string[], isPublic = true) => {
    const mockFetch = makeFetch(
      [[(u) => u.includes("/robots.txt"), plainRobots]],
      requested,
    );
    // fetchRobots() reads the GLOBAL fetch — keep the test offline.
    vi.stubGlobal("fetch", mockFetch);
    return createFetchContext({
      fetchImpl: mockFetch as unknown as typeof fetch,
      isPublicHost: async () => isPublic,
      sleep: async () => undefined,
    });
  };
  /** Page requests only (robots.txt fetches are not page inspections). */
  const pages = (requested: string[]) => requested.filter((u) => !u.includes("/robots.txt"));

  it("passes the results-per-query budget to the provider and never fetches more", async () => {
    const urls = Array.from(
      { length: 12 },
      (_, i) => `https://firma${i}.de/ausbildung/${i}`,
    );
    const { client, calls } = fakeSearchClient([urls.map(resultOf)]);
    const requested: string[] = [];
    const adapter = createSearchAdapter(client, {}, {
      maxQueries: 1,
      maxResultsPerQuery: 10,
      maxPagesPerQuery: 10,
      maxPagesToFetch: 20,
    });
    const result = await adapter.searchOffers(ADAPTER_CRITERIA, ctx(requested));
    expect(calls).toHaveLength(1);
    expect(calls[0].maxResults).toBe(10); // the provider sees the budget
    expect(pages(requested).length).toBeLessThanOrEqual(10); // and so does the fetcher
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.stats?.resultsInspected).toBeLessThanOrEqual(10);
    }
  });

  it("fetches at most `maxPagesPerQuery` pages PER QUERY", async () => {
    const make = (prefix: string) =>
      Array.from({ length: 5 }, (_, i) => resultOf(`https://${prefix}.de/ausbildung/${i}`));
    const { client } = fakeSearchClient([make("p1"), make("p2")]);
    const requested: string[] = [];
    const adapter = createSearchAdapter(client, {}, {
      maxQueries: 2,
      maxResultsPerQuery: 10,
      maxPagesPerQuery: 2,
      maxPagesToFetch: 20,
    });
    const result = await adapter.searchOffers(ADAPTER_CRITERIA, ctx(requested));
    // 2 pages for query 1 + 2 pages for query 2 — the remaining results stay
    // un-fetched, per query.
    expect(pages(requested)).toHaveLength(4);
    expect(requested.some((u) => u.includes("p1.de/ausbildung/2"))).toBe(false);
    expect(result.status).toBe("ok");
  });

  it("stops at the per-run page total (the global safety bound)", async () => {
    const make = (prefix: string) =>
      Array.from({ length: 5 }, (_, i) => resultOf(`https://${prefix}.de/ausbildung/${i}`));
    const { client, calls } = fakeSearchClient([
      make("q1"),
      make("q2"),
      make("q3"),
      make("q4"),
    ]);
    const requested: string[] = [];
    const adapter = createSearchAdapter(client, {}, {
      maxQueries: 4,
      maxResultsPerQuery: 10,
      maxPagesPerQuery: 10,
      maxPagesToFetch: 3,
    });
    const result = await adapter.searchOffers(ADAPTER_CRITERIA, ctx(requested));
    expect(calls).toHaveLength(1); // the run budget was spent inside query 1
    expect(pages(requested)).toHaveLength(3);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.stats).toEqual({ queriesExecuted: 1, resultsInspected: 3 });
    }
  });

  it("keeps SSRF protection active for provider results", async () => {
    const { client } = fakeSearchClient([[resultOf("https://localhost/ausbildung")]]);
    const requested: string[] = [];
    const adapter = createSearchAdapter(client, {}, {
      maxQueries: 1,
      maxResultsPerQuery: 1,
      maxPagesPerQuery: 5,
      maxPagesToFetch: 5,
    });
    const result = await adapter.searchOffers(ADAPTER_CRITERIA, ctx(requested, false));
    expect(requested).toEqual([]); // a non-public host is never contacted
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.offers).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// §6 — the expanded company-site path under the 6-page cap
// ---------------------------------------------------------------------------

describe("the expanded company-site pass", () => {
  it("inspects homepage + the well-known offer AND contact paths, capped at 6 pages", async () => {
    const requested: string[] = [];
    const mockFetch = makeFetch(
      [
        [(u) => u.includes("/robots.txt"), plainRobots],
        [(u) => u === "https://doppelt.de", () => html(PLAIN_PAGE)],
      ],
      requested,
    );
    vi.stubGlobal("fetch", mockFetch);
    const ctx = createFetchContext({
      fetchImpl: mockFetch as unknown as typeof fetch,
      isPublicHost: async () => true,
      sleep: async () => undefined,
    });
    const result = await discoverCompanySiteOffers(ctx, {
      websiteUrl: "https://doppelt.de",
      field: "Marketing / E-Commerce",
      goal: "ausbildung",
      maxPages: 6, // the new default: 6 pages TOTAL, homepage included
    });
    expect(result.pagesFetched).toBe(6);
    for (const path of ["/ausbildung", "/karriere", "/jobs", "/stellenangebote", "/kontakt"]) {
      expect(requested).toContain(`https://doppelt.de${path}`);
    }
    // The remaining candidates wait for the budget — never blindly fetched.
    expect(requested.some((u) => u.includes("/impressum"))).toBe(false);
    expect(requested.some((u) => u.includes("/team"))).toBe(false);
  });

  it("never requests a robots-disallowed fallback path", async () => {
    const requested: string[] = [];
    const mockFetch = makeFetch(
      [
        [
          (u) => u.includes("/robots.txt"),
          // "Disallow: /jobs" (no slash) covers the EXACT path /jobs — per
          // the robots spec "/jobs/" would not disallow "/jobs" itself.
          () =>
            new Response("User-agent: *\nDisallow: /jobs\n", {
              status: 200,
              headers: { "content-type": "text/plain" },
            }),
        ],
        [(u) => u === "https://doppelt.de", () => html(PLAIN_PAGE)],
      ],
      requested,
    );
    vi.stubGlobal("fetch", mockFetch);
    const ctx = createFetchContext({
      fetchImpl: mockFetch as unknown as typeof fetch,
      isPublicHost: async () => true,
      sleep: async () => undefined,
    });
    const result = await discoverCompanySiteOffers(ctx, {
      websiteUrl: "https://doppelt.de",
      field: "Marketing / E-Commerce",
      goal: "ausbildung",
      maxPages: 6,
    });
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("robots_disallow");
    // /jobs is a POLICY decision: no request ever left the process.
    expect(requested.some((u) => u === "https://doppelt.de/jobs")).toBe(false);
    expect(requested).toContain("https://doppelt.de/robots.txt");
    // And the breaker now short-circuits even more requests on that host.
    const before = requested.length;
    await discoverCompanySiteOffers(ctx, {
      websiteUrl: "https://doppelt.de",
      field: "Marketing / E-Commerce",
      goal: "ausbildung",
      maxPages: 6,
    });
    expect(requested.length).toBe(before);
  });

  it("is never reached for a non-public (SSRF) website", async () => {
    const requested: string[] = [];
    const mockFetch = makeFetch([], requested);
    vi.stubGlobal("fetch", mockFetch);
    const ctx = createFetchContext({
      fetchImpl: mockFetch as unknown as typeof fetch,
      isPublicHost: async () => false,
      sleep: async () => undefined,
    });
    const result = await discoverCompanySiteOffers(ctx, {
      websiteUrl: "https://localhost",
      field: "Marketing / E-Commerce",
      goal: "ausbildung",
      maxPages: 6,
    });
    expect(result.offers).toEqual([]);
    expect(requested).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §7/§8 — the pipeline: cross-query dedupe + honest search-layer stats
// ---------------------------------------------------------------------------

describe("the pipeline with the expanded radius", () => {
  it("keeps ONE company that four DIFFERENT queries found, and dedupes the rest", async () => {
    const requested: string[] = [];
    const DOPPELT_OFFERS = [
      "https://doppelt.de/ausbildung/kaufmann-1",
      "https://doppelt.de/ausbildung/kaufmann-2",
      "https://doppelt.de/ausbildung/kauffrau-3",
      "https://doppelt.de/ausbildung/praktikum-4",
    ];
    const mockFetch = makeFetch(
      [
        [(u) => u.includes("/robots.txt"), plainRobots],
        // Only the four offer pages carry the JobPosting; every other page of
        // the site (homepage, fallback paths, email pass) is plain text.
        ...DOPPELT_OFFERS.map(
          (url): Route => [(u) => u === url, () => html(jobPosting("Doppelt GmbH", "https://doppelt.de"))],
        ),
        [(u) => u.startsWith("https://doppelt.de"), () => html(PLAIN_PAGE)],
      ],
      requested,
    );
    vi.stubGlobal("fetch", mockFetch);
    const store = await import("@/lib/company-discovery/runs");
    vi.mocked(store.getDiscoveryRun).mockResolvedValue(baseRun());
    vi.mocked(store.startDiscoveryRun).mockResolvedValue(baseRun());

    // Four different queries → four different offer PAGES, one company.
    const { client } = fakeSearchClient(
      DOPPELT_OFFERS.map((url) => [resultOf(url)]),
    );
    const adapter = createSearchAdapter(client, {}, {
      maxQueries: 4,
      maxResultsPerQuery: 1,
      maxPagesPerQuery: 5,
      maxPagesToFetch: 20,
    });

    await runDiscoveryPipeline(RUN_ID, USER_ID, {
      window: emptyWindow(),
      adapters: [adapter],
      searchClient: null,
      offerSearchClient: null,
      fetchContext: createFetchContext({
        fetchImpl: mockFetch as unknown as typeof fetch,
        isPublicHost: async () => true,
        sleep: async () => undefined,
      }),
      isCancelled: async () => false,
    });

    const finish = state.finish as {
      foundCompanies: number;
      uniqueCompanies: number;
      duplicatesRemoved: number;
      offersAnalyzed: number;
      companiesProcessed: number;
      emailsFound: number;
      noPublicEmail: number;
      sourcesBlocked: number;
      sources: Array<{
        id: string;
        status: string;
        category?: string;
        candidates?: number;
        stats?: { queriesExecuted: number; resultsInspected: number };
      }>;
    };
    // §7/§8: 4 queries → 4 offers → 1 company, 3 duplicates removed.
    expect(finish.offersAnalyzed).toBe(4);
    expect(finish.foundCompanies).toBe(1);
    expect(finish.uniqueCompanies).toBe(1);
    expect(finish.duplicatesRemoved).toBe(3);
    // The §4.8 invariant holds exactly.
    expect(finish.emailsFound + finish.noPublicEmail + finish.sourcesBlocked).toBe(
      finish.companiesProcessed,
    );
    // Honest search-layer stats reach the run report (persisted via jsonb).
    const searchSource = finish.sources.find((s) => s.id === "search-api");
    expect(searchSource?.status).toBe("ok");
    expect(searchSource?.candidates).toBe(4);
    expect(searchSource?.stats).toEqual({ queriesExecuted: 4, resultsInspected: 4 });
  });

  it("accepts a LITERALLY published email from a search-discovered offer and never guesses one", async () => {
    const requested: string[] = [];
    const LITERAL = "ausbildung@doppelt.de";
    const mockFetch = makeFetch(
      [
        [(u) => u.includes("/robots.txt"), plainRobots],
        [
          (u) => u === "https://doppelt.de/ausbildung/kaufmann-1",
          () =>
            html(
              jobPosting(
                "Doppelt GmbH",
                "https://doppelt.de",
                `Bewerbung bitte per E-Mail an ${LITERAL}.`,
              ),
            ),
        ],
        [(u) => u.startsWith("https://doppelt.de"), () => html(PLAIN_PAGE)],
      ],
      requested,
    );
    vi.stubGlobal("fetch", mockFetch);
    const store = await import("@/lib/company-discovery/runs");
    vi.mocked(store.getDiscoveryRun).mockResolvedValue(baseRun());
    vi.mocked(store.startDiscoveryRun).mockResolvedValue(baseRun());

    const { client } = fakeSearchClient([[resultOf("https://doppelt.de/ausbildung/kaufmann-1")]]);
    const adapter = createSearchAdapter(client, {}, {
      maxQueries: 1,
      maxResultsPerQuery: 1,
      maxPagesPerQuery: 5,
      maxPagesToFetch: 5,
    });
    await runDiscoveryPipeline(RUN_ID, USER_ID, {
      window: emptyWindow(),
      adapters: [adapter],
      searchClient: null,
      offerSearchClient: null,
      fetchContext: createFetchContext({
        fetchImpl: mockFetch as unknown as typeof fetch,
        isPublicHost: async () => true,
        sleep: async () => undefined,
      }),
      isCancelled: async () => false,
    });

    const finish = state.finish as {
      emailsFound: number;
      noPublicEmail: number;
      sourcesBlocked: number;
      companiesProcessed: number;
    };
    // The literal address is accepted…
    expect(finish.emailsFound).toBe(1);
    expect(finish.noPublicEmail).toBe(0);
    expect(finish.companiesProcessed).toBe(1);
    // …the company was recorded with the `email_found` outcome…
    const companyCalls = vi.mocked(store.recordCompany).mock.calls;
    const accepted = companyCalls.find(
      (call) => (call[1] as { status?: string }).status === "accepted",
    );
    expect(accepted?.[1]).toMatchObject({
      emailStatus: "email_found",
      companyName: "Doppelt GmbH",
    });
    // …the email was stored exactly as published, with its provenance page.
    const emailCalls = vi.mocked(store.recordCompanyEmail).mock.calls;
    expect(emailCalls).toHaveLength(1);
    expect(emailCalls[0]?.[1]).toMatchObject({
      email: LITERAL,
      sourceType: "job_listing",
    });
    // …and NOTHING is guessed for it (no info@/kontakt@/bewerbung@ variant).
    const allStoredEmails = emailCalls.map((call) => (call[1] as { email: string }).email);
    expect(allStoredEmails).toEqual([LITERAL]);
  });

  it("survives A=success, B=provider error, C=CAPTCHA, D=success — with partial results", async () => {
    const requested: string[] = [];
    const mockFetch = makeFetch(
      [
        [(u) => u.includes("/robots.txt"), plainRobots],
        [(u) => u === "https://doppelt.de/ausbildung/1", () => html(jobPosting("Doppelt GmbH", "https://doppelt.de"))],
        [(u) => u === "https://viert.de/ausbildung/1", () => html(jobPosting("Viert GmbH", "https://viert.de"))],
        [(u) => u.startsWith("https://blockiert.de"), () => html(CAPTCHA_PAGE)],
        [(u) => u.startsWith("https://doppelt.de") || u.startsWith("https://viert.de"), () => html(PLAIN_PAGE)],
      ],
      requested,
    );
    vi.stubGlobal("fetch", mockFetch);
    const store = await import("@/lib/company-discovery/runs");
    vi.mocked(store.getDiscoveryRun).mockResolvedValue(baseRun());
    vi.mocked(store.startDiscoveryRun).mockResolvedValue(baseRun());

    const { client, calls } = fakeSearchClient(
      [
        [resultOf("https://doppelt.de/ausbildung/1")], // A → success
        [resultOf("https://nie.de/ausbildung")],       // B → provider throws
        [resultOf("https://blockiert.de/ausbildung")], // C → CAPTCHA page
        [resultOf("https://viert.de/ausbildung/1")],   // D → success
      ],
      [1], // query B (0-based index 1) fails at the provider
    );
    const adapter = createSearchAdapter(client, {}, {
      maxQueries: 4,
      maxResultsPerQuery: 1,
      maxPagesPerQuery: 5,
      maxPagesToFetch: 20,
    });
    await runDiscoveryPipeline(RUN_ID, USER_ID, {
      window: emptyWindow(),
      adapters: [adapter],
      searchClient: null,
      offerSearchClient: null,
      fetchContext: createFetchContext({
        fetchImpl: mockFetch as unknown as typeof fetch,
        isPublicHost: async () => true,
        sleep: async () => undefined,
      }),
      isCancelled: async () => false,
    });

    // All four queries were attempted — the error and the CAPTCHA did not
    // terminate the run.
    expect(calls).toHaveLength(4);
    const finish = state.finish as {
      status: string;
      foundCompanies: number;
      companiesProcessed: number;
      emailsFound: number;
      noPublicEmail: number;
      sourcesBlocked: number;
      sources: Array<{ id: string; status: string; candidates?: number; stats?: { queriesExecuted: number; resultsInspected: number } }>;
    };
    expect(finish.foundCompanies).toBe(2); // A + D persisted
    expect(finish.companiesProcessed).toBe(2);
    // The CAPTCHA host was asked exactly once and then circuit-broken.
    expect(requested.filter((u) => u.startsWith("https://blockiert.de/ausbildung"))).toHaveLength(1);
    // The search layer reports `ok` with its honest stats — never `error`.
    const searchSource = finish.sources.find((s) => s.id === "search-api");
    expect(searchSource?.status).toBe("ok");
    expect(searchSource?.candidates).toBe(2);
    expect(searchSource?.stats).toEqual({ queriesExecuted: 4, resultsInspected: 2 });
    // The §4.8 invariant holds for the partial result as well.
    expect(finish.emailsFound + finish.noPublicEmail + finish.sourcesBlocked).toBe(
      finish.companiesProcessed,
    );
  });
});

// ---------------------------------------------------------------------------
// The provider availability chain — where executedQueries becomes 0 (§9).
//
// The exact production path: TAVILY_API_KEY → resolveTavilyKey() →
// getWebSearchClient() → createSearchAdapter(client | null) → skipped/ok →
// stats in the source report → the UI tiles.
// ---------------------------------------------------------------------------

describe("the provider availability chain (deterministic, no real Tavily)", () => {
  const withEnvKey = (value: string | null, fn: () => unknown): unknown => {
    const saved = process.env.TAVILY_API_KEY;
    if (value === null) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = value;
    try {
      return fn();
    } finally {
      if (saved === undefined) delete process.env.TAVILY_API_KEY;
      else process.env.TAVILY_API_KEY = saved;
    }
  };

  it("missing key → getWebSearchClient() is null → adapter skipped → executedQueries stays 0, no error", async () => {
    withEnvKey(null, () => {
      expect(getWebSearchClient()).toBeNull();
      expect(getWebSearchClient({ maxRequests: 12 })).toBeNull();
    });
    // The pipeline builds the adapter with that null client:
    const adapter = createSearchAdapter(null, { beginnYear: 2027 }, {
      maxQueries: 12,
      maxResultsPerQuery: 10,
      maxPagesPerQuery: 5,
      maxPagesToFetch: 20,
    });
    const requested: string[] = [];
    const result = await adapter.searchOffers(ADAPTER_CRITERIA, makeCtx(requested));
    expect(result).toEqual({ status: "skipped", reason: "search_provider_not_configured" });
    expect(requested).toEqual([]); // nothing was fetched, nothing was invented
    // No `stats` on a skipped result → the UI counter reads exactly 0.
    expect(
      (result as { stats?: { queriesExecuted: number } }).stats?.queriesExecuted ?? 0,
    ).toBe(0);
  });

  it("a placeholder key is treated as NOT configured", () => {
    withEnvKey("tvly-your-api-key", () => {
      expect(getWebSearchClient()).toBeNull();
    });
  });

  it("a real-looking key → a client is created with the requested budget (no network at construction)", () => {
    withEnvKey("tvly-test-key-not-real", () => {
      const client = getWebSearchClient({ maxRequests: 12 });
      expect(client).not.toBeNull();
      expect(client?.name).toBe("tavily");
    });
  });

  it("configured provider + valid criteria + positive budget → at least one search invocation", async () => {
    const { client, calls } = fakeSearchClient([
      [resultOf("https://doppelt.de/ausbildung/1")],
    ]);
    const requested: string[] = [];
    const adapter = createSearchAdapter(client, { beginnYear: 2027 }, {
      maxQueries: 12,
      maxResultsPerQuery: 10,
      maxPagesPerQuery: 5,
      maxPagesToFetch: 20,
    });
    // The criteria carry a profession (and no location): the families must
    // NOT be empty — national search works without a location.
    const queries = generateSearchQueries(
      ADAPTER_CRITERIA,
      { beginnYear: 2027 },
      12,
    );
    expect(queries.length).toBeGreaterThan(0);
    expect(queries).toContain("Ausbildung Kaufmann im E-Commerce");
    expect(queries).toContain("Kaufmann im E-Commerce Ausbildung 2027");

    const result = await adapter.searchOffers(ADAPTER_CRITERIA, makeCtx(requested));
    expect(calls.length).toBeGreaterThanOrEqual(1); // the provider WAS invoked
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.stats?.queriesExecuted).toBeGreaterThan(0);
      expect(result.stats?.resultsInspected).toBe(1);
    }
    expect(requested).toContain("https://doppelt.de/ausbildung/1");
  });

  it("pipeline, production path WITHOUT a provider key → search-api row skipped with reason, no stats, run finishes without error, UI counters read 0", async () => {
    const requested: string[] = [];
    const mockFetch = makeFetch(
      [[(u) => u.includes("/robots.txt"), plainRobots]],
      requested,
    );
    vi.stubGlobal("fetch", mockFetch);
    const store = await import("@/lib/company-discovery/runs");
    vi.mocked(store.getDiscoveryRun).mockResolvedValue(baseRun());
    vi.mocked(store.startDiscoveryRun).mockResolvedValue(baseRun());

    // The key must stay absent for the WHOLE run (the pipeline reads it
    // asynchronously) — restore only after the await.
    const savedKey = process.env.TAVILY_API_KEY;
    delete process.env.TAVILY_API_KEY;
    try {
      // Exactly the production call: no deps at all — the pipeline builds the
      // offer client from the (absent) TAVILY_API_KEY itself.
      await runDiscoveryPipeline(RUN_ID, USER_ID, {
        window: emptyWindow(),
        searchClient: null,
        fetchContext: createFetchContext({
          fetchImpl: mockFetch as unknown as typeof fetch,
          isPublicHost: async () => true,
          sleep: async () => undefined,
        }),
        isCancelled: async () => false,
      });
    } finally {
      if (savedKey === undefined) delete process.env.TAVILY_API_KEY;
      else process.env.TAVILY_API_KEY = savedKey;
    }

    const finish = state.finish as {
      status: string;
      sources: Array<{
        id: string;
        status: string;
        reason?: string | null;
        stats?: { queriesExecuted: number; resultsInspected: number };
      }>;
    };
    expect(finish.status).toBe("partial"); // zero found, no failure
    const searchSource = finish.sources.find((s) => s.id === "search-api");
    expect(searchSource?.status).toBe("skipped");
    expect(searchSource?.reason).toBe("search_provider_not_configured");
    expect(searchSource?.stats).toBeUndefined();
    // The UI tile reads `stats?.queriesExecuted ?? 0`:
    expect(searchSource?.stats?.queriesExecuted ?? 0).toBe(0);
    expect(searchSource?.stats?.resultsInspected ?? 0).toBe(0);
  });

  it("pipeline, provider configured → provider called → executedQueries > 0 in the run report", async () => {
    const requested: string[] = [];
    const mockFetch = makeFetch(
      [
        [(u) => u.includes("/robots.txt"), plainRobots],
        [
          (u) => u === "https://doppelt.de/ausbildung/1",
          () => html(jobPosting("Doppelt GmbH", "https://doppelt.de")),
        ],
      ],
      requested,
    );
    vi.stubGlobal("fetch", mockFetch);
    const store = await import("@/lib/company-discovery/runs");
    vi.mocked(store.getDiscoveryRun).mockResolvedValue(baseRun());
    vi.mocked(store.startDiscoveryRun).mockResolvedValue(baseRun());

    // A configured provider is simulated by a stub client (never Tavily).
    const { client, calls } = fakeSearchClient([
      [resultOf("https://doppelt.de/ausbildung/1")],
    ]);
    await runDiscoveryPipeline(RUN_ID, USER_ID, {
      window: emptyWindow(),
      searchClient: null,
      offerSearchClient: client,
      fetchContext: createFetchContext({
        fetchImpl: mockFetch as unknown as typeof fetch,
        isPublicHost: async () => true,
        sleep: async () => undefined,
      }),
      isCancelled: async () => false,
    });

    expect(calls.length).toBeGreaterThan(0); // the provider was actually called
    const finish = state.finish as {
      foundCompanies: number;
      companiesProcessed: number;
      emailsFound: number;
      noPublicEmail: number;
      sourcesBlocked: number;
      sources: Array<{ id: string; status: string; candidates?: number; stats?: { queriesExecuted: number; resultsInspected: number } }>;
    };
    const searchSource = finish.sources.find((s) => s.id === "search-api");
    expect(searchSource?.status).toBe("ok");
    expect(searchSource?.stats?.queriesExecuted).toBeGreaterThan(0);
    expect(finish.foundCompanies).toBe(1);
    expect(finish.emailsFound + finish.noPublicEmail + finish.sourcesBlocked).toBe(
      finish.companiesProcessed,
    );
  });

  it("scenario A — DEFAULT production path (no deps override, fake key, Tavily stubbed at HTTP): client created inside the pipeline, provider invoked, executedQueries > 0, checkpoint persisted before the email phase", async () => {
    const requested: string[] = [];
    const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      requested.push(url);
      // The ONLY real Tavily endpoint — answered offline, exactly like the
      // provider would answer: JSON with result URLs.
      if (url === "https://api.tavily.com/search") {
        return new Response(
          JSON.stringify({
            results: [
              { title: "Ausbildung", url: "https://doppelt.de/ausbildung/1", snippet: "" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/robots.txt")) return plainRobots();
      if (url === "https://doppelt.de/ausbildung/1") {
        return html(jobPosting("Doppelt GmbH", "https://doppelt.de"));
      }
      return html(PLAIN_PAGE);
    });
    vi.stubGlobal("fetch", mockFetch);
    const store = await import("@/lib/company-discovery/runs");
    vi.mocked(store.getDiscoveryRun).mockResolvedValue(baseRun());
    vi.mocked(store.startDiscoveryRun).mockResolvedValue(baseRun());

    // A fake, non-placeholder key: the REAL client path runs end-to-end
    // (key resolution, per-run budget, auth header, HTTP call, response
    // parsing) — only the network is stubbed.
    const savedKey = process.env.TAVILY_API_KEY;
    process.env.TAVILY_API_KEY = "tvly-test-fake-123456";
    try {
      await runDiscoveryPipeline(RUN_ID, USER_ID, {
        // Only the two documented offline seams: the BA window (real API)
        // and the SSRF DNS gate. The offer client is NOT injected — the
        // pipeline must build it from the environment, exactly like the
        // production route does.
        window: emptyWindow(),
        isPublicHost: async () => true,
      });
    } finally {
      if (savedKey === undefined) delete process.env.TAVILY_API_KEY;
      else process.env.TAVILY_API_KEY = savedKey;
    }

    // offerSearchClient !== null ⇔ the provider endpoint was actually hit.
    const tavilyCalls = requested.filter((u) => u === "https://api.tavily.com/search");
    expect(tavilyCalls.length).toBeGreaterThan(0);

    const finish = state.finish as {
      foundCompanies: number;
      companiesProcessed: number;
      emailsFound: number;
      noPublicEmail: number;
      sourcesBlocked: number;
      sources: Array<{ id: string; status: string; candidates?: number; stats?: { queriesExecuted: number; resultsInspected: number } }>;
    };
    const searchSource = finish.sources.find((s) => s.id === "search-api");
    expect(searchSource?.status).toBe("ok");
    expect(searchSource?.stats?.queriesExecuted).toBeGreaterThan(0);
    expect(searchSource?.stats?.resultsInspected).toBe(1);
    expect(searchSource?.candidates).toBe(1);
    expect(finish.foundCompanies).toBe(1);
    expect(finish.emailsFound + finish.noPublicEmail + finish.sourcesBlocked).toBe(
      finish.companiesProcessed,
    );

    // The checkpoint: a progress flush that CARRIES the search-api row with
    // its stats happened BEFORE the email phase — a function killed during
    // the email phase can no longer erase the search layer's execution.
    const checkpoint = vi.mocked(store.setRunCounters).mock.calls.find((call) =>
      (call[3] ?? []).some(
        (entry) =>
          entry.id === "search-api" && entry.status === "ok" && entry.stats !== undefined,
      ),
    );
    expect(checkpoint).toBeDefined();
  }, 30000); // the DEFAULT path keeps the real ≥1 s/host pacing guard
});

/** Offline fetch context helper for the provider-chain tests. */
function makeCtx(requested: string[]) {
  const mockFetch = makeFetch(
    [[(u) => u.includes("/robots.txt"), plainRobots]],
    requested,
  );
  vi.stubGlobal("fetch", mockFetch);
  return createFetchContext({
    fetchImpl: mockFetch as unknown as typeof fetch,
    isPublicHost: async () => true,
    sleep: async () => undefined,
  });
}

// ---------------------------------------------------------------------------
// §16 — the new UI strings exist in every locale
// ---------------------------------------------------------------------------

describe("the new UI strings exist in all four locales", () => {
  const dictionaries = readFileSync(
    resolve(fileURLToPath(new URL("../..", import.meta.url)), "src/lib/i18n/dictionaries.ts"),
    "utf8",
  );

  it("has the new discovery tile keys in de/en/fr/ar", () => {
    for (const key of ["queries:", "results:", "processed:"]) {
      const count = (dictionaries.match(new RegExp(key.replace(":", "\\:"), "g")) ?? []).length;
      expect(count, `${key} should exist in all four locales`).toBeGreaterThanOrEqual(4);
    }
  });
});
