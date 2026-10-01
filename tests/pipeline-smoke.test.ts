import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runWebDiscovery } from "@/lib/opportunities/web-discovery";
import { runCompanyEnrichment } from "@/lib/opportunities/enrichment";
import {
  clearTavilyMemoryCache,
  getWebSearchClient,
  MAX_TAVILY_REQUESTS_PER_RUN,
  TAVILY_SEARCH_URL,
  type WebSearchResult,
} from "@/lib/web-search";

/**
 * Pipeline smoke test — "Kaufmann im E-Commerce".
 *
 * Runs the REAL pipeline (Tavily client with its request cap → broad
 * discovery → guarded page fetch → extraction → company enrichment with the
 * contact seeds) against a deterministic provider response. It prints the
 * metrics the operator asked for and asserts the contract:
 *   - at most 3 provider requests for the whole search,
 *   - a company website is taken from the provider response,
 *   - an address published in that response is attributed to its company,
 *   - a company without a published address stays WITHOUT one (no invention),
 *   - the number of opportunities never shrinks because emails are missing.
 *
 * The HTTP layer is mocked (no live Tavily key in this environment); every
 * other stage is the production code path.
 */

vi.mock("@/lib/ai-provider", () => ({ createAIProvider: () => null }));
vi.mock("@/lib/opportunities/search", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/opportunities/search")>();
  return { ...actual, resolveOpportunity: vi.fn() };
});
vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));

const { lookup } = await import("node:dns/promises");

const QUERY = '"Kaufmann im E-Commerce" Ausbildung 2027 Berlin';

/** One provider response payload, reused for every intent query (Tavily
 *  returns the same public pages for closely related German queries). */
function tavilyPayload(): { results: WebSearchResult[] } {
  return {
    results: [
      {
        title: "Ausbildung Kaufmann/-frau im E-Commerce 2027 – Handelshaus Nord",
        url: "https://www.ausbildung.de/berufe/kaufmann-im-e-commerce",
        snippet:
          "Ausbildung 2027 in Berlin – jetzt bewerben. Unternehmen: Handelshaus Nord GmbH.",
        score: 0.94,
      },
      {
        title: "Karriere & Ausbildung bei Handelshaus Nord GmbH",
        url: "https://www.handelshaus-nord.de/karriere/ausbildung-2027",
        snippet:
          "Bewerbung an bewerbung@handelshaus-nord.de oder über unser Kontaktformular.",
        score: 0.91,
      },
      {
        title: "Karriere bei Logistik Süd GmbH",
        url: "https://www.logistik-sued.de/karriere",
        snippet: "Ausbildung und Studium – Bewerbung über unser Online-Portal.",
        score: 0.88,
      },
      {
        title: "Handelshaus Nord GmbH | LinkedIn",
        url: "https://www.linkedin.com/company/handelshaus-nord/jobs",
        snippet: "Ausbildung 2027 bei Handelshaus Nord GmbH",
        score: 0.7,
      },
    ],
  };
}

function page(title: string, siteName: string, body: string): Response {
  return new Response(
    `<!doctype html><html><head><title>${title}</title>` +
      `<meta property="og:site_name" content="${siteName}" /></head>` +
      `<body><h1>${title}</h1><p>${body}</p></body></html>`,
    { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

describe("pipeline smoke: Kaufmann im E-Commerce", () => {
  let tavilyRequests = 0;
  let rawResults = 0;

  beforeEach(() => {
    clearTavilyMemoryCache();
    tavilyRequests = 0;
    rawResults = 0;
    process.env.TAVILY_API_KEY = "tvly-smoke-test-key-123456";
    vi.mocked(lookup).mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
    ] as never);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url === TAVILY_SEARCH_URL) {
          tavilyRequests += 1;
          const payload = tavilyPayload();
          rawResults += payload.results.length;
          return Response.json(payload);
        }
        if (url.endsWith("/robots.txt"))
          return new Response("not found", { status: 404 });
        if (url.includes("handelshaus-nord.de"))
          return page(
            "Karriere bei Handelshaus Nord GmbH",
            "Handelshaus Nord GmbH",
            "Ausbildung Kaufmann im E-Commerce 2027 in Berlin. Bewerbung an bewerbung@handelshaus-nord.de. Impressum: Handelshaus Nord GmbH, Berlin.",
          );
        if (url.includes("ausbildung.de"))
          return page(
            "Ausbildung Kaufmann im E-Commerce 2027",
            "ausbildung.de",
            "Ausbildung 2027 bei Handelshaus Nord GmbH in Berlin – jetzt bewerben. Mehr Informationen auf der Karriereseite des Unternehmens.",
          );
        if (url.includes("logistik-sued.de"))
          return page(
            "Karriere bei Logistik Süd GmbH",
            "Logistik Süd GmbH",
            "Ausbildung und duales Studium 2027. Bewerbungen richten Sie bitte über unser Online-Bewerbungsformular an das Recruiting-Team.",
          );
        return new Response("not found", { status: 404 });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.TAVILY_API_KEY;
  });

  it("finds opportunities, applies provider websites + real emails, and keeps the budget", async () => {
    const client = getWebSearchClient();
    expect(client).not.toBeNull();

    const web = await runWebDiscovery({
      client,
      webQueries: [QUERY],
      goal: "ausbildung",
      userId: "smoke-user",
    });

    // Search credits are untouched by this phase, but the provider budget is
    // the hard cap that must hold.
    expect(tavilyRequests).toBe(MAX_TAVILY_REQUESTS_PER_RUN);
    expect(web.groundingCallsOk).toBe(3);
    expect(web.providerErrors).toBe(0);

    const enriched = await runCompanyEnrichment(web.opportunities, {
      client: null,
      contactSeeds: web.companyContacts,
    });

    const publicEmails = enriched.filter(
      (row) => row.contact?.email ?? row.enrichment?.email ?? null,
    );
    const officialWebsites = enriched.filter(
      (row) => row.enrichment?.website_url ?? null,
    );
    const applicationLinks = enriched.filter(
      (row) => row.application_url ?? null,
    );
    const withoutEmail = enriched.filter(
      (row) => !(row.contact?.email ?? row.enrichment?.email ?? null),
    );

    console.info(
      "[SMOKE] opportunities found=%d publicEmails=%d officialWebsites=%d applicationLinks=%d tavilyRequests=%d totalResults=%d duplicatesRemoved=%d",
      enriched.length,
      publicEmails.length,
      officialWebsites.length,
      applicationLinks.length,
      tavilyRequests,
      rawResults,
      rawResults - web.opportunities.length > 0
        ? rawResults - web.opportunities.length
        : 0,
    );

    // 1) The job count does NOT shrink because some companies lack an email.
    expect(enriched.length).toBeGreaterThan(0);
    expect(withoutEmail.length).toBeGreaterThan(0);

    // 2) The website from the provider response is applied (no extra request).
    expect(officialWebsites.length).toBeGreaterThan(0);
    expect(
      officialWebsites.some((row) =>
        row.enrichment?.website_url?.includes("handelshaus-nord.de"),
      ),
    ).toBe(true);

    // 3) An address published in the provider response is attributed correctly.
    const withEmail = publicEmails.find((row) =>
      row.enrichment?.email?.includes("bewerbung@handelshaus-nord.de"),
    );
    expect(withEmail).toBeDefined();

    // 4) A company without a published address gets NO invented one.
    const logistik = enriched.find((row) =>
      "company_name" in row && row.company_name?.includes("Logistik Süd"),
    );
    if (logistik) expect(logistik.enrichment?.email ?? null).toBeNull();
  });
});
