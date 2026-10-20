import { describe, expect, it } from "vitest";

import { normalizeGermanSalutation } from "@/lib/contact-name";
import {
  GREETING_FALLBACK,
  renderContactName,
  renderGreeting,
} from "@/lib/personalization";

describe("normalizeGermanSalutation", () => {
  it("preserves a single explicit salutation unchanged (idempotent)", () => {
    const x = "Herr Max Mustermann";
    expect(normalizeGermanSalutation(x)).toBe(x);
    expect(normalizeGermanSalutation(x)).toBe(normalizeGermanSalutation(x));
  });

  it("collapses a duplicated salutation to exactly one", () => {
    expect(normalizeGermanSalutation("Herr Herr Max Mustermann")).toBe(
      "Herr Max Mustermann",
    );
    expect(normalizeGermanSalutation("Frau Frau Anna Schneider")).toBe(
      "Frau Anna Schneider",
    );
    // Mixed/duplicate: the first salutation wins and is deduped.
    expect(normalizeGermanSalutation("Herr Frau Anna")).toBe("Herr Anna");
  });

  it("canonicalizes casing and capitalizes the name", () => {
    expect(normalizeGermanSalutation("herr max")).toBe("Herr Max");
    expect(normalizeGermanSalutation("FRAU anna")).toBe("Frau Anna");
  });

  it("does NOT guess gender when no explicit salutation is present", () => {
    expect(normalizeGermanSalutation("Max Mustermann")).toBe("Max Mustermann");
    expect(normalizeGermanSalutation("Anna Schneider")).toBe("Anna Schneider");
    expect(normalizeGermanSalutation("Alex Taylor")).toBe("Alex Taylor");
  });

  it("preserves titles, compound names, umlauts, hyphens and apostrophes", () => {
    expect(normalizeGermanSalutation("Herr Dr. Müller")).toBe("Herr Dr. Müller");
    expect(normalizeGermanSalutation("Frau O'Brien-Müller")).toBe(
      "Frau O'Brien-Müller",
    );
    expect(normalizeGermanSalutation("Herr Marie-Claire Dupont")).toBe(
      "Herr Marie-Claire Dupont",
    );
  });

  it("handles empty / null / whitespace", () => {
    expect(normalizeGermanSalutation("")).toBe("");
    expect(normalizeGermanSalutation(null)).toBe("");
    expect(normalizeGermanSalutation(undefined)).toBe("");
    expect(normalizeGermanSalutation("   ")).toBe("");
  });

  it("is idempotent across every case", () => {
    const cases = [
      "Herr Max",
      "Herr Herr Max",
      "frau anna",
      "Max Mustermann",
      "Alex Taylor",
      "Herr Dr. Müller",
      "",
    ];
    for (const c of cases) {
      const once = normalizeGermanSalutation(c);
      expect(normalizeGermanSalutation(once)).toBe(once);
    }
  });
});

describe("salutation rendering stays consistent and never duplicates", () => {
  it("renderGreeting applies Herr/Frau exactly once", () => {
    expect(renderGreeting("Herr Max")).toBe("Sehr geehrter Herr Max,");
    expect(renderGreeting("Herr Herr Max")).toBe("Sehr geehrter Herr Max,");
    expect(renderGreeting("Frau Anna")).toBe("Sehr geehrte Frau Anna,");
    expect(renderGreeting("Frau Frau Anna")).toBe("Sehr geehrte Frau Anna,");
  });

  it("renderGreeting stays neutral for unknown or missing gender", () => {
    expect(renderGreeting("Max Mustermann")).toBe(GREETING_FALLBACK);
    expect(renderGreeting("Alex Taylor")).toBe(GREETING_FALLBACK);
    expect(renderGreeting(null)).toBe(GREETING_FALLBACK);
    expect(renderGreeting("")).toBe(GREETING_FALLBACK);
  });

  it("renderContactName keeps the explicit salutation without duplication", () => {
    expect(renderContactName("Herr Max")).toBe("Herr Max");
    expect(renderContactName("Herr Herr Max")).toBe("Herr Max");
    expect(renderContactName("Frau Anna")).toBe("Frau Anna");
    expect(renderContactName("Max Mustermann")).toBe("Max Mustermann");
  });
});
