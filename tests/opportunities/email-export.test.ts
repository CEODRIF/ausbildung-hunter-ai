import { describe, expect, it } from "vitest";
import {
  exportableOpportunities,
  normalizeOpportunityEmail,
  opportunityEmail,
  resultsWithEmailCount,
} from "@/lib/opportunities/email-export";
import type { Opportunity } from "@/lib/opportunities/types";

/**
 * Excel export email-eligibility rules (opportunity outreach export).
 *
 * Contract: an opportunity is exported ONLY when its source published a
 * real, non-empty, non-placeholder email; duplicates are removed; the UI
 * count uses exactly the same rules as the workbook.
 */

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
    location: "10115 Berlin",
    location_detail: {
      city: "Berlin",
      region: "Berlin",
      country: "Deutschland",
      postal_code: "10115",
    },
    distance_km: null,
    latitude: null,
    longitude: null,
    profession: "Mechatroniker/in",
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

/** Build a realistic page of 100 results: exactly 17 with valid, unique
 *  emails (varied formatting), the rest without usable contact data. */
function build100Results(): Opportunity[] {
  const results: Opportunity[] = [];
  for (let i = 0; i < 100; i += 1) {
    let contact: Opportunity["contact"] = null;
    if (i < 17) {
      // valid emails with varied (but real) formatting
      const variants = [
        `bewerbung${i}@firma-${i}.de`,
        ` hr@firma-${i}.de `, // surrounding whitespace
        `karriere@FIRMA-${i}.DE`, // uppercase
        `talent.${i}@firma-${i}.com`,
      ];
      contact = {
        person: i % 2 === 0 ? `Frau Herr${i}` : null,
        email: variants[i % variants.length],
        phone: i % 3 === 0 ? `030 12345${i}` : null,
      };
    } else {
      // no contact / unusable contact data
      const junk: Array<
        | null
        | { person: null; email: string | null; phone: null }
      > = [
        null,
        { person: null, email: null, phone: null },
        { person: null, email: "", phone: null },
        { person: null, email: "   ", phone: null },
        { person: null, email: "N/A", phone: null },
        { person: null, email: "none", phone: null },
        { person: null, email: "not available", phone: null },
        { person: null, email: "keine", phone: null },
      ];
      contact = junk[i % junk.length];
    }
    results.push(
      mkOpp({
        id: `arbeitsagentur:TEST-${i}`,
        external_id: `TEST-${i}`,
        source_url: `https://example.test/${i}`,
        title: `Ausbildung Position ${i}`,
        contact,
        company_name: i % 5 === 0 ? null : `Firma ${i} GmbH`,
      }),
    );
  }
  return results;
}

