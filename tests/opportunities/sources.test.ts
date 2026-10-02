import { describe, expect, it } from "vitest";

import { isAllowedCompanyDomain } from "@/lib/opportunities/sources";

/**
 * Company-domain guard (anti-portal) — the shared part of the sources
 * library that remained after the AI Ausbildung Search feature (and its
 * source registry) was removed.
 */

describe("isAllowedCompanyDomain (anti-portal guard)", () => {
  it("accepts a plausible company's own domain", () => {
    expect(isAllowedCompanyDomain("https://www.muster-technik.de")).toBe(true);
    expect(isAllowedCompanyDomain("https://beispiel.de/impressum")).toBe(true);
  });

  it("rejects job portals, review sites and social networks", () => {
    expect(isAllowedCompanyDomain("https://www.azubiyo.de/firmen/muster")).toBe(false);
    expect(isAllowedCompanyDomain("https://ausbildung.de/stellenangebot/1")).toBe(false);
    expect(isAllowedCompanyDomain("https://www.kununu.com/de/muster")).toBe(false);
    expect(isAllowedCompanyDomain("https://www.linkedin.com/company/muster")).toBe(false);
    expect(isAllowedCompanyDomain("https://www.arbeitsagentur.de/jobsuche/1")).toBe(false);
    expect(isAllowedCompanyDomain("https://www.handwerk.de/x")).toBe(false);
  });

  it("subdomains of blocked domains are blocked too", () => {
    expect(isAllowedCompanyDomain("https://de.indeed.com/viewjob?jk=1")).toBe(false);
    expect(isAllowedCompanyDomain("https://job.stepstone.de/jobs/1")).toBe(false);
  });

  it("rejects unparseable URLs (never a false allow)", () => {
    expect(isAllowedCompanyDomain("not a url")).toBe(false);
    expect(isAllowedCompanyDomain("")).toBe(false);
  });
});
