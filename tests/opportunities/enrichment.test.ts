import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyCompanyEnrichment,
  computeResultStats,
  runCompanyEnrichment,
  type CompanyEnrichmentRecord,
} from "@/lib/opportunities/enrichment";
import {
  bestEmail,
  classifyPageUrl,
  extractContactPerson,
  extractEmails,
  extractPhone,
} from "@/lib/opportunities/enrichment/text-extract";
import {
  cityOf,
  fingerprintOpportunity,
  mergeOpportunities,
  startYearOf,
} from "@/lib/opportunities/web-discovery";
import type { Opportunity } from "@/lib/opportunities/types";
import { clearCompanyMemoryCache } from "@/lib/opportunities/enrichment/cache";

const { createAdminClient } = await import("@/lib/supabase/admin");
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(),
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
          email_status: "found", phone: null, phone_source: null,
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
    });
  });
});

// ---------------------------------------------------------------------------
// Merge-level dedupe refinements (year + city) and provenance
// ---------------------------------------------------------------------------
describe("mergeOpportunities (AI Search 2.0 refinements)", () => {
  it("source_ids + official flag + email provenance on merged rows", () => {
    const ba = mkOpp({
      id: "arbeitsagentur:REF-A",
      source_type: "official_source",
      source_url: "https://www.arbeitsagentur.de/jobsuche/1",
    });
    const web = mkOpp({
      id: "web:WEB-1",
      provider: "web",
      source_type: "company_website",
      source_url: "https://firma.example/karriere/a",
      source_ids: ["company_career"],
      contact: { person: null, email: "azubi@firma.example", phone: null },
      company_url: "https://firma.example",
      application_url: "https://firma.example/karriere/a#bewerben",
    });
    const { merged, duplicatesRemoved } = mergeOpportunities({
      ba: [ba],
      web: [web],
      aiDuplicates: [],
    });
    expect(duplicatesRemoved).toBe(1);
    const row = merged[0];
    expect(row.provider).toBe("arbeitsagentur");
    expect(row.source_ids).toEqual(["arbeitsagentur", "company_career"]);
    expect(row.enrichment?.official_company_source).toBe(true);
    // The email's public page is the web posting, not the BA page.
    expect(row.enrichment?.email).toBe("azubi@firma.example");
    expect(row.enrichment?.email_source).toBe("https://firma.example/karriere/a");
    expect(row.enrichment?.email_status).toBe("found");
    // Official application link wins over the aggregator.
    expect(row.application_url).toBe("https://firma.example/karriere/a#bewerben");
    // Non-aggregator company URL becomes the website with evidence.
    expect(row.enrichment?.website_url).toBe("https://firma.example");
    expect(row.enrichment?.website_source).toBe("https://firma.example/karriere/a");
  });

  it("same company + title + year in DIFFERENT cities stays separate (chain)", () => {
    const koeln = mkOpp({
      id: "web:A",
      provider: "web",
      location_detail: { city: "Köln", region: "NRW", country: "Deutschland", postal_code: "50667" },
      valid_from: "2027-08-01T00:00:00.000Z",
    });
    const duesseldorf = mkOpp({
      id: "web:B",
      provider: "web",
      location_detail: { city: "Düsseldorf", region: "NRW", country: "Deutschland", postal_code: "40213" },
      valid_from: "2027-08-01T00:00:00.000Z",
    });
    const { merged } = mergeOpportunities({
      ba: [],
      web: [koeln, duesseldorf],
      aiDuplicates: [],
    });
    expect(merged).toHaveLength(2);
  });

  it("unknown city merges with a known city; unknown year merges too", () => {
    const known = mkOpp({
      id: "web:A",
      provider: "web",
      location_detail: { city: "Köln", region: "NRW", country: "Deutschland", postal_code: "50667" },
      valid_from: "2027-08-01T00:00:00.000Z",
    });
    const unknown = mkOpp({ id: "web:B", provider: "web" });
    const { merged, duplicatesRemoved } = mergeOpportunities({
      ba: [],
      web: [known, unknown],
      aiDuplicates: [],
    });
    expect(merged).toHaveLength(1);
    expect(duplicatesRemoved).toBe(1);
    expect(merged[0].location_detail?.city).toBe("Köln");
  });

  it("different documented start years never merge", () => {
    const a2027 = mkOpp({
      id: "web:A",
      provider: "web",
      valid_from: "2027-08-01T00:00:00.000Z",
    });
    const b2028 = mkOpp({
      id: "web:B",
      provider: "web",
      valid_from: "2028-08-01T00:00:00.000Z",
    });
    const { merged } = mergeOpportunities({
      ba: [],
      web: [a2027, b2028],
      aiDuplicates: [],
    });
    expect(merged).toHaveLength(2);
  });

  it("fingerprint + startYearOf + cityOf are stable and honest", () => {
    expect(fingerprintOpportunity(mkOpp())).toBe(
      fingerprintOpportunity(mkOpp({ title: "Ausbildung Mechatroniker / in" })),
    );
    expect(startYearOf(mkOpp({ valid_from: "2027-08-01" }))).toBe("2027");
    expect(startYearOf(mkOpp({ title: "Ausbildung 2028" }))).toBe("2028");
    expect(startYearOf(mkOpp())).toBeNull();
    // This codebase's normalizeIdentity strips umlauts (ö → o).
    expect(cityOf(mkOpp({ location_detail: { city: "Köln", region: null, country: null, postal_code: null } }))).toBe(
      "koln",
    );
    expect(cityOf(mkOpp())).toBeNull();
  });
});
