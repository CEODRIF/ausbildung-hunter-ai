import { describe, expect, it } from "vitest";

import {
  buildDiscoveryQueries,
  companyWebsiteFromResult,
  emailsFromPageText,
  emailsFromSearchResult,
  findContactSeed,
  isFreeMailDomain,
  looksLikePersonAddress,
  pickCompanyEmail,
  roleOfLocalPart,
  type CompanyContactSeed,
} from "@/lib/opportunities/company-contact";
import { MAX_TAVILY_REQUESTS_PER_RUN } from "@/lib/web-search";

/**
 * Deterministic company-contact rules (AI Search 2.5).
 *
 * The pipeline must turn the data the search provider already returned into
 * attributed contact information — and never invent, never mis-attribute and
 * never spend an extra provider request.
 */

describe("email extraction from provider results", () => {
  it("extracts an address printed in the result content (same domain → high)", () => {
    const emails = emailsFromSearchResult({
      title: "Karriere bei Beispiel GmbH",
      snippet:
        "Ausbildung 2027 – Bewerbungen an bewerbung@beispiel-gmbh.de oder telefonisch.",
      url: "https://www.beispiel-gmbh.de/karriere",
    });
    expect(emails).toHaveLength(1);
    expect(emails[0]).toMatchObject({
      email: "bewerbung@beispiel-gmbh.de",
      sourceUrl: "https://www.beispiel-gmbh.de/karriere",
      source: "tavily_result_content",
      confidence: "high",
      sameDomain: true,
    });
  });

  it("picks the application address when several are published", () => {
    const emails = emailsFromSearchResult({
      title: "Kontakt",
      snippet:
        "info@beispiel-gmbh.de · kontakt@beispiel-gmbh.de · karriere@beispiel-gmbh.de",
      url: "https://beispiel-gmbh.de/kontakt",
    });
    expect(emails.map((entry) => entry.email).sort()).toEqual([
      "info@beispiel-gmbh.de",
      "karriere@beispiel-gmbh.de",
      "kontakt@beispiel-gmbh.de",
    ]);
    expect(pickCompanyEmail(emails)?.email).toBe("karriere@beispiel-gmbh.de");
  });

  it("never links another company's address to this company", () => {
    const emails = emailsFromSearchResult({
      title: "Stellenangebot",
      snippet: "Bewerbung an bewerbung@fremde-firma.de",
      url: "https://www.beispiel-gmbh.de/karriere",
    });
    // Different domain and the text does not name the company → dropped.
    expect(emails).toHaveLength(0);
  });

  it("keeps a different-domain address when the same text names the company", () => {
    const emails = emailsFromSearchResult({
      title: "Beispiel GmbH – Ausbildung 2027",
      snippet: "Bewerbungen an ausbildung@karriereportal.de (Beispiel GmbH)",
      url: "https://www.jobboerse-extern.de/beispiel-gmbh",
      companyName: "Beispiel GmbH",
    });
    expect(emails.map((entry) => entry.email)).toEqual([
      "ausbildung@karriereportal.de",
    ]);
  });

  it("never treats a private mailbox as the company's official address", () => {
    expect(isFreeMailDomain("gmail.com")).toBe(true);
    expect(isFreeMailDomain("outlook.de")).toBe(true);
    expect(isFreeMailDomain("beispiel-gmbh.de")).toBe(false);
    const emails = emailsFromSearchResult({
      title: "Beispiel GmbH Ausbildung",
      snippet: "Kontakt: beispiel.gmbh2027@gmail.com",
      url: "https://beispiel-gmbh.de/karriere",
    });
    expect(emails).toHaveLength(0);
  });

  it("excludes person-looking addresses unless published as a recruiting contact", () => {
    expect(looksLikePersonAddress("max.mustermann")).toBe(true);
    expect(looksLikePersonAddress("m.mustermann")).toBe(true);
    expect(looksLikePersonAddress("bewerbung")).toBe(false);
    expect(looksLikePersonAddress("karriere")).toBe(false);

    // Personal address on a normal page → dropped.
    expect(
      emailsFromPageText({
        text: "Impressum: Max Mustermann, max.mustermann@beispiel-gmbh.de",
        sourceUrl: "https://beispiel-gmbh.de/impressum",
      }),
    ).toHaveLength(0);

    // …but kept when the recruiting page explicitly publishes it.
    const recruiting = emailsFromPageText({
      text: "Ihre Bewerbung richten Sie an m.mustermann@beispiel-gmbh.de",
      sourceUrl: "https://beispiel-gmbh.de/karriere/bewerbung",
      companyName: "Beispiel GmbH",
    });
    expect(recruiting).toHaveLength(1);
    expect(recruiting[0].confidence).toBe("low");
  });

  it("never invents an address (no derivation from the company name)", () => {
    const emails = emailsFromSearchResult({
      title: "Beispiel GmbH",
      snippet: "Ausbildung 2027 in Berlin – jetzt bewerben.",
      url: "https://beispiel-gmbh.de/karriere",
    });
    expect(emails).toEqual([]);
    expect(
      emailsFromPageText({
        text: "Beispiel GmbH – Ihr Partner für Automatisierung. Kein Kontakt angegeben.",
        sourceUrl: "https://beispiel-gmbh.de/",
        companyName: "Beispiel GmbH",
      }),
    ).toEqual([]);
  });

  it("reports no contact when nothing is published", () => {
    expect(
      pickCompanyEmail(
        emailsFromSearchResult({
          title: "Beispiel GmbH Karriere",
          snippet: "Bewerben Sie sich online über unser Formular.",
          url: "https://beispiel-gmbh.de/karriere",
        }),
      ),
    ).toBeNull();
  });

  it("classifies role addresses for the priority order", () => {
    expect(roleOfLocalPart("bewerbung")).toBe("application");
    expect(roleOfLocalPart("karriere")).toBe("application");
    expect(roleOfLocalPart("ausbildung")).toBe("application");
    expect(roleOfLocalPart("info")).toBe("general");
    expect(roleOfLocalPart("kontakt")).toBe("general");
    expect(roleOfLocalPart("mueller")).toBeNull();
  });
});

