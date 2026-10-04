import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * The additional Ausbildung sources.
 *
 * Covers, offline and deterministically (fetch and DNS are stubbed, no
 * third-party site is contacted): the per-source offer mapping of a newly
 * enabled portal, detail-URL discovery, the resulting policy gate, the
 * blocked-source matrix, email safety against generated addresses,
 * cross-source deduplication and source isolation.
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

import type { NormalizedOffer, OfferSourceAdapter } from "@/lib/company-discovery/adapter";
import {
  adapterFor,
  enabledAdapters,
  enabledSourcesWithoutAdapter,
  ENDPOINT_CONFIRMED,
} from "@/lib/company-discovery/adapters";
import { createFetchContext, guardedFetch } from "@/lib/company-discovery/fetch-guard";
import { detailLinks, jsonLdBlocks, parseListingPage } from "@/lib/company-discovery/listing";
import {
  enabledSources,
  mayYieldEmail,
  policySkippedSources,
  PORTAL_SOURCES,
  sourceById,
} from "@/lib/company-discovery/sources";
import { resolveCompanyEmails } from "@/lib/company-discovery/emails";
import { runDiscoveryPipeline } from "@/lib/company-discovery/search";
import type { DiscoveryRun } from "@/lib/company-discovery/types";

const RUN_ID = "33333333-3333-4333-8333-333333333333";
const USER_ID = "44444444-4444-4444-8444-444444444444";

/**
 * A detail page as AUBI-plus serves it: the JSON-LD `type` attribute is
 * HTML-entity-encoded (`application&#x2F;ld&#x2B;json`), which is ordinary
 * templating — the JSON body itself is plain.
 */
const AUBI_DETAIL = `<!doctype html><html><head>
<script type="application&#x2F;ld&#x2B;json">
{
"@context": "https://schema.org",
"@type": "JobPosting",
"title": "Ausbildung Industriekaufmann (m/w/d)",
"datePosted": "2026-09-24",
"validThrough": "2026-12-31",
"jobStartDate": "2027-08-01",
"employmentType": "APPRENTICESHIP",
"hiringOrganization": { "name": "Bücker Essing GmbH", "url": "https://buecker-essing.de" },
"jobLocation": { "address": { "addressLocality": "Lingen", "addressRegion": "Niedersachsen" } },
"baseSalary": { "currency": "EUR", "value": { "value": 1100, "unitText": "MONTH" } },
"description": "Bewerbung an ausbildung@buecker-essing.de"
}
</script></head><body>Ausbildung bei Bücker Essing GmbH in Lingen</body></html>`;

const AUBI_DETAIL_SPARSE = `<!doctype html><html>
<script type="application&#x2F;ld&#x2B;json">
{"@type":"JobPosting","title":"Ausbildung","hiringOrganization":{"name":"Nur Name GmbH"}}
</script></html>`;

const LISTING_INDEX = `<!doctype html><html><body>
<a href="/ausbildung/buecker-essing-gmbh-industriekaufmann-lingen-415233/">Ausbildung Industriekaufmann</a>
<a href="/ausbildung/buecker-essing-gmbh-fachkraft-lagerlogistik-lingen-164193/">Lagerlogistik</a>
<a href="/ausbildung/">Zur Übersicht</a>
<a href="https://www.stepstone.de/stellenangebote">Extern</a>
<a href="/impressum">Impressum</a>
</body></html>`;

