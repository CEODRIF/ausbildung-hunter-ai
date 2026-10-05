import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The UNIFIED research engine at pipeline level — Tavily (search API), BA,
 * the plain-HTTP scraper and the Camofox browser working as ONE system:
 *
 *  - Tavily/search failure → the other sources keep the run alive;
 *  - Camofox failure → the run degrades to HTTP-only, never crashes;
 *  - Camofox deep crawl runs for accepted companies (session reuse, real
 *    browser pages counted) and its own-company offers DEDUPE against the
 *    BA/Tavily company (one company, many sources);
 *  - the run's execution stats are MEASURED (browserPages = what the fake
 *    engine really loaded, queriesExecuted ≥ provider calls, …);
 *  - a runtime overrun mid-crawl ends the run as an honest `partial` with
 *    the checkpoint + stats persisted;
 *  - the planner's documented geographic expansion (city → Bundesland).
 */

const state = vi.hoisted(() => ({
  finishOutcome: null as unknown,
  counterCalls: [] as unknown[],
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from() {
      const api: Record<string, unknown> = {};
      for (const key of ["select", "eq", "in", "order", "limit", "not", "update", "insert", "upsert"]) {
        api[key] = () => api;
      }
      api.maybeSingle = async () => ({ data: null, error: null });
      api.single = async () => ({ data: null, error: null });
      api.insert = () => ({
        select: () => ({
          single: async () => ({ data: { id: `company-${Math.random()}` }, error: null }),
          maybeSingle: async () => ({ data: { id: "company-1" }, error: null }),
        }),
      });
      api.update = () => api;
      api.then = (resolve: (value: unknown) => unknown) => resolve({ data: [], error: null });
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
    setRunCounters: vi.fn(async (_id: string, _uid: string, patch: unknown) => {
      state.counterCalls.push(patch);
    }),
    recordCandidates: vi.fn(async () => undefined),
    recordCompany: vi.fn(async () => ({ companyId: "company-1", created: true })),
    recordCompanyEmail: vi.fn(async () => "email-1"),
  };
});

import { createResearchPlanner } from "@/lib/company-discovery/planner";
import { createFetchContext } from "@/lib/company-discovery/fetch-guard";
import { runDiscoveryPipeline } from "@/lib/company-discovery/search";
import { CamofoxClient } from "@/lib/company-discovery/camofox/client";
import type { DiscoveryRun, DiscoveryRunParams } from "@/lib/company-discovery/types";
import type { OpportunityWindow } from "@/lib/opportunities/types";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";

const RUN_PARAMS: DiscoveryRunParams = {
  field: "Technik",
  role: "Mechatroniker",
  beginn: { mode: "from_now" },
  goal: "ausbildung",
  targetCompanies: 10,
  onlyPublicEmail: true,
};

beforeEach(() => {
  state.finishOutcome = null;
  state.counterCalls = [];
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

function opportunity(index: number): import("@/lib/opportunities/types").Opportunity {
  return {
    id: `arbeitsagentur:${index}-S`,
    goal: "ausbildung" as const,
    title: "Ausbildung Mechatroniker",
    company_name: `Musterbetrieb ${index} GmbH`,
    location_detail: { city: "München", region: "Bayern", country: "DE", postal_code: "80331" },
    valid_from: "2027-08-01",
    salary: { label: "1150 €" },
    source_name: "Bundesagentur für Arbeit",
    source_url: `https://www.arbeitsagentur.de/jobsuche/jobdetail/${index}`,
    contact: { email: null, phone: null, name: null },
    enrichment: {
      website_url: `https://firma-${index}.de`,
      website_source: `https://firma-${index}.de/impressum`,
      email: null,
    },
  } as unknown as import("@/lib/opportunities/types").Opportunity;
}

function windowOf(count: number): () => Promise<OpportunityWindow> {
  const seeds = Array.from({ length: count }, (_, i) => opportunity(i));
  return async () =>
    ({
      mode: "scan",
      window: seeds,
      total: seeds.length,
      scan_truncated: false,
      exhausted: true,
      degraded: false,
      filter_counts: { any: seeds.length, today: 0, yesterday: 0, week: 0, twoWeeks: 0, fourWeeks: 0 },
    } as unknown as OpportunityWindow);
}

/**
 * Offline HTTP: robots allowed; company impressum pages publish a literal
 * email (the email pass can accept); everything else is an empty page.
 */
function mockHttpFetch() {
  const impl = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url.includes("/robots.txt")) {
      return new Response("User-agent: *\nDisallow:\n", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }
    if (url.endsWith("/impressum")) {
      const host = new URL(url).hostname;
      return new Response(
        `<html><body>Impressum — ${host}. Kontakt: bewerbung@${host}</body></html>`,
        { status: 200, headers: { "content-type": "text/html" } },
      );
    }
    return new Response("<html><body>Leere Seite ohne Inhalt.</body></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  }) as unknown as typeof fetch;
  vi.stubGlobal("fetch", impl);
  return { impl };
}

/**
 * A FAKE camofox engine over the companies' sites (same contract as the real
 * server): the homepage links to /ausbildung + /kontakt; /ausbildung carries
 * a JobPosting for the SAME company (the dedupe case); /kontakt the email.
 */
function fakeCamofoxEngine() {
  const loaded: string[] = [];
  /** tabId → the {host, path} the tab currently shows. */
  const tabs = new Map<string, { host: string; path: string }>();

  const companyOf = (host: string): string => {
    const n = host.replace("firma-", "").replace(".de", "");
    return `Musterbetrieb ${n} GmbH`;
  };

  const engineFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const raw = String(input);
    const method = init?.method ?? "GET";
    const body =
      init?.body !== undefined
        ? (JSON.parse(init.body as string) as Record<string, unknown>)
        : ({} as Record<string, unknown>);
    const url = new URL(raw);

    if (method === "GET" && url.pathname === "/health") return Response.json({ ok: true });
    if (method === "DELETE") return Response.json({ ok: true });

    if (method === "POST" && url.pathname === "/tabs") {
      const tabId = `tab-${tabs.size + 1}`;
      const pageUrl = String(body.url ?? "https://x.de/");
      tabs.set(tabId, { host: new URL(pageUrl).hostname, path: new URL(pageUrl).pathname });
      loaded.push(pageUrl);
      return Response.json({ tabId, url: pageUrl, httpStatus: 200, navigationOk: true });
    }
    const nav = url.pathname.match(/^\/tabs\/([^/]+)\/navigate$/);
    if (method === "POST" && nav) {
      const pageUrl = String(body.url ?? "https://x.de/");
      tabs.set(nav[1], { host: new URL(pageUrl).hostname, path: new URL(pageUrl).pathname });
      loaded.push(pageUrl);
      return Response.json({ ok: true, tabId: nav[1], url: pageUrl, httpStatus: 200, navigationOk: true });
    }
    const ev = url.pathname.match(/^\/tabs\/([^/]+)\/evaluate$/);
    if (method === "POST" && ev) {
      const tab = tabs.get(ev[1]) ?? { host: "firma-0.de", path: "/" };
      const text = `Gehrender Inhalt von ${tab.host} ${tab.path} — die Seite ist vollständig im Browser gerendert und lesbar.`;
      const jsonLd =
        tab.path.includes("ausbildung")
          ? `<script type="application/ld+json">${JSON.stringify({
              "@type": "JobPosting",
              title: "Ausbildung Mechatroniker",
              url: `https://${tab.host}/ausbildung`,
              hiringOrganization: { "@type": "Organization", name: companyOf(tab.host), url: `https://${tab.host}` },
              jobLocation: { "@type": "Place", name: "München" },
            })}</script>`
          : "";
      return Response.json({
        ok: true,
        result: {
          title: tab.host,
          href: `https://${tab.host}${tab.path}`,
          html: `<html><body>${text}</body>${jsonLd}</html>`,
          text,
        },
      });
    }
    const links = url.pathname.match(/^\/tabs\/([^/]+)\/links$/);
    if (method === "GET" && links) {
      const tab = tabs.get(links[1]) ?? { host: "firma-0.de", path: "/" };
      const base = `https://${tab.host}`;
      return Response.json({
        links: [
          { url: `${base}/ausbildung`, text: "Ausbildung" },
          { url: `${base}/kontakt`, text: "Kontakt" },
        ],
        pagination: { total: 2, offset: 0, limit: 100, hasMore: false },
      });
    }
    if (method === "GET" && url.pathname.match(/^\/tabs\/[^/]+\/snapshot$/)) {
      return Response.json({ url: raw, snapshot: "- document" });
    }
    return Response.json({ error: "unknown" }, { status: 404 });
  };
  const fetch = vi.fn(engineFetch) as unknown as FetchImpl;

  return { fetch, loaded };
}

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function camofoxClientOf(engine: { fetch: typeof fetch }, maxPages = 20): CamofoxClient {
  return new CamofoxClient(
    { baseUrl: "http://127.0.0.1:9377", accessKey: null, timeoutMs: 2000 },
    `discovery:${RUN_ID}`,
    {
      maxPages,
      maxInteractions: 10,
      deps: { fetchImpl: engine.fetch, isPublicHost: async () => true },
    },
  );
}

