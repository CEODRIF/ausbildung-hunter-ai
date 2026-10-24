import { describe, expect, it } from "vitest";

import {
  BEW_MAX_COUNT,
  BEW_MIN_COUNT,
  BEW_NEUTRAL_GREETING,
  assembleLetter,
  autoMapColumns,
  buildCompanyRow,
  buildImportResult,
  buildSampleCsvTemplate,
  buildSubject,
  computeSendPlan,
  isValidEmail,
  mergeColumnMapping,
  normalizeEmail,
  parseCompaniesCsv,
  parsePdfCompanyCandidates,
  recordsFromCsvMatrix,
  suggestCompanyNameFromEmail,
  validateCompanyCount,
} from "@/lib/bewerbung-automation";

describe("validateCompanyCount", () => {
  it("accepts the full valid range 1..100", () => {
    expect(validateCompanyCount(BEW_MIN_COUNT)).toEqual({ ok: true, value: 1 });
    expect(validateCompanyCount(50)).toEqual({ ok: true, value: 50 });
    expect(validateCompanyCount(BEW_MAX_COUNT)).toEqual({ ok: true, value: 100 });
  });

  it("accepts a numeric string (browser form value)", () => {
    expect(validateCompanyCount("42")).toEqual({ ok: true, value: 42 });
    expect(validateCompanyCount(" 7 ")).toEqual({ ok: true, value: 7 });
  });

  it("rejects values below the minimum", () => {
    expect(validateCompanyCount(0)).toMatchObject({ ok: false, error: "too-small" });
    expect(validateCompanyCount(-3)).toMatchObject({ ok: false, error: "too-small" });
  });

  it("rejects values above the maximum", () => {
    expect(validateCompanyCount(101)).toMatchObject({ ok: false, error: "too-large" });
    expect(validateCompanyCount(1000)).toMatchObject({ ok: false, error: "too-large" });
  });

  it("rejects non-integers and non-numbers", () => {
    expect(validateCompanyCount(1.5)).toMatchObject({ ok: false, error: "not-integer" });
    expect(validateCompanyCount("abc")).toMatchObject({ ok: false, error: "not-integer" });
    expect(validateCompanyCount(NaN)).toMatchObject({ ok: false, error: "not-integer" });
  });

  it("rejects empty / null / undefined", () => {
    expect(validateCompanyCount("")).toMatchObject({ ok: false, error: "empty" });
    expect(validateCompanyCount(null)).toMatchObject({ ok: false, error: "empty" });
    expect(validateCompanyCount(undefined)).toMatchObject({ ok: false, error: "empty" });
  });
});

describe("isValidEmail", () => {
  it("accepts normal addresses and is case/space-insensitive", () => {
    expect(isValidEmail("jobs@example-gmbh.de")).toBe(true);
    expect(isValidEmail("  HR@TEST.AG ")).toBe(true);
  });
  it("rejects malformed addresses", () => {
    expect(isValidEmail("")).toBe(false);
    expect(isValidEmail("nope")).toBe(false);
    expect(isValidEmail("a@b")).toBe(false); // needs a TLD
    expect(isValidEmail("a b@c.de")).toBe(false); // space
  });
  it("normalizeEmail lower-cases and trims", () => {
    expect(normalizeEmail("  A@B.DE ")).toBe("a@b.de");
  });
});

describe("parseCompaniesCsv", () => {
  it("parses a simple header + data matrix", () => {
    const rows = parseCompaniesCsv("a,b,c\n1,2,3\n4,5,6");
    expect(rows).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
      ["4", "5", "6"],
    ]);
  });

  it("handles quoted fields with embedded commas", () => {
    const rows = parseCompaniesCsv('name,email\n"Muster, GmbH",a@b.de');
    expect(rows[1]).toEqual(["Muster, GmbH", "a@b.de"]);
  });

  it("handles escaped double-quotes and embedded newlines", () => {
    const rows = parseCompaniesCsv('a\n"line1\nline2"');
    expect(rows[1]).toEqual(["line1\nline2"]);
  });

  it("strips a leading UTF-8 BOM", () => {
    const rows = parseCompaniesCsv("\ufeffcompany,email\nx,y");
    expect(rows[0][0]).toBe("company");
  });

  it("returns [] for empty input and drops trailing blank rows", () => {
    expect(parseCompaniesCsv("")).toEqual([]);
    expect(parseCompaniesCsv("a,b\n1,2\n\n")).toHaveLength(2);
  });

  it("handles CRLF line endings", () => {
    const rows = parseCompaniesCsv("a,b\r\n1,2\r\n3,4");
    expect(rows).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });
});

