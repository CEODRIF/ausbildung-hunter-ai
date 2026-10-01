import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildCategoryQueries,
  classifySource,
  deterministicExtract,
  discoverCategory,
  fingerprintOpportunity,
  mergeOpportunities,
  runWebDiscovery,
  type VerifiedCandidate,
} from "@/lib/opportunities/web-discovery";
import {
  enabledWebSources,
  getSource,
} from "@/lib/opportunities/sources";
import { targetStartYear } from "@/lib/opportunities/ai-search";
import {
  getWebSearchClient,
  WebSearchError,
  type WebSearchResult,
} from "@/lib/web-search";
import {
  candidateProfileFixture,
  createAdminMock,
  jsonResponse,
  mkSearchItem,
} from "../helpers";

const { createAdminClient } = await import("@/lib/supabase/admin");
const { createAIProvider } = await import("@/lib/ai-provider");
const { resolveOpportunity } =
  await import("@/lib/opportunities/providers/arbeitsagentur");
const { lookup } = await import("node:dns/promises");

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(),
}));
vi.mock("@/lib/ai-provider", () => ({
  createAIProvider: vi.fn(),
}));
vi.mock("@/lib/ai-service", () => ({
  reserveAIUsage: vi.fn(async () => {}),
}));
vi.mock("@/lib/opportunities/providers/arbeitsagentur", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/opportunities/providers/arbeitsagentur")
  >();
  return { ...actual, resolveOpportunity: vi.fn() };
});
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(),
}));
vi.mock("@/lib/web-search", () => ({
  getWebSearchClient: vi.fn(),
  // Mirrors the real WebSearchError shape (diagnostic fields included) so
  // provider-error plumbing under test behaves like production.
  WebSearchError: class WebSearchError extends Error {
    readonly status: number | null;
    readonly code: number | null;
    readonly providerStatus: string | null;
    readonly providerMessage: string | null;
    readonly model: string | null;
    constructor(
      message: string,
      status: number | null = null,
      info: {
        code: number | null;
        status: string | null;
        message: string | null;
      } = { code: null, status: null, message: null },
      model: string | null = null,
    ) {
      super(message);
      this.name = "WebSearchError";
      this.status = status;
      this.code = info.code;
      this.providerStatus = info.status;
      this.providerMessage = info.message;
      this.model = model;
    }
  },
}));

import type { Opportunity } from "@/lib/opportunities/types";
import { runAISearch } from "@/lib/opportunities/ai-search";

// ---------------------------------------------------------------------------
// mkOpp factory (schema-valid Opportunity literal)
// ---------------------------------------------------------------------------
function mkOpp(overrides: Partial<Opportunity> = {}): Opportunity {
  const base: Opportunity = {
    id: "web:TEST-1",
    provider: "web",
    external_id: "TEST-1",
    source_name: "example.com",
    source_url: "https://example.com/opportunity",
    source_type: "company_website",
    additional_sources: [],
    source_ids: [],
    enrichment: null,
    application_url: null,
    aggregator_url: null,
    title: "Ausbildung Mechatroniker/in",
    goal: "ausbildung",
    stellenangebotsart: null,
    company_name: "Beispiel GmbH",
    company_url: null,
    location: "10115 Berlin",
    location_detail: null,
    distance_km: null,
    latitude: null,
    longitude: null,
    profession: null,
    alternative_professions: [],
    description: null,
    tasks: [],
    requirements: [],
    employment_type: null,
    home_office: null,
    career_change_friendly: null,
    salary: null,
    training_type: null,
    education_requirement: null,
    valid_from: null,
    application_deadline: null,
    posted_at: null,
    updated_at: null,
    retrieved_at: "2026-09-30T12:00:00.000Z",
    contact: null,
    required_skills: [],
    preferred_skills: [],
    required_languages: [],
    extracted_keywords: [],
    match: null,
    ...overrides,
  };
  return base;
}

