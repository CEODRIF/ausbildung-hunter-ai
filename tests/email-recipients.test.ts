import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  extractRecipientFromLine,
  isValidRecipientEmail,
  MAX_RECIPIENTS,
  normalizeRecipientEmail,
  parseRecipientInput,
} from "@/lib/email-recipients";
import { validateRecipientList } from "@/lib/application-drafts";
import {
  normalizeEmails,
  validateRecipients,
} from "@/components/recipient-manager";

/**
 * Email-list import contract (Email Sender / Email Composer).
 *
 * The bug: the old validator used /^[^\s@]+@[^\s@]+\.[^\s@]+$/, whose classes
 * accept ':', ';', ',' and '|'. A pasted "email:password" line therefore
 * validated as ONE address and was stored/sent WITH the password attached.
 *
 * These tests pin the rule: only the address is kept, everything after it is
 * dropped, and the address itself is never modified.
 */
const root = fileURLToPath(new URL("..", import.meta.url));

/** Source with comments stripped — the comment that DOCUMENTS the old regex
 *  legitimately quotes it, so only executable code may be asserted on. */
const codeOnly = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");

describe("the reported format: email:password", () => {
  it("keeps only the address", () => {
    expect(extractRecipientFromLine("melvin.loinette@windstream.net:Lake2018")).toBe(
      "melvin.loinette@windstream.net",
    );
    expect(extractRecipientFromLine("john.smith@gmail.com:Password123")).toBe(
      "john.smith@gmail.com",
    );
  });

  it("leaves a plain address untouched", () => {
    expect(extractRecipientFromLine("contact@company.de")).toBe("contact@company.de");
  });

  it("never returns the secret part", () => {
    for (const secret of ["Lake2018", "Password123", "abc123", "secret"]) {
      expect(extractRecipientFromLine(`user@example.com:${secret}`)).toBe(
        "user@example.com",
      );
    }
  });
});

describe("every common separator", () => {
  const cases: Array<[string, string, string]> = [
    ["colon", "email@example.com:password", "email@example.com"],
    ["semicolon", "email@example.com;password", "email@example.com"],
    ["comma", "email@example.com,password", "email@example.com"],
    ["pipe", "email@example.com|password", "email@example.com"],
    ["space", "email@example.com password", "email@example.com"],
    ["tab", "email@example.com\tpassword", "email@example.com"],
    ["plain", "email@example.com", "email@example.com"],
  ];

  it.each(cases)("%s", (_label, input, expected) => {
    expect(extractRecipientFromLine(input)).toBe(expected);
  });

  it("applies to a whole pasted list, one line at a time", () => {
    // Distinct addresses per line: the same address twice would be (correctly)
    // collapsed by the duplicate rule and not test the per-line handling.
    const pasted = [
      "one@example.com:password",
      "two@example.com;password",
      "three@example.com,password",
      "four@example.com|password",
      "five@example.com password",
      "six@example.com",
    ].join("\n");
    expect(parseRecipientInput(pasted).emails).toEqual([
      "one@example.com",
      "two@example.com",
      "three@example.com",
      "four@example.com",
      "five@example.com",
      "six@example.com",
    ]);
    expect(parseRecipientInput(pasted).skipped).toBe(0);
  });
});

