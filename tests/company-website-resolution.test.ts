import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runWebDiscovery } from "@/lib/opportunities/web-discovery";
import { runCompanyEnrichment } from "@/lib/opportunities/enrichment";
import {
  clearTavilyMemoryCache,
  getWebSearchClient,
  TAVILY_SEARCH_URL,
} from "@/lib/web-search";

/**
 * Company-website resolution (AI Search 2.6) — the production failure.
 *
 * Production proved that "Official websites found" stayed 0 while Tavily
 * worked: the enrichment needed a seed whose TEXT names the company, so a
 * company whose provider results are generically titled never got a website,
 * even though the opportunity itself was extracted from the company's own
 * page. These tests run the real discovery + enrichment path (mocked HTTP
 * only) and pin the required behaviour:
 *
 *   12) portal result → company domain → official website → contact pages →
 *       email → application link
 *   13) no public email → company stays, website present, email null
 *   14) a result about Company B must never attach to Company A
 *   +)  the exact production loss: a generically titled company result still
 *       resolves the website from first-hand evidence
 */

vi.mock("@/lib/ai-provider", () => ({ createAIProvider: () => null }));
vi.mock("@/lib/opportunities/search", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/opportunities/search")>();
  return { ...actual, resolveOpportunity: vi.fn() };
});
vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));

const { lookup } = await import("node:dns/promises");

const QUERY = '"Kaufmann im E-Commerce" Ausbildung 2027 Berlin';

function html(title: string, siteName: string, body: string): Response {
  return new Response(
    `<!doctype html><html><head><title>${title}</title>` +
      `<meta property="og:site_name" content="${siteName}" /></head>` +
      `<body><h1>${title}</h1><p>${body}</p></body></html>`,
    { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

function stubFetch(routes: Array<{ match: string; response: () => Response }>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url === TAVILY_SEARCH_URL) {
        const payload = stubbedPayload;
        return Response.json(payload);
      }
      if (url.endsWith("/robots.txt"))
        return new Response("not found", { status: 404 });
      for (const route of routes)
        if (url.includes(route.match)) return route.response();
      return new Response("not found", { status: 404 });
    }),
  );
}

let stubbedPayload: { results: Array<Record<string, unknown>> } = {
  results: [],
};

async function discoverAndEnrich() {
  const client = getWebSearchClient();
  if (!client) throw new Error("expected a client");
  const web = await runWebDiscovery({
    client,
    webQueries: [QUERY],
    goal: "ausbildung",
    userId: "site-user",
  });
  const enriched = await runCompanyEnrichment(web.opportunities, {
    client: null,
    contactSeeds: web.companyContacts,
  });
  return { web, enriched };
}

