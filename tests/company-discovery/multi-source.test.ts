import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Multi-source discovery: the access policy, the central blocked-source
 * classifier, the guarded fetcher (SSRF / robots / circuit breaker), the
 * portal adapter and the run-level invariants.
 *
 * Everything is offline and deterministic: `fetch` is stubbed, DNS is stubbed
 * and time is injected, so no third-party site is ever contacted.
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
      // Recording the writes is what the assertions need.
      (api.insert as unknown) = (values: Row | Row[]) => {
        const list = Array.isArray(values) ? values : [values];
        if (table === "discovery_companies") state.companies.push(...list);
        if (table === "discovery_company_emails") state.emails.push(...list);
        rows().push(...list);
        return { select: () => ({ single: async () => ({ data: { id: `company-${state.companies.length}` }, error: null }), maybeSingle: async () => ({ data: list[0] ?? null, error: null }) }), then: (r: (v: unknown) => unknown) => r({ data: list, error: null }) };
      };
      (api.upsert as unknown) = (values: Row | Row[]) => {
        const list = Array.isArray(values) ? values : [values];
        if (table === "discovery_company_emails") state.emails.push(...list);
        rows().push(...list);
        return { select: () => ({ maybeSingle: async () => ({ data: { id: `email-${state.emails.length}` }, error: null }) }), then: (r: (v: unknown) => unknown) => r({ data: list, error: null }) };
      };
      (api.update as unknown) = () => ({
        eq: () => ({ eq: () => ({ eq: () => ({ in: () => ({ select: () => ({ maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }) }) }) }) }) }),
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

import { classifyResponse } from "@/lib/company-discovery/classify";
import {
  createFetchContext,
  guardedFetch,
  REQUEST_TIMEOUT_MS,
} from "@/lib/company-discovery/fetch-guard";
import { parseListingPage } from "@/lib/company-discovery/listing";
import {
  adapterFor,
  enabledAdapters,
} from "@/lib/company-discovery/adapters";
import {
  enabledSources,
  isPortalHost,
  mayYieldEmail,
  policySkippedSources,
  PORTAL_SOURCES,
  sourceById,
} from "@/lib/company-discovery/sources";
import { runDiscoveryPipeline } from "@/lib/company-discovery/search";
import type { OpportunityWindow } from "@/lib/opportunities/types";
import type { DiscoveryRun, DiscoveryRunParams } from "@/lib/company-discovery/types";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";

const RUN_PARAMS: DiscoveryRunParams = {
  field: "Marketing / E-Commerce",
  role: "Kaufmann im E-Commerce",
  beginn: { mode: "from_now" },
  goal: "ausbildung",
  targetCompanies: 100,
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
});

// ---------------------------------------------------------------------------
// §4.3 — the central classifier
// ---------------------------------------------------------------------------

