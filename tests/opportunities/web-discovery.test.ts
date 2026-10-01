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
    readonly geminiCode: number | null;
    readonly geminiStatus: string | null;
    readonly geminiMessage: string | null;
    readonly model: string | null;
    constructor(
      message: string,
      status: number | null = null,
      gemini: {
        code: number | null;
        status: string | null;
        message: string | null;
      } = { code: null, status: null, message: null },
      model: string | null = null,
    ) {
      super(message);
      this.name = "WebSearchError";
      this.status = status;
      this.geminiCode = gemini.code;
      this.geminiStatus = gemini.status;
      this.geminiMessage = gemini.message;
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
    name: "gemini_grounding" as const,
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
      name: "gemini_grounding",
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
    expect(result.discovery.provider).toBe("gemini_grounding");
    expect(result.discovery.categories.search_engine).toBe(1);
    expect(result.discovery.categories.job_portal).toBe(1);
    expect(result.discovery.categories.company_website).toBe(1);
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
    // Website discovery verified the fetched content against the company
    // name (the karriere page says "Beispiel GmbH").
    expect(row.enrichment?.website_url).toBe("https://example.com");
    expect(row.enrichment?.last_verified_at).not.toBeNull();
    // Honest result statistics on the complete event.
    const completeEvent = events.at(-1);
    expect(completeEvent).toBe("complete");
    expect(result.stats.found).toBe(1);
    expect(result.stats.withPublicEmail).toBe(1);
    expect(result.stats.withApplicationUrl).toBe(0);
    expect(result.stats.withOfficialSource).toBe(1);
    expect(result.stats.sourcesSearched).toBeGreaterThan(1);
    expect(result.stats.webSearchesExecuted).toBeGreaterThan(0);
    expect(result.stats.companiesEnriched).toBe(1);
    expect(result.stats.companiesWithPublicEmail).toBe(1);
    expect(result.stats.officialWebsitesFound).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// runWebDiscovery — budget, per-source isolation, honest blocking (2.1)
// ---------------------------------------------------------------------------
describe("runWebDiscovery (source registry discipline)", () => {
  const WEB_QUERY = '"Mechatroniker" Ausbildung 2027 Berlin';

  /** Mock client: one relevant, SOURCE-SCOPED candidate per query so every
   *  called source is distinguishable (portals return their own domain). */
  function recordingClient(
    onQuery?: (query: string) => void,
  ): { client: Parameters<typeof runWebDiscovery>[0]["client"]; queries: string[] } {
    const queries: string[] = [];
    const client = {
      name: "gemini_grounding",
      search: vi.fn(async (query: string) => {
        queries.push(query);
        onQuery?.(query);
        if (query.includes("site:linkedin.com"))
          return [
            {
              title: "Ausbildung 2027 – jetzt bewerben",
              url: "https://www.linkedin.com/company/beispiel/jobs",
              snippet: "",
            },
          ];
        const site = query.match(/site:([a-z0-9.-]+)/i)?.[1];
        if (site)
          return [
            {
              title: "Ausbildung 2027 – jetzt bewerben",
              url: `https://${site}/azubi/ausbildung-2027`,
              snippet: "",
            },
          ];
        if (query.includes("karriere OR"))
          return [
            {
              title: "Ausbildung Mechatroniker 2027 – bewerben",
              url: "https://karriere.example/azubi/1",
              snippet: "",
            },
          ];
        return [
          {
            title: "Ausbildung 2027 – jetzt bewerben",
            url: "https://example.com/plain/ausbildung-2027",
            snippet: "",
          },
        ];
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

  it("every registered source is reported: queried (≤ budget) or skipped_budget", async () => {
    stubFast404();
    const { client, queries } = recordingClient();
    const web = enabledWebSources();
    const result = await runWebDiscovery({
      client,
      webQueries: [WEB_QUERY],
      goal: "ausbildung",
      userId: "u1",
    });

    // 1 plain query + one call per source, capped at MAX_DISCOVERY_CALLS=16.
    expect(queries).toHaveLength(16);
    expect(result.groundingCallsOk).toBe(16);
    expect(result.providerErrors).toBe(0);

    // EVERY enabled source is accounted for — the diagnostics card must
    // never hide a source (this is what production "web=0" hid before).
    expect(result.sourceStatuses).toHaveLength(web.length);
    const called = new Set(
      result.sourceStatuses
        .filter((s) => s.status !== "skipped_budget")
        .map((s) => s.source),
    );
    const skipped = new Set(
      result.sourceStatuses
        .filter((s) => s.status === "skipped_budget")
        .map((s) => s.source),
    );
    expect(called.size + skipped.size).toBe(web.length);
    // Called + skipped partition the registry (no overlap, none missing).
    for (const id of web.map((s) => s.id))
      expect(called.has(id) || skipped.has(id)).toBe(true);
    expect(called.size).toBeLessThanOrEqual(15); // 16 − 1 plain query

    // The highest-value sources always fit the budget (worst case: 4 plain
    // queries → only 12 source calls).
    expect(called).toContain("company_career");
    expect(called).toContain("bund");

    // Each called source was queried with its OWN scoping (site: / terms).
    const azubiyo = getSource("azubiyo")!;
    const hwk = getSource("hwk")!;
    expect(called.has(azubiyo.id)).toBe(true);
    expect(queries).toContain(`${WEB_QUERY} site:${azubiyo.domains[0]}`);
    expect(called.has(hwk.id)).toBe(true);
    expect(
      queries.some(
        (q) =>
          q.includes(`site:${hwk.domains[0]}`) &&
          q.includes(`site:${hwk.domains[1]}`),
      ),
    ).toBe(true);
  });

  it("one source's provider failure never stops the other sources", async () => {
    stubFast404();
    const { client, queries } = recordingClient((query) => {
      if (query.includes("site:stepstone.de"))
        throw new WebSearchError("provider down", 503);
    });
    const result = await runWebDiscovery({
      client,
      webQueries: [WEB_QUERY],
      goal: "ausbildung",
      userId: "u1",
    });

    const stepstone = result.sourceStatuses.find(
      (s) => s.source === "stepstone",
    );
    expect(stepstone?.status).toBe("failed");
    expect(stepstone?.candidates).toBe(0);
    expect(result.sourceCounts["stepstone"]).toBe(0);
    expect(result.providerErrors).toBe(1);

    // The remaining sources still ran AND still delivered candidates.
    const ausbildung = result.sourceStatuses.find(
      (s) => s.source === "ausbildung.de",
    );
    expect(ausbildung?.status).toBe("ok");
    expect(ausbildung?.candidates).toBeGreaterThan(0);
    // The full budget was still attempted (failure consumed one slot);
    // 15 of 16 grounding calls succeeded.
    expect(queries).toHaveLength(16);
    expect(result.groundingCallsOk).toBe(15);
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
    // Every source returns the SAME gojobs URL (403 behind the mock).
    const client = {
      name: "gemini_grounding",
      search: vi.fn(async () => [
        {
          title: "Ausbildung 2027 – jetzt bewerben",
          url: "https://www.gojobs.de/azubi/ausbildung-2027",
          snippet: "",
        },
      ]),
    };
    const result = await runWebDiscovery({
      client: client as never,
      webQueries: [WEB_QUERY],
      goal: "ausbildung",
      userId: "u1",
    });

    // Searches succeeded; the block happened at page level — the run must
    // report zero opportunities (no fabrication) and a counted failure.
    expect(result.opportunities).toHaveLength(0);
    const totalFailures = Object.values(result.failures).reduce(
      (a, b) => a + (b ?? 0),
      0,
    );
    expect(totalFailures).toBeGreaterThanOrEqual(1);
    expect(result.failures.http_error ?? 0).toBeGreaterThanOrEqual(1);
    expect(result.providerErrors).toBe(0);
    // Source statuses describe the SEARCH phase (ok) — the honesty lives in
    // `failures` + the zero opportunity count, not a hidden retry.
    for (const status of result.sourceStatuses)
      expect(["ok", "skipped_budget"]).toContain(status.status);
    // No provider errors in this scenario → no detail object (honest null).
    expect(result.firstProviderError).toBeNull();
  });

  it("provider failure surfaces the FIRST error detail (safe fields, no key)", async () => {
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
    const boom = new WebSearchError(
      "The web search provider rejected the configured key (HTTP 401, PERMISSION_DENIED)",
      401,
      {
        code: 401,
        status: "PERMISSION_DENIED",
        message: "API key not valid. Please pass a valid API key.",
      },
      "gemini-2.5-flash-lite",
    );
    const client = {
      name: "gemini_grounding",
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

    // Every call failed → the run must carry the root-cause detail the UI
    // renders, with only safe/provider-controlled fields.
    expect(result.providerErrors).toBeGreaterThanOrEqual(1);
    expect(result.firstProviderError).toEqual({
      provider: "gemini_grounding",
      model: "gemini-2.5-flash-lite",
      http: 401,
      code: 401,
      geminiStatus: "PERMISSION_DENIED",
      message:
        "The web search provider rejected the configured key (HTTP 401, PERMISSION_DENIED)",
    });
    // The detail must never contain a key-shaped token.
    const detail = JSON.stringify(result.firstProviderError);
    expect(detail).not.toMatch(/AIza[0-9A-Za-z_\-]{10,}/);
  });
});