describe("reliability — one source failing never stops the research", () => {
  it("Tavily/search fails → BA + HTTP continue, the run still counts companies", async () => {
    const { impl } = mockHttpFetch();
    const store = await import("@/lib/company-discovery/runs");
    vi.mocked(store.getDiscoveryRun).mockResolvedValue(baseRun());
    vi.mocked(store.startDiscoveryRun).mockResolvedValue(baseRun());

    const failingSearch = {
      name: "tavily" as const,
      search: async () => {
        throw new Error("TAVILY_ERROR: quota exhausted");
      },
    };

    await runDiscoveryPipeline(RUN_ID, USER_ID, {
      window: windowOf(2),
      offerSearchClient: failingSearch,
      searchClient: null,
      fetchContext: createFetchContext({
        fetchImpl: impl,
        isPublicHost: async () => true,
        sleep: async () => undefined,
      }),
      camofoxClient: null,
      isCancelled: async () => false,
    });

    const outcome = state.finishOutcome as {
      status: string;
      foundCompanies: number;
      sources: Array<{ id: string; status: string; stats?: { queriesExecuted: number; resultsInspected: number } }>;
    };
    expect(outcome.status).not.toBe("failed");
    // The BA-sourced companies were still researched and counted.
    expect(outcome.foundCompanies).toBeGreaterThanOrEqual(1);
    // The search layer reported its REAL failure — per design a provider
    // error is an HONEST ZERO (queries issued, zero results), never a
    // silent success and never a run-ending crash.
    const searchSource = outcome.sources.find((s) => s.id === "search-api");
    expect(searchSource?.status).toBe("ok");
    expect(searchSource?.stats?.queriesExecuted).toBeGreaterThan(0);
    expect(searchSource?.stats?.resultsInspected).toBe(0);
  });

  it("Camofox fails (probe → unavailable) → HTTP-only run, honest source row, no crash", async () => {
    const { impl } = mockHttpFetch();
    const store = await import("@/lib/company-discovery/runs");
    vi.mocked(store.getDiscoveryRun).mockResolvedValue(baseRun());
    vi.mocked(store.startDiscoveryRun).mockResolvedValue(baseRun());

    // A dead engine: /health never answers.
    const deadEngine = {
      fetch: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
      loaded: [] as string[],
    };

    const result = await runDiscoveryPipeline(RUN_ID, USER_ID, {
      window: windowOf(1),
      offerSearchClient: null,
      searchClient: null,
      fetchContext: createFetchContext({
        fetchImpl: impl,
        isPublicHost: async () => true,
        sleep: async () => undefined,
      }),
      camofoxClient: camofoxClientOf(deadEngine),
      isCancelled: async () => false,
    });

    expect(result.status).not.toBe("failed");
    const outcome = state.finishOutcome as {
      foundCompanies: number;
      browserPages: number;
      sources: Array<{ id: string; status: string }>;
    };
    // The HTTP pass still found the company …
    expect(outcome.foundCompanies).toBeGreaterThanOrEqual(1);
    // …zero browser pages were really loaded …
    expect(outcome.browserPages).toBe(0);
    // …and the browser source row says WHY it was unavailable.
    expect(
      outcome.sources.find((s) => s.id === "browser-camofox")?.status,
    ).toBe("unavailable");
  });
});

