import { describe, expect, it } from "vitest";
import {
  AUTO_BEWERB_COMPANY_LIMIT,
  AUTO_BEWERB_EMAIL_TOKENS,
  adExtractSchema,
  isValidEmail,
  normalizeCompanyKey,
  renderAutoBewerbEmailBody,
  type AdExtract,
} from "@/lib/auto-bewerb/schema";

/**
 * Focused AUTO BEWERB tests — the pure contract functions the workflow and
 * the send path rely on (no-invention token rendering, dedupe keys,
 * recipient validation, company cap).
 */

const extract = (partial: Partial<AdExtract> = {}): AdExtract =>
  adExtractSchema.parse(partial);

describe("AUTO_BEWERB_COMPANY_LIMIT", () => {
  it("caps the workflow at 10 companies", () => {
    expect(AUTO_BEWERB_COMPANY_LIMIT).toBe(10);
  });
});

describe("normalizeCompanyKey (dedupe)", () => {
  it("is case- and punctuation-insensitive", () => {
    expect(normalizeCompanyKey("  BMW AG ")).toBe(normalizeCompanyKey("bmw-ag"));
    expect(normalizeCompanyKey("Siemens & Co.")).toBe(normalizeCompanyKey("siemens co"));
  });
  it("keeps umlauts distinguishable from ASCII", () => {
    expect(normalizeCompanyKey("Müller GmbH")).toBe("müller gmbh");
    expect(normalizeCompanyKey("Mueller GmbH")).toBe("mueller gmbh");
    expect(normalizeCompanyKey("Müller GmbH")).not.toBe(normalizeCompanyKey("Mueller GmbH"));
  });
});

describe("renderAutoBewerbEmailBody (no-invention token substitution)", () => {
  it("substitutes all three tokens from the stored extraction", () => {
    const ex = extract({ company: "Firma AG", jobTitle: "Auszubildende:r", contactPerson: "Max Mustermann" });
    expect(renderAutoBewerbEmailBody("Sehr geehrte:r {contactName}, Firma: {company}, Stelle: {position}", ex)).toBe(
      "Sehr geehrte:r Max Mustermann, Firma: Firma AG, Stelle: Auszubildende:r",
    );
  });
  it("falls back to occupation when jobTitle is empty", () => {
    const ex = extract({ company: "X", occupation: "Kaufmann" });
    expect(renderAutoBewerbEmailBody("{position}", ex)).toBe("Kaufmann");
  });
  it("replaces missing values with an empty string — never invents", () => {
    expect(renderAutoBewerbEmailBody("Hallo {company}, {contactName}!", extract({}))).toBe("Hallo , !");
  });
  it("is case-insensitive on the token name", () => {
    expect(renderAutoBewerbEmailBody("{COMPANY}", extract({ company: "Y" }))).toBe("Y");
  });
});

describe("AUTO_BEWERB_EMAIL_TOKENS", () => {
  it("documents exactly the tokens the renderer substitutes", () => {
    expect(AUTO_BEWERB_EMAIL_TOKENS).toEqual(["{company}", "{position}", "{contactName}"]);
  });
});

describe("isValidEmail (recipient validation)", () => {
  it("accepts a normal address", () => {
    expect(isValidEmail("bewerbung@firma.de")).toBe(true);
  });
  it("rejects missing domain parts, whitespace and overlong values", () => {
    expect(isValidEmail("no-at-sign")).toBe(false);
    expect(isValidEmail("a@b")).toBe(false);
    expect(isValidEmail(" a@b.co ")).toBe(true); // trimmed
    expect(isValidEmail(`x@${"y".repeat(330)}.com`)).toBe(false); // > 320 chars
  });
});
