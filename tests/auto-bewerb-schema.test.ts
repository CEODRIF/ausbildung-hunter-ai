import { describe, expect, it } from "vitest";
import {
  AUTO_BEWERB_COMPANY_LIMIT,
  AUTO_BEWERB_EMAIL_TOKENS,
  AUTO_BEWERB_TABLES,
  adExtractSchema,
  classifyProbeError,
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

describe("schema probe (setup-pending honesty)", () => {
  it("checks exactly the seven tables the migration creates", () => {
    expect([...AUTO_BEWERB_TABLES]).toEqual([
      "auto_bewerb_profiles",
      "auto_bewerb_companies",
      "auto_bewerb_documents",
      "auto_bewerb_attachments",
      "auto_bewerb_company_attachments",
      "auto_bewerb_email_templates",
      "auto_bewerb_send_attempts",
    ]);
  });

  it("classifies 'relation not found' (incl. schema-cache lag) as missing tables", () => {
    expect(
      classifyProbeError({
        message: "Could not find a table named 'public.auto_bewerb_profiles' in the schema cache",
      }),
    ).toBe("missing");
    expect(classifyProbeError({ message: "42P01: relation public.auto_bewerb_companies does not exist" })).toBe(
      "missing",
    );
    expect(classifyProbeError({ message: 'Could not find the table "public.auto_bewerb_documents"' })).toBe(
      "missing",
    );
  });

  it("classifies column, permission and connectivity failures as blocked — never as missing", () => {
    // Regression: the old probe did select("id"), and two of the seven tables
    // (company_attachments: composite PK, email_templates: user_id PK) have no
    // id column → 42703 on a FULLY migrated database → permanent "setup pending".
    expect(classifyProbeError({ message: '42703: column "id" does not exist' })).toBe("blocked");
    expect(classifyProbeError({ message: "42501: permission denied for table auto_bewerb_companies" })).toBe(
      "blocked",
    );
    expect(classifyProbeError({ message: "fetch failed" })).toBe("blocked");
    expect(classifyProbeError(null)).toBe("blocked");
  });

  it("does not treat a missing UNRELATED relation as an AUTO BEWERB setup gap", () => {
    expect(classifyProbeError({ message: "42P01: relation public.studio_applications does not exist" })).toBe(
      "blocked",
    );
  });
});