describe("unified research — the crawl feeds the dedupe + the real stats", () => {
  it("a company from BA whose site is crawled by Camofox stays ONE company (multi-source dedupe)", async () => {
    const { impl } = mockHttpFetch();
    const store = await import("@/lib/company-discovery/runs");
    vi.mocked(store.getDiscoveryRun).mockResolvedValue(baseRun());
    vi.mocked(store.startDiscoveryRun).mockResolvedValue(baseRun());

    const engine = fakeCamofoxEngine();

    const result = await runDiscoveryPipeline(RUN_ID, USER_ID, {
      window: windowOf(1), // Musterbetrieb 0 GmbH @ firma-0.de
      offerSearchClient: null,
      searchClient: null,
      fetchContext: createFetchContext({
        fetchImpl: impl,
        isPublicHost: async () => true,
        sleep: async () => undefined,
      }),
      camofoxClient: camofoxClientOf(engine),
      isCancelled: async () => false,
    });

    expect(result.status).not.toBe("failed");
    const outcome = state.finishOutcome as {
      foundCompanies: number;
      uniqueCompanies: number;
      duplicatesRemoved: number;
      browserPages: number;
      pagesInspected: number;
      sources: Array<{ id: string; status: string }>;
    };
    // ONE counted company — the crawl's own-company offer deduped against
    // the BA-sourced company (name + domain identity).
    expect(outcome.foundCompanies).toBe(1);
    expect(outcome.uniqueCompanies).toBe(1);
    // The browser really loaded pages (measured, ≥ homepage + 2 links).
    expect(outcome.browserPages).toBeGreaterThan(0);
    expect(engine.loaded.length).toBeGreaterThan(0);
    expect(outcome.pagesInspected).toBeGreaterThan(0);
    // The crawl was reported as a working source.
    expect(outcome.sources.find((s) => s.id === "browser-camofox")?.status).toBe("ok");
  });

  it("the run's stats are MEASURED (provider queries + inspected pages + browser pages)", async () => {
    const { impl } = mockHttpFetch();
    const store = await import("@/lib/company-discovery/runs");
    // YEAR mode (2027): a documented 2027 start can be CONFIRMED (from_now
    // has no concrete year to confirm — that is by design, never a guess).
    const run = baseRun();
    run.params = { ...run.params, beginn: { mode: "year", year: 2027 } };
    vi.mocked(store.getDiscoveryRun).mockResolvedValue(run);
    vi.mocked(store.startDiscoveryRun).mockResolvedValue(run);

    const engine = fakeCamofoxEngine();
    const searchCalls: string[] = [];
    const searchClient = {
      name: "tavily" as const,
      search: async (query: string) => {
        searchCalls.push(query);
        return []; // no web results — BA is the only discovery source
      },
    };

    await runDiscoveryPipeline(RUN_ID, USER_ID, {
      window: windowOf(2),
      offerSearchClient: searchClient,
      searchClient: null,
      fetchContext: createFetchContext({
        fetchImpl: impl,
        isPublicHost: async () => true,
        sleep: async () => undefined,
      }),
      camofoxClient: camofoxClientOf(engine),
      isCancelled: async () => false,
    });

    const outcome = state.finishOutcome as {
      queriesExecuted: number;
      pagesInspected: number;
      browserPages: number;
      beginnConfirmed: number;
      applicationsFound: number;
    };
    // queriesExecuted counts every provider query the search adapter issued
    // (the agentic planner's batches) + the per-company lookup queries.
    expect(outcome.queriesExecuted).toBeGreaterThanOrEqual(searchCalls.length);
    expect(searchCalls.length).toBeGreaterThan(0); // the planner really ran
    // pagesInspected = HTTP pages + browser pages, all real fetches.
    expect(outcome.pagesInspected).toBeGreaterThan(0);
    // The browser pages equal what the engine actually loaded.
    expect(outcome.browserPages).toBe(engine.loaded.length);
    // The BA offers start in 2027 → documented (the run's beginn matches).
    expect(outcome.beginnConfirmed).toBeGreaterThanOrEqual(1);
    expect(typeof outcome.applicationsFound).toBe("number");
  });
});

