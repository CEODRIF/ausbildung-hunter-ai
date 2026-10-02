import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * The Internet Discovery Engine expansion (§5–§26).
 *
 * Covers, offline and deterministically (fetch, DNS and the search provider
 * are stubbed — no third-party site is ever contacted):
 *  - the controlled, structured query generator (no random queries);
 *  - the exported fan-out configuration (§17);
 *  - the search-engine adapter: bounded, never-fabricating, portal-free,
 *    blocked-page-safe, and honest about a missing provider;
 *  - the company-website offer-discovery pass: bounded pages, robots-gated,
 *    falling back to well-known paths only;
 *  - the pipeline: cross-source deduplication of one company found by four
 *    sources, a blocked source that never takes the run down, and the
 *    category-enriched source report (§19/§23).
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

import type { OfferSourceAdapter } from "@/lib/company-discovery/adapter";
import { createSearchAdapter } from "@/lib/company-discovery/adapters";
import { discoverCompanySiteOffers } from "@/lib/company-discovery/company-site";
import { createFetchContext } from "@/lib/company-discovery/fetch-guard";
import { generateSearchQueries } from "@/lib/company-discovery/queries";
import { runDiscoveryPipeline } from "@/lib/company-discovery/search";
import {
  COMPANY_WEBSITES_LAYER,
  categoryForSourceId,
  enabledSources,
  mayYieldEmail,
  policySkippedSources,
  sourceById,
} from "@/lib/company-discovery/sources";
import { discoveryFanout, discoveryLimits, type DiscoveryRun } from "@/lib/company-discovery/types";
import type { Opportunity, OpportunityWindow } from "@/lib/opportunities/types";
import type { WebSearchClient, WebSearchResult } from "@/lib/web-search";

const RUN_ID = "55555555-5555-4555-8555-555555555555";
const USER_ID = "66666666-6666-4666-8666-666666666666";

// ---------------------------------------------------------------------------
// Fixtures (all offline)
// ---------------------------------------------------------------------------

/** A real `schema.org/JobPosting` — the ONLY data shape the engine reads. */
const DOPPELT_JOBPOSTING = `<!doctype html><html><head>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"JobPosting","title":"Ausbildung Kauffrau im E-Commerce (m/w/d)","employmentType":"APPRENTICESHIP","hiringOrganization":{"name":"Doppelt GmbH","url":"https://doppelt.de"},"jobLocation":{"address":{"addressLocality":"Köln"}}}
</script></head><body>Ausbildung bei Doppelt GmbH in Köln</body></html>`;

/** A page that states no offer and no address — plain text only. */
const PLAIN_PAGE =
  "<html><body><h1>Doppelt GmbH</h1><p>Telefon 0221 123456. Bitte nutzen Sie unser Kontaktformular.</p></body></html>";

/** The central classifier's canonical Cloudflare challenge marker. */
const CAPTCHA_PAGE = "<title>Just a moment…</title>";

/** A homepage that exposes five same-origin offer links. */
const HOMEPAGE_FIVE_LINKS = `<!doctype html><html><body>
<a href="/ausbildung/kaufmann-1">Ausbildung Kaufmann</a>
<a href="/ausbildung/kauffrau-2">Ausbildung Kauffrau</a>
<a href="/jobs/mechatroniker-3">Job Mechatroniker</a>
<a href="/karriere/buerofachkraft-4">Karriere Bürofachkraft</a>
<a href="/stellenangebote/it-system-5">Stellenangebot IT</a>
</body></html>`;

const HOMEPAGE_JOBS_FIRST = `<!doctype html><html><body>
<a href="/jobs/1">Jobs</a>
<a href="/ausbildung/2">Ausbildung 2</a>
<a href="/ausbildung/3">Ausbildung 3</a>
<a href="/ausbildung/4">Ausbildung 4</a>
</body></html>`;

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

function baSeed(website: string | null): Opportunity {
  return {
    id: "arbeitsagentur:DOPPELT-S",
    goal: "ausbildung" as const,
    title: "Ausbildung Kaufmann im E-Commerce",
    company_name: "Doppelt GmbH",
    location_detail: { city: "Köln", region: "Nordrhein-Westfalen", country: "DE", postal_code: "50667" },
    valid_from: "2027-08-01",
    salary: { label: "1150 €" },
    source_name: "Bundesagentur für Arbeit",
    source_url: "https://www.arbeitsagentur.de/jobsuche/jobdetail/doppelt",
    contact: { email: null, phone: null, name: null },
    enrichment: website
      ? { website_url: website, website_source: `${website}/impressum`, email: null }
      : null,
  } as unknown as Opportunity;
}