describe("autoMapColumns", () => {
  it("detects German + English headers case-insensitively", () => {
    const mapping = autoMapColumns(["Firma", "E-Mail", "Ansprechpartner", "Straße"]);
    expect(mapping.companyName).toBe(0);
    expect(mapping.companyEmail).toBe(1);
    expect(mapping.contactName).toBe(2);
    expect(mapping.companyAddress).toBe(3);
  });

  it("first matching column wins per field (no double-map)", () => {
    const mapping = autoMapColumns(["name", "company", "email"]);
    expect(mapping.companyName).toBe(0); // "name" wins
    expect(mapping.companyEmail).toBe(2);
  });

  it("leaves fields unmapped when no header matches", () => {
    const mapping = autoMapColumns(["foo", "bar"]);
    expect(mapping).toEqual({});
  });
});

describe("mergeColumnMapping", () => {
  it("explicit override wins over auto-detection", () => {
    const merged = mergeColumnMapping({ companyName: 0 }, { companyName: 2 });
    expect(merged.companyName).toBe(2);
  });
  it("keeps auto values for fields the user did not override", () => {
    const merged = mergeColumnMapping(
      { companyName: 0, companyEmail: 1 },
      { companyEmail: 3 },
    );
    expect(merged.companyName).toBe(0);
    expect(merged.companyEmail).toBe(3);
  });
});

describe("recordsFromCsvMatrix", () => {
  it("maps data rows to field records and skips blank rows", () => {
    const matrix = parseCompaniesCsv(
      "company_name,company_email,contact_name\nACME,hr@acme.de,Dr. X\n,,\nGLOBE,job@globe.de,",
    );
    const records = recordsFromCsvMatrix(
      matrix,
      autoMapColumns(matrix[0]),
    );
    expect(records).toEqual([
      { companyName: "ACME", companyEmail: "hr@acme.de", contactName: "Dr. X", companyAddress: "" },
      { companyName: "GLOBE", companyEmail: "job@globe.de", contactName: "", companyAddress: "" },
    ]);
  });
  it("returns [] when there is no data row", () => {
    expect(recordsFromCsvMatrix([["a", "b"]], autoMapColumns(["a", "b"]))).toEqual([]);
  });
});

describe("suggestCompanyNameFromEmail", () => {
  it("derives a suggestion from a plain corporate domain", () => {
    expect(suggestCompanyNameFromEmail("jobs@example-gmbh.de")).toBe("Example Gmbh");
  });
  it("never suggests a name for free-mail providers", () => {
    expect(suggestCompanyNameFromEmail("user@gmail.com")).toBeNull();
    expect(suggestCompanyNameFromEmail("user@web.de")).toBeNull();
  });
});

describe("buildCompanyRow", () => {
  it("is valid when email + name are present", () => {
    const row = buildCompanyRow(1, {
      companyName: "ACME",
      companyEmail: "hr@acme.de",
      contactName: "Herr X",
    });
    expect(row.valid).toBe(true);
    expect(row.problems).toEqual([]);
  });
  it("flags a missing e-mail", () => {
    const row = buildCompanyRow(1, { companyName: "ACME", companyEmail: "" });
    expect(row.valid).toBe(false);
    expect(row.problems.some((p) => p.startsWith("company_email"))).toBe(true);
  });
  it("flags an invalid e-mail", () => {
    const row = buildCompanyRow(1, { companyName: "ACME", companyEmail: "bad" });
    expect(row.valid).toBe(false);
  });
  it("suggests + flags a missing company name (never silently accepts)", () => {
    const row = buildCompanyRow(1, { companyName: "", companyEmail: "hr@acme.de" });
    expect(row.companyName).toBe("Acme");
    expect(row.valid).toBe(false); // still flagged for confirmation
    expect(row.problems.some((p) => p.startsWith("company_name"))).toBe(true);
  });
  it("does not suggest a name for free-mail (leaves it missing)", () => {
    const row = buildCompanyRow(1, { companyName: "", companyEmail: "a@gmail.com" });
    expect(row.companyName).toBe("");
    expect(row.valid).toBe(false);
  });
});

describe("buildImportResult", () => {
  const records = [
    { companyName: "ACME", companyEmail: "hr@acme.de" },
    { companyName: "GLOBE", companyEmail: "job@globe.de" },
    { companyName: "ACME", companyEmail: "hr@acme.de" }, // duplicate
    { companyName: "", companyEmail: "bad" }, // invalid email, missing name
  ];

  it("preserves every row (never silently discards)", () => {
    const result = buildImportResult(records, 1);
    expect(result.rows).toHaveLength(4);
  });

  it("numbers rows sequentially from startSeq", () => {
    const result = buildImportResult(records, 10);
    expect(result.rows.map((r) => r.seq)).toEqual([10, 11, 12, 13]);
  });

  it("detects duplicate e-mails", () => {
    const result = buildImportResult(records, 1);
    expect(result.duplicateEmails).toEqual(["hr@acme.de"]);
  });

  it("counts valid rows and invalid e-mails", () => {
    const result = buildImportResult(records, 1);
    // Rows 1,2,3 are individually valid (the 3rd is a duplicate of the 1st,
    // which is reported via duplicateEmails, not as an invalid row). Row 4 is invalid.
    expect(result.validCount).toBe(3);
    expect(result.invalidEmailCount).toBe(1);
  });

  it("collects per-row errors", () => {
    const result = buildImportResult(records, 1);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.row === 4 && e.field === "company_email")).toBe(true);
  });
});