describe("§4.3 — ONE classifier decides what is blocked", () => {
  const facts = (over: Partial<Parameters<typeof classifyResponse>[0]>) => ({
    url: "https://example-source.de/jobs",
    status: 200,
    headers: {},
    contentType: "text/html",
    bodyHead: "<html><body>Ausbildung bei Muster GmbH in Köln</body></html>",
    visibleTextLength: 400,
    ...over,
  });

  it("passes an ordinary page", () => {
    expect(classifyResponse(facts({}))).toEqual({ blocked: false });
  });

  it("treats 401/403/429/451 as a deliberate refusal", () => {
    expect(classifyResponse(facts({ status: 401 }))).toMatchObject({
      blocked: true,
      reason: "login_required",
    });
    expect(classifyResponse(facts({ status: 403 }))).toMatchObject({
      blocked: true,
      reason: "forbidden",
    });
    expect(classifyResponse(facts({ status: 429 }))).toMatchObject({
      blocked: true,
      reason: "rate_limited",
    });
    expect(classifyResponse(facts({ status: 451 }))).toMatchObject({
      blocked: true,
      reason: "forbidden",
    });
  });

  it("treats a challenge header as blocked even on a 200", () => {
    expect(
      classifyResponse(facts({ headers: { "cf-mitigated": "challenge" } })),
    ).toMatchObject({ blocked: true, reason: "bot_challenge" });
  });

  it("detects reCAPTCHA, hCaptcha and Cloudflare Turnstile", () => {
    for (const head of [
      '<script src="https://www.google.com/recaptcha/api.js"></script>',
      '<div class="h-captcha" data-sitekey="x"></div>',
      '<div class="cf-turnstile" data-sitekey="x"></div>',
    ]) {
      expect(classifyResponse(facts({ bodyHead: head, visibleTextLength: 5 }))).toMatchObject(
        { blocked: true, reason: "captcha" },
      );
    }
  });

  it("detects interstitials, DataDome and PerimeterX (HTTP 200)", () => {
    for (const head of [
      "<title>Just a moment…</title>",
      "<h1>Sicherheitsüberprüfung</h1>",
      "bestätigen Sie, dass Sie kein Roboter sind",
      "detected unusual traffic from your network",
      '<script src="/datadome.js"></script>',
      "<div id='px-captcha'></div>",
    ]) {
      expect(
        classifyResponse(facts({ bodyHead: head, visibleTextLength: 10 })).blocked,
      ).toBe(true);
    }
  });

  it("treats a login redirect and a JS-only shell as blocked", () => {
    expect(
      classifyResponse(facts({ url: "https://portal.de/login?next=/jobs" })),
    ).toMatchObject({ blocked: true, reason: "login_required" });
    expect(
      classifyResponse(
        facts({
          bodyHead: "<noscript>Please enable JavaScript to continue</noscript>",
          visibleTextLength: 12,
        }),
      ),
    ).toMatchObject({ blocked: true, reason: "js_protected" });
  });

  it("marks a robots denial without any HTTP involvement", () => {
    expect(classifyResponse(facts({ robotsDisallowed: true }))).toMatchObject({
      blocked: true,
      reason: "robots_disallow",
    });
  });
});

// ---------------------------------------------------------------------------
// §6 #15/#16 — the guarded fetcher: SSRF, robots, breaker
// ---------------------------------------------------------------------------