type Route = [match: (url: string) => boolean, respond: () => Response];

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html" } });
}

function plainRobots(): Response {
  return new Response("User-agent: *\nDisallow:\n", {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
}

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

function fakeSearchClient(resultsPerCall: WebSearchResult[][]) {
  const queries: string[] = [];
  let call = 0;
  const client = {
    name: "tavily",
    async search(query: string): Promise<WebSearchResult[]> {
      queries.push(query);
      const results = resultsPerCall[Math.min(call, resultsPerCall.length - 1)] ?? [];
      call += 1;
      return results;
    },
  } as unknown as WebSearchClient;
  return { client, queries };
}

function fakeAdapter(
  id: "aubi-plus-de" | "ausbildung-de",
  offers: Partial<import("@/lib/company-discovery/adapter").NormalizedOffer>[] | "blocked",
): OfferSourceAdapter {
  const source = sourceById(id);
  return {
    id,
    displayName: source?.displayName ?? id,
    category: "ausbildung",
    policy: "enabled_public",
    async searchOffers() {
      if (offers === "blocked") return { status: "blocked" as const, reason: "captcha" };
      return {
        status: "ok" as const,
        offers: offers.map((offer, index) => ({
          companyName: `Firma ${index} GmbH`,
          companyWebsite: null,
          role: "Ausbildung",
          field: null,
          city: null,
          state: null,
          offerType: "ausbildung" as const,
          beginn: null,
          salary: null,
          offerSource: source?.displayName ?? id,
          offerUrl: `https://example.invalid/${id}/${index}`,
          publishedEmail: null,
          listingText: "",
          candidateRef: `${id}:${index}`,
          ...offer,
        })),
      };
    },
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

// The search adapter's `criteria` is the run's normalized search params; for
// the generator what matters is role / keyword / goal.
const CRITERIA = {
  role: "Kaufmann im E-Commerce",
  keyword: "Marketing / E-Commerce",
  goal: "ausbildung",
} as unknown as import("@/lib/opportunities/types").OpportunitySearchParams;

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
// §7 — the controlled query generator
// ---------------------------------------------------------------------------

describe("the structured query generator", () => {
  it("is deterministic: same criteria → same bounded, ordered queries", () => {
    const a = generateSearchQueries(CRITERIA, { beginnYear: 2027 }, 3);
    const b = generateSearchQueries(CRITERIA, { beginnYear: 2027 }, 3);
    expect(a).toEqual(b);
    expect(a).toHaveLength(3);
    expect(a[0]).toBe("Ausbildung Kaufmann im E-Commerce");
    // No random / free-form flooding: every query is anchored or scoped.
    for (const query of a) {
      expect(
        query.includes("Ausbildung") ||
          query.includes("Azubi") ||
          query === "Kaufmann im E-Commerce" ||
          query === "Marketing / E-Commerce",
      ).toBe(true);
    }
  });

  it("narrows to the concrete beginn year and respects the limit", () => {
    // 10 term families + the beginn-year variant = 11 (the default limit 12
    // keeps every family, including the year-narrowed one).
    const withYear = generateSearchQueries(
      { role: "Kaufmann", keyword: null, goal: "ausbildung" } as unknown as typeof CRITERIA,
      { beginnYear: 2027 },
    );
    expect(withYear).toHaveLength(11);
    expect(withYear).toContain("Kaufmann Ausbildung 2027");
    expect(generateSearchQueries(CRITERIA, {}, 1)).toHaveLength(1);
    expect(generateSearchQueries(CRITERIA, {}, 1)).toEqual(
      generateSearchQueries(CRITERIA, {}, 1),
    );
  });

  it("emits no query when the criteria carry no usable term", () => {
    expect(
      generateSearchQueries({ role: "", keyword: null, goal: "ausbildung" } as unknown as typeof CRITERIA),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §17 — the exported fan-out configuration
// ---------------------------------------------------------------------------

describe("the fan-out configuration is exported and bounded", () => {
  it("mirrors the registry and the documented defaults", () => {
    const limits = discoveryLimits();
    expect(limits.maxSearchQueries).toBe(12);
    expect(limits.maxSearchResultsPerQuery).toBe(10);
    expect(limits.maxSearchPagesPerQuery).toBe(5);
    expect(limits.maxSearchPagesToFetch).toBe(20);
    expect(limits.maxCompanySiteOfferCompanies).toBe(12);
    expect(limits.maxCompanySiteOfferPages).toBe(6);

    const fanout = discoveryFanout();
    expect(fanout.maxEnabledSourcesPerRun).toBe(enabledSources().length);
    expect(fanout.maxRequestsPerHost).toBe(1);
    expect(fanout.minHostDelayMs).toBe(1000);
    expect(fanout.requestTimeoutMs).toBe(10000);
    expect(fanout.maxSearchQueriesPerRun).toBe(limits.maxSearchQueries);
    expect(fanout.maxResultsPerQuery).toBe(limits.maxSearchResultsPerQuery);
    expect(fanout.maxSearchPagesPerQuery).toBe(limits.maxSearchPagesPerQuery);
    expect(fanout.maxSearchPagesPerRun).toBe(limits.maxSearchPagesToFetch);
    expect(fanout.maxCompanySiteCompaniesPerRun).toBe(limits.maxCompanySiteOfferCompanies);
    expect(fanout.maxCompanySitePagesPerCompany).toBe(limits.maxCompanySiteOfferPages);
  });

  it("stays env-tunable without a code change", () => {
    vi.stubEnv("DISCOVERY_MAX_SEARCH_QUERIES", "1");
    expect(discoveryFanout().maxSearchQueriesPerRun).toBe(1);
  });

  it("clamps unreasonable env values into the hard caps", () => {
    vi.stubEnv("DISCOVERY_MAX_SEARCH_QUERIES", "999");
    vi.stubEnv("DISCOVERY_MAX_SEARCH_RESULTS_PER_QUERY", "500");
    vi.stubEnv("DISCOVERY_MAX_SEARCH_PAGES_PER_QUERY", "40");
    vi.stubEnv("DISCOVERY_MAX_SEARCH_PAGES_TO_FETCH", "10000");
    vi.stubEnv("DISCOVERY_MAX_COMPANY_SITE_COMPANIES", "9999");
    vi.stubEnv("DISCOVERY_MAX_COMPANY_SITE_PAGES", "64");
    const limits = discoveryLimits();
    expect(limits.maxSearchQueries).toBe(20);
    expect(limits.maxSearchResultsPerQuery).toBe(20);
    expect(limits.maxSearchPagesPerQuery).toBe(10);
    expect(limits.maxSearchPagesToFetch).toBe(60);
    expect(limits.maxCompanySiteOfferCompanies).toBe(20);
    expect(limits.maxCompanySiteOfferPages).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// §6–§9 — the search-engine adapter (legitimate API, guarded fetcher)
// ---------------------------------------------------------------------------

describe("the search-engine adapter", () => {
  const fetchCtx = (requested: string[], routes: Route[]) => {
    const mockFetch = makeFetch(routes, requested);
    // fetchRobots() reads the GLOBAL fetch — keep the test offline.
    vi.stubGlobal("fetch", mockFetch);
    return createFetchContext({
      fetchImpl: mockFetch as unknown as typeof fetch,
      isPublicHost: async () => true,
      sleep: async () => undefined,
    });
  };

  it("reports `skipped` — never an error — when no provider is configured", async () => {
    const adapter = createSearchAdapter(null);
    const result = await adapter.searchOffers(CRITERIA, null);
    expect(result).toEqual({ status: "skipped", reason: "search_provider_not_configured" });
  });

  it("issues at most `maxQueries` provider requests", async () => {
    // Every query answers with a PORTAL host only → nothing is fetched, so the
    // page budget never bites and only the query bound is observable.
    const { client, queries } = fakeSearchClient([
      [
        { title: "A", url: "https://www.aubi-plus.de/ausbildung/x-1/", snippet: "" },
        { title: "B", url: "https://de.indeed.com/jobs?q=x", snippet: "" },
      ],
      [
        { title: "C", url: "https://www.stepstone.de/jobs/x", snippet: "" },
      ],
    ]);
    const requested: string[] = [];
    const adapter = createSearchAdapter(client, {}, {
      maxQueries: 2,
      maxResultsPerQuery: 1,
      maxPagesPerQuery: 5,
      maxPagesToFetch: 5,
    });
    const result = await adapter.searchOffers(CRITERIA, fetchCtx(requested, []));
    expect(queries).toHaveLength(2);
    expect(queries[0]).toBe("Ausbildung Kaufmann im E-Commerce");
    expect(queries[1]).toBe("Ausbildungsplatz Kaufmann im E-Commerce");
    expect(requested).toEqual([]); // portal hosts are never content for this layer
    expect(result).toEqual({
      status: "ok",
      offers: [],
      stats: { queriesExecuted: 2, resultsInspected: 0 },
    });
  });

  it("fetches at most `maxPagesToFetch` pages, skips portal hosts, and normalizes only stated facts", async () => {
    const { client, queries } = fakeSearchClient([
      [
        { title: "Portal", url: "https://www.aubi-plus.de/ausbildung/x-1/", snippet: "" },
        { title: "Site", url: "https://doppelt.de/ausbildung/1", snippet: "" },
      ],
    ]);
    const requested: string[] = [];
    const adapter = createSearchAdapter(client, { beginnYear: 2027 }, {
      maxQueries: 3,
      maxResultsPerQuery: 1,
      maxPagesPerQuery: 5,
      maxPagesToFetch: 1,
    });
    const result = await adapter.searchOffers(
      CRITERIA,
      fetchCtx(requested, [
        [(u) => u.includes("/robots.txt"), plainRobots],
        [(u) => u === "https://doppelt.de/ausbildung/1", () => html(DOPPELT_JOBPOSTING)],
      ]),
    );
    // The page budget was spent after the first fetchable result.
    expect(queries).toHaveLength(1);
    expect(requested.some((u) => u.includes("aubi-plus"))).toBe(false);
    expect(requested).toContain("https://doppelt.de/ausbildung/1");

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.stats).toEqual({ queriesExecuted: 1, resultsInspected: 1 });
    }
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.offers).toHaveLength(1);
    // Everything the listing stated — and nothing it did not.
    expect(result.offers[0]).toMatchObject({
      companyName: "Doppelt GmbH",
      companyWebsite: "https://doppelt.de",
      city: "Köln",
      offerType: "ausbildung",
      offerSource: "Search API (Tavily)",
      offerUrl: "https://doppelt.de/ausbildung/1",
      beginn: null,
      salary: null,
      publishedEmail: null,
    });
  });

  it("treats a CAPTCHA page as blocked and then circuit-breaks the host", async () => {
    const requested: string[] = [];
    const routes: Route[] = [
      [(u) => u.includes("/robots.txt"), plainRobots],
      [(u) => u.startsWith("https://blockiert.de"), () => html(CAPTCHA_PAGE)],
    ];
    const first = fakeSearchClient([
      [{ title: "Challenge", url: "https://blockiert.de/ausbildung", snippet: "" }],
    ]);
    const adapter = createSearchAdapter(first.client, {}, {
      maxQueries: 1,
      maxResultsPerQuery: 1,
      maxPagesPerQuery: 1,
      maxPagesToFetch: 1,
    });
    const ctx = createFetchContext({
      fetchImpl: makeFetch(routes, requested) as unknown as typeof fetch,
      isPublicHost: async () => true,
      sleep: async () => undefined,
    });
    const result = await adapter.searchOffers(CRITERIA, ctx);
    // The challenge is never solved, never retried, and never turned into data.
    expect(result).toEqual({
      status: "ok",
      offers: [],
      stats: { queriesExecuted: 1, resultsInspected: 0 },
    });
    expect(requested).toContain("https://blockiert.de/ausbildung");

    // The host breaker is now open: a second pass over the SAME context issues
    // no further request for that host and still yields nothing.
    const before = requested.length;
    const second = fakeSearchClient([
      [{ title: "Challenge", url: "https://blockiert.de/ausbildung", snippet: "" }],
    ]);
    const adapter2 = createSearchAdapter(second.client, {}, {
      maxQueries: 1,
      maxResultsPerQuery: 1,
      maxPagesPerQuery: 1,
      maxPagesToFetch: 1,
    });
    const result2 = await adapter2.searchOffers(CRITERIA, ctx);
    expect(result2).toEqual({
      status: "ok",
      offers: [],
      stats: { queriesExecuted: 1, resultsInspected: 0 },
    });
    expect(requested.length).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// §11 — company-website → more offers (bounded, robots-gated)
// ---------------------------------------------------------------------------

describe("the company-website offer-discovery pass", () => {
  it("fetches the homepage plus at most `maxPages` linked offer pages", async () => {
    const requested: string[] = [];
    const mockFetch = makeFetch(
      [
        [(u) => u.includes("/robots.txt"), plainRobots],
        [(u) => u === "https://doppelt.de", () => html(HOMEPAGE_FIVE_LINKS)],
        [(u) => u === "https://doppelt.de/ausbildung/kaufmann-1", () => html(DOPPELT_JOBPOSTING)],
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
      // Total per-company budget, homepage INCLUDED: 2 = homepage + 1 page.
      maxPages: 2,
    });
    expect(result.pagesFetched).toBe(2); // homepage + exactly one offer page
    expect(result.blocked).toBe(false);
    expect(result.offers).toHaveLength(1);
    expect(result.offers[0].companyName).toBe("Doppelt GmbH");
    expect(requested).toContain("https://doppelt.de/ausbildung/kaufmann-1");
    for (const neverFetched of ["kauffrau-2", "/jobs/", "/karriere/", "/stellenangebote/"]) {
      expect(requested.some((u) => u.includes(neverFetched))).toBe(false);
    }
  });

  it("never requests a robots-disallowed path (and opens the host breaker)", async () => {
    const requested: string[] = [];
    const mockFetch = makeFetch(
      [
        [
          (u) => u.includes("/robots.txt"),
          () =>
            new Response("User-agent: *\nDisallow: /jobs/\n", {
              status: 200,
              headers: { "content-type": "text/plain" },
            }),
        ],
        [(u) => u === "https://doppelt.de", () => html(HOMEPAGE_JOBS_FIRST)],
      ],
      requested,
    );
    // fetchRobots() reads the GLOBAL fetch — stub it with the same recorder.
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
      maxPages: 4,
    });
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("robots_disallow");
    expect(result.offers).toEqual([]);
    expect(result.pagesFetched).toBe(1); // the homepage only
    // The disallowed URL was a POLICY decision — no network request left the process.
    expect(requested.some((u) => u.includes("/jobs/1"))).toBe(false);
    expect(requested).toContain("https://doppelt.de/robots.txt");
  });

  it("falls back to well-known offer paths only when the homepage links none", async () => {
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
      // Total per-company budget, homepage INCLUDED: 3 = homepage + 2 paths.
      maxPages: 3,
    });
    expect(result.pagesFetched).toBe(3); // homepage + two fallback paths
    expect(result.offers).toEqual([]);
    expect(requested).toContain("https://doppelt.de/ausbildung");
    expect(requested).toContain("https://doppelt.de/karriere");
    for (const neverFetched of ["/jobs", "/stellenangebote", "/kontakt", "/impressum", "/team"]) {
      expect(requested.some((u) => u.includes(neverFetched))).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// §14 — the registry: categories, policies, the derived layer
// ---------------------------------------------------------------------------

describe("the extended registry", () => {
  it("classifies the new sources with an auditable category and policy", () => {
    expect(sourceById("search-api")).toMatchObject({
      category: "search",
      policy: "enabled_official_api",
      emailAllowed: false,
    });
    expect(sourceById("search-google")).toMatchObject({
      category: "search",
      policy: "restricted",
      emailAllowed: false,
    });
    expect(sourceById("search-bing")).toMatchObject({ category: "search", policy: "restricted" });
    expect(sourceById("search-google-cse")).toMatchObject({
      category: "search",
      policy: "unverified",
    });
    expect(sourceById("directory-handwerksrolle")).toMatchObject({
      category: "directory",
      policy: "unverified",
    });
    // Platforms move to their own family — still restricted, still no adapter.
    expect(sourceById("xing-jobs")?.category).toBe("platform");
    expect(sourceById("linkedin-jobs")?.category).toBe("platform");
    for (const id of [
      "search-api",
      "search-google",
      "search-bing",
      "search-google-cse",
      "directory-handwerksrolle",
    ]) {
      expect(sourceById(id)?.reason.length).toBeGreaterThan(30);
      expect(mayYieldEmail(id)).toBe(false);
    }
    // The restricted search engines are registered but never runnable.
    expect(enabledSources().map((s) => s.id)).not.toContain("search-google");
    expect(enabledSources().map((s) => s.id)).not.toContain("search-bing");
    expect(policySkippedSources().map((s) => s.id)).toContain("search-google");
    expect(policySkippedSources().map((s) => s.id)).toContain("search-bing");
  });

  it("keeps the company-websites layer out of the runnable source set", () => {
    expect(enabledSources().map((s) => s.id)).not.toContain(COMPANY_WEBSITES_LAYER.id);
    expect(policySkippedSources().map((s) => s.id)).not.toContain(COMPANY_WEBSITES_LAYER.id);
    expect(categoryForSourceId(COMPANY_WEBSITES_LAYER.id)).toBe("company-site");
    expect(categoryForSourceId("search-api")).toBe("search");
    expect(categoryForSourceId("does-not-exist")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §16/§18/§19 — pipeline: multi-source collection, dedupe, isolation, report
// ---------------------------------------------------------------------------

describe("the pipeline with the search layer and the company-site pass", () => {
  it("counts one company found by FOUR sources as one, with three duplicates", async () => {
    const requested: string[] = [];
    const mockFetch = makeFetch(
      [
        [(u) => u.includes("/robots.txt"), plainRobots],
        [(u) => u === "https://doppelt.de/ausbildung/1", () => html(DOPPELT_JOBPOSTING)],
        [(u) => u.startsWith("https://doppelt.de"), () => html(PLAIN_PAGE)],
      ],
      requested,
    );
    vi.stubGlobal("fetch", mockFetch);
    const store = await import("@/lib/company-discovery/runs");
    vi.mocked(store.getDiscoveryRun).mockResolvedValue(baseRun());
    vi.mocked(store.startDiscoveryRun).mockResolvedValue(baseRun());

    const { client } = fakeSearchClient([
      [{ title: "Site", url: "https://doppelt.de/ausbildung/1", snippet: "" }],
      [],
      [],
    ]);
    const searchAdapter = createSearchAdapter(client, {}, {
      maxQueries: 3,
      maxResultsPerQuery: 1,
      maxPagesPerQuery: 5,
      maxPagesToFetch: 5,
    });

    const window = async () =>
      ({
        mode: "scan",
        window: [baSeed("https://doppelt.de")],
        total: 1,
        scan_truncated: false,
        exhausted: true,
        degraded: false,
        filter_counts: { any: 1, today: 0, yesterday: 0, week: 0, twoWeeks: 0, fourWeeks: 0 },
      }) as unknown as OpportunityWindow;

    await runDiscoveryPipeline(RUN_ID, USER_ID, {
      window,
      adapters: [
        fakeAdapter("aubi-plus-de", [{ companyName: "Doppelt GmbH", companyWebsite: "https://doppelt.de", candidateRef: "p1:shared" }]),
        fakeAdapter("ausbildung-de", [{ companyName: "Doppelt GmbH", companyWebsite: "https://doppelt.de", candidateRef: "p2:shared" }]),
        searchAdapter,
      ],
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
      status: string;
      foundCompanies: number;
      uniqueCompanies: number;
      duplicatesRemoved: number;
      offersAnalyzed: number;
      companiesProcessed: number;
      emailsFound: number;
      noPublicEmail: number;
      sourcesBlocked: number;
      sources: Array<{ id: string; status: string; category?: string; candidates?: number; reason?: string | null }>;
    };
    // One company, four sources → three duplicates removed (§18).
    expect(finish.foundCompanies).toBe(1);
    expect(finish.uniqueCompanies).toBe(1);
    expect(finish.duplicatesRemoved).toBe(3);
    expect(finish.offersAnalyzed).toBe(4);
    // The §4.8 outcome invariant still holds exactly.
    expect(finish.emailsFound + finish.noPublicEmail + finish.sourcesBlocked).toBe(
      finish.companiesProcessed,
    );
    expect(finish.companiesProcessed).toBe(1);
    expect(finish.noPublicEmail).toBe(1); // the site publishes no address
    expect(finish.status).toBe("partial");

    const source = (id: string) => finish.sources.find((s) => s.id === id);
    // The search layer ran, contributed, and is reported with its category (§19).
    expect(source("search-api")?.status).toBe("ok");
    expect(source("search-api")?.category).toBe("search");
    expect(source("search-api")?.candidates).toBe(1);
    expect(source("aubi-plus-de")?.status).toBe("ok");
    expect(source("ausbildung-de")?.status).toBe("ok");
    // The derived company-websites layer ran (homepage + fallback paths) and
    // reported honestly: zero offers, its own category.
    expect(source("company-websites")?.status).toBe("ok");
    expect(source("company-websites")?.category).toBe("company-site");
    expect(requested.some((u) => u === "https://doppelt.de")).toBe(true);
    // Restricted search engines stayed registered-only: never a report row
    // beyond skipped_by_policy, and never requested.
    expect(source("search-google")?.status).toBe("skipped_by_policy");
    expect(source("search-google")?.category).toBe("search");
    expect(source("xing-jobs")?.status).toBe("skipped_by_policy");
    expect(source("xing-jobs")?.category).toBe("platform");
    expect(requested.some((u) => u.includes("google") || u.includes("bing") || u.includes("xing"))).toBe(false);
  });

  it("keeps a CAPTCHA-blocked source honest while every other source continues", async () => {
    const requested: string[] = [];
    const mockFetch = makeFetch(
      [
        [(u) => u.includes("/robots.txt"), plainRobots],
        [(u) => u.startsWith("https://gesund.de"), () => html(PLAIN_PAGE)],
      ],
      requested,
    );
    vi.stubGlobal("fetch", mockFetch);
    const store = await import("@/lib/company-discovery/runs");
    vi.mocked(store.getDiscoveryRun).mockResolvedValue(baseRun());
    vi.mocked(store.startDiscoveryRun).mockResolvedValue(baseRun());

    await runDiscoveryPipeline(RUN_ID, USER_ID, {
      window: emptyWindow(),
      adapters: [
        fakeAdapter("aubi-plus-de", "blocked"),
        fakeAdapter("ausbildung-de", [{ companyName: "Gesund GmbH", companyWebsite: "https://gesund.de" }]),
      ],
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
      status: string;
      foundCompanies: number;
      companiesProcessed: number;
      emailsFound: number;
      noPublicEmail: number;
      sourcesBlocked: number;
      sources: Array<{ id: string; status: string; reason?: string | null }>;
    };
    // The blocked source is reported `blocked` with its reason — and the run
    // still delivers the healthy source's company (§4.7).
    expect(finish.sources.find((s) => s.id === "aubi-plus-de")?.status).toBe("blocked");
    expect(finish.sources.find((s) => s.id === "aubi-plus-de")?.reason).toBe("captcha");
    expect(finish.sources.find((s) => s.id === "ausbildung-de")?.status).toBe("ok");
    expect(finish.foundCompanies).toBe(1);
    expect(finish.companiesProcessed).toBe(1);
    expect(finish.emailsFound + finish.noPublicEmail + finish.sourcesBlocked).toBe(
      finish.companiesProcessed,
    );
    expect(finish.status).toBe("partial");
  });
});

// ---------------------------------------------------------------------------
// §22/§23 — the new UI strings exist in every locale
// ---------------------------------------------------------------------------

describe("the new UI strings exist in all four locales", () => {
  const dictionaries = readFileSync(
    resolve(fileURLToPath(new URL("../..", import.meta.url)), "src/lib/i18n/dictionaries.ts"),
    "utf8",
  );

  it("has the discovery, family and category keys in de/en/fr/ar", () => {
    // Quoted keys (hyphenated) are matched on the quoted identifier.
    for (const key of [
      "scanned:",
      "family:",
      "platform:",
      'company-site"',
      "directory:",
      "blocked:",
    ]) {
      const count = (dictionaries.match(new RegExp(key.replace(":", "\\:"), "g")) ?? []).length;
      expect(count, `${key} should exist in all four locales`).toBeGreaterThanOrEqual(4);
    }
  });
});