describe("normalization rules", () => {
  it("trims leading and trailing whitespace", () => {
    expect(extractRecipientFromLine("  email@example.com:password  ")).toBe(
      "email@example.com",
    );
    expect(extractRecipientFromLine("\temail@example.com\t")).toBe("email@example.com");
  });

  it("lowercases for storage without altering the address structure", () => {
    expect(extractRecipientFromLine("EMAIL@EXAMPLE.COM:password")).toBe(
      "email@example.com",
    );
    expect(extractRecipientFromLine("John.Smith@Gmail.COM:Pass")).toBe(
      "john.smith@gmail.com",
    );
    // Plus-addressing and dots in the local part survive untouched.
    expect(extractRecipientFromLine("first.last+ausbildung@example.co.uk:pw")).toBe(
      "first.last+ausbildung@example.co.uk",
    );
  });

  it("removes duplicates case-insensitively", () => {
    const parsed = parseRecipientInput(
      ["duplicate@example.com:one", "DUPLICATE@example.com:two", "Duplicate@Example.com:three"].join("\n"),
    );
    expect(parsed.emails).toEqual(["duplicate@example.com"]);
  });

  it("ignores empty lines and lines without a valid address", () => {
    const parsed = parseRecipientInput(
      ["valid@example.com", "", "   ", "invalid-line", "no-at-sign.com", "@nope.com", "a@b", "x@y."].join("\n"),
    );
    expect(parsed.emails).toEqual(["valid@example.com"]);
    expect(parsed.skipped).toBe(5);
  });

  it("handles CRLF, a BOM and a trailing newline", () => {
    const parsed = parseRecipientInput("\uFEFFa@example.com:pw\r\nb@example.com\r\n");
    expect(parsed.emails).toEqual(["a@example.com", "b@example.com"]);
  });

  it("keeps peer addresses on one line (existing paste behaviour preserved)", () => {
    expect(parseRecipientInput("a@example.com, b@example.com").emails).toEqual([
      "a@example.com",
      "b@example.com",
    ]);
    expect(parseRecipientInput("a@example.com; b@example.com").emails).toEqual([
      "a@example.com",
      "b@example.com",
    ]);
  });

  it("understands the address-book form", () => {
    expect(extractRecipientFromLine('"John Smith" <john@example.com>')).toBe(
      "john@example.com",
    );
    expect(extractRecipientFromLine("John Smith <john@example.com>:pw")).toBe(
      "john@example.com",
    );
  });

  it("caps the list length", () => {
    const many = Array.from({ length: MAX_RECIPIENTS + 25 }, (_, i) => `u${i}@example.com`);
    const parsed = parseRecipientInput(many.join("\n"));
    expect(parsed.emails).toHaveLength(MAX_RECIPIENTS);
    expect(parsed.truncated).toBe(true);
  });
});

describe("the full example from the report", () => {
  const input = [
    "melvin.loinette@windstream.net:Lake2018",
    "john.smith@gmail.com:Password123",
    "contact@company.de",
    "admin@company.com|secret",
    "hello@yahoo.com,password",
    "invalid-line",
  ].join("\n");

  it("yields exactly the five expected recipients", () => {
    expect(parseRecipientInput(input).emails).toEqual([
      "melvin.loinette@windstream.net",
      "john.smith@gmail.com",
      "contact@company.de",
      "admin@company.com",
      "hello@yahoo.com",
    ]);
  });

  it("no password fragment survives anywhere in the result", () => {
    const joined = parseRecipientInput(input).emails.join(" ");
    for (const secret of ["Lake2018", "Password123", "secret", "password"]) {
      expect(joined.toLowerCase()).not.toContain(secret.toLowerCase());
    }
  });
});

describe("validity grammar", () => {
  it("accepts real addresses", () => {
    for (const email of [
      "a@example.com",
      "first.last@example.co.uk",
      "user+tag@example.com",
      "user_name@example-domain.de",
      "info@ex-ample.com",
    ]) {
      expect(isValidRecipientEmail(email), email).toBe(true);
    }
  });

  it("rejects addresses carrying a suffix or malformed parts", () => {
    for (const value of [
      "a@b.com:pw",
      "a@b.com;pw",
      "a@b.com,pw",
      "a@b.com|pw",
      "a@b.com pw",
      "a@b",
      "a@.com",
      "a@b.",
      "@b.com",
      "a@b.com.",
      ".a@b.com",
      "a..b@c.com",
      "",
    ]) {
      expect(isValidRecipientEmail(value), value).toBe(false);
    }
  });

  it("rejects an over-long address", () => {
    expect(isValidRecipientEmail(`${"a".repeat(70)}@example.com`)).toBe(false);
    expect(isValidRecipientEmail(`${"a".repeat(250)}@example.com`)).toBe(false);
  });
});

