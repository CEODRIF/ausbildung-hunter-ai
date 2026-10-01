import { describe, expect, it } from "vitest";

import {
  buildSourceQuery,
  enabledWebSources,
  getSource,
  hostToSourceId,
  SOURCE_CATEGORIES,
  SOURCE_REGISTRY,
  sourceLabel,
} from "@/lib/opportunities/sources";

/**
 * Source Registry (AI Search 2.0) — integrity + query building.
 * The registry is the single source of truth for WHICH public sources the
 * AI search uses and HOW it may legally reach each of them.
 */

describe("SOURCE_REGISTRY integrity", () => {
  it("has unique, non-empty ids and labels", () => {
    const ids = SOURCE_REGISTRY.map((source) => source.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const source of SOURCE_REGISTRY) {
      expect(source.id.length).toBeGreaterThan(0);
      expect(source.label.length).toBeGreaterThan(0);
    }
  });

  it("every entry has a valid kind, category and enabled flag", () => {
    const kinds = new Set(["api", "web", "link_only"]);
    for (const source of SOURCE_REGISTRY) {
      expect(kinds.has(source.kind)).toBe(true);
      expect(SOURCE_CATEGORIES).toContain(source.category);
      expect(typeof source.enabled).toBe("boolean");
    }
  });

  it("the BA source is the only API source (official REST API)", () => {
    const api = SOURCE_REGISTRY.filter((source) => source.kind === "api");
    expect(api.map((source) => source.id)).toEqual(["arbeitsagentur"]);
  });

  it("official search URLs are https (or null — never invented)", () => {
    for (const source of SOURCE_REGISTRY) {
      if (source.officialSearchUrl === null) continue;
      const parsed = new URL(source.officialSearchUrl);
      expect(parsed.protocol).toBe("https:");
      expect(parsed.hostname.length).toBeGreaterThan(0);
    }
  });

  it("the user-required public sources are registered and enabled", () => {
    const required = [
      "arbeitsagentur",
      "ausbildung.de",
      "azubiyo",
      "aubi-plus",
      "ihk",
      "hwk",
      "meinestadt",
      "stepstone",
      "indeed",
    ];
    for (const id of required) {
      const source = getSource(id);
      expect(source, `registry must contain "${id}"`).not.toBeNull();
      expect(source?.enabled).toBe(true);
    }
  });

  it("enabledWebSources excludes the API source (BA has its own pipeline)", () => {
    const web = enabledWebSources();
    expect(web.every((source) => source.kind === "web")).toBe(true);
    expect(web.map((source) => source.id)).not.toContain("arbeitsagentur");
    expect(web.length).toBeGreaterThanOrEqual(10);
  });
});

describe("buildSourceQuery", () => {
  const query = '"Kaufmann im E-Commerce" Ausbildung 2027';

  it("scopes domain sources with site: operators", () => {
    const azubiyo = getSource("azubiyo");
    expect(azubiyo).not.toBeNull();
    expect(buildSourceQuery(azubiyo!, query)).toBe(
      `${query} site:azubiyo.de`,
    );
  });

  it("joins multi-domain sources with OR (hwk)", () => {
    const hwk = getSource("hwk");
    expect(hwk).not.toBeNull();
    const built = buildSourceQuery(hwk!, query);
    expect(built).toContain("site:hwk.de");
    expect(built).toContain("site:handwerk.de");
    expect(built).toContain("OR");
  });

  it("company_career adds career-page terms without site: scoping", () => {
    const career = getSource("company_career");
    expect(career).not.toBeNull();
    const built = buildSourceQuery(career!, query);
    expect(built).toContain("karriere");
    expect(built).toContain("stellenangebote");
    expect(built).not.toContain("site:");
  });

  it("social_media stays scoped to public social platforms", () => {
    const social = getSource("social_media");
    expect(social).not.toBeNull();
    const built = buildSourceQuery(social!, query);
    expect(built).toContain("site:linkedin.com");
  });

  it("returns '' for an empty AI query (never a bare operator)", () => {
    const azubiyo = getSource("azubiyo");
    expect(buildSourceQuery(azubiyo!, "   ")).toBe("");
  });
});

describe("hostToSourceId + sourceLabel", () => {
  it("maps known portal hosts to their registry ids", () => {
    expect(hostToSourceId("https://www.azubiyo.de/stellenangebote/1")).toBe(
      "azubiyo",
    );
    expect(hostToSourceId("https://www.aubi-plus.de/detail/2")).toBe(
      "aubi-plus",
    );
    expect(hostToSourceId("https://de.indeed.com/viewjob?jk=1")).toBe(
      "indeed",
    );
    expect(hostToSourceId("https://www.stepstone.de/stellenangebote/3")).toBe(
      "stepstone",
    );
    expect(hostToSourceId("https://www.meinestadt.de/jobs/4")).toBe(
      "meinestadt",
    );
  });

  it("returns null for hosts no source claims (company career pages)", () => {
    expect(hostToSourceId("https://firma.example/karriere/a")).toBeNull();
    expect(hostToSourceId("not a url")).toBeNull();
  });

  it("sourceLabel falls back to the id for unknown ids (honest)", () => {
    expect(sourceLabel("azubiyo")).toBe("Azubiyo");
    expect(sourceLabel("unknown-source")).toBe("unknown-source");
  });
});