describe("email export eligibility (AI Search Excel export)", () => {
  it("100 results → only the 17 results with valid emails are exported", () => {
    const results = build100Results();
    const exportable = exportableOpportunities(results);
    expect(results).toHaveLength(100);
    expect(exportable).toHaveLength(17);
    // stable order: first (highest-ranked) occurrence of each email
    expect(exportable.map((o) => o.id)).toEqual(
      Array.from({ length: 17 }, (_, i) => `arbeitsagentur:TEST-${i}`),
    );
    // every exported row has a usable email; nothing else was exported
    for (const o of exportable) {
      expect(opportunityEmail(o)).not.toBeNull();
    }
  });

  it("empty / null / undefined / whitespace-only emails are excluded", () => {
    const results = [
      mkOpp({ id: "a:1", contact: null }),
      mkOpp({ id: "a:2", contact: { person: null, email: null, phone: null } }),
      mkOpp({ id: "a:3", contact: { person: null, email: "", phone: null } }),
      mkOpp({
        id: "a:4",
        contact: { person: null, email: " \t  ", phone: null },
      }),
      mkOpp({
        id: "a:5",
        contact: { person: null, email: "good@real.de", phone: null },
      }),
    ];
    const exportable = exportableOpportunities(results);
    expect(exportable.map((o) => o.id)).toEqual(["a:5"]);
    expect(normalizeOpportunityEmail(undefined)).toBeNull();
    expect(normalizeOpportunityEmail(null)).toBeNull();
    expect(normalizeOpportunityEmail("")).toBeNull();
  });

  it("placeholder values are excluded (no fabricated contacts)", () => {
    const placeholders = [
      "N/A",
      "n.a.",
      "NA",
      "none",
      "not available",
      "no email",
      "email not available",
      "keine",
      "keine angabe",
      "Keine E-Mail",
      "unbekannt",
      "unknown",
      "pending",
      "tbd",
      "to be determined",
      "—",
      "-",
      "null",
    ];
    for (const value of placeholders) {
      expect(normalizeOpportunityEmail(value), `must reject "${value}"`).toBeNull();
    }
    // structurally invalid emails are excluded too
    expect(normalizeOpportunityEmail("email")).toBeNull();
    expect(normalizeOpportunityEmail("foo@")).toBeNull();
    expect(normalizeOpportunityEmail("@bar.de")).toBeNull();
    expect(normalizeOpportunityEmail("foo bar@x.de")).toBeNull();
    expect(normalizeOpportunityEmail("foo@bar")).toBeNull(); // no TLD
    // real emails survive (trimmed, case preserved for display)
    expect(normalizeOpportunityEmail("  User@Firma.DE ")).toBe("User@Firma.DE");
    expect(normalizeOpportunityEmail("bewerbung@firma.de")).toBe(
      "bewerbung@firma.de",
    );
  });

  it("duplicate emails are deduplicated (case/whitespace-insensitive), keeping the first ranked occurrence", () => {
    const results = [
      mkOpp({
        id: "d:1",
        title: "Position A",
        contact: { person: null, email: "  Bewerbung@FIRMA.DE ", phone: null },
      }),
      mkOpp({
        id: "d:2",
        title: "Position B (same company)",
        contact: { person: null, email: "bewerbung@firma.de", phone: null },
      }),
      mkOpp({
        id: "d:3",
        title: "Position C (same company)",
        contact: {
          person: null,
          email: "BEWERBUNG@FIRMA.DE",
          phone: null,
        },
      }),
      mkOpp({
        id: "d:4",
        title: "Position D (different contact)",
        contact: { person: null, email: "personal@firma.de", phone: null },
      }),
    ];
    const exportable = exportableOpportunities(results);
    // 4 results, 2 unique emails → 2 rows; the FIRST occurrence wins
    expect(exportable).toHaveLength(2);
    expect(exportable.map((o) => o.id)).toEqual(["d:1", "d:4"]);
    // …while the count still reports all qualifying results (4)
    expect(resultsWithEmailCount(results)).toBe(4);
  });

  it("missing optional fields do not break the export row", () => {
    const minimal = mkOpp({
      company_name: null,
      location: null,
      location_detail: null,
      contact: { person: null, email: "only@this.de", phone: null },
      valid_from: null,
      application_deadline: null,
      requirements: [],
      salary: null,
      profession: null,
      training_type: null,
      posted_at: null,
    });
    expect(exportableOpportunities([minimal])).toHaveLength(1);
  });

  it("zero email results → nothing is exportable (button disabled / request blocked)", () => {
    const results = build100Results().slice(17); // the 83 without emails
    expect(resultsWithEmailCount(results)).toBe(0);
    expect(exportableOpportunities(results)).toEqual([]);
    expect(exportableOpportunities([])).toEqual([]);
    // the route guards the same condition (length === 0 → 409)
    expect(exportableOpportunities(results).length === 0).toBe(true);
  });

  it("the summary count equals the number of results with a valid email", () => {
    const results = build100Results();
    expect(resultsWithEmailCount(results)).toBe(17);
    expect(resultsWithEmailCount([])).toBe(0);
    expect(resultsWithEmailCount([mkOpp({ contact: null })])).toBe(0);
    expect(
      resultsWithEmailCount([
        mkOpp({
          contact: { person: null, email: "one@x.de", phone: null },
        }),
      ]),
    ).toBe(1);
  });
});


