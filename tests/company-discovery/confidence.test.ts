import { describe, expect, it } from "vitest";

import {
  buildCompanyEvidence,
  companyConfidence,
  CONFIDENCE_WEIGHTS,
  type CompanyConfidenceInput,
  type CompanyFacts,
} from "@/lib/company-discovery/confidence";

const NO_FACTS: CompanyConfidenceInput = {
  officialDomain: false,
  training: false,
  role: false,
  location: false,
  email: false,
  application: false,
  secondSource: false,
  conflict: false,
};

const NO_COMPANY: CompanyFacts = {
  offerUrl: null,
  role: null,
  city: null,
  state: null,
  beginn: null,
  websiteUrl: null,
  websiteSourceUrl: null,
  email: null,
  emailSourceUrls: [],
  applicationUrl: null,
  checkedAt: "2026-10-25T10:00:00.000Z",
};

describe("company confidence (interpretable, evidence-derived)", () => {
  it("no measured fact → score 0, no reasons, no conflict", () => {
    const result = companyConfidence(NO_FACTS);
    expect(result.score).toBe(0);
    expect(result.reasons).toEqual([]);
    expect(result.conflict).toBe(false);
  });

  it("each present fact adds exactly its documented weight", () => {
    expect(
      companyConfidence({ ...NO_FACTS, officialDomain: true }).score,
    ).toBe(CONFIDENCE_WEIGHTS.officialDomain);
    expect(
      companyConfidence({ ...NO_FACTS, training: true }).score,
    ).toBe(CONFIDENCE_WEIGHTS.training);
    expect(companyConfidence({ ...NO_FACTS, role: true }).score).toBe(
      CONFIDENCE_WEIGHTS.role,
    );
    expect(companyConfidence({ ...NO_FACTS, location: true }).score).toBe(
      CONFIDENCE_WEIGHTS.location,
    );
    expect(companyConfidence({ ...NO_FACTS, email: true }).score).toBe(
      CONFIDENCE_WEIGHTS.email,
    );
    expect(
      companyConfidence({ ...NO_FACTS, application: true }).score,
    ).toBe(CONFIDENCE_WEIGHTS.application);
    expect(
      companyConfidence({ ...NO_FACTS, secondSource: true }).score,
    ).toBe(CONFIDENCE_WEIGHTS.secondSource);
  });

  it("a full company scores the sum of all weights (capped at 100)", () => {
    const result = companyConfidence({
      officialDomain: true,
      training: true,
      role: true,
      location: true,
      email: true,
      application: true,
      secondSource: true,
      conflict: false,
    });
    expect(result.score).toBe(100); // 30+20+15+10+10+10+5 = 100
    expect(result.reasons).toHaveLength(7);
  });

  it("every applied weight leaves a readable reason (no decorative score)", () => {
    const result = companyConfidence({
      officialDomain: true,
      training: false,
      role: true,
      location: true,
      email: true,
      application: false,
      secondSource: false,
      conflict: false,
    });
    expect(result.score).toBe(30 + 15 + 10 + 10);
    expect(result.reasons).toHaveLength(4);
    expect(result.reasons.join(" ")).not.toBe("");
  });

  it("a contradiction is RECORDED (conflict=true) and penalized", () => {
    const without = companyConfidence({ ...NO_FACTS, email: true });
    const withConflict = companyConfidence({ ...NO_FACTS, email: true, conflict: true });
    expect(withConflict.conflict).toBe(true);
    expect(withConflict.score).toBe(without.score + CONFIDENCE_WEIGHTS.conflict);
    expect(withConflict.reasons).toContainEqual(expect.stringContaining("Widerspruch"));
  });

  it("the score never drops below 0 (conflict alone clamps at 0)", () => {
    expect(companyConfidence({ ...NO_FACTS, conflict: true }).score).toBe(0);
  });

  it("is deterministic: same facts → same result", () => {
    const a = companyConfidence({ ...NO_FACTS, email: true, officialDomain: true });
    const b = companyConfidence({ ...NO_FACTS, email: true, officialDomain: true });
    expect(b).toEqual(a);
  });
});

describe("company evidence ledger (only pages the run actually holds)", () => {
  it("empty facts → empty ledger (nothing invented)", () => {
    expect(buildCompanyEvidence(NO_COMPANY)).toEqual([]);
  });

  it("lists every measured page with its fact and the check stamp", () => {
    const items = buildCompanyEvidence({
      offerUrl: "https://portal.de/angebot/123",
      role: "Mechatroniker",
      city: "München",
      state: "Bayern",
      beginn: "2027-08-01",
      websiteUrl: "https://firma.de",
      websiteSourceUrl: "https://search-result.de/firma",
      email: "info@firma.de",
      emailSourceUrls: ["https://firma.de/impressum", "https://firma.de/kontakt"],
      applicationUrl: "https://firma.de/karriere/ausbildung",
      checkedAt: "2026-10-25T10:00:00.000Z",
    });
    const urls = items.map((item) => item.url);
    expect(urls).toEqual([
      "https://portal.de/angebot/123",
      "https://search-result.de/firma",
      "https://firma.de/impressum",
      "https://firma.de/kontakt",
      "https://firma.de/karriere/ausbildung",
    ]);
    for (const item of items) {
      expect(item.fact.length).toBeGreaterThan(0);
      expect(item.checkedAt).toBe("2026-10-25T10:00:00.000Z");
      expect(item.sourceType).toMatch(/^[a-z_]+$/);
    }
    const offer = items.find((item) => item.sourceType === "job_listing");
    expect(offer?.fact).toContain("Mechatroniker");
    expect(offer?.fact).toContain("München");
    expect(offer?.fact).toContain("2027");
  });

  it("never lists a URL that is not actually present in the facts", () => {
    const items = buildCompanyEvidence({
      ...NO_COMPANY,
      offerUrl: "https://portal.de/angebot/1",
      websiteUrl: "https://firma.de", // identified, but NO source page
      email: null,
    });
    expect(items.map((item) => item.url)).toEqual(["https://portal.de/angebot/1"]);
    // The website is known but the page that proved it was never opened →
    // no search_result item. A URL is evidence only when it exists.
  });
});