describe("company website seeds", () => {
  it("takes a non-portal result as the company's own website", () => {
    expect(
      companyWebsiteFromResult("https://www.beispiel-gmbh.de/karriere/2027", false, false),
    ).toBe("https://www.beispiel-gmbh.de");
    // Portals and social pages are never a company website.
    expect(companyWebsiteFromResult("https://www.azubiyo.de/jobs", true, false)).toBeNull();
    expect(
      companyWebsiteFromResult("https://www.linkedin.com/company/x/jobs", false, true),
    ).toBeNull();
  });

  it("attributes a seed to the RIGHT company only", () => {
    const seedA: CompanyContactSeed = {
      domain: "beispiel-gmbh.de",
      websiteUrl: "https://beispiel-gmbh.de",
      sourceUrl: "https://beispiel-gmbh.de/karriere",
      text: "Karriere bei der Beispiel GmbH",
      emails: [],
    };
    const seedB: CompanyContactSeed = {
      domain: "andere-firma.de",
      websiteUrl: "https://andere-firma.de",
      sourceUrl: "https://andere-firma.de/karriere",
      text: "Karriere bei der Andere Firma GmbH",
      emails: [],
    };
    expect(findContactSeed("Beispiel GmbH", [seedA, seedB])?.domain).toBe(
      "beispiel-gmbh.de",
    );
    expect(findContactSeed("Unbekannte Firma AG", [seedA, seedB])).toBeNull();
  });
});

describe("discovery queries + provider budget", () => {
  it("builds three DISTINCT intents and never more than the cap", () => {
    const queries = buildDiscoveryQueries(
      ["\"Kaufmann im E-Commerce\" Ausbildung 2027 Berlin"],
      MAX_TAVILY_REQUESTS_PER_RUN,
    );
    expect(queries).toHaveLength(3);
    expect(queries.map((entry) => entry.intent)).toEqual([
      "jobs",
      "company",
      "contact",
    ]);
    expect(new Set(queries.map((entry) => entry.query)).size).toBe(3);
    for (const entry of queries)
      expect(entry.query).toContain("Kaufmann im E-Commerce");
    // The raised default provider budget (cost cap stays at 60).
    expect(MAX_TAVILY_REQUESTS_PER_RUN).toBe(30);
  });

  it("never produces more queries than the cap", () => {
    expect(buildDiscoveryQueries(["q"], 1)).toHaveLength(1);
    expect(buildDiscoveryQueries(["q"], 2)).toHaveLength(2);
    expect(buildDiscoveryQueries([], 3)).toEqual([]);
  });

  it("the contact layer performs no provider request and touches no credits", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync("src/lib/opportunities/company-contact.ts", "utf8"),
    );
    expect(source).not.toContain("fetch(");
    expect(source).not.toContain("getWebSearchClient");
    expect(source).not.toContain("search-credits");
    expect(source).not.toContain("createAdminClient");
  });
});