describe("§6 — the guarded fetcher", () => {
  type Call = { url: string };
  const calls: Call[] = [];

  function stubFetch(
    handler: (url: string) => Response | Promise<Response>,
    opts: { publicHosts?: (host: string) => boolean } = {},
  ) {
    const mock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({ url });
      return handler(url);
    });
    vi.stubGlobal("fetch", mock);
    const ctx = createFetchContext({
      fetchImpl: mock as unknown as typeof fetch,
      isPublicHost: async (host) =>
        opts.publicHosts ? opts.publicHosts(host) : host !== "127.0.0.1" && host !== "10.0.0.5",
      sleep: async () => undefined,
    });
    return { mock, ctx };
  }

  const robotsOk = () =>
    new Response("User-agent: *\nDisallow:\n", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  const html = (body: string) =>
    new Response(body, { status: 200, headers: { "content-type": "text/html" } });

  beforeEach(() => {
    calls.length = 0;
  });

  it("15. rejects non-http schemes, credentials and private targets", async () => {
    const { ctx } = stubFetch(robotsOk);
    expect(await guardedFetch(ctx, "ftp://example.de/x")).toMatchObject({
      ok: false,
      kind: "unsafe",
    });
    expect(await guardedFetch(ctx, "https://user:pw@example.de/x")).toMatchObject({
      ok: false,
      kind: "unsafe",
    });
    expect(await guardedFetch(ctx, "http://127.0.0.1/x")).toMatchObject({
      ok: false,
      kind: "unsafe",
    });
    expect(await guardedFetch(ctx, "http://10.0.0.5/x")).toMatchObject({
      ok: false,
      kind: "unsafe",
    });
    // Nothing was requested for any of them.
    expect(calls).toHaveLength(0);
  });

  it("15b. re-checks SSRF after a redirect (redirect to a private address)", async () => {
    const { ctx } = stubFetch((url) =>
      url.includes("/robots.txt")
        ? robotsOk()
        : new Response(null, { status: 302, headers: { location: "http://10.0.0.5/internal" } }),
    );
    const result = await guardedFetch(ctx, "https://example.de/jobs");
    expect(result).toMatchObject({ ok: false, kind: "unsafe" });
    // Only the allowed host was contacted.
    expect(calls.filter((call) => call.url.includes("10.0.0.5"))).toHaveLength(0);
  });

  it("16. a robots-disallowed path is never requested", async () => {
    const { ctx } = stubFetch((url) =>
      url.includes("/robots.txt")
        ? new Response("User-agent: *\nDisallow: /jobs\n", {
            status: 200,
            headers: { "content-type": "text/plain" },
          })
        : html("<html><body>secret</body></html>"),
    );
    const result = await guardedFetch(ctx, "https://example.de/jobs");
    expect(result).toMatchObject({ ok: false, kind: "blocked", reason: "robots_disallow" });
    expect(calls.map((call) => call.url)).toEqual(["https://example.de/robots.txt"]);
  });

  it("3. a challenge opens a per-host breaker: no second request, no retry", async () => {
    const { ctx } = stubFetch((url) =>
      url.includes("/robots.txt")
        ? robotsOk()
        : html("<title>Just a moment…</title><body>cf-challenge</body>"),
    );
    const first = await guardedFetch(ctx, "https://example.de/jobs");
    expect(first).toMatchObject({ ok: false, kind: "blocked", reason: "bot_challenge" });
    const before = calls.length;
    const second = await guardedFetch(ctx, "https://example.de/kontakt");
    expect(second).toMatchObject({ ok: false, kind: "blocked" });
    // The breaker means the second call never touched the network.
    expect(calls.length).toBe(before);
    // And nothing was retried with different headers inside the first call.
    expect(calls.filter((call) => call.url.includes("/jobs"))).toHaveLength(1);
  });

  it("caps the body and refuses non-HTML", async () => {
    const { ctx } = stubFetch((url) =>
      url.includes("/robots.txt")
        ? robotsOk()
        : new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    );
    expect(await guardedFetch(ctx, "https://example.de/api")).toMatchObject({
      ok: false,
      kind: "error",
      message: "not_html",
    });
    expect(REQUEST_TIMEOUT_MS).toBe(10_000);
  });
});

// ---------------------------------------------------------------------------
// §6 #17 — the adapter + the policy gate
// ---------------------------------------------------------------------------

const FIXTURE_LISTING = `<!doctype html><html><head><title>Ausbildung Jobs</title>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "JobPosting",
  "title": "Ausbildung Kaufmann im E-Commerce",
  "url": "https://www.ausbildung.de/stellen/123",
  "employmentType": "APPRENTICESHIP",
  "jobStartDate": "2027-08-01",
  "baseSalary": { "currency": "EUR", "value": { "value": 1150, "unitText": "MONTH" } },
  "hiringOrganization": { "name": "Mustermann GmbH", "url": "https://mustermann-gmbh.de" },
  "jobLocation": { "address": { "addressLocality": "Köln", "addressRegion": "Nordrhein-Westfalen" } },
  "description": "Bewerbung an ausbildung@mustermann-gmbh.de"
}
</script>
<script type="application/ld+json">
{ "@type": "JobPosting", "title": "Ausbildung ohne Arbeitgeber", "url": "https://www.ausbildung.de/stellen/999" }
</script>
</head><body>Ausbildung bei der Mustermann GmbH</body></html>`;