describe("buildSampleCsvTemplate", () => {
  it("round-trips through the CSV parser with 4 columns", () => {
    const matrix = parseCompaniesCsv(buildSampleCsvTemplate());
    expect(matrix[0]).toEqual([
      "company_name",
      "company_email",
      "contact_name",
      "company_address",
    ]);
    expect(matrix.length).toBeGreaterThanOrEqual(2);
  });
});

describe("computeSendPlan", () => {
  it("sends everything when quota is plenty", () => {
    const plan = computeSendPlan({ requested: 20, remaining: 500 });
    expect(plan.batch).toBe(20);
    expect(plan.deferred).toBe(0);
    expect(plan.overLimit).toBe(false);
  });

  it("clamps to the remaining quota (binding=quota)", () => {
    const plan = computeSendPlan({ requested: 50, remaining: 35 });
    expect(plan.batch).toBe(35);
    expect(plan.deferred).toBe(15);
    expect(plan.overLimit).toBe(true);
    expect(plan.binding).toBe("quota");
  });

  // M4 regression (P0 quota audit 2026-10-25): the fixed 100/day platform
  // cap must NOT truncate plans whose canonical quota is higher.
  it("no longer truncates a 250-allowance plan at 100 (M4)", () => {
    const plan = computeSendPlan({ requested: 100, remaining: 250 });
    expect(plan.batch).toBe(100);
    expect(plan.deferred).toBe(0);
    expect(plan.overLimit).toBe(false);
    expect(plan.binding).toBe("requested");
  });

  it("no longer truncates a 500-allowance plan at 100 (M4)", () => {
    const plan = computeSendPlan({ requested: 100, remaining: 500 });
    expect(plan.batch).toBe(100);
    expect(plan.overLimit).toBe(false);
  });

  it("never sends more than requested", () => {
    const plan = computeSendPlan({ requested: 5, remaining: 500 });
    expect(plan.batch).toBe(5);
  });

  it("returns 0 batch when quota is exhausted", () => {
    const plan = computeSendPlan({ requested: 10, remaining: 0 });
    expect(plan.batch).toBe(0);
    expect(plan.overLimit).toBe(true);
  });
});

describe("buildSubject", () => {
  it("matches the existing template subjects per purpose", () => {
    expect(buildSubject("ausbildung", "ACME")).toBe(
      "Bewerbung um einen Ausbildungsplatz bei ACME",
    );
    expect(buildSubject("arbeit", "ACME")).toBe("Bewerbung bei ACME");
    expect(buildSubject("praktikum", "ACME")).toBe(
      "Bewerbung um ein Praktikum bei ACME",
    );
  });
  it("falls back to a neutral company phrase", () => {
    expect(buildSubject("ausbildung", "  ")).toBe(
      "Bewerbung um einen Ausbildungsplatz bei Ihrem Unternehmen",
    );
  });
});