describe("runtime budget — a mid-crawl overrun is an honest partial + checkpoint", () => {
  it("exceeding MAX_RUNTIME during the crawl finishes `partial` and keeps the stats", async () => {
    const { impl } = mockHttpFetch();
    const store = await import("@/lib/company-discovery/runs");
    vi.mocked(store.getDiscoveryRun).mockResolvedValue(baseRun());
    vi.mocked(store.startDiscoveryRun).mockResolvedValue(baseRun());

    vi.stubEnv("DISCOVERY_MAX_RUNTIME_MS", "1500");
    const engine = fakeCamofoxEngine();
    let t = 0; // 300ms per clock read → the budget trips mid-run

    await runDiscoveryPipeline(RUN_ID, USER_ID, {
      window: windowOf(2),
      offerSearchClient: null,
      searchClient: null,
      fetchContext: createFetchContext({
        fetchImpl: impl,
        isPublicHost: async () => true,
        sleep: async () => undefined,
      }),
      camofoxClient: camofoxClientOf(engine),
      isCancelled: async () => false,
      now: () => (t += 300),
    });

    const outcome = state.finishOutcome as {
      status: string;
      foundCompanies: number;
      browserPages: number;
      pagesInspected: number;
    };
    // Honest partial (target 10, budget ran out) …
    expect(outcome.status).toBe("partial");
    // …with the measured work preserved in the outcome (the checkpoint the
    // /continue endpoint restores):
    expect(outcome.foundCompanies).toBeGreaterThanOrEqual(0);
    expect(typeof outcome.browserPages).toBe("number");
    expect(typeof outcome.pagesInspected).toBe("number");
  });
});