describe("§6 #17 — the enabled portal adapter", () => {
  it("maps exactly what the listing states and leaves the rest null", () => {
    const offers = parseListingPage({
      html: FIXTURE_LISTING,
      pageUrl: "https://www.ausbildung.de/suche/?q=Kaufmann",
      offerSource: "Ausbildung.de",
      sourceId: "ausbildung-de",
      field: "Marketing / E-Commerce",
      goal: "ausbildung",
    });
    expect(offers).toHaveLength(1); // the employer-less posting is dropped
    expect(offers[0]).toMatchObject({
      companyName: "Mustermann GmbH",
      role: "Ausbildung Kaufmann im E-Commerce",
      city: "Köln",
      state: "Nordrhein-Westfalen",
      offerType: "ausbildung",
      beginn: "2027-08-01",
      salary: "1150 EUR MONTH",
      offerSource: "Ausbildung.de",
      offerUrl: "https://www.ausbildung.de/stellen/123",
    });
    // The listing's own address is accepted WITH its evidence.
    expect(offers[0].publishedEmail).toMatchObject({
      email: "ausbildung@mustermann-gmbh.de",
    });
  });

  it("leaves every field the listing does not state as null", () => {
    const sparse = `<script type="application/ld+json">
      {"@type":"JobPosting","title":"Ausbildung","hiringOrganization":{"name":"Muster AG"}}
    </script>`;
    const offers = parseListingPage({
      html: sparse,
      pageUrl: "https://www.ausbildung.de/suche/?q=x",
      offerSource: "Ausbildung.de",
      sourceId: "ausbildung-de",
      field: "IT",
      goal: "ausbildung",
    });
    expect(offers[0]).toMatchObject({
      companyName: "Muster AG",
      city: null,
      state: null,
      beginn: null,
      salary: null,
      companyWebsite: null,
      publishedEmail: null,
    });
  });

  it("returns nothing for a page it cannot understand (no invention)", () => {
    expect(
      parseListingPage({
        html: "<html><body><h1>Jobs</h1></body></html>",
        pageUrl: "https://www.ausbildung.de/suche/",
        offerSource: "Ausbildung.de",
        sourceId: "ausbildung-de",
        field: "IT",
        goal: "ausbildung",
      }),
    ).toEqual([]);
  });

  it("never parses a company website that is really a portal host", () => {
    const withPortal = FIXTURE_LISTING.replace(
      "https://mustermann-gmbh.de",
      "https://www.stepstone.de",
    );
    const offers = parseListingPage({
      html: withPortal,
      pageUrl: "https://www.ausbildung.de/suche/?q=x",
      offerSource: "Ausbildung.de",
      sourceId: "ausbildung-de",
      field: "IT",
      goal: "ausbildung",
    });
    expect(offers[0].companyWebsite).toBeNull();
    expect(isPortalHost("www.stepstone.de")).toBe(true);
  });

  it("classifies the 15 portals + Arbeitsagentur, and implements only enabled ones", () => {
    expect(PORTAL_SOURCES).toHaveLength(16);
    expect(enabledSources().map((source) => source.id)).toEqual(["ausbildung-de"]);
    expect(policySkippedSources()).toHaveLength(15);
    expect(enabledAdapters()).toHaveLength(1);

    // restricted / unverified sources have NO adapter and may never yield an
    // address — checked by id, not by hope.
    for (const source of policySkippedSources()) {
      expect(adapterFor(source.id)).toBeNull();
      expect(mayYieldEmail(source.id)).toBe(false);
    }
    expect(mayYieldEmail("arbeitsagentur")).toBe(false);
    expect(sourceById("arbeitsagentur")?.policy).toBe("restricted");
    // Every skipped source carries an evidence-based reason.
    for (const source of policySkippedSources()) {
      expect(source.reason.length).toBeGreaterThan(20);
    }
  });
});

// ---------------------------------------------------------------------------
// §4.8 / §6 #12 — the partial run
// ---------------------------------------------------------------------------

