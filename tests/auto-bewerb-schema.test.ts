import { describe, expect, it } from "vitest";
import {
  AUTO_BEWERB_COMPANY_LIMIT,
  AUTO_BEWERB_TABLES,
  adExtractSchema,
  classifyProbeError,
  isValidEmail,
  normalizeCompanyKey,
  resolveAutoBewerbRecipient,
  type AdExtract,
} from "@/lib/auto-bewerb/schema";

/**
 * Focused AUTO BEWERB tests — the pure contract functions the workflow and
 * the send path rely on (verified recipient resolution, dedupe keys,
 * recipient validation, company cap).
 */

const extract = (partial: Partial<AdExtract> = {}): AdExtract =>
  adExtractSchema.parse(partial);

describe("AUTO_BEWERB_COMPANY_LIMIT", () => {
  it("caps the workflow at 100 companies (global across all campaigns)", () => {
    expect(AUTO_BEWERB_COMPANY_LIMIT).toBe(100);
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

describe("resolveAutoBewerbRecipient (verified delivery destination)", () => {
  it("an explicit GLOBAL recipient applies to every company (identical)", () => {
    const exs = [
      extract({ applicationEmail: "a@firma-a.de" }),
      extract({ applicationEmail: "b@firma-b.de" }),
      extract({ applicationEmail: "c@firma-c.de" }),
    ];
    for (const ex of exs) {
      expect(resolveAutoBewerbRecipient("zentral@postbox.de", "legacy@row.de", ex)).toBe("zentral@postbox.de");
    }
  });
  it("without a global recipient: the legacy per-company value wins", () => {
    expect(resolveAutoBewerbRecipient("", " Legacy@Row.de ", extract({ applicationEmail: "a@firma-a.de" }))).toBe(
      "legacy@row.de",
    );
  });
  it("without global or legacy: the VERIFIED application email from the ad", () => {
    const ex = extract({ company: "Firma AG", applicationEmail: "  bewerbung@firma-ag.de " });
    expect(resolveAutoBewerbRecipient("", null, ex)).toBe("bewerbung@firma-ag.de");
    expect(resolveAutoBewerbRecipient("  ", "", null)).toBe(""); // nothing invented
  });
  it("null/undefined inputs are safe (never crash, never invent)", () => {
    expect(resolveAutoBewerbRecipient(null, null, null)).toBe("");
    expect(resolveAutoBewerbRecipient(undefined, undefined, extract({}))).toBe("");
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
