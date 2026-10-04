import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Offer → Company — the missing-link regression suite.
 *
 * Production incident: "3 offers discovered → 0 companies discovered →
 * 0 companies processed → 0 emails found". Two root causes are pinned down
 * here:
 *   RC-1: portals mark genuine "Ausbildung" postings with
 *         `employmentType: FULL_TIME`; the funnel then dropped the offers
 *         SILENTLY (goal gate) — even though the title literally said
 *         "Ausbildung".
 *   RC-2: a company the source gave no website for NEVER had its official
 *         site opened — only search snippets were scanned, so almost no
 *         email could ever be literally found.
 *
 * This suite proves the required flow: search result → employer identity →
 * official domain (verified, never guessed) → official site opened
 * (Kontakt / Impressum / Karriere) → literal public email → verified
 * company — and that every offer that never becomes a company has a clear,
 * traced REJECTION REASON.
 *
 * Everything is offline and deterministic: fetch is stubbed, the provider is
 * stubbed, the BA window is empty, and no third-party site is contacted.
 */

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  finishOutcome: null as unknown,
  companies: [] as Row[],
  emails: [] as Row[],
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
        if (table === "discovery_company_emails") state.emails.push(...list);
        rows().push(...list);
        return {
          select: () => ({
            single: async () => ({ data: { id: `company-${state.companies.length}` }, error: null }),
            maybeSingle: async () => ({ data: list[0] ?? null, error: null }),
          }),
          then: (r: (v: unknown) => unknown) => r({ data: list, error: null }),
        };
      };
      (api.upsert as unknown) = (values: Row | Row[]) => {
        const list = Array.isArray(values) ? values : [values];
        if (table === "discovery_company_emails") state.emails.push(...list);
        rows().push(...list);
        return {
          select: () => ({ maybeSingle: async () => ({ data: { id: `email-${state.emails.length}` }, error: null }) }),
          then: (r: (v: unknown) => unknown) => r({ data: list, error: null }),
        };
      };
      (api.update as unknown) = () => ({
        eq: () => ({
          eq: () => ({
            eq: () => ({
              in: () => ({
                select: () => ({ maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }) }),
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

import { resolveOfficialSite } from "@/lib/company-discovery/emails";
import { createFetchContext } from "@/lib/company-discovery/fetch-guard";
import { effectiveOfferType, parseListingPage } from "@/lib/company-discovery/listing";
import { createResearchPlanner } from "@/lib/company-discovery/planner";
import { runDiscoveryPipeline } from "@/lib/company-discovery/search";
import type { NormalizedOffer, OfferSourceAdapter } from "@/lib/company-discovery/adapter";
import type { DiscoveryRun, DiscoveryRunParams } from "@/lib/company-discovery/types";
import type { WebSearchClient } from "@/lib/web-search";
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
  state.emails = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function baseRun(params: DiscoveryRunParams = RUN_PARAMS): DiscoveryRun {
  return {
    runId: RUN_ID,
    status: "pending",
    params,
    progress: {
      status: "pending",
      targetCompanies: params.targetCompanies,
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
    } as unknown as OpportunityWindow);
}

function offer(
  companyName: string,
  index: number,
  over: Partial<NormalizedOffer> = {},
): NormalizedOffer {
  return {
    companyName,
    companyWebsite: null,
    role: "Ausbildung Kaufmann im E-Commerce",
    field: RUN_PARAMS.field,
    city: "Köln",
    state: "Nordrhein-Westfalen",
    offerType: null,
    beginn: null,
    salary: null,
    offerSource: "Search API (Tavily)",
    offerUrl: `https://job-portal.example/offers/${index}`,
    publishedEmail: null,
    listingText: `Ausbildung bei ${companyName} in Köln`,
    candidateRef: `search-api:${index}`,
    ...over,
  };
}

/** The search adapter as the run builds it — but pre-loaded with our offers. */
function fakeSearchAdapter(offers: NormalizedOffer[]): OfferSourceAdapter {
  return {
    id: "search-api",
    displayName: "Search API (Tavily)",
    category: "search",
    policy: "enabled_official_api",
    async searchOffers() {
      return { status: "ok", offers };
    },
  };
}

/** A stubbed provider whose only job is to hand back candidate result URLs. */
function tavilyStub(resultUrls: string[], snippet = ""): {
  client: WebSearchClient;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    client: {
      name: "tavily" as const,
      search: async (query: string) => {
        calls.push(query);
        return resultUrls.map((url) => ({ title: "Suchergebnis", url, snippet }));
      },
    } as WebSearchClient,
  };
}

/**
 * The company's site, offline: robots allowed; the impressum names the
 * company (the domain-verification fact) and — when `withEmail` — literally
 * publishes an address on the company's own domain.
 */
function musterwerkFetch(withEmail: boolean) {
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
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {
      host = "";
    }
    if (host.endsWith("musterwerk.de")) {
      if (url.includes("/impressum")) {
        const body = withEmail
          ? `<html><body>Impressum — Musterwerk GmbH, Am Ring 5, 50667 Köln. E-Mail: bewerbung@musterwerk.de Telefon 0221 555. ${"x".repeat(120)}</body></html>`
          : `<html><body>Impressum — Musterwerk GmbH, Am Ring 5, 50667 Köln. Telefon 0221 555. ${"x".repeat(120)}</body></html>`;
        return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
      }
      const page = url.includes("/karriere") ? "Karriere & Ausbildung" : "Kontakt";
      return new Response(
        `<html><body>Musterwerk GmbH — ${page}. ${"x".repeat(120)}</body></html>`,
        { status: 200, headers: { "content-type": "text/html" } },
      );
    }
    return new Response(
      `<html><body>Not found. ${"x".repeat(120)}</body></html>`,
      { status: 404, headers: { "content-type": "text/html" } },
    );
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

async function runPipeline(opts: {
  offers: NormalizedOffer[];
  withEmail: boolean;
  params?: DiscoveryRunParams;
  tavilyUrls?: string[];
  snippet?: string;
}) {
  const site = musterwerkFetch(opts.withEmail);
  const tavily = tavilyStub(opts.tavilyUrls ?? ["https://musterwerk.de/impressum"], opts.snippet);
  vi.stubGlobal("fetch", site.impl);
  vi.stubEnv("DISCOVERY_MAX_EMAIL_SITE_PASSES", "20");

  const store = await import("@/lib/company-discovery/runs");
  const run = baseRun(opts.params);
  vi.mocked(store.getDiscoveryRun).mockResolvedValue(run);
  vi.mocked(store.startDiscoveryRun).mockResolvedValue(run);

  const result = await runDiscoveryPipeline(RUN_ID, USER_ID, {
    window: emptyWindow(),
    adapters: [fakeSearchAdapter(opts.offers)],
    searchClient: tavily.client,
    offerSearchClient: tavily.client,
    fetchContext: createFetchContext({
      fetchImpl: site.impl,
      isPublicHost: async () => true,
      sleep: async () => undefined,
    }),
    isCancelled: async () => false,
  });

  return {
    result,
    fetchCalls: site.calls,
    searchCalls: tavily.calls,
    outcome: state.finishOutcome as {
      status: string;
      foundCompanies: number;
      offersAnalyzed: number;
      uniqueCompanies: number;
      duplicatesRemoved: number;
      companiesRejected: number;
      emailsFound: number;
      noPublicEmail: number;
      sourcesBlocked: number;
      companiesProcessed: number;
    },
  };
}

const companyRecords = async (): Promise<Row[]> => {
  const store = await import("@/lib/company-discovery/runs");
  return vi.mocked(store.recordCompany).mock.calls.map((call) => call[1] as unknown as Row);
};

// ---------------------------------------------------------------------------
// RC-1 — a documented "Ausbildung" title outranks the portal's FULL_TIME tag
// ---------------------------------------------------------------------------

describe("RC-1 — offer type: the page's own words decide", () => {
  const parse = (title: string, employmentType: unknown) =>
    parseListingPage({
      html: `<script type="application/ld+json">{"@type":"JobPosting","title":${JSON.stringify(
        title,
      )},"employmentType":${JSON.stringify(employmentType)},"hiringOrganization":{"name":"Musterwerk GmbH"}}</script>`,
      pageUrl: "https://job-portal.example/offers/1",
      offerSource: "Search API (Tavily)",
      sourceId: "search-api",
      field: RUN_PARAMS.field,
      goal: "ausbildung",
    });

  it("FULL_TIME + title 'Ausbildung … (Azubi)' stays an ausbildung offer", () => {
    const offers = parse("Ausbildung Kaufmann im E-Commerce (Azubi)", "FULL_TIME");
    expect(offers).toHaveLength(1);
    expect(offers[0].offerType).toBe("ausbildung");
  });

  it("FULL_TIME without any apprenticeship word stays 'arbeit' (scope guard holds)", () => {
    const offers = parse("Kaufmann im E-Commerce Vollzeit", "FULL_TIME");
    expect(offers).toHaveLength(1);
    expect(offers[0].offerType).toBe("arbeit");
  });

  it("nothing stated → the pass's own goal; stated apprenticeship always wins", () => {
    expect(effectiveOfferType(null, "irgendwas", "ausbildung")).toBe("ausbildung");
    expect(effectiveOfferType("ausbildung", "Kaufmann Vollzeit", "arbeit")).toBe("ausbildung");
    expect(effectiveOfferType("arbeit", "Bürokaufmann", "ausbildung")).toBe("arbeit");
  });

  it("an offer whose type is out of scope is NOT a silent drop — it is traced with a reason", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    await runPipeline({
      offers: [offer("Musterwerk GmbH", 1, { offerType: "arbeit" })],
      withEmail: true,
    });
    expect(info.mock.calls.some((call) => String(call[0]).includes('outcome="goal_out_of_scope"'))).toBe(
      true,
    );
    // And nothing was processed or counted.
    expect(state.finishOutcome && (state.finishOutcome as { companiesProcessed: number }).companiesProcessed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// RC-2 — Job portal → employer identity → official website → contact evidence
// ---------------------------------------------------------------------------

describe("RC-2 — a company without a stated website gets its official site resolved and opened", () => {
  it("10. end-to-end: offer → company → official domain → contact/impressum → public email → accepted", async () => {
    const { outcome, searchCalls, fetchCalls } = await runPipeline({
      offers: [offer("Musterwerk GmbH", 1)],
      withEmail: true,
    });

    // The company search actually ran, for the company, with the contact terms.
    expect(searchCalls).toHaveLength(1);
    expect(searchCalls[0]).toContain("Musterwerk GmbH");
    expect(searchCalls[0]).toContain("Kontakt");

    // The official site was OPENED: impressum, kontakt and karriere pages.
    expect(fetchCalls.some((u) => u.includes("musterwerk.de/impressum"))).toBe(true);
    expect(fetchCalls.some((u) => u.includes("musterwerk.de/kontakt"))).toBe(true);
    expect(fetchCalls.some((u) => u.includes("musterwerk.de/karriere"))).toBe(true);

    // The company was counted exactly once, with its email.
    expect(outcome.foundCompanies).toBe(1);
    expect(outcome.companiesProcessed).toBe(1);
    expect(outcome.emailsFound).toBe(1);
    expect(outcome.uniqueCompanies).toBe(1);

    // The VERIFIED domain was stored with the company (not left null).
    const records = await companyRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      status: "accepted",
      websiteUrl: "https://musterwerk.de",
    });
    expect(String(records[0].websiteSourceUrl ?? "")).toContain("musterwerk.de");

    // The email was recorded, verified, on the company's own domain.
    const store = await import("@/lib/company-discovery/runs");
    const emailCalls = vi.mocked(store.recordCompanyEmail).mock.calls;
    expect(emailCalls).toHaveLength(1);
    expect(emailCalls[0][1]).toMatchObject({ email: "bewerbung@musterwerk.de" });
  });

  it("5. no email anywhere → the company is NOT accepted under onlyPublicEmail=true (but honestly processed)", async () => {
    const { outcome } = await runPipeline({
      offers: [offer("Musterwerk GmbH", 1)],
      withEmail: false,
    });
    expect(outcome.companiesProcessed).toBe(1);
    expect(outcome.noPublicEmail).toBe(1);
    expect(outcome.foundCompanies).toBe(0);
    const records = await companyRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ status: "rejected", rejectReason: "no_public_email" });
    const store = await import("@/lib/company-discovery/runs");
    expect(vi.mocked(store.recordCompanyEmail).mock.calls).toHaveLength(0);
  });

  it("6. a guessed email is never accepted — an address must literally occur in opened content", async () => {
    // Nowhere in the stubbed web is "bewerbung@musterwerk.de" stated — not on
    // the pages, not in a snippet. The engine cannot produce it.
    const { outcome } = await runPipeline({
      offers: [offer("Musterwerk GmbH", 1)],
      withEmail: false,
      snippet: "Musterwerk GmbH sucht Azubis in Köln",
    });
    expect(outcome.foundCompanies).toBe(0);
    expect(outcome.emailsFound).toBe(0);
    const store = await import("@/lib/company-discovery/runs");
    expect(vi.mocked(store.recordCompanyEmail).mock.calls).toHaveLength(0);
  });

  it("8+9. three offers of the SAME company → exactly ONE company (no re-processed duplicates)", async () => {
    const { outcome, searchCalls } = await runPipeline({
      offers: [
        offer("Musterwerk GmbH", 1),
        offer("Musterwerk GmbH", 2),
        offer("Musterwerk GmbH", 3),
      ],
      withEmail: true,
    });
    expect(outcome.foundCompanies).toBe(1);
    expect(outcome.duplicatesRemoved).toBe(2);
    // The expensive email pass ran ONCE — the duplicates never paid for it.
    expect(outcome.companiesProcessed).toBe(1);
    expect(searchCalls).toHaveLength(1);
    expect(outcome.offersAnalyzed).toBe(3);
  });

  it("12. reaching the target keeps the existing stop condition (no over-processing)", async () => {
    const { outcome, searchCalls } = await runPipeline({
      offers: [
        offer("Musterwerk GmbH", 1),
        offer("Musterwerk GmbH", 2),
      ],
      withEmail: true,
      params: { ...RUN_PARAMS, targetCompanies: 1 },
    });
    expect(outcome.foundCompanies).toBe(1);
    expect(outcome.status).toBe("completed");
    // The loop stopped AT the target: the second offer was never processed.
    expect(outcome.companiesProcessed).toBe(1);
    expect(outcome.offersAnalyzed).toBe(1);
    expect(searchCalls).toHaveLength(1);
  });

  it("14+15. no fake progress: counters add up and reflect what actually happened", async () => {
    const { outcome } = await runPipeline({
      offers: [offer("Musterwerk GmbH", 1)],
      withEmail: true,
    });
    // The §4.8 invariant, exactly.
    expect(outcome.emailsFound + outcome.noPublicEmail + outcome.sourcesBlocked).toBe(
      outcome.companiesProcessed,
    );
    expect(outcome.foundCompanies).toBeLessThanOrEqual(outcome.companiesProcessed);
    expect(outcome.offersAnalyzed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Rejection reasons — every offer that never became a company is explainable
// ---------------------------------------------------------------------------

describe("rejection reasons — a lost offer is never a mystery", () => {
  it("7a. a JobPosting without an employer identity yields no offer (no invention)", () => {
    expect(
      parseListingPage({
        html: `<script type="application/ld+json">{"@type":"JobPosting","title":"Ausbildung Kaufmann"}</script>`,
        pageUrl: "https://job-portal.example/offers/9",
        offerSource: "Search API (Tavily)",
        sourceId: "search-api",
        field: "IT",
        goal: "ausbildung",
      }),
    ).toEqual([]);
  });

  it("7b. an unusable employer name is rejected with the traced reason 'unusable_company_name'", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { outcome } = await runPipeline({
      offers: [offer("AG", 1)],
      withEmail: true,
    });
    expect(
      info.mock.calls.some((call) => String(call[0]).includes('outcome="unusable_company_name"')),
    ).toBe(true);
    // Analyzed, but never resolved: an unusable name spends no email pass.
    expect(outcome.offersAnalyzed).toBe(1);
    expect(outcome.companiesProcessed).toBe(0);
    expect(await companyRecords()).toHaveLength(0);
  });

  it("a duplicate is traced with the identity it matched", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    await runPipeline({
      offers: [offer("Musterwerk GmbH", 1), offer("Musterwerk GmbH", 2)],
      withEmail: true,
    });
    expect(
      info.mock.calls.some(
        (call) =>
          String(call[0]).includes('outcome="duplicate"') &&
          String(call[0]).includes('"matchedIdentity":"name"'),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Official-domain resolution — verified, never guessed
// ---------------------------------------------------------------------------

describe("resolveOfficialSite — the domain is a fact, not a pattern", () => {
  const seedFetch = (entries: Array<[string, string | number]>) => {
    const pages = new Map(entries);
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
      const entry = [...pages.entries()].find(([prefix]) => url.startsWith(prefix));
      if (!entry) {
        return new Response("<html><body>404</body></html>", {
          status: 404,
          headers: { "content-type": "text/html" },
        });
      }
      const status = typeof entry[1] === "number" ? entry[1] : 200;
      return new Response(
        typeof entry[1] === "number"
          ? "<html><body>Refused</body></html>"
          : entry[1],
        { status, headers: { "content-type": "text/html" } },
      );
    });
    return { impl: impl as unknown as typeof fetch, calls };
  };

  const ctx = (impl: typeof fetch) =>
    createFetchContext({
      fetchImpl: impl,
      isPublicHost: async () => true,
      sleep: async () => undefined,
    });

  it("accepts a domain whose own page literally names the company", async () => {
    const site = seedFetch([
      ["https://firma-a.de/impressum", "<html><body>Impressum — Firma A GmbH, Musterstr. 1, Köln.</body></html>"],
    ]);
    vi.stubGlobal("fetch", site.impl);
    const res = await resolveOfficialSite({
      companyName: "Firma A GmbH",
      urls: ["https://firma-a.de/impressum"],
      ctx: ctx(site.impl),
    });
    expect(res.websiteUrl).toBe("https://firma-a.de");
    expect(res.pages).toHaveLength(1);
    expect(res.pages[0].kind).toBe("impressum");
  });

  it("rejects a portal host even when its page names the company", async () => {
    const site = seedFetch([
      ["https://www.stepstone.de/unternehmen/firma-a", "<html><body>Firma A GmbH — Karriereseite von StepStone</body></html>"],
    ]);
    vi.stubGlobal("fetch", site.impl);
    const res = await resolveOfficialSite({
      companyName: "Firma A GmbH",
      urls: ["https://www.stepstone.de/unternehmen/firma-a"],
      ctx: ctx(site.impl),
    });
    expect(res.websiteUrl).toBeNull();
    expect(site.calls.filter((u) => u.includes("stepstone"))).toHaveLength(0); // never even fetched
  });

  it("rejects a page that does not name the company (no name → domain guessing)", async () => {
    const site = seedFetch([
      ["https://firma-a.de/impressum", "<html><body>Impressum — Ein anderes Unternehmen GmbH, Köln.</body></html>"],
    ]);
    vi.stubGlobal("fetch", site.impl);
    const res = await resolveOfficialSite({
      companyName: "Firma A GmbH",
      urls: ["https://firma-a.de/impressum"],
      ctx: ctx(site.impl),
    });
    expect(res.websiteUrl).toBeNull();
  });

  it("keeps trying later candidates: a 404 first page is a real answer, not THE answer", async () => {
    // A 404 says "that page does not exist" (no breaker) — the next candidate
    // is still tried. (A 403 WOULD open the host's circuit breaker: a host
    // that deliberately refuses is not hammered — the guard's existing rule.)
    const site = seedFetch([
      ["https://firma-a.de/alter-pfad", 404],
      ["https://firma-a.de/impressum", "<html><body>Impressum — Firma A GmbH, Köln. info@firma-a.de</body></html>"],
    ]);
    vi.stubGlobal("fetch", site.impl);
    const res = await resolveOfficialSite({
      companyName: "Firma A GmbH",
      urls: ["https://firma-a.de/alter-pfad", "https://firma-a.de/impressum"],
      ctx: ctx(site.impl),
    });
    expect(res.websiteUrl).toBe("https://firma-a.de");
    expect(res.pages[0].kind).toBe("impressum");
  });
});

// ---------------------------------------------------------------------------
// 11. the planner moves to another strategy when the first one measured zero
// ---------------------------------------------------------------------------

describe("11. planner — a dead-first strategy does not grind forever", () => {
  it("after a zero-offer batch, the next batch contains fresh queries", () => {
    const planner = createResearchPlanner({
      role: "Kaufmann im E-Commerce",
      field: "Marketing / E-Commerce",
      beginnYear: null,
      goal: "ausbildung",
    });
    const b1 = planner.nextBatch(4);
    expect(b1.queries.length).toBeGreaterThan(0);
    // First strategy measured: results existed, but NO offers, no companies.
    planner.observe(
      b1.queries,
      { resultsSeen: 12, offersExtracted: 0, newCompanies: 0 },
      b1.queries.map((query) => ({
        query,
        resultsSeen: 3,
        pagesFetched: 1,
        offersExtracted: 0,
      })),
    );
    const b2 = planner.nextBatch(4);
    expect(b2.queries.length).toBeGreaterThan(0);
    // The engine changed course: at least one query it has never issued.
    expect(b2.queries.some((q) => !b1.queries.includes(q))).toBe(true);
  });
});
