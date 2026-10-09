import { describe, expect, it } from "vitest";

import {
  canonicalCityKey,
  extractCityFromText,
  isKnownCity,
  matchCity,
  normalizeCityKey,
} from "@/lib/housing/web-search/geo";

describe("normalizeCityKey", () => {
  it("folds case, umlauts, ß and punctuation", () => {
    expect(normalizeCityKey("Köln")).toBe("koeln");
    expect(normalizeCityKey("Düsseldorf")).toBe("duesseldorf");
    expect(normalizeCityKey("Frankfurt (Main)")).toBe("frankfurt main");
    expect(normalizeCityKey("  Berlin-Mitte ")).toBe("berlin mitte");
    expect(normalizeCityKey("MÜNCHEN")).toBe("muenchen");
  });
});

describe("canonicalCityKey / isKnownCity", () => {
  it("resolves names and unambiguous aliases", () => {
    expect(canonicalCityKey("Berlin")).toBe("Berlin");
    expect(canonicalCityKey("koeln")).toBe("Köln");
    expect(canonicalCityKey("Köln")).toBe("Köln");
    expect(canonicalCityKey("Frankfurt")).toBe("Frankfurt (Main)");
    expect(canonicalCityKey("Frankfurt am Main")).toBe("Frankfurt (Main)");
    expect(canonicalCityKey("Münster")).toBe("Münster");
    expect(canonicalCityKey("Düsseldorf")).toBe("Düsseldorf");
  });

  it("keeps Frankfurt (Main) and Frankfurt (Oder) distinct", () => {
    expect(canonicalCityKey("Frankfurt (Oder)")).toBe("Frankfurt (Oder)");
    expect(canonicalCityKey("Frankfurt (Oder)")).not.toBe(canonicalCityKey("Frankfurt"));
  });

  it("returns null for unknown names (possibly districts)", () => {
    expect(canonicalCityKey("Neukölln")).toBeNull();
    expect(canonicalCityKey("Prenzlauer Berg")).toBeNull();
    expect(canonicalCityKey("Neunkirchen")).toBeNull();
    expect(isKnownCity("Neukölln")).toBe(false);
    expect(isKnownCity("Hamburg")).toBe(true);
  });
});

describe("matchCity", () => {
  it("matches the requested city", () => {
    expect(matchCity("Berlin", "", "Berlin", null).status).toBe("match");
    expect(matchCity("Köln", "", "koeln", null).status).toBe("match");
    expect(matchCity("Düsseldorf", "", "Duesseldorf", null).status).toBe("match");
  });

  it("treats district-style evidence as matching the requested city", () => {
    expect(matchCity("Berlin", "", "Berlin-Mitte", null).status).toBe("match");
    expect(matchCity("Köln", "", "Koeln-Ehrenfeld", null).status).toBe("match");
  });

  it("rejects a KNOWN different city (the Berlin→Frankfurt incident)", () => {
    expect(matchCity("Berlin", "", "Frankfurt", null).status).toBe("mismatch");
    expect(matchCity("Berlin", "", "Frankfurt am Main", null).status).toBe("mismatch");
    expect(matchCity("Köln", "", "München", null).status).toBe("mismatch");
  });

  it("does NOT reject unknown names (Neukölln is a Berlin district, not a city mismatch)", () => {
    const m = matchCity("Berlin", "", "Neukölln", null);
    expect(m.status).toBe("unknown");
    expect(m.evidenceCity).toBe("Neukölln");
  });

  it("keeps Frankfurt (Main) vs Frankfurt (Oder) a mismatch", () => {
    expect(matchCity("Frankfurt", "", "Frankfurt (Oder)", null).status).toBe("mismatch");
  });

  it("no evidence → unknown (never a silent match, never a false rejection)", () => {
    expect(matchCity("Berlin", "", null, null).status).toBe("unknown");
    expect(matchCity("Berlin", "", "", null).status).toBe("unknown");
  });

  it("a differing postal code is decisive", () => {
    expect(matchCity("", "10115", "Berlin", "10115").status).toBe("match");
    expect(matchCity("", "10115", "Frankfurt", "60311").status).toBe("mismatch");
  });

  it("postal-code-only requests cannot confirm or refute a city name", () => {
    expect(matchCity("", "10115", "Berlin", null).status).toBe("unknown");
  });
});

describe("extractCityFromText", () => {
  it("finds the city in titles and URL slugs (word-boundary, folded)", () => {
    expect(extractCityFromText("Helle 2-Zimmer-Wohnung in Berlin-Kreuzberg")).toBe("Berlin");
    expect(extractCityFromText("2-zimmer-koeln-123456789")).toBe("Köln");
    expect(extractCityFromText("Wohnung in Frankfurt, 2 Zimmer")).toBe("Frankfurt (Main)");
  });

  it("does NOT extract from street names or adjectives", () => {
    // "Frankfurter Allee" is a street in BERLIN — must not say Frankfurt.
    expect(extractCityFromText("Wohnung nahe Frankfurter Allee")).toBeNull();
    expect(extractCityFromText("Koelner Strasse 5, Wohnung")).toBeNull();
  });

  it("returns null for empty or city-free text", () => {
    expect(extractCityFromText("")).toBeNull();
    expect(extractCityFromText("Schöne 3-Zimmer-Wohnung mit Balkon")).toBeNull();
  });
});