beforeEach(() => {
  clearTavilyMemoryCache();
  process.env.TAVILY_API_KEY = "tvly-website-test-key-123456";
  vi.mocked(lookup).mockResolvedValue([
    { address: "93.184.216.34", family: 4 },
  ] as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TAVILY_API_KEY;
  stubbedPayload = { results: [] };
});

describe("company-website resolution", () => {
  it("12) portal result → company domain → website → contact pages → email → apply link", async () => {
    stubbedPayload = {
      results: [
        {
          // A job portal names the company…
          title: "Ausbildung Kaufmann im E-Commerce 2027 – Handelshaus Nord GmbH",
          url: "https://www.ausbildung.de/berufe/kaufmann-im-e-commerce",
          snippet:
            "Ausbildung 2027 in Berlin bei Handelshaus Nord GmbH – jetzt bewerben.",
          score: 0.95,
        },
        {
          // …and the provider also returns the company's OWN career page.
          title: "Karriere bei Handelshaus Nord GmbH",
          url: "https://www.handelshaus-nord.de/karriere/ausbildung-2027",
          snippet: "Ausbildung 2027 – Bewerbung an bewerbung@handelshaus-nord.de",
          score: 0.9,
        },
      ],
    };
    stubFetch([
      {
        match: "handelshaus-nord.de/karriere",
        response: () =>
          html(
            "Karriere bei Handelshaus Nord GmbH",
            "Handelshaus Nord GmbH",
            "Ausbildung Kaufmann im E-Commerce 2027. Bewerbung an bewerbung@handelshaus-nord.de. Kontakt: 030 1234.",
          ),
      },
      {
        // Homepage: links to the real career page (link discovery).
        match: "handelshaus-nord.de",
        response: () =>
          html(
            "Handelshaus Nord GmbH",
            "Handelshaus Nord GmbH",
            'Handelshaus Nord GmbH – Karriere. <a href="/karriere/ausbildung-2027">Karriere</a>',
          ),
      },
      {
        match: "ausbildung.de",
        response: () =>
          html(
            "Ausbildung Kaufmann im E-Commerce 2027",
            "ausbildung.de",
            "Ausbildung 2027 bei Handelshaus Nord GmbH in Berlin – jetzt bewerben.",
          ),
      },
    ]);

    const { enriched } = await discoverAndEnrich();

    const company = enriched.find((row) =>
      row.company_name?.includes("Handelshaus Nord"),
    );
    expect(company).toBeDefined();
    // The portal is never the company's website; the company domain is.
    expect(company?.enrichment?.website_url).toBe("https://handelshaus-nord.de");
    expect(company?.enrichment?.website_source).toContain("handelshaus-nord.de");
    // A real published address was extracted (never invented).
    expect(company?.enrichment?.email).toBe("bewerbung@handelshaus-nord.de");
    // …and an application page on the company's own domain, when detected.
    if (company?.application_url)
      expect(company.application_url).toContain("handelshaus-nord.de");
  });

  it("13) a company without a public email stays in the results (no fabrication)", async () => {
    stubbedPayload = {
      results: [
        {
          title: "Karriere bei Logistik Süd GmbH",
          url: "https://www.logistik-sued.de/karriere",
          snippet: "Ausbildung 2027 – Bewerbung über unser Online-Formular.",
          score: 0.9,
        },
      ],
    };
    stubFetch([
      {
        match: "logistik-sued.de",
        response: () =>
          html(
            "Karriere bei Logistik Süd GmbH",
            "Logistik Süd GmbH",
            "Ausbildung und duales Studium 2027. Bewerbungen bitte über unser Online-Bewerbungsformular.",
          ),
      },
    ]);

    const { enriched } = await discoverAndEnrich();
    const company = enriched.find((row) =>
      row.company_name?.includes("Logistik Süd"),
    );
    expect(company).toBeDefined();
    expect(company?.enrichment?.website_url).toBe("https://logistik-sued.de");
    expect(company?.enrichment?.email ?? null).toBeNull();
    // The UI renders exactly this string for a company without a public email.
    expect(company?.enrichment?.email_status).toBe("not_found");
  });

  it("14) a result about Company B is never attached to Company A", async () => {
    stubbedPayload = {
      results: [
        {
          // Portal page about Company A …
          title: "Ausbildung 2027 – Firma A GmbH",
          url: "https://www.azubiyo.de/stelle/firma-a-ausbildung",
          snippet: "Ausbildung 2027 bei Firma A GmbH in Berlin.",
          score: 0.9,
        },
        {
          // … plus a completely different company's page, titled for B.
          title: "Karriere bei Firma B GmbH",
          url: "https://www.firma-b.de/karriere",
          snippet: "Bewerbung an bewerbung@firma-b.de",
          score: 0.8,
        },
      ],
    };
    stubFetch([
      {
        match: "azubiyo.de",
        response: () =>
          html(
            "Ausbildung 2027 – Firma A GmbH",
            "azubiyo.de",
            "Ausbildung 2027 bei Firma A GmbH in Berlin. Weitere Informationen beim Arbeitgeber.",
          ),
      },
      {
        match: "firma-b.de",
        response: () =>
          html(
            "Karriere bei Firma B GmbH",
            "Firma B GmbH",
            "Bewerbung an bewerbung@firma-b.de – Ausbildung 2027.",
          ),
      },
    ]);

    const { enriched } = await discoverAndEnrich();
    const companyA = enriched.find((row) =>
      row.company_name?.includes("Firma A"),
    );
    if (companyA) {
      // Company B's domain and address must never be attributed to A.
      expect(companyA.enrichment?.website_url ?? null).not.toContain("firma-b.de");
      expect(companyA.enrichment?.email ?? null).toBeNull();
    }
    const companyB = enriched.find((row) =>
      row.company_name?.includes("Firma B"),
    );
    if (companyB)
      expect(companyB.enrichment?.website_url ?? "").toContain("firma-b.de");
  });

  it("resolves the website from first-hand evidence even when the provider text never names the company (production loss)", async () => {
    stubbedPayload = {
      results: [
        {
          // Realistic generic title/snippet — no company name at all.
          title: "Karriere & Ausbildung 2027",
          url: "https://www.beispiel-gmbh.de/karriere/ausbildung-2027",
          snippet: "Starte deine Ausbildung bei uns – jetzt online bewerben.",
          score: 0.9,
        },
      ],
    };
    stubFetch([
      {
        match: "beispiel-gmbh.de/karriere",
        response: () =>
          html(
            "Ausbildung 2027 bei Beispiel GmbH",
            "Beispiel GmbH",
            "Ausbildung 2027 bei Beispiel GmbH in Berlin. Bewerbung an bewerbung@beispiel-gmbh.de.",
          ),
      },
      {
        match: "beispiel-gmbh.de",
        response: () =>
          html(
            "Karriere & Ausbildung 2027",
            "Beispiel GmbH",
            "Ausbildung bei Beispiel GmbH – jetzt online bewerben.",
          ),
      },
    ]);

    const { enriched } = await discoverAndEnrich();
    const company = enriched.find((row) =>
      row.company_name?.includes("Beispiel GmbH"),
    );
    expect(company).toBeDefined();
    // Before the fix this was null (the seed text never named the company),
    // which is exactly why production reported 0 official websites.
    expect(company?.enrichment?.website_url).toBe("https://beispiel-gmbh.de");
    expect(company?.enrichment?.email).toBe("bewerbung@beispiel-gmbh.de");
  });
});