describe("assembleLetter", () => {
  it("uses the neutral greeting when no contact name is provided", () => {
    const letter = assembleLetter({ aiBody: "Text.", contactName: null, signature: "Max" });
    expect(letter.greeting).toBe(BEW_NEUTRAL_GREETING);
    expect(letter.bodyHtml).toContain(BEW_NEUTRAL_GREETING);
  });

  it("personalizes the greeting only with an explicit Herr/Frau", () => {
    const male = assembleLetter({ aiBody: "Text.", contactName: "Herr Schmidt", signature: "Max" });
    expect(male.greeting).toBe("Sehr geehrter Herr Schmidt,");
    const female = assembleLetter({ aiBody: "Text.", contactName: "Frau Dr. Meyer", signature: "Max" });
    expect(female.greeting).toBe("Sehr geehrte Frau Dr. Meyer,");
    // A bare name without Herr/Frau must NOT invent a gendered greeting.
    const bare = assembleLetter({ aiBody: "Text.", contactName: "Musterfrau", signature: "Max" });
    expect(bare.greeting).toBe(BEW_NEUTRAL_GREETING);
  });

  it("appends the profile signature and a closing", () => {
    const letter = assembleLetter({ aiBody: "Text.", contactName: null, signature: "Mustapha Drif" });
    expect(letter.bodyHtml).toContain("Mit freundlichen Grüßen");
    expect(letter.bodyHtml).toContain("Mustapha Drif");
  });

  it("escapes AI body content (no raw markup injection)", () => {
    const letter = assembleLetter({
      aiBody: "<script>alert(1)</script>",
      contactName: null,
      signature: "Max",
    });
    expect(letter.bodyHtml).not.toContain("<script>");
    expect(letter.bodyHtml).toContain("&lt;script&gt;");
  });

  it("splits the AI body into distinct paragraphs", () => {
    const letter = assembleLetter({
      aiBody: "Absatz eins.\n\nAbsatz zwei.",
      contactName: null,
      signature: "Max",
    });
    expect(letter.bodyHtml).toContain("<p>Absatz eins.</p>");
    expect(letter.bodyHtml).toContain("<p>Absatz zwei.</p>");
  });

  it("produces a unique letter per company (body reflects the given text)", () => {
    const a = assembleLetter({ aiBody: "Ich bewerbe mich bei ACME.", contactName: null, signature: "Max" });
    const b = assembleLetter({ aiBody: "Ich bewerbe mich bei GLOBE.", contactName: null, signature: "Max" });
    expect(a.bodyHtml).not.toBe(b.bodyHtml);
    expect(a.bodyHtml).toContain("ACME");
    expect(b.bodyHtml).toContain("GLOBE");
  });
});

describe("parsePdfCompanyCandidates (best-effort PDF import)", () => {
  it("extracts one candidate per line containing an e-mail, pairing name from the SAME line", () => {
    const text = [
      "Example GmbH jobs@example.de",
      "Test AG personal@test-ag.de",
      "no e-mail on this line at all",
      "Third UG jobs@third-ug.de",
    ].join("\n");
    const out = parsePdfCompanyCandidates(text);
    expect(out).toHaveLength(3);
    // The name is taken from the text LEFT of the e-mail on the same line —
    // never from a different line (no cross-line guessing).
    expect(out[0]).toEqual({ email: "jobs@example.de", companyName: "Example GmbH" });
    expect(out[1]).toEqual({ email: "personal@test-ag.de", companyName: "Test AG" });
    expect(out[2]).toEqual({ email: "jobs@third-ug.de", companyName: "Third UG" });
  });

  it("collapses duplicate e-mails (first occurrence wins)", () => {
    const text = [
      "Example GmbH jobs@example.de",
      "Example GmbH again jobs@example.de",
      "Other GmbH other@example.de",
    ].join("\n");
    const out = parsePdfCompanyCandidates(text);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ email: "jobs@example.de", companyName: "Example GmbH" });
    expect(out[1]).toEqual({ email: "other@example.de", companyName: "Other GmbH" });
  });

  it("skips invalid e-mail-looking tokens and keeps a valid one later on the line", () => {
    const text = [
      "invalid @ not-an-address Example GmbH good@valid.de",
    ].join("\n");
    const out = parsePdfCompanyCandidates(text);
    // "invalid @ not-an-address" is not a valid e-mail; only good@valid.de is.
    expect(out).toHaveLength(1);
    expect(out[0].email).toBe("good@valid.de");
  });

  it("strips bullets / numbering / leading separators from the name proposal", () => {
    const text = [
      "1. Example GmbH jobs@example.de",
      "• Test AG personal@test-ag.de",
      "- Third UG jobs@third-ug.de",
    ].join("\n");
    const out = parsePdfCompanyCandidates(text);
    expect(out[0].companyName).toBe("Example GmbH");
    expect(out[1].companyName).toBe("Test AG");
    expect(out[2].companyName).toBe("Third UG");
  });

  it("returns an empty name (never invents one) when the line is only an e-mail", () => {
    const text = ["jobs@example.de"].join("\n");
    const out = parsePdfCompanyCandidates(text);
    expect(out).toHaveLength(1);
    expect(out[0].companyName).toBe("");
  });

  it("caps output at the campaign maximum (100)", () => {
    const lines = Array.from(
      { length: 150 },
      (_, i) => `Company ${i} jobs${i}@company${i}.de`,
    );
    const out = parsePdfCompanyCandidates(lines.join("\n"));
    expect(out).toHaveLength(100);
  });

  it("uses only the FIRST e-mail on a line and ignores extra ones", () => {
    const text = "Example GmbH first@example.de second@example.de";
    const out = parsePdfCompanyCandidates(text);
    expect(out).toHaveLength(1);
    expect(out[0].email).toBe("first@example.de");
    expect(out[0].companyName).toBe("Example GmbH");
  });
});
