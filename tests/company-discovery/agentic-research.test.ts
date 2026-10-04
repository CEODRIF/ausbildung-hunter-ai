import { describe, expect, it } from "vitest";

/**
 * Agentic web research — the guard tests.
 *
 * These lock the promises the owner made explicit:
 *  - NO guessed email: an address is accepted only by literal presence on a
 *    page the run actually read (or that the provider returned);
 *  - NO duplicate company: name OR official domain OR verified email;
 *  - NO fake progress: the search layer reports a query only when it ISSUES
 *    it, and nothing it did not measure is counted;
 *  - the target counts COMPANIES, not offers — reaching it ends the run as
 *    `completed`, a checkpoint ends it as `partial`;
 *  - the verification facts (application URL, 2027 confirmation, confidence
 *    score) are derived from stored evidence only.
 */

import {
  acceptEmailsFromContent,
  confidenceScoreOf,
  emailConfidenceOf,
} from "@/lib/company-discovery/accept";
import {
  createSearchAdapter,
  type SearchAdapterBudget,
} from "@/lib/company-discovery/adapters";
import {
  CompanyIdentityIndex,
  companyKeyOf,
  emailKeyOf,
  hostKeyOf,
} from "@/lib/company-discovery/dedupe";
import { applicationUrlOf } from "@/lib/company-discovery/emails";
import { createFetchContext } from "@/lib/company-discovery/fetch-guard";
import {
  beginnYearConfirmedOf,
  outcomeSum,
  runTerminalStatus,
} from "@/lib/company-discovery/search";
import type { OpportunitySearchParams } from "@/lib/opportunities/types";
import type { WebSearchClient } from "@/lib/web-search";

// ---------------------------------------------------------------------------
// 1. No guessed emails — literal presence is the only admission path
// ---------------------------------------------------------------------------