beforeEach(() => {
  const adminMock = createAdminMock();
  vi.mocked(createAdminClient).mockReturnValue(adminMock.admin as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Intake year
// ---------------------------------------------------------------------------
describe("targetStartYear", () => {
  it("targets the current year Jan–Jul, next year Aug+", () => {
    expect(targetStartYear(new Date("2026-03-15T12:00:00Z"))).toBe(2026);
    expect(targetStartYear(new Date("2026-07-31T12:00:00Z"))).toBe(2026);
    expect(targetStartYear(new Date("2026-08-01T12:00:00Z"))).toBe(2027);
    expect(targetStartYear(new Date("2026-09-30T12:00:00Z"))).toBe(2027);
  });
});

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------
describe("classifySource", () => {
  it("maps known portal hosts to job_portal", () => {
    expect(classifySource("https://www.ausbildung.de/a/123", "")).toBe(
      "job_portal",
    );
    expect(classifySource("https://de.indeed.com/job/x", "")).toBe(
      "job_portal",
    );
    expect(classifySource("https://www.stepstone.de/jobs/x", "")).toBe(
      "job_portal",
    );
  });

  it("maps social hosts to social_media (public indexed only)", () => {
    expect(classifySource("https://www.linkedin.com/posts/x", "")).toBe(
      "social_media",
    );
    expect(classifySource("https://www.instagram.com/p/x", "")).toBe(
      "social_media",
    );
    expect(classifySource("https://www.tiktok.com/@x/video/1", "")).toBe(
      "social_media",
    );
  });

  it("maps IHK/HWK/BA hosts to official_source", () => {
    expect(classifySource("https://www.arbeitsagentur.de/x", "")).toBe(
      "official_source",
    );
    expect(classifySource("https://muenchen.ihk.de/ausbildung", "")).toBe(
      "official_source",
    );
    expect(classifySource("https://hwk-berlin.de/stellen", "")).toBe(
      "official_source",
    );
  });

  it("maps career paths on unknown hosts to company_website, else other", () => {
    expect(
      classifySource("https://firma.example/karriere/ausbildung", ""),
    ).toBe("company_website");
    expect(
      classifySource("https://firma.example/jobs/ausbildung-2027", ""),
    ).toBe("company_website");
    expect(classifySource("https://blog.example/post-1", "")).toBe("other");
    expect(
      classifySource("https://blog.example/post-1", "Karriere bei uns"),
    ).toBe("company_website");
  });
});

// ---------------------------------------------------------------------------
// Category queries
// ---------------------------------------------------------------------------
describe("buildCategoryQueries", () => {
  const queries = ['"Kaufmann im E-Commerce" Ausbildung 2027'];
  it("search_engine passes the query through", () => {
    expect(buildCategoryQueries(queries, "search_engine")).toEqual(queries);
  });
  it("job_portal scopes to portal sites", () => {
    const [q] = buildCategoryQueries(queries, "job_portal");
    expect(q).toContain("site:ausbildung.de");
    expect(q).toContain("site:stepstone.de");
  });
  it("company_website adds career-page terms", () => {
    const [q] = buildCategoryQueries(queries, "company_website");
    expect(q).toContain("karriere");
    expect(q).toContain("stellenangebote");
  });
  it("social_media scopes to public social platforms", () => {
    const [q] = buildCategoryQueries(queries, "social_media");
    expect(q).toContain("site:linkedin.com");
    expect(q).toContain("site:youtube.com");
  });
});

// ---------------------------------------------------------------------------
// Discovery (search provider)
// ---------------------------------------------------------------------------
describe("discoverCategory", () => {
  const makeClient = (results: WebSearchResult[]) => ({
    name: "tavily" as const,
    search: vi.fn(async (): Promise<WebSearchResult[]> => results),
  });

  it("dedupes URLs, drops http + arbeitsagentur.de, counts errors", async () => {
    const client = makeClient([
      {
        title: "Ausbildung 2027",
        url: "https://firma.example/karriere/a?utm_source=google",
        snippet: "Ausbildung Mechatroniker",
      },
      {
        title: "Ausbildung 2027",
        url: "https://firma.example/karriere/a?utm_medium=cpc",
        snippet: "Ausbildung Mechatroniker",
      },
      { title: "X", url: "http://insecure.example/job", snippet: "Ausbildung" },
      {
        title: "BA",
        url: "https://www.arbeitsagentur.de/jobsuche/1",
        snippet: "Ausbildung",
      },
      { title: "No signal", url: "https://blog.example/hobby", snippet: "Kuchen" },
    ]);
    const { candidates, errors } = await discoverCategory({
      client,
      category: "search_engine",
      webQueries: ["Ausbildung 2027"],
    });
    expect(errors).toBe(0);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].url).toBe("https://firma.example/karriere/a");
  });

  it("counts provider failures as errors and keeps going", async () => {
    const client = makeClient([]);
    vi.mocked(client.search)
      .mockRejectedValueOnce(new WebSearchError("boom", 429))
      .mockResolvedValueOnce([
        {
          title: "Ausbildung 2027",
          url: "https://firma.example/karriere/b",
          snippet: "Ausbildung 2027",
        },
      ]);
    const { candidates, errors } = await discoverCategory({
      client,
      category: "job_portal",
      webQueries: ["Ausbildung 2027", "Mechatroniker 2027"],
    });
    expect(errors).toBe(1);
    expect(candidates).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Deterministic extraction fallback
// ---------------------------------------------------------------------------
describe("deterministicExtract", () => {
  const verified = (page: VerifiedCandidate["page"]): VerifiedCandidate => ({
    candidate: {
      url: "https://firma.example/karriere/a",
      title: "Ausbildung Mechatroniker/in 2027 | Karriere",
      snippet: "Ausbildung 2027",
      category: "company_website",
      query: "q",
    },
    page,
    source_type: "company_website",
    failure: null,
  });

  it("uses og:site_name as company and the page title as title", () => {
    const item = deterministicExtract(
      verified({
        url: "https://firma.example/karriere/a",
        finalUrl: "https://firma.example/karriere/a",
        title: "Ausbildung Mechatroniker/in 2027 | Karriere",
        metaDescription: "desc",
        siteName: "Beispiel GmbH",
        text: "x".repeat(100),
      }),
    );
    expect(item?.company).toBe("Beispiel GmbH");
    expect(item?.title).toBe("Ausbildung Mechatroniker/in 2027");
    expect(item?.email).toBeNull();
  });

  it("drops candidates without a determinable company (no invention)", () => {
    expect(
      deterministicExtract(
        verified({
          url: "u",
          finalUrl: "u",
          title: "T",
          metaDescription: null,
          siteName: "LinkedIn",
          text: "x".repeat(100),
        }),
      ),
    ).toBeNull();
    expect(deterministicExtract(verified(null))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Fingerprint + multi-source merge
// ---------------------------------------------------------------------------
describe("fingerprintOpportunity + mergeOpportunities", () => {
  it("fingerprint is case/diacritic/punctuation-insensitive; year matters", () => {
    const a = fingerprintOpportunity(mkOpp());
    const b = fingerprintOpportunity(
      mkOpp({ title: "Ausbildung Mechatroniker / in" }),
    );
    const c = fingerprintOpportunity(
      mkOpp({ title: "Ausbildung Mechatroniker/in 2028" }),
    );
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("merges BA + web same vacancy: official wins, provenance kept, nulls back-filled", () => {
    const ba = mkOpp({
      id: "arbeitsagentur:REF-A",
      provider: "arbeitsagentur",
      source_name: "Bundesagentur für Arbeit",
      source_url: "https://www.arbeitsagentur.de/jobsuche/1",
      source_type: "official_source",
      contact: null,
      company_url: null,
    });
    const web = mkOpp({
      id: "web:WEB-1",
      source_url: "https://firma.example/karriere/a",
      source_type: "company_website",
      contact: { person: null, email: "azubi@firma.example", phone: null },
      company_url: "https://firma.example",
    });
    const { merged, duplicatesRemoved } = mergeOpportunities({
      ba: [ba],
      web: [web],
      aiDuplicates: [],
    });
    expect(duplicatesRemoved).toBe(1);
    expect(merged).toHaveLength(1);
    const row = merged[0];
    expect(row.provider).toBe("arbeitsagentur");
    expect(row.source_type).toBe("official_source");
    expect(row.contact?.email).toBe("azubi@firma.example");
    expect(row.company_url).toBe("https://firma.example");
    expect(row.additional_sources).toEqual([
      {
        url: "https://firma.example/karriere/a",
        source_type: "company_website",
        source_name: "example.com",
      },
    ]);
  });

  it("prefers company_website over job_portal for web-only duplicates", () => {
    const portal = mkOpp({
      id: "web:P",
      source_url: "https://ausbildung.de/x",
      source_type: "job_portal",
      source_name: "ausbildung.de",
    });
    const company = mkOpp({
      id: "web:C",
      source_url: "https://firma.example/karriere/a",
      source_type: "company_website",
      source_name: "example.com",
    });
    const { merged, duplicatesRemoved } = mergeOpportunities({
      ba: [],
      web: [portal, company],
      aiDuplicates: [],
    });
    expect(duplicatesRemoved).toBe(1);
    expect(merged[0].id).toBe("web:C");
    expect(merged[0].additional_sources[0].url).toBe("https://ausbildung.de/x");
  });

  it("merges different titles via AI duplicate links only", () => {
    const first = mkOpp({
      id: "web:A",
      title: "Ausbildung Mechatroniker/in",
      source_url: "https://ausbildung.de/x",
      source_type: "job_portal",
      source_name: "ausbildung.de",
    });
    const second = mkOpp({
      id: "web:B",
      title: "Mechatroniker (m/w/d) – Ausbildung 2027",
      source_url: "https://www.linkedin.com/posts/1",
      source_type: "social_media",
      source_name: "linkedin.com",
    });
    const notLinked = mergeOpportunities({
      ba: [],
      web: [first, second],
      aiDuplicates: [],
    });
    expect(notLinked.merged).toHaveLength(2);
    const linked = mergeOpportunities({
      ba: [],
      web: [first, second],
      aiDuplicates: [
        {
          fromUrl: "https://www.linkedin.com/posts/1",
          toUrl: "https://ausbildung.de/x",
        },
      ],
    });
    expect(linked.merged).toHaveLength(1);
    expect(linked.duplicatesRemoved).toBe(1);
  });

  it("never merges different companies or different years", () => {
    const a = mkOpp();
    const b = mkOpp({
      id: "web:2",
      company_name: "Andere AG",
      source_url: "https://andere.example/karriere",
    });
    const c = mkOpp({
      id: "web:3",
      title: "Ausbildung Mechatroniker/in 2028",
      source_url: "https://example.com/2028",
    });
    const { merged } = mergeOpportunities({
      ba: [],
      web: [a, b, c],
      aiDuplicates: [],
    });
    expect(merged).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: runAISearch with web discovery (all upstream mocked)
// ---------------------------------------------------------------------------
describe("runAISearch + web discovery (integration)", () => {
  const WEB_PAGE_HTML = `<html><head>
<title>Ausbildung Mechatroniker/in 2027 bei Beispiel GmbH</title>
<meta name="description" content="Ausbildung 2027 in Berlin. Bewerbung bitte per E-Mail an azubi@beispiel-gmbh.de bis 03.01.2027.">
<meta property="og:site_name" content="Beispiel GmbH">
</head><body>
<p>Wir bilden aus! Ausbildung Mechatroniker/in zum 01.08.2027 in Berlin.
Anforderungen: Mittlere Reife, technisches Interesse.
Kontakt: azubi@beispiel-gmbh.de, Telefon 030 123456. Jetzt bewerben.</p>
</body></html>`;

  function stubFetchWith(
    handler: (url: string) => Response | Promise<Response>,
  ) {
    vi.stubGlobal("fetch", vi.fn(handler as never));
  }

  it("discovers, verifies, extracts, dedupes BA + web, and reports real counts", async () => {
    const adminMock = createAdminMock({
      maybeSingleData: (table: string) =>
        table === "candidate_profiles"
          ? { profile_json: candidateProfileFixture() }
          : null,
    });
    vi.mocked(createAdminClient).mockReturnValue(adminMock.admin as never);

    const planJson = {
      rationale: "Profile documents Mechatroniker in Berlin.",
      queries: [{ keyword: "", role: "Mechatroniker", location: "Berlin" }],
      web_queries: ['"Mechatroniker" Ausbildung 2027 Berlin'],
    };
    const extractionJson = [
      {
        url: "https://example.com/karriere/ausbildung-2027",
        company: "Beispiel GmbH",
        title: "Ausbildung Mechatroniker/in 2027",
        location: "10115 Berlin",
        bundesland: "Berlin",
        start_date: "2027-08-01",
        application_deadline: "2027-01-03",
        email: "azubi@beispiel-gmbh.de",
        phone: "030 123456",
        company_website: null,
        application_url: null,
        requirements: ["Mittlere Reife", "Technisches Interesse"],
        duplicate_of_url: null,
        note: "",
      },
    ];
    let aiCall = 0;
    vi.mocked(createAIProvider).mockReturnValue({
      generateText: vi.fn(async () => {
        aiCall += 1;
        return JSON.stringify(aiCall === 1 ? planJson : extractionJson);
      }),
      streamText: vi.fn(),
      analyzeFile: vi.fn(),
      analyzeImage: vi.fn(),
      generateFile: vi.fn(),
    } as never);

    vi.mocked(getWebSearchClient).mockReturnValue({
      name: "tavily",
      search: vi.fn(async (q: string) =>
        q.includes("site:linkedin.com")
          ? []
          : [
              {
                title: "Ausbildung Mechatroniker/in 2027 bei Beispiel GmbH",
                url: "https://example.com/karriere/ausbildung-2027?utm_source=g",
                snippet: "Ausbildung 2027 in Berlin – jetzt bewerben",
              },
            ],
      ),
    } as never);

    vi.mocked(lookup).mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
    ] as never);
    vi.mocked(resolveOpportunity).mockResolvedValue(
      mkOpp({
        id: "arbeitsagentur:REF-A",
        provider: "arbeitsagentur",
        source_name: "Bundesagentur für Arbeit",
        source_url: "https://www.arbeitsagentur.de/jobsuche/1",
        source_type: "official_source",
        title: "Ausbildung Mechatroniker/in 2027",
        company_name: "Beispiel GmbH",
        description: "BA text",
        contact: { person: null, email: null, phone: null },
      }),
    );

    stubFetchWith((url) => {
      if (url.startsWith("https://rest.arbeitsagentur.de"))
        return Promise.resolve(
          jsonResponse({
            ergebnisliste: [
              mkSearchItem("REF-A", "2026-09-28", {
                hauptberuf: "Mechatroniker/in",
                firma: "Beispiel GmbH",
                stellenangebotsTitel: "Ausbildung Mechatroniker/in 2027",
                stellenangebotsart: "AUSBILDUNG",
              }),
            ],
            maxErgebnisse: 1,
          }),
        );
      if (url.endsWith("/robots.txt"))
        return Promise.resolve(
          new Response("not found", { status: 404 }),
        );
      if (url.startsWith("https://example.com/karriere/"))
        return Promise.resolve(
          new Response(WEB_PAGE_HTML, {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
        );
      // Company-site pages (home /impressum /kontakt /karriere …) fetched
      // by the enrichment stage: return a fast 404 (http_error — not
      // retried) so the run stays bounded; the karriere posting above is
      // the only real page in this scenario.
      if (url.startsWith("https://example.com"))
        return Promise.resolve(new Response("not found", { status: 404 }));
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });

    const events: string[] = [];
    const result = await runAISearch({
      userId: "user-1",
      goal: "ausbildung",
      targetCount: 10,
      onProgress: (event) => events.push(event.type),
    });

    // Real event sequence (order of the distinct pipeline phases).
    expect(events).toEqual(
      expect.arrayContaining([
        "profile",
        "plan",
        "web_status",
        "search",
        "discover",
        "check",
        "extract",
        "enrich",
        "dedupe",
        "company_enrich",
        "complete",
      ]),
    );
    expect(result.discovery.configured).toBe(true);
    expect(result.discovery.provider).toBe("tavily");
    // Broad discovery classifies by the result's OWN domain: this mock
    // returns a single non-portal company URL, so it lands in the general
    // web bucket (portal/social buckets are covered by the dedicated
    // broad-discovery tests above).
    expect(result.discovery.categories.search_engine).toBe(1);
    expect(result.discovery.categories.job_portal).toBe(0);
    expect(result.discovery.categories.company_website).toBe(0);
    expect(result.discovery.categories.social_media).toBe(0);
    expect(result.discovery.webFound).toBe(1);
    expect(result.discovery.duplicatesRemoved).toBe(1);
    // The BA row (official) absorbed the web row as an additional source.
    expect(result.found).toBe(1);
    const row = result.results[0];
    expect(row.provider).toBe("arbeitsagentur");
    expect(row.source_type).toBe("official_source");
    expect(row.contact?.email).toBe("azubi@beispiel-gmbh.de");
    expect(row.contact?.phone).toBe("030 123456");
    expect(row.application_deadline).toBe("2027-01-03");
    expect(row.requirements).toEqual([
      "Mittlere Reife",
      "Technisches Interesse",
    ]);
    expect(row.additional_sources).toHaveLength(1);
    expect(row.additional_sources[0].url).toBe(
      "https://example.com/karriere/ausbildung-2027",
    );
    // AI Search 2.0: every source the vacancy was found on is recorded.
    expect(row.source_ids[0]).toBe("arbeitsagentur");
    expect(row.source_ids.length).toBeGreaterThanOrEqual(2);
    // The web row is the company's own career page → official source, and
    // the email's provenance is that public page (never a guess).
    expect(row.enrichment?.official_company_source).toBe(true);
    expect(row.enrichment?.email).toBe("azubi@beispiel-gmbh.de");
    expect(row.enrichment?.email_status).toBe("found");
    expect(row.enrichment?.email_source).toBe(
      "https://example.com/karriere/ausbildung-2027",
    );
    // The official website now comes from the provider's OWN response (no
    // per-company request): the karriere page the discovery already found is
    // the company's website seed.
    expect(row.enrichment?.website_url).toBe("https://example.com");
    expect(row.enrichment?.last_verified_at).not.toBeNull();
    // Honest result statistics on the complete event.
    const completeEvent = events.at(-1);
    expect(completeEvent).toBe("complete");
    expect(result.stats.found).toBe(1);
    expect(result.stats.withPublicEmail).toBe(1);
    expect(result.stats.withApplicationUrl).toBe(0);
    expect(result.stats.withOfficialSource).toBe(1);
    // Broad discovery: 1 (BA) + the registry sources that matched a result.
    // This mock's single URL matches no registry domain → the honest value
    // is 1 (with real provider results several portals match).
    expect(result.stats.sourcesSearched).toBeGreaterThanOrEqual(1);
    expect(result.stats.webSearchesExecuted).toBeGreaterThan(0);
    expect(result.stats.companiesEnriched).toBe(1);
    expect(result.stats.companiesWithPublicEmail).toBe(1);
    // The website seed from the provider response is applied to the company.
    expect(result.stats.officialWebsitesFound).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// runWebDiscovery — broad provider discovery (Tavily): request budget,
// domain-based classification, honest blocking
// ---------------------------------------------------------------------------
describe("runWebDiscovery (broad provider discovery)", () => {
  const WEB_QUERY = '"Mechatroniker" Ausbildung 2027 Berlin';
  const AZUBIYO = getSource("azubiyo")!;

  /** Mock client: a few results spanning several domains so the domain-based
   *  classification is observable. Records every call. */
  function recordingClient(
    onQuery?: (query: string, callNo: number) => void,
    results: Array<{ title: string; url: string; snippet: string }> = [
      {
        title: "Ausbildung Mechatroniker 2027 bei Beispiel GmbH",
        url: `https://www.${AZUBIYO.domains[0]}/ausbildung/mechatroniker-2027`,
        snippet: "Ausbildung 2027 in Berlin – jetzt bewerben",
      },
      {
        title: "Ausbildung 2027 bei Beispiel GmbH – bewerben",
        url: "https://www.beispiel-gmbh.de/karriere/ausbildung-2027",
        snippet: "Bewerbung für 2027",
      },
      {
        title: "Jobs bei Beispiel GmbH | Ausbildung 2027 bewerben",
        url: "https://www.linkedin.com/company/beispiel/jobs",
        snippet: "",
      },
      {
        title: "Ausbildung 2027 – jetzt bewerben",
        url: "https://www.gojobs.de/azubi/ausbildung-2027",
        snippet: "",
      },
    ],
  ): {
    client: Parameters<typeof runWebDiscovery>[0]["client"];
    queries: string[];
  } {
    const queries: string[] = [];
    const client = {
      name: "tavily",
      search: vi.fn(async (query: string) => {
        queries.push(query);
        onQuery?.(query, queries.length);
        return results;
      }),
    };
    return { client: client as never, queries };
  }

  /** Pages 404 (fast, non-retryable) so the run stays bounded. */
  function stubFast404() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.endsWith("/robots.txt"))
          return new Response("not found", { status: 404 });
        return new Response("not found", { status: 404 });
      }),
    );
    vi.mocked(lookup).mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
    ] as never);
  }

  it("issues at most 3 broad provider requests per run and reports EVERY registry source", async () => {
    stubFast404();
    const { client, queries } = recordingClient();
    const web = enabledWebSources();
    const result = await runWebDiscovery({
      client,
      webQueries: [WEB_QUERY, `${WEB_QUERY} 2`, `${WEB_QUERY} 3`, `${WEB_QUERY} 4`, `${WEB_QUERY} 5`],
      goal: "ausbildung",
      userId: "u1",
    });

    // Hard cap: one request per planned query, at most 3 — the 4th/5th query
    // is not requested at all (no open loop, no retry).
    expect(queries).toHaveLength(3);
    expect(result.groundingCallsOk).toBe(3);
    expect(result.providerErrors).toBe(0);

    // Every enabled source is accounted for: it either surfaced results from
    // the broad net (ok) or was not queried individually (skipped_budget).
    expect(result.sourceStatuses).toHaveLength(web.length);
    for (const source of web) {
      const status = result.sourceStatuses.find((s) => s.source === source.id);
      expect(status).toBeDefined();
      expect(["ok", "skipped_budget"]).toContain(status!.status);
    }
    // The registry portal in the mock results is reported as contributing.
    const azubiyo = result.sourceStatuses.find((s) => s.source === AZUBIYO.id);
    expect(azubiyo?.status).toBe("ok");
    expect(azubiyo?.candidates).toBeGreaterThan(0);
  });

  it("classifies results by their OWN domain (registry / social / portal / company page)", async () => {
    stubFast404();
    const { client } = recordingClient();
    const result = await runWebDiscovery({
      client,
      webQueries: [WEB_QUERY],
      goal: "ausbildung",
      userId: "u1",
    });

    // azubiyo.de + gojobs.de → job portals; linkedin → social media;
    // beispiel-gmbh.de is not a portal → the general web bucket.
    expect(result.categoryCounts.job_portal).toBe(2);
    expect(result.categoryCounts.social_media).toBe(1);
    expect(result.categoryCounts.search_engine).toBe(1);
    expect(result.categoryCounts.company_website).toBe(0);
    // Raw per-source hits are attributed to the registry ids that matched.
    expect(result.sourceCounts[AZUBIYO.id]).toBe(1);
    expect(result.sourceCounts["gojobs"]).toBe(1);
  });

  it("a failing broad query is counted and never stops the remaining queries", async () => {
    stubFast404();
    const { client, queries } = recordingClient((_query, callNo) => {
      if (callNo === 2) throw new WebSearchError("provider down", 503);
    });
    const result = await runWebDiscovery({
      client,
      webQueries: [WEB_QUERY, `${WEB_QUERY} 2`, `${WEB_QUERY} 3`],
      goal: "ausbildung",
      userId: "u1",
    });

    expect(queries).toHaveLength(3); // all three were attempted
    expect(result.providerErrors).toBe(1);
    expect(result.groundingCallsOk).toBe(2); // honest usage metric
    // The surviving queries still produced candidates.
    expect(result.categoryCounts.job_portal).toBeGreaterThan(0);
    expect(result.firstProviderError?.provider).toBe("tavily");
    expect(result.firstProviderError?.http).toBe(503);
  });

  it("a blocked (403) page is counted, never bypassed, never fabricated", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.endsWith("/robots.txt"))
          return new Response("not found", { status: 404 });
        return new Response("access denied", { status: 403 });
      }),
    );
    vi.mocked(lookup).mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
    ] as never);
    const { client } = recordingClient(undefined, [
      {
        title: "Ausbildung 2027 – jetzt bewerben",
        url: "https://www.gojobs.de/azubi/ausbildung-2027",
        snippet: "",
      },
    ]);
    const result = await runWebDiscovery({
      client,
      webQueries: [WEB_QUERY],
      goal: "ausbildung",
      userId: "u1",
    });

    // The search succeeded; the block happened at page level — zero
    // opportunities (nothing fabricated) and a counted failure.
    expect(result.opportunities).toHaveLength(0);
    const totalFailures = Object.values(result.failures).reduce(
      (a, b) => a + (b ?? 0),
      0,
    );
    expect(totalFailures).toBeGreaterThanOrEqual(1);
    expect(result.failures.http_error ?? 0).toBeGreaterThanOrEqual(1);
    expect(result.providerErrors).toBe(0);
    expect(result.firstProviderError).toBeNull();
  });

  it("provider failure surfaces the first error detail (safe fields, never a key)", async () => {
    stubFast404();
    const boom = new WebSearchError(
      "The web search provider rejected the configured key (HTTP 401)",
      401,
      {
        code: 401,
        status: "UNAUTHORIZED",
        message: "Unauthorized: missing or invalid API key.",
      },
      null,
    );
    const client = {
      name: "tavily",
      search: vi.fn(async () => {
        throw boom;
      }),
    };
    const result = await runWebDiscovery({
      client: client as never,
      webQueries: [WEB_QUERY],
      goal: "ausbildung",
      userId: "u1",
    });

    expect(result.providerErrors).toBeGreaterThanOrEqual(1);
    expect(result.groundingCallsOk).toBe(0);
    expect(result.firstProviderError).toEqual({
      provider: "tavily",
      model: null,
      http: 401,
      code: 401,
      providerStatus: "UNAUTHORIZED",
      message: "The web search provider rejected the configured key (HTTP 401)",
      providerMessage: "Unauthorized: missing or invalid API key.",
    });
    // The detail must never contain a key-shaped token.
    const detail = JSON.stringify(result.firstProviderError);
    expect(detail).not.toMatch(/tvly-[A-Za-z0-9_-]{6,}/);
  });
});
