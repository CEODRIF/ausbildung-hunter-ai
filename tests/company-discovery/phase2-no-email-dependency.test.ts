import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The email layer is additive, never load-bearing.
 *
 * Company Discovery shipped in production with `discovery_company_emails`
 * MISSING (the migration was only partially applied) while the three core
 * tables existed. That must stay survivable: a run has to keep counting and
 * storing companies even when the email table is absent, and an address must
 * only ever come from a published source — the run must never invent one to
 * fill the gap.
 *
 * These are the contracts this file locks:
 *   1. storing an address can never fail a run (guarded write, logged);
 *   2. `onlyPublicEmail` gates COUNTING (that is what it means), and a company
 *      dropped for a missing address is recorded with an audit reason;
 *   3. the pipeline reaches for the email table only through the store;
 *   4. the words that would indicate a fabricated address ("info@", a name as
 *      a host) appear nowhere in the resolution path.
 */

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const read = (relative: string) => readFileSync(resolve(root, relative), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

const STORE = resolve(root, "src/lib/company-discovery/runs.ts");
const srcFiles = walk(resolve(root, "src"));
const pipeline = read("src/lib/company-discovery/search.ts");
const emails = read("src/lib/company-discovery/emails.ts");

describe("a run survives a database without the email table", () => {
  it("guards the email write so a missing table cannot fail the run", () => {
    const write = pipeline.slice(
      pipeline.indexOf("if (emailResolution) {"),
      pipeline.indexOf("countedKeys.add(key)"),
    );
    expect(write).toContain("try {");
    expect(write).toContain("await recordCompanyEmail(");
    expect(write).toContain("catch (error)");
    expect(write).toContain("console.error(");
    // The company itself is recorded BEFORE the address is stored.
    expect(pipeline.indexOf("await recordCompany(runId, {")).toBeLessThan(
      pipeline.indexOf("await recordCompanyEmail("),
    );
  });

  it("touches the email table only through the store (no raw access)", () => {
    const offenders = srcFiles
      .filter((file) => file !== STORE && file !== resolve(root, "src/lib/company-discovery/emails.ts"))
      .filter((file) => readFileSync(file, "utf8").includes("discovery_company_emails"))
      .map((file) => file.slice(root.length + 1));
    expect(offenders).toEqual([]);
  });
});

describe("onlyPublicEmail gates counting, honestly", () => {
  it("counts a company only when the option allows it", () => {
    const gate = pipeline.slice(
      pipeline.indexOf("if (\n        !countsAsResult("),
      pipeline.indexOf("const { companyId } = await recordCompany"),
    );
    expect(gate).toContain("onlyPublicEmail: params.onlyPublicEmail");
    expect(gate).toContain("hasPublicEmail: emailResolution !== null");
    // Dropped for a missing address → recorded with an audit reason, not counted.
    expect(gate).toContain('rejectReason: NO_PUBLIC_EMAIL_REASON');
    expect(gate).toContain("continue;");
    expect(pipeline).toContain('const NO_PUBLIC_EMAIL_REASON = "no_public_email"');
  });

  it("never inflates the counters to reach the target", () => {
    // foundCompanies only ever increments on an accepted company.
    const increments = pipeline.match(/counters\.foundCompanies \+= 1;/g) ?? [];
    expect(increments).toHaveLength(1);
  });
});

describe("no fabricated addresses anywhere in the resolution path", () => {
  it("never builds an address from the company name or a fixed prefix", () => {
    // Comments explain the rule; only executable lines are inspected here.
    const code = emails
      .split("\n")
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join("\n");
    expect(code).not.toMatch(/["'`][\w.+-]+@/); // no hardcoded address literal
    expect(code).not.toMatch(/@\$\{|\$\{[^}]*\}@/); // no interpolated address
    expect(code).toContain("normalizeOpportunityEmail"); // only published values
  });

  it("derives a website only from published evidence", () => {
    expect(emails).toContain("companyWebsiteFromPublishedEmail");
    expect(emails).not.toMatch(/slugify|toLowerCase\(\)\.replace\(\/\[\^a-z\]\/g, ""\)\s*\+\s*"\.de"/);
    expect(read("src/lib/company-discovery/search.ts")).toContain(
      "websiteUrl: opp.enrichment?.website_url ?? null",
    );
  });

  it("keeps the fetch budget bounded per run", () => {
    expect(pipeline).toContain("MAX_EMAIL_SITE_PASSES_PER_RUN");
    expect(pipeline).toContain("fetchPages: emailSiteBudget > 0 ? fetchCompanySiteTextPages : null");
  });
});