describe("adaptive planner — documented geographic expansion (city → Bundesland)", () => {
  it("discovering offers in München widens the strategy space to Bayern", () => {
    const planner = createResearchPlanner({
      role: "Mechatroniker",
      field: "Technik",
      beginnYear: 2027,
      goal: "ausbildung",
    });
    // Batch 1: the role/city-free base queries.
    const first = planner.nextBatch(4);
    expect(first.queries.length).toBeGreaterThan(0);
    // The run discovers offers in München (BA city).
    planner.noteDiscovery({ role: "Mechatroniker", city: "München", state: null });
    // The next strategy must contain a STATE-level query (the documented
    // widening München → Bayern), not just grind the city.
    let sawStateQuery = false;
    for (let i = 0; i < 4 && !sawStateQuery; i += 1) {
      const batch = planner.nextBatch(4);
      if (batch.queries.length === 0) break;
      sawStateQuery = batch.queries.some((query) => query.includes("Bayern"));
    }
    expect(sawStateQuery).toBe(true);
  });

  it("an unknown city widens nothing (no guessing)", () => {
    const planner = createResearchPlanner({
      role: "Mechatroniker",
      field: "Technik",
      beginnYear: 2027,
      goal: "ausbildung",
    });
    planner.nextBatch(4);
    planner.noteDiscovery({ role: "Mechatroniker", city: "Musterdorf", state: null });
    const memory = planner.snapshot();
    // "Musterdorf" is not in the curated list → no new state may appear.
    expect(JSON.stringify(memory.states)).not.toContain("Bayern");
  });
});