function opportunity(
  index: number,
  withWebsite: boolean,
): import("@/lib/opportunities/types").Opportunity {
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
    enrichment: withWebsite
      ? { website_url: `https://firma-${index}.de`, website_source: `https://firma-${index}.de/impressum`, email: null }
      : null,
  } as unknown as import("@/lib/opportunities/types").Opportunity;
}

const COMPANY_EMAIL = "bewerbung@firma";
const ADDRESS_HOSTS = new Set([0, 1, 2, 3, 4, 5]);

describe("§6 #12 + §4.8 — ten companies, partial results, honest counters", () => {
  it("6 found / 2 without an address / 2 blocked, run completes, counters add up", async () => {
    // The ten companies: 6 publish an address, 2 publish nothing, 2 refuse.
    const seeds = Array.from({ length: 10 }, (_, i) => opportunity(i, true));
    const window = async (): Promise<OpportunityWindow> => ({
      mode: "scan" as const,
      window: seeds,
      total: seeds.length,
      scan_truncated: false,
      exhausted: true,
      degraded: false,
      filter_counts: { any: seeds.length, today: 0, yesterday: 0, week: 0, twoWeeks: 0, fourWeeks: 0 },
    } as unknown as OpportunityWindow);

    const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/robots.txt")) {
        return new Response("User-agent: *\nDisallow:\n", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }
      const host = new URL(url).hostname;
      const index = Number(host.replace(/\D/g, ""));
      // Companies 6 and 7 refuse every request.
      if (index === 6 || index === 7) {
        return new Response("<title>Just a moment…</title>", {
          status: 403,
          headers: { "content-type": "text/html" },
        });
      }
      if (url.endsWith("/impressum")) {
        const body = ADDRESS_HOSTS.has(index)
          ? `<html><body>Impressum — Musterbetrieb ${index} GmbH, Köln. Kontakt: ${COMPANY_EMAIL}-${index}.de</body></html>`
          : `<html><body>Impressum — Musterbetrieb ${index} GmbH, Köln. Telefon 0221 123456.</body></html>`;
        return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
      }
      return new Response(
        `<html><body>Kontakt — Musterbetrieb ${index} GmbH. Bitte nutzen Sie unser Formular. ${"x".repeat(200)}</body></html>`,
        { status: 200, headers: { "content-type": "text/html" } },
      );
    });
    vi.stubGlobal("fetch", mockFetch);
    vi.stubEnv("DISCOVERY_MAX_EMAIL_SITE_PASSES", "20");

    const run: DiscoveryRun = {
      runId: RUN_ID,
      status: "pending",
      params: RUN_PARAMS,
      progress: {
        status: "pending",
        targetCompanies: 100,
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
      createdAt: "2026-10-03T10:00:00.000Z",
      startedAt: null,
      finishedAt: null,
    };
    const store = await import("@/lib/company-discovery/runs");
    vi.mocked(store.getDiscoveryRun).mockResolvedValue(run);
    vi.mocked(store.startDiscoveryRun).mockResolvedValue(run);

    const result = await runDiscoveryPipeline(RUN_ID, USER_ID, {
      window,
      adapters: [],
      searchClient: null,
      fetchContext: createFetchContext({
        fetchImpl: mockFetch as unknown as typeof fetch,
        isPublicHost: async () => true,
        sleep: async () => undefined,
      }),
      isCancelled: async () => false,
    });

    const outcome = state.finishOutcome as {
      status: string;
      emailsFound: number;
      noPublicEmail: number;
      sourcesBlocked: number;
      companiesProcessed: number;
      foundCompanies: number;
      sources: Array<{ id: string; status: string }>;
    };
    expect(result.status).toBe("partial");
    expect(outcome.emailsFound).toBe(6);
    expect(outcome.noPublicEmail).toBe(2);
    expect(outcome.sourcesBlocked).toBe(2);
    // The invariant of §4.8 holds exactly.
    expect(
      outcome.emailsFound + outcome.noPublicEmail + outcome.sourcesBlocked,
    ).toBe(outcome.companiesProcessed);
    expect(outcome.companiesProcessed).toBe(10);
    // with onlyPublicEmail=true only the 6 found companies are results.
    expect(outcome.foundCompanies).toBe(6);
    // The run completes with a source report instead of dying.
    expect(outcome.sources.some((source) => source.id === "bundesagentur")).toBe(true);
    expect(
      outcome.sources.filter((source) => source.status === "skipped_by_policy").length,
    ).toBeGreaterThanOrEqual(14);
  });

  it("13. a failing source never takes the run down, and no blocked company is stored as 'no public email'", async () => {
    const seeds = [opportunity(0, true), opportunity(1, true)];
    const window = async (): Promise<OpportunityWindow> => ({
      mode: "scan" as const,
      window: seeds,
      total: seeds.length,
      scan_truncated: false,
      exhausted: true,
      degraded: false,
      filter_counts: { any: seeds.length, today: 0, yesterday: 0, week: 0, twoWeeks: 0, fourWeeks: 0 },
    } as unknown as OpportunityWindow);
    const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/robots.txt")) throw new Error("DNS failure");
      return new Response("<title>Just a moment…</title>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    });
    vi.stubGlobal("fetch", mockFetch);
    vi.stubEnv("DISCOVERY_MAX_EMAIL_SITE_PASSES", "20");

    const run = {
      runId: RUN_ID,
      status: "pending" as const,
      params: RUN_PARAMS,
      progress: {
        status: "pending" as const,
        targetCompanies: 100,
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
      createdAt: "2026-10-03T10:00:00.000Z",
      startedAt: null,
      finishedAt: null,
    };
    const store = await import("@/lib/company-discovery/runs");
    vi.mocked(store.getDiscoveryRun).mockResolvedValue(run);
    vi.mocked(store.startDiscoveryRun).mockResolvedValue(run);

    await runDiscoveryPipeline(RUN_ID, USER_ID, {
      window,
      adapters: [],
      searchClient: null,
      fetchContext: createFetchContext({
        fetchImpl: mockFetch as unknown as typeof fetch,
        isPublicHost: async () => true,
        sleep: async () => undefined,
      }),
      isCancelled: async () => false,
    });

    const outcome = state.finishOutcome as {
      emailsFound: number;
      noPublicEmail: number;
      sourcesBlocked: number;
    };
    // Blocked is reported as blocked — never as "no public email".
    expect(outcome.noPublicEmail).toBe(0);
    expect(outcome.sourcesBlocked).toBe(2);
    const recorded = vi.mocked(store.recordCompany).mock.calls;
    for (const call of recorded) {
      const record = call[1] as { status: string; rejectReason?: string | null };
      if (record.status === "rejected") {
        expect(record.rejectReason).not.toBe("no_public_email");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// §4.11 — i18n parity
// ---------------------------------------------------------------------------

describe("§4.11 — every new string exists in every locale", () => {
  const dictionaries = readFileSync(
    resolve(fileURLToPath(new URL("../..", import.meta.url)), "src/lib/i18n/dictionaries.ts"),
    "utf8",
  );

  it("has the source-type, status and counter keys in de/en/fr/ar", () => {
    for (const key of [
      "emailSource:",
      "emailStatus:",
      "job_listing:",
      "official_site_impressum:",
      "trusted_public_page:",
      "email_found:",
      "no_public_email:",
      "source_blocked:",
      "legacy:",
      "emailsFound:",
      "noPublicEmail:",
      "sourcesBlocked:",
      "sourceUrl:",
    ]) {
      const count = (dictionaries.match(new RegExp(key.replace(":", "\\:"), "g")) ?? []).length;
      expect(count, `${key} should exist in all four locales`).toBeGreaterThanOrEqual(4);
    }
  });
});
