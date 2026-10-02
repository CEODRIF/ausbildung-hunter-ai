import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyCompanyEnrichment,
  computeResultStats,
  runCompanyEnrichment,
  type CompanyEnrichmentRecord,
} from "@/lib/opportunities/enrichment";
import {
  bestEmail,
  classifyEmailType,
  classifyPageUrl,
  extractContactPerson,
  extractDepartment,
  extractEmails,
  extractPhone,
} from "@/lib/opportunities/enrichment/text-extract";
import { discoverCompanyWebsite } from "@/lib/opportunities/enrichment/company-site";
import type { Opportunity } from "@/lib/opportunities/types";
import { clearCompanyMemoryCache } from "@/lib/opportunities/enrichment/cache";
import { ConcurrencyLimiter } from "@/lib/concurrency";
import { WebSearchError } from "@/lib/web-search";

const { createAdminClient } = await import("@/lib/supabase/admin");
const { lookup } = await import("node:dns/promises");
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(),
}));
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(),
}));

afterEach(() => {
  clearCompanyMemoryCache();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/** Minimal valid Opportunity literal (test factory). */
function mkOpp(overrides: Partial<Opportunity> = {}): Opportunity {
  const base: Opportunity = {
    id: "arbeitsagentur:TEST-1",
    provider: "arbeitsagentur",
    external_id: "TEST-1",
    source_name: "S",
    source_url: "https://example.test/1",
    source_type: "official_source",
    additional_sources: [],
    source_ids: [],
    enrichment: null,
    application_url: null,
    aggregator_url: null,
    title: "Ausbildung Mechatroniker/in",
    goal: "ausbildung",
    stellenangebotsart: "AUSBILDUNG",
    company_name: null,
    company_url: null,
    location: null,
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
    training_type: "AUSBILDUNG",
    education_requirement: null,
    valid_from: null,
    application_deadline: null,
    posted_at: null,
    updated_at: null,
    retrieved_at: "2026-10-01T12:00:00.000Z",
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

function mkCompany(overrides: Partial<CompanyEnrichmentRecord> = {}): CompanyEnrichmentRecord {
  return {
    company_key: "beispiel gmbh",
    company_name: "Beispiel GmbH",
    checked: true,
    website_url: "https://beispiel.de",
    website_source: "https://beispiel.de/impressum",
    career_url: null,
    ausbildung_url: null,
    email: null,
    email_source: null,
    email_type: null,
    department: null,
    phone: null,
    phone_source: null,
    contact_name: null,
    contact_source: null,
    data_confidence: null,
    last_verified_at: "2026-10-01T12:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Deterministic extraction (no-invention contract)
// ---------------------------------------------------------------------------
describe("email extraction", () => {
  it("finds real addresses literally present in the text", () => {
    const text =
      "Bewerbung bitte an bewerbung@beispiel.de oder info@beispiel.de senden.";
    const emails = extractEmails(text, { companyDomain: "beispiel.de" });
    expect(emails.map((email) => email.value)).toContain("bewerbung@beispiel.de");
    // Application-intent address outranks a generic info address.
    expect(bestEmail(text, { companyDomain: "beispiel.de" })).toBe(
      "bewerbung@beispiel.de",
    );
  });

  it("never invents an address from the company name", () => {
    // Text with NO email at all → null. (jobs@siemens.de would be a
    // fabrication and must never appear.)
    expect(bestEmail("Siemens bildet aus. Telefon 0180 123456.")).toBeNull();
    expect(extractEmails("Siemens bildet aus.").length).toBe(0);
  });

  it("drops placeholders, fake domains and image-file names", () => {
    const text =
      "E-Mail: — (n/a) logo@image.png team@example.de kontakt@beispiel.de";
    const emails = extractEmails(text, { companyDomain: "beispiel.de" });
    const values = emails.map((email) => email.value);
    expect(values).not.toContain("team@example.de");
    expect(values).not.toContain("logo@image.png");
    expect(values).toContain("kontakt@beispiel.de");
  });

  it("penalizes no-reply style addresses", () => {
    const text = "no-reply@beispiel.de und karriere@beispiel.de";
    expect(bestEmail(text, { companyDomain: "beispiel.de" })).toBe(
      "karriere@beispiel.de",
    );
  });

  it("multiple emails: strict tier priority bewerbung > karriere > hr > kontakt > info", () => {
    const domain = { companyDomain: "firma.de" };
    expect(
      bestEmail("info@firma.de karriere@firma.de hr@firma.de bewerbung@firma.de", domain),
    ).toBe("bewerbung@firma.de");
    expect(
      bestEmail("info@firma.de karriere@firma.de hr@firma.de", domain),
    ).toBe("karriere@firma.de");
    expect(bestEmail("info@firma.de hr@firma.de", domain)).toBe("hr@firma.de");
    expect(
      bestEmail("info@firma.de kontakt@firma.de", domain),
    ).toBe("kontakt@firma.de");
  });
});

describe("email type + department classification (found data only)", () => {
  it("classifyEmailType maps each tier deterministically", () => {
    expect(classifyEmailType("bewerbung@firma.de")).toBe("application");
    expect(classifyEmailType("ausbildung@firma.de")).toBe("application");
    expect(classifyEmailType("azubi@firma.de")).toBe("application");
    expect(classifyEmailType("karriere@firma.de")).toBe("career");
    expect(classifyEmailType("personal@firma.de")).toBe("career");
    expect(classifyEmailType("hr@firma.de")).toBe("hr");
    expect(classifyEmailType("recruiting@firma.de")).toBe("hr");
    expect(classifyEmailType("kontakt@firma.de")).toBe("contact");
    expect(classifyEmailType("info@firma.de")).toBe("general");
  });

  it("extractDepartment only returns a documented department", () => {
    expect(extractDepartment("Ihre Bewerbung an die Personalabteilung")).toBe(
      "Personalabteilung",
    );
    expect(extractDepartment("Abteilung: IT – wir freuen uns")).toBe(
      "Abteilung: IT",
    );
    // No department documented → null (never invented).
    expect(extractDepartment("Wir freuen uns auf Ihre Bewerbung.")).toBeNull();
  });
});

describe("phone + contact person extraction", () => {
  it("extracts a phone number with explicit tel context", () => {
    expect(extractPhone("Telefon: 030 1234567")).toBe("030 1234567");
    expect(extractPhone("Tel. +49 221 999888, Mo–Fr 9–17 Uhr")).toBe(
      "+49 221 999888",
    );
  });

  it("never confuses PLZ, years or other numbers with phones", () => {
    expect(extractPhone("50667 Köln, Ausbildung 2027")).toBeNull();
    expect(extractPhone("PLZ 10115, Beginn am 01.08.2027")).toBeNull();
  });

  it("extracts a named Ansprechpartner, never an empty label", () => {
    expect(extractContactPerson("Ansprechpartner: Herr Maier")).toBe(
      "Herr Maier",
    );
    expect(
      extractContactPerson("Ihre Ansprechpartnerin ist Frau Anna Beispiel"),
    ).toBe("Frau Anna Beispiel");
    expect(extractContactPerson("Ansprechpartner: —")).toBeNull();
    expect(extractContactPerson("Keine Angaben")).toBeNull();
  });
});

describe("page classification + confidence", () => {
  it("classifies standard company paths", () => {
    expect(classifyPageUrl("https://firma.de/impressum")).toBe("impressum");
    expect(classifyPageUrl("https://firma.de/kontakt")).toBe("kontakt");
    expect(classifyPageUrl("https://firma.de/karriere/stellen/1")).toBe("karriere");
    expect(classifyPageUrl("https://firma.de/ausbildung").toLowerCase().length)
      .toBeGreaterThan(0);
    expect(classifyPageUrl("https://firma.de/")).toBe("home");
  });
});

// ---------------------------------------------------------------------------
// Applying enrichment to a row (pure back-fill, never overwrite)
// ---------------------------------------------------------------------------
describe("applyCompanyEnrichment", () => {
  it("back-fills a missing contact email with provenance + status found", () => {
    const row = mkOpp({ contact: null });
    const applied = applyCompanyEnrichment(
      row,
      mkCompany({
        email: "bewerbung@beispiel.de",
        email_source: "https://beispiel.de/impressum",
        data_confidence: "high",
      }),
    );
    expect(applied.contact?.email).toBe("bewerbung@beispiel.de");
    expect(applied.enrichment?.email_status).toBe("found");
    expect(applied.enrichment?.email_source).toBe("https://beispiel.de/impressum");
    expect(applied.enrichment?.data_confidence).toBe("high");
    expect(applied.enrichment?.last_verified_at).not.toBeNull();
  });

  it("NEVER overwrites an email the source itself documented", () => {
    const row = mkOpp({
      contact: { person: null, email: "azubi@quelle.de", phone: null },
      enrichment: {
        website_url: null,
        website_source: null,
        career_url: null,
        ausbildung_url: null,
        email: "azubi@quelle.de",
        email_source: "https://quelle.de/stelle/1",
        email_status: "found",
        email_type: null,
        department: null,
        phone: null,
        phone_source: null,
        contact_name: null,
        contact_source: null,
        last_verified_at: null,
        data_confidence: null,
        official_company_source: false,
      },
    });
    const applied = applyCompanyEnrichment(
      row,
      mkCompany({
        email: "falsch@beispiel.de",
        email_source: "https://beispiel.de/impressum",
      }),
    );
    // The source's own email wins — enrichment only fills nulls.
    expect(applied.contact?.email).toBe("azubi@quelle.de");
    expect(applied.enrichment?.email).toBe("azubi@quelle.de");
    expect(applied.enrichment?.email_source).toBe("https://quelle.de/stelle/1");
  });

  it("marks not_found only when the checks actually ran", () => {
    const checked = applyCompanyEnrichment(mkOpp(), mkCompany());
    expect(checked.enrichment?.email_status).toBe("not_found");
    const unchecked = applyCompanyEnrichment(
      mkOpp(),
      mkCompany({ checked: false, website_url: null }),
    );
    expect(unchecked.enrichment?.email_status).toBe("unknown");
  });

  it("keeps official_company_source from the merge seed", () => {
    const row = mkOpp({
      source_type: "company_website",
      enrichment: {
        website_url: null,
        website_source: null,
        career_url: "https://firma.de/karriere",
        ausbildung_url: null,
        email: null,
        email_source: null,
    email_type: null,
    department: null,
        email_status: "unknown",
        phone: null,
        phone_source: null,
        contact_name: null,
        contact_source: null,
        last_verified_at: null,
        data_confidence: null,
        official_company_source: true,
      },
    });
    const applied = applyCompanyEnrichment(row, mkCompany());
    expect(applied.enrichment?.official_company_source).toBe(true);
    expect(applied.enrichment?.career_url).toBe("https://firma.de/karriere");
  });
});

// ---------------------------------------------------------------------------
// Run-level behavior (budget, no client → no website, no invention)
// ---------------------------------------------------------------------------
describe("runCompanyEnrichment", () => {
  it("without a website and without a search client: honest not_found, no fetches", async () => {
    vi.mocked(createAdminClient).mockReturnValue({
      from: () =>
        ({
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
          upsert: async () => ({ data: null, error: null }),
        }) as never,
    } as never);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const rows = [
      mkOpp({ company_name: "NurName AG", contact: null }),
      mkOpp({ company_name: null }), // no documented company → skipped entirely
    ];
    const result = await runCompanyEnrichment(rows, { client: null });
    expect(result).toHaveLength(2);
    expect(result[0].enrichment?.email_status).toBe("not_found");
    expect(result[0].enrichment?.email).toBeNull();
    expect(result[0].contact?.email ?? null).toBeNull();
    // Rows without a company name are untouched (no identification guess).
    expect(result[1].enrichment).toBeNull();
    // No website known → no page may be fetched.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cache: a SECOND run for the same company performs ZERO fetches", async () => {
    vi.mocked(lookup).mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
    ] as never);
    const rows = [
      mkOpp({
        id: "arbeitsagentur:C1",
        company_name: "Cachebank AG",
        company_url: "https://cachebank.de",
      }),
    ];
    const impressum = `<html><head><title>Impressum – Cachebank AG</title></head>
      <body><p>Cachebank AG, Musterstraße 1, 10115 Berlin. Vertreten durch
      Vorstand. E-Mail für Bewerbungen: bewerbung@cachebank.de Telefon 030 99988877.</p></body></html>`;
    let fetchCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        fetchCalls += 1;
        const url = String(input);
        if (url.endsWith("/robots.txt"))
          return new Response("not found", { status: 404 });
        if (url === "https://cachebank.de/impressum")
          return new Response(impressum, {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        return new Response("not found", { status: 404 });
      }),
    );

    const first = await runCompanyEnrichment(rows, { client: null });
    expect(first[0].contact?.email).toBe("bewerbung@cachebank.de");
    expect(first[0].enrichment?.email_type).toBe("application");
    expect(first[0].enrichment?.website_url).toBe("https://cachebank.de");
    expect(fetchCalls).toBeGreaterThan(0); // first run really worked

    // Second run: the network now REJECTS — a cache miss would fail loudly.
    const callsBefore = fetchCalls;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network must not be touched (cache hit expected)");
      }),
    );
    const second = await runCompanyEnrichment(rows, { client: null });
    expect(second[0].contact?.email).toBe("bewerbung@cachebank.de");
    expect(fetchCalls).toBe(callsBefore); // zero additional fetches
  });

  it("website discovery provider failure: no crash, honest not_found", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const rows = [
      mkOpp({
        id: "arbeitsagentur:F1",
        company_name: "Fehlende Firma GmbH",
        company_url: null,
      }),
    ];
    const structured = vi.fn(async () => {
      throw new WebSearchError("The web search provider is unavailable.");
    });
    const failingClient = {
      name: "tavily",
      search: vi.fn(async () => {
        throw new WebSearchError("The web search provider is unavailable.");
      }),
      searchStructured: structured,
    };
    const result = await runCompanyEnrichment(rows, {
      client: failingClient as never,
    });
    // One structured attempt (break on first provider error — budget safe),
    // then honest nulls: checked, but nothing found.
    expect(structured).toHaveBeenCalledTimes(1);
    expect(result[0].enrichment?.website_url).toBeNull();
    expect(result[0].enrichment?.email).toBeNull();
    expect(result[0].enrichment?.email_status).toBe("not_found");
    // No page was fetched (discovery produced nothing to verify).
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Structured company-website discovery (blocklist + content verification)
// ---------------------------------------------------------------------------
describe("discoverCompanyWebsite (structured grounding, anti-fabrication)", () => {
  const COMPANY = "Muster Technik GmbH";
  const CITY = "Berlin";

  it("NEVER accepts a portal/review/social domain as the official website", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const run = async (answers: string[]) => {
      let call = 0;
      const client = {
        name: "tavily",
        search: vi.fn(),
        searchStructured: vi.fn(async () => {
          call += 1;
          return {
            data: {
              officialWebsite: answers[Math.min(call - 1, answers.length - 1)],
              confidence: "high",
            },
            results: [],
          };
        }),
      };
      return {
        found: await discoverCompanyWebsite(
          COMPANY,
          CITY,
          client as never,
          new Map(),
          new ConcurrencyLimiter(2),
        ),
        calls: client.searchStructured.mock.calls.length,
      };
    };

    // Scenario A: first answer is a job-portal company page → rejected at
    // the domain gate (non-empty candidate → the 1-2 call cap stops here).
    const a = await run(["https://www.azubiyo.de/firmen/muster-technik"]);
    expect(a.found).toBeNull();
    expect(a.calls).toBe(1);

    // Scenario B: empty first answer → second call → review site → rejected.
    const b = await run([
      "",
      "https://www.kununu.com/de/muster-technik-gmbh",
    ]);
    expect(b.found).toBeNull();
    expect(b.calls).toBe(2);

    // Blocked at the DOMAIN gate — the guarded fetcher was never even asked.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts a verified company site (fetched content must prove the name)", async () => {
    vi.mocked(lookup).mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
    ] as never);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.endsWith("/robots.txt"))
          return new Response("not found", { status: 404 });
        if (url.startsWith("https://www.muster-technik.de"))
          return new Response(
            `<html><head><title>Muster Technik GmbH – Über uns</title></head>
             <body>Muster Technik GmbH entwickelt Automatisierungslösungen
             in Berlin. Wir bilden Auszubildende im Bereich Elektrotechnik aus.</body></html>`,
            { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
          );
        return new Response("not found", { status: 404 });
      }),
    );
    const client = {
      name: "tavily",
      search: vi.fn(),
      searchStructured: vi.fn(async () => ({
        data: { officialWebsite: "https://www.muster-technik.de", confidence: "high" },
        results: [],
      })),
    };
    const found = await discoverCompanyWebsite(
      COMPANY,
      CITY,
      client as never,
      new Map(),
      new ConcurrencyLimiter(2),
    );
    expect(found).toEqual({
      url: "https://www.muster-technik.de",
      // URL canonicalization keeps the trailing slash of the origin.
      evidenceUrl: "https://www.muster-technik.de/",
      searched: 1,
    });
    // One grounding call — the 1-2 call cap held.
    expect(client.searchStructured).toHaveBeenCalledTimes(1);
  });

  it("rejects an allowed domain whose FETCHED content cannot verify the company", async () => {
    vi.mocked(lookup).mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
    ] as never);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.endsWith("/robots.txt"))
          return new Response("not found", { status: 404 });
        if (url.startsWith("https://www.unbekannt-verlag.de"))
          return new Response(
            `<html><head><title>Unbekannt Verlag</title></head>
             <body>Willkommen beim Unbekannt Verlag. Wir verlegen Bücher,
             Zeitschriften und digitale Medien für den gesamten DACH-Raum.</body></html>`,
            { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
          );
        return new Response("not found", { status: 404 });
      }),
    );
    const client = {
      name: "tavily",
      search: vi.fn(),
      searchStructured: vi.fn(async () => ({
        data: { officialWebsite: "https://www.unbekannt-verlag.de", confidence: "high" },
        results: [],
      })),
    };
    const found = await discoverCompanyWebsite(
      COMPANY,
      CITY,
      client as never,
      new Map(),
      new ConcurrencyLimiter(2),
    );
    // The page is real, but it is NOT Muster Technik GmbH → honest null.
    expect(found).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Result statistics (honest counters)