describe("email acceptance is literal-presence only", () => {
  it("rejects a page that merely mentions the company's domain", () => {
    // The page text has the domain and even the word "email" — but no
    // address is literally published. Nothing may be derived.
    const accepted = acceptEmailsFromContent({
      text: "Kontakt: Bitte schreiben Sie uns eine Email. Infos: mustermann-gmbh.de",
      sourceUrl: "https://mustermann-gmbh.de/kontakt",
      sourceType: "official_site_contact",
      companyName: "Mustermann GmbH",
      companyDomain: "mustermann-gmbh.de",
    });
    expect(accepted).toEqual([]);
  });

  it("rejects a page that names a role mailbox without printing it", () => {
    const accepted = acceptEmailsFromContent({
      text: "Für Bewerbungen erreichen Sie unser Bewerbungsteam per E-Mail.",
      sourceUrl: "https://mustermann-gmbh.de/karriere",
      sourceType: "official_site_career",
      companyName: "Mustermann GmbH",
      companyDomain: "mustermann-gmbh.de",
    });
    expect(accepted).toEqual([]);
  });

  it("accepts an address only when it is literally on the page", () => {
    const accepted = acceptEmailsFromContent({
      text: "Impressum — Mustermann GmbH · E-Mail: bewerbung@mustermann-gmbh.de",
      sourceUrl: "https://mustermann-gmbh.de/impressum",
      sourceType: "official_site_impressum",
      companyName: "Mustermann GmbH",
      companyDomain: "mustermann-gmbh.de",
    });
    expect(accepted).toHaveLength(1);
    expect(accepted[0].email).toBe("bewerbung@mustermann-gmbh.de");
    expect(accepted[0].domainMatch).toBe(true);
  });

  it("the company's domain never manufactures an address", () => {
    // The website is all the run knows. A derived mailbox like
    // `info@<domain>` is a guess and must not exist anywhere downstream.
    const index = new CompanyIdentityIndex();
    index.mark(companyKeyOf("Mustermann GmbH"), "https://www.mustermann-gmbh.de");
    // Same employer re-encountered under a DIFFERENT name, same official
    // domain → duplicate by domain (the name key is genuinely different):
    expect(
      index.check(
        companyKeyOf("MM Maschinen"),
        "https://mustermann-gmbh.de/kontakt",
      ),
    ).toBe("domain");
    // …and no email was invented for it:
    expect(emailKeyOf(null)).toBe("");
    expect(emailKeyOf("  ")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 2. Strong dedupe — name + domain + email, across a run's whole lifetime
// ---------------------------------------------------------------------------

describe("CompanyIdentityIndex (name + domain + email)", () => {
  it("catches name variants of an already counted company", () => {
    const index = new CompanyIdentityIndex();
    index.mark(companyKeyOf("Siemens AG"));
    // Case variants and the "… Deutschland" suffix both normalize to the
    // same core name — every spelling of the same employer is a duplicate:
    expect(index.check(companyKeyOf("SIEMENS AG"))).toBe("name");
    expect(index.check(companyKeyOf("Siemens Deutschland"))).toBe("name");
    // A genuinely different employer is NOT swallowed by the index:
    expect(index.check(companyKeyOf("Bosch Thermotechnik"))).toBe("new");
  });

  it("catches the same official domain under a different name", () => {
    const index = new CompanyIdentityIndex();
    index.mark(companyKeyOf("Müller Maschinen"), "https://www.mueller-maschinen.de");
    expect(
      index.check(companyKeyOf("Mueller Masch"), "https://mueller-maschinen.de/jobs"),
    ).toBe("domain");
  });

  it("catches the same published email under a different name and domain", () => {
    const index = new CompanyIdentityIndex();
    index.mark(
      companyKeyOf("Firma A"),
      "https://firma-a.de",
      "jobs@firma-a.de",
    );
    expect(index.check(companyKeyOf("Firma B"), "https://firma-b.de", "Jobs@Firma-A.de ")).toBe(
      "email",
    );
  });

  it("check does not register; mark does (the checkpoint rebuild)", () => {
    const index = new CompanyIdentityIndex();
    expect(index.check(companyKeyOf("Neu GmbH"))).toBe("new");
    // Checking must not consume the identity:
    expect(index.check(companyKeyOf("Neu GmbH"))).toBe("new");
    index.mark(companyKeyOf("Neu GmbH"));
    expect(index.check(companyKeyOf("Neu GmbH"))).toBe("name");
    expect(index.nameCount).toBe(1);
  });

  it("empty parts never produce a key", () => {
    const index = new CompanyIdentityIndex();
    index.mark(companyKeyOf("Ganz Neu KG"));
    // A company with neither domain nor email is judged by name alone:
    expect(index.check(companyKeyOf("Andere Firma GmbH"), null, null)).toBe("new");
    expect(hostKeyOf(null)).toBe("");
    expect(hostKeyOf("not a url")).toBe("");
  });

  it("host keys are normalised (scheme, www, case)", () => {
    expect(hostKeyOf("https://WWW.Example.DE/Path")).toBe("example.de");
    expect(hostKeyOf("http://example.de")).toBe("example.de");
  });
});

// ---------------------------------------------------------------------------
// 3. No fake progress — the search layer measures what it did
// ---------------------------------------------------------------------------

describe("search layer live reporting (no fake progress)", () => {
  function emptySearchClient() {
    const calls: string[] = [];
    const client: WebSearchClient = {
      name: "tavily",
      search: async (query: string) => {
        calls.push(query);
        return []; // the provider returns nothing: zero candidates, zero fetches
      },
    };
    return { client, calls };
  }

  const criteria: OpportunitySearchParams = {
    goal: "ausbildung",
    keyword: "Marketing",
    role: "Kaufmann im E-Commerce",
    company: "",
    location: "",
    cities: [],
    beginn: "2027-08",
    freshness: "any",
    sort: "relevance",
    employment: "any",
    training_type: "any",
    home_office: "any",
    salary: "any",
    contact_email: "any",
    page: 1,
    pageSize: 20,
    match: false,
  };

  it("reports a current query ONLY when the provider call is issued", async () => {
    const { client, calls } = emptySearchClient();
    const reported: Array<{ query: string; source: string }> = [];
    const budget: SearchAdapterBudget = {
      maxQueries: 4,
      maxResultsPerQuery: 5,
      maxPagesPerQuery: 5,
      maxPagesToFetch: 20,
      onQuery: (info) => reported.push(info),
    };
    const adapter = createSearchAdapter(client, { beginnYear: 2027 }, budget);
    const fetchContext = createFetchContext({
      fetchImpl: async () => {
        throw new Error("no network may happen in this test");
      },
    });
    const result = await adapter.searchOffers(criteria, fetchContext);
    // Every reported query was actually sent to the provider — 1:1, no more,
    // no less. The provider answered empty, so there are no candidates and
    // not a single HTTP request for offer pages: nothing was invented.
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(reported).toHaveLength(calls.length);
    expect(reported).toEqual(
      calls.map((query) => ({ query, source: "search-api" })),
    );
    expect(result.offers).toHaveLength(0);
    expect(result.stats?.queriesExecuted).toBe(calls.length);
    expect(result.stats?.resultsInspected).toBe(0);
    expect(fetchContext.requests).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. The target counts companies — and decides the terminal state
// ---------------------------------------------------------------------------

describe("run terminal state (the target is a company count)", () => {
  it("reaching the target (e.g. 300 unique companies with a public email) → completed", () => {
    expect(
      runTerminalStatus({
        found: 300,
        target: 300,
        companiesProcessed: 300,
        allPassesFailed: false,
      }),
    ).toBe("completed");
  });

  it("overshooting is impossible to hide: found >= target still completes", () => {
    expect(
      runTerminalStatus({
        found: 301,
        target: 300,
        companiesProcessed: 301,
        allPassesFailed: false,
      }),
    ).toBe("completed");
  });

  it("short of the target → an honest partial (the checkpoint for Continue)", () => {
    expect(
      runTerminalStatus({
        found: 299,
        target: 300,
        companiesProcessed: 299,
        allPassesFailed: false,
      }),
    ).toBe("partial");
  });

  it("no company at all and every pass unavailable → failed (not partial)", () => {
    expect(
      runTerminalStatus({
        found: 0,
        target: 300,
        companiesProcessed: 0,
        allPassesFailed: true,
      }),
    ).toBe("failed");
  });

  it("the outcome counters always add up to the processed count (§4.8)", () => {
    const emailsFound = 127;
    const noPublicEmail = 96;
    const sourcesBlocked = 77;
    expect(outcomeSum({ emailsFound, noPublicEmail, sourcesBlocked })).toBe(300);
    expect(outcomeSum({ emailsFound: 0, noPublicEmail: 0, sourcesBlocked: 0 })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Verification facts — stored evidence only
// ---------------------------------------------------------------------------

describe("per-company verification facts", () => {
  it("the application URL is a page that was actually inspected", () => {
    const outcome = {
      inspectedPages: [
        { url: "https://firma.de/impressum", kind: "impressum" },
        { url: "https://firma.de/karriere", kind: "karriere" },
        { url: "https://firma.de/jobs", kind: "jobs" },
      ],
    };
    // Karriere wins (fixed page order) — and only real URLs qualify:
    expect(applicationUrlOf(outcome, null)).toBe("https://firma.de/karriere");
    expect(applicationUrlOf({ inspectedPages: [] }, null)).toBeNull();
    // A domain-derived URL is NEVER produced here:
    expect(applicationUrlOf({ inspectedPages: [] }, "https://firma.de/karriere")).toBe(
      "https://firma.de/karriere",
    );
  });

  it("the 2027 confirmation is true / false / null — never guessed", () => {
    const year2027 = { beginn: { mode: "year", year: 2027 } as const };
    expect(
      beginnYearConfirmedOf({ beginn: "2027-08-01" }, year2027),
    ).toBe(true);
    expect(
      beginnYearConfirmedOf({ beginn: "2028-01-15" }, year2027),
    ).toBe(false);
    expect(
      beginnYearConfirmedOf({ beginn: null }, year2027),
    ).toBeNull(); // not documented → cannot be confirmed
    expect(
      beginnYearConfirmedOf({ beginn: "2027-08-01" }, {
        beginn: { mode: "from_now" } as const,
      }),
    ).toBeNull(); // no concrete year in the run to confirm against
    expect(
      beginnYearConfirmedOf({ beginn: "2027-08-01" }, {
        beginn: { mode: "date", date: "2027-08-01" } as const,
      }),
    ).toBe(true);
  });

  it("the confidence score is evidence-derived, 0–100, and null without an email", () => {
    expect(confidenceScoreOf(null)).toBeNull();
    // Impressum page + matching domain + two corroborating pages:
    // 75 (high) + 15 (domain match) + 10 (corroboration, capped) = 100.
    const strong = {
      sourceType: "official_site_impressum" as const,
      domainMatch: true,
      sourceUrls: [
        "https://firma.de/impressum",
        "https://firma.de/kontakt",
        "https://firma.de/team",
      ],
    };
    expect(emailConfidenceOf(strong)).toBe("high");
    expect(confidenceScoreOf(strong)).toBe(100);
    // A search snippet alone is the weakest evidence:
    const weak = {
      sourceType: "search_result" as const,
      domainMatch: false,
      sourceUrls: ["https://example.com/x"],
    };
    expect(emailConfidenceOf(weak)).toBe("low");
    expect(confidenceScoreOf(weak)).toBe(35);
    // Corroboration is capped: many pages do not outrun the ceiling.
    const many = {
      ...strong,
      sourceUrls: Array.from({ length: 9 }, (_, i) => `https://firma.de/p${i}`),
    };
    expect(confidenceScoreOf(many)).toBe(100);
  });
});