describe("server-side gate: the password never reaches storage", () => {
  it("stores only the address for a polluted entry", () => {
    const [recipient] = validateRecipientList([
      { email: "melvin.loinette@windstream.net:Lake2018" },
    ]);
    expect(recipient).toEqual({
      email: "melvin.loinette@windstream.net",
      company_name: null,
      validation_status: "valid",
    });
  });

  it("handles the whole reported list", () => {
    const rows = validateRecipientList(
      [
        "melvin.loinette@windstream.net:Lake2018",
        "john.smith@gmail.com:Password123",
        "contact@company.de",
        "admin@company.com|secret",
      ].map((email) => ({ email })),
    );
    expect(rows.map((row) => row.email)).toEqual([
      "melvin.loinette@windstream.net",
      "john.smith@gmail.com",
      "contact@company.de",
      "admin@company.com",
    ]);
    expect(rows.every((row) => row.validation_status === "valid")).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("Lake2018");
    expect(JSON.stringify(rows)).not.toContain("Password123");
    expect(JSON.stringify(rows)).not.toContain("secret");
  });

  it("marks duplicates and unparseable entries, without storing them as valid", () => {
    const rows = validateRecipientList([
      { email: "a@example.com:one" },
      { email: "A@EXAMPLE.COM:two" },
      { email: "invalid-line" },
    ]);
    expect(rows.map((row) => row.validation_status)).toEqual([
      "valid",
      "duplicate",
      "invalid",
    ]);
    expect(rows[0].email).toBe("a@example.com");
  });

  it("keeps the company name behaviour", () => {
    const [row] = validateRecipientList([
      { email: "hr@company.de:pw", companyName: "  ACME GmbH  " },
    ]);
    expect(row.email).toBe("hr@company.de");
    expect(row.company_name).toBe("ACME GmbH");
  });
});

describe("client-side input paths use the same layer", () => {
  it("paste path: normalizeEmails strips the suffix", () => {
    expect(normalizeEmails("melvin.loinette@windstream.net:Lake2018")).toEqual([
      "melvin.loinette@windstream.net",
    ]);
    expect(normalizeEmails("a@example.com:1\nb@example.com:2")).toEqual([
      "a@example.com",
      "b@example.com",
    ]);
  });

  it("paste path: validateRecipients marks the cleaned address valid", () => {
    const result = validateRecipients(["user@example.com:secret"]);
    expect(result).toEqual([{ email: "user@example.com", status: "valid" }]);
  });

  it("paste path: duplicates against already-added recipients are flagged", () => {
    const result = validateRecipients(
      ["USER@example.com:other"],
      [{ email: "user@example.com", status: "valid" }],
    );
    expect(result).toEqual([{ email: "user@example.com", status: "duplicate" }]);
  });

  it("file path: the import runs every cell through the shared layer", () => {
    const source = readFileSync(
      `${root}/src/components/recipient-manager.tsx`,
      "utf8",
    );
    expect(source).toContain("normalizeRecipientEmail(cell)");
    // The old permissive regex must be gone from the component.
    expect(source).not.toContain("const emailPattern");
    expect(source).not.toContain("[^\\s@]+@[^\\s@]+");
  });

  it("the old permissive regex is gone from the server validator too", () => {
    const source = readFileSync(`${root}/src/lib/application-drafts.ts`, "utf8");
    expect(source).toContain("normalizeRecipientEmail(recipient.email)");
    const code = codeOnly(source);
    expect(code).not.toContain("[^\\s@]+@[^\\s@]+");
    expect(code).not.toMatch(/\.test\(\s*email\s*\)/);
  });
});

describe("security: no credentials in logs", () => {
  it("the shared module performs no logging at all", () => {
    const source = readFileSync(`${root}/src/lib/email-recipients.ts`, "utf8");
    expect(source).not.toMatch(/console\.(log|info|warn|error|debug)/);
    expect(source).not.toContain("process.env");
    expect(source).not.toContain('import "server-only"');
  });

  it("does not log the raw line in the two call sites", () => {
    for (const file of [
      "src/components/recipient-manager.tsx",
      "src/lib/application-drafts.ts",
    ]) {
      const source = readFileSync(`${root}/${file}`, "utf8");
      // Nothing may log a recipient value.
      expect(source).not.toMatch(/console\.\w+\([^)]*recipient/i);
    }
  });
});

describe("normalizeRecipientEmail (single value)", () => {
  it("returns null when there is no address", () => {
    expect(normalizeRecipientEmail("invalid-line")).toBeNull();
    expect(normalizeRecipientEmail("")).toBeNull();
    expect(normalizeRecipientEmail("password-only")).toBeNull();
  });

  it("returns the first address of a polluted value", () => {
    expect(normalizeRecipientEmail("keep@example.com:drop@example.com")).toBe(
      "keep@example.com",
    );
  });
});