// ---------------------------------------------------------------------------
describe("computeResultStats", () => {
  it("counts only REAL emails, application links and official sources", () => {
    const rows = [
      mkOpp({
        contact: { person: null, email: "a@x.de", phone: null },
        application_url: "https://x.de/apply",
        enrichment: {
          website_url: null, website_source: null, career_url: null,
          ausbildung_url: null, email: "a@x.de", email_source: null,
          email_status: "found",
        email_type: null,
        department: null, phone: null, phone_source: null,
          contact_name: null, contact_source: null, last_verified_at: null,
          data_confidence: null, official_company_source: true,
        },
      }),
      mkOpp({
        contact: { person: null, email: null, phone: null },
        application_url: null,
      }),
      mkOpp({
        contact: { person: null, email: "b@y.de", phone: null },
        application_url: "https://y.de",
        source_type: "company_website",
      }),
    ];
    expect(computeResultStats(rows)).toEqual({
      found: 3,
      withPublicEmail: 2,
      withApplicationUrl: 2,
      withOfficialSource: 2,
      // No run context passed → all run counters are honestly zero.
      sourcesSearched: 0,
      sourcesWithResults: 0,
      webSearchesExecuted: 0,
      companiesEnriched: 0,
      // No row documents a company_name → nothing to count.
      companiesWithPublicEmail: 0,
      // No enrichment website found; two official rows carry an apply URL.
      officialWebsitesFound: 0,
      officialApplicationLinks: 2,
    });
    // Run context overrides the derived counters.
    expect(
      computeResultStats(rows, {
        sourcesSearched: 7,
        sourcesWithResults: 3,
        webSearchesExecuted: 9,
        companiesEnriched: 2,
        companiesWithPublicEmail: 1,
      }),
    ).toMatchObject({
      sourcesSearched: 7,
      sourcesWithResults: 3,
      webSearchesExecuted: 9,
      companiesEnriched: 2,
      companiesWithPublicEmail: 1,
    });
  });
});