beforeEach(() => {
  state.rows = {};
  state.finish = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Registry / policy gate
// ---------------------------------------------------------------------------

describe("the extended registry stays evidence-based and fail-closed", () => {
  it("registers every candidate with exactly one classification", () => {
    const ids = PORTAL_SOURCES.map((source) => source.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicate ids
    for (const source of PORTAL_SOURCES) {
      expect(["enabled_public", "enabled_official_api", "restricted", "unverified"]).toContain(
        source.policy,
      );
      // Every classification carries a real, auditable reason.
      expect(source.reason.length).toBeGreaterThan(30);
      expect(source.domain).not.toContain("://");
    }
    // The four newly audited portals are registered under the requested names.
    expect(sourceById("aubi-plus-de")?.displayName).toBe("AUBI-plus.de");
    expect(sourceById("azubiyo-de")?.displayName).toBe("Azubiyo.de");
    expect(sourceById("azubister-de")?.displayName).toBe("Azubister.de");
    expect(sourceById("ausbildunganzeigen-de")?.displayName).toBe(
      "Ausbildunganzeigen.de",
    );
  });

  it("gives an adapter to every enabled source and to no other", () => {
    const enabled = enabledSources().map((source) => source.id);
    expect(enabled).toContain("ausbildung-de");
    expect(enabled).toContain("aubi-plus-de");
    // Enabled ⇒ an adapter exists (no hollow "enabled" source).
    expect(enabledSourcesWithoutAdapter()).toEqual([]);
    expect(enabledAdapters().map((adapter) => adapter.id).sort()).toEqual(
      [...enabled].sort(),
    );
    // Restricted / unverified ⇒ no adapter at all.
    for (const source of policySkippedSources()) {
      expect(adapterFor(source.id)).toBeNull();
    }
    expect(adapterFor("azubister-de")).toBeNull();
    expect(adapterFor("ausbildunganzeigen-de")).toBeNull();
    expect(adapterFor("azubiyo-de")).toBeNull();
    expect(adapterFor("does-not-exist")).toBeNull();
  });

  it("only lets an enabled, email-allowed source contribute an address", () => {
    expect(mayYieldEmail("aubi-plus-de")).toBe(true);
    expect(mayYieldEmail("ausbildung-de")).toBe(true);
    expect(mayYieldEmail("azubiyo-de")).toBe(false); // unverified
    expect(mayYieldEmail("azubister-de")).toBe(false); // restricted
    expect(mayYieldEmail("arbeitsagentur")).toBe(false); // §3.3
  });

  it("marks the AUBI-plus endpoint as verified against a live page", () => {
    expect(ENDPOINT_CONFIRMED["aubi-plus-de"]).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Offer parsing (fixtures, offline)
// ---------------------------------------------------------------------------

describe("offer parsing of the newly enabled portal", () => {
  const context = {
    offerSource: "AUBI-plus.de",
    sourceId: "aubi-plus-de",
    field: "Marketing / E-Commerce",
    goal: "ausbildung" as const,
  };

  it("reads the entity-encoded JobPosting and maps every stated field", () => {
    const offers = parseListingPage({
      ...context,
      html: AUBI_DETAIL,
      pageUrl: "https://www.aubi-plus.de/ausbildung/buecker-essing-gmbh-industriekaufmann-lingen-415233/",
    });
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({
      companyName: "Bücker Essing GmbH",
      companyWebsite: "https://buecker-essing.de",
      role: "Ausbildung Industriekaufmann (m/w/d)",
      field: "Marketing / E-Commerce",
      city: "Lingen",
      state: "Niedersachsen",
      offerType: "ausbildung",
      beginn: "2027-08-01",
      salary: "1100 EUR MONTH",
      offerSource: "AUBI-plus.de",
      offerUrl: "https://www.aubi-plus.de/ausbildung/buecker-essing-gmbh-industriekaufmann-lingen-415233/",
    });
    // The listing's own printed address is accepted with its evidence.
    expect(offers[0].publishedEmail?.email).toBe("ausbildung@buecker-essing.de");
  });

  it("leaves everything the listing does not state as null", () => {
    const offers = parseListingPage({
      ...context,
      html: AUBI_DETAIL_SPARSE,
      pageUrl: "https://www.aubi-plus.de/ausbildung/nur-name-1/",
    });
    expect(offers[0]).toMatchObject({
      companyName: "Nur Name GmbH",
      city: null,
      state: null,
      beginn: null,
      salary: null,
      companyWebsite: null,
      publishedEmail: null,
    });
  });

  it("finds no offer on a page without structured data (never invents one)", () => {
    expect(
      parseListingPage({
        ...context,
        html: "<html><body><h1>Ausbildung</h1><p>Bücker Essing GmbH</p></body></html>",
        pageUrl: "https://www.aubi-plus.de/aktuelle-ausbildungsplaetze/",
      }),
    ).toEqual([]);
  });
});

describe("detail-URL discovery on an index page", () => {
  const PATTERN = /^\/ausbildung\/[a-z0-9-]+-\d+\/?$/i;

  it("keeps only same-origin links matching the declared shape", () => {
    const links = detailLinks({
      html: LISTING_INDEX,
      pageUrl: "https://www.aubi-plus.de/aktuelle-ausbildungsplaetze/",
      pattern: PATTERN,
      limit: 10,
    });
    expect(links).toEqual([
      "https://www.aubi-plus.de/ausbildung/buecker-essing-gmbh-industriekaufmann-lingen-415233/",
      "https://www.aubi-plus.de/ausbildung/buecker-essing-gmbh-fachkraft-lagerlogistik-lingen-164193/",
    ]);
  });

  it("respects the limit and drops query strings", () => {
    const links = detailLinks({
      html: LISTING_INDEX,
      pageUrl: "https://www.aubi-plus.de/aktuelle-ausbildungsplaetze/?page=2",
      pattern: PATTERN,
      limit: 1,
    });
    expect(links).toHaveLength(1);
    expect(links[0]).not.toContain("page=2");
  });

  it("accepts a plain and an entity-encoded script type alike", () => {
    const plain = '<script type="application/ld+json">{"@type":"JobPosting"}</script>';
    const encoded =
      '<script type="application&#x2F;ld&#x2B;json">{"@type":"JobPosting"}</script>';
    expect(jsonLdBlocks(plain)).toHaveLength(1);
    expect(jsonLdBlocks(encoded)).toHaveLength(1);
    // A non-JSON-LD script is still ignored.
    expect(jsonLdBlocks('<script type="text/javascript">var a=1</script>')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Blocked sources — always source_blocked, never no_public_email
// ---------------------------------------------------------------------------

describe("every block produces source_blocked, never no_public_email", () => {
  const cases: Array<[string, number, Record<string, string>, string]> = [
    ["403 forbidden", 403, {}, "forbidden"],
    ["429 rate limited", 429, {}, "rate_limited"],
    ["reCAPTCHA", 200, {}, "captcha"],
    ["Cloudflare challenge", 200, { "cf-mitigated": "challenge" }, "bot_challenge"],
    ["login redirect", 200, {}, "login_required"],
  ];

  it("classifies and reports them consistently through the resolver", async () => {
    for (const [label, status, headers, expected] of cases) {
      const body =
        label === "reCAPTCHA"
          ? '<script src="https://www.google.com/recaptcha/api.js"></script>'
          : label === "login redirect"
            ? "<html><body>login</body></html>"
            : '<title>Just a moment…</title>';
      const mock = vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/robots.txt")) {
          return new Response("User-agent: *\nDisallow:\n", {
            status: 200,
            headers: { "content-type": "text/plain" },
          });
        }
        // A login WALL is a redirect the page answers with: model it as such.
        if (label === "login redirect" && !url.includes("/login")) {
          return new Response(null, {
            status: 302,
            headers: { location: "/login?next=/impressum" },
          });
        }
        return new Response(body, {
          status,
          headers: { "content-type": "text/html", ...headers },
        });
      });
      vi.stubGlobal("fetch", mock);
      const ctx = createFetchContext({
        fetchImpl: mock as unknown as typeof fetch,
        isPublicHost: async () => true,
        sleep: async () => undefined,
      });
      const outcome = await resolveCompanyEmails({
        companyName: "Muster GmbH",
        listingEmail: null,
        websiteUrl: "https://muster-gmbh.de",
        search: { ran: true, results: [] },
        trustedPages: [],
        fetchSite: async (url) => {
          // Drive the REAL guarded fetcher so the classifier is exercised.
          const first = await guardedFetch(ctx, `${url}/impressum`);
          if (!first.ok) {
            return {
              pages: [],
              attempts: ctx.attempts.slice(-1),
              blocked: true,
              blockedReason: "reason" in first ? first.reason : "unreachable",
            };
          }
          return { pages: [], attempts: [], blocked: false, blockedReason: null };
        },
      });
      expect(outcome.reasonCode, label).toBe("source_blocked");
      expect(outcome.blocked, label).toBe(true);
      expect(["captcha", "bot_challenge", "login_required", "forbidden", "rate_limited"]).toContain(
        outcome.blockedReason,
      );
      expect(outcome.blockedReason, label).toBe(expected);
    }
  });
});

// ---------------------------------------------------------------------------
// Email safety
// ---------------------------------------------------------------------------

describe("no address can be generated for a company domain", () => {
  const site = async () => ({
    pages: [
      {
        url: "https://muster-gmbh.de/impressum",
        kind: "impressum",
        text: "Impressum — Muster GmbH, Köln. Telefon 0221 123456. Keine E-Mail angegeben.",
      },
    ],
    attempts: [],
    blocked: false,
    blockedReason: null,
  });

  it("never produces info@/kontakt@/bewerbung@/karriere@ from the domain", async () => {
    const outcome = await resolveCompanyEmails({
      companyName: "Muster GmbH",
      listingEmail: null,
      websiteUrl: "https://muster-gmbh.de",
      search: { ran: true, results: [] },
      trustedPages: [],
      fetchSite: site as never,
    });
    expect(outcome.emails).toEqual([]);
    expect(outcome.reasonCode).toBe("no_public_email");
    for (const generated of [
      "info@muster-gmbh.de",
      "kontakt@muster-gmbh.de",
      "bewerbung@muster-gmbh.de",
      "karriere@muster-gmbh.de",
    ]) {
      expect(JSON.stringify(outcome)).not.toContain(generated);
    }
  });

  it("accepts the same address only when it is literally published", async () => {
    const outcome = await resolveCompanyEmails({
      companyName: "Muster GmbH",
      listingEmail: null,
      websiteUrl: "https://muster-gmbh.de",
      search: { ran: true, results: [] },
      trustedPages: [],
      fetchSite: (async () => ({
        pages: [
          {
            url: "https://muster-gmbh.de/impressum",
            kind: "impressum",
            text: "Impressum — Muster GmbH, Köln. E-Mail: bewerbung@muster-gmbh.de",
          },
        ],
        attempts: [],
        blocked: false,
        blockedReason: null,
      })) as never,
    });
    expect(outcome.primary?.email).toBe("bewerbung@muster-gmbh.de");
    expect(outcome.primary?.sourceUrl).toBe("https://muster-gmbh.de/impressum");
  });
});

// ---------------------------------------------------------------------------
// Run level: dedupe, isolation, policy (no restricted source is ever asked)
// ---------------------------------------------------------------------------

function run(overrides: Partial<DiscoveryRun> = {}): DiscoveryRun {
  return {
    runId: RUN_ID,
    status: "pending",
    params: {
      field: "Marketing / E-Commerce",
      role: "Kaufmann im E-Commerce",
      beginn: { mode: "from_now" },
      goal: "ausbildung",
      targetCompanies: 50,
      onlyPublicEmail: false,
    },
    progress: {
      status: "pending",
      targetCompanies: 50,
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
    ...overrides,
  };
}

function fakeAdapter(
  id: "aubi-plus-de" | "ausbildung-de",
  offers: Partial<NormalizedOffer>[] | "throw",
): OfferSourceAdapter {
  const source = sourceById(id);
  return {
    id,
    displayName: source?.displayName ?? id,
    category: "ausbildung",
    policy: "enabled_public",
    async searchOffers() {
      if (offers === "throw") throw new Error("adapter exploded");
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

async function runPipeline(
  adapters: OfferSourceAdapter[],
  requested: string[],
  emptyWindow = true,
) {
  const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
    requested.push(typeof input === "string" ? input : input.toString());
    return new Response("<html><body>nothing</body></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  });
  vi.stubGlobal("fetch", mockFetch);
  const store = await import("@/lib/company-discovery/runs");
  vi.mocked(store.getDiscoveryRun).mockResolvedValue(run());
  vi.mocked(store.startDiscoveryRun).mockResolvedValue(run());
  const result = await runDiscoveryPipeline(RUN_ID, USER_ID, {
    window: async () =>
      ({
        mode: "scan",
        window: [],
        total: 0,
        scan_truncated: false,
        exhausted: true,
        degraded: false,
        filter_counts: { any: 0, today: 0, yesterday: 0, week: 0, twoWeeks: 0, fourWeeks: 0 },
      }) as never,
    adapters,
    searchClient: null,
    fetchContext: createFetchContext({
      fetchImpl: mockFetch as unknown as typeof fetch,
      isPublicHost: async () => true,
      sleep: async () => undefined,
    }),
    isCancelled: async () => false,
  });
  void emptyWindow;
  return { result, finish: state.finish as Record<string, unknown>, requested };
}

describe("run level: dedupe, isolation and the policy gate", () => {
  it("merges the same company across two sources and counts the duplicate", async () => {
    const shared = { companyName: "Doppelt GmbH", city: "Köln" };
    const { finish } = await runPipeline([
      fakeAdapter("aubi-plus-de", [shared]),
      fakeAdapter("ausbildung-de", [shared]),
    ], []);
    expect(finish.companiesProcessed).toBe(1);
    expect(finish.duplicatesRemoved).toBe(1);
    expect(finish.foundCompanies).toBe(1);
  });

  it("continues when one adapter throws and another succeeds", async () => {
    const { finish, result } = await runPipeline([
      fakeAdapter("aubi-plus-de", "throw"),
      fakeAdapter("ausbildung-de", [{ companyName: "Gesund GmbH" }]),
    ], []);
    expect(finish.companiesProcessed).toBe(1);
    expect(finish.foundCompanies).toBe(1);
    const sources = finish.sources as Array<{ id: string; status: string }>;
    expect(sources.find((s) => s.id === "aubi-plus-de")?.status).toBe("error");
    expect(sources.find((s) => s.id === "ausbildung-de")?.status).toBe("ok");
    expect(["partial", "completed"]).toContain(result.status);
  });

  it("never requests a restricted or unverified host, and reports it as skipped", async () => {
    const requested: string[] = [];
    const { finish, requested: urls } = await runPipeline([], requested);
    for (const forbidden of [
      "indeed",
      "stepstone",
      "jobware",
      "xing",
      "linkedin",
      "meinestadt",
      "yourfirm",
      "service.bund.de",
      "ausbildungsmarkt",
      "azubister",
      "ausbildunganzeigen",
      "azubiyo",
      "aubi-plus",
    ]) {
      expect(urls.some((url) => url.includes(forbidden))).toBe(false);
    }
    const sources = finish.sources as Array<{ id: string; status: string; policy?: string }>;
    for (const source of policySkippedSources()) {
      const entry = sources.find((s) => s.id === source.id);
      expect(entry?.status, source.id).toBe("skipped_by_policy");
    }
    expect(sources.every((s) => s.status !== "ok" || s.id === "bundesagentur")).toBe(true);
  });
});
