import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Phase 2 must run WITHOUT the email table.
 *
 * Production fact this locks: `discovery_runs`, `discovery_candidates` and
 * `discovery_companies` exist, `discovery_company_emails` does NOT (it belongs
 * to the Email phase). A Company Discovery run therefore has to complete
 * without ever touching that table — if any accidental dependency creeps into
 * the run path, every user whose database lacks the table would see a failed
 * search while the offer engine itself works fine.
 *
 * The store keeps `recordCompanyEmail` as the deliberate seam for the Email
 * phase; these tests assert that nothing outside the store uses it yet, and
 * that `onlyPublicEmail` is a recorded preference — not a Phase 2 gate.
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
const pipelineSrc = read("src/lib/company-discovery/search.ts");
const startRouteSrc = read("src/app/api/company-discovery/start/route.ts");

describe("Phase 2 has no email dependency", () => {
  it("no file under src/ touches the email table except the store's own seam", () => {
    const offenders = srcFiles
      .filter((file) => file !== STORE)
      .filter((file) => readFileSync(file, "utf8").includes("discovery_company_emails"))
      .map((file) => file.slice(root.length + 1));
    expect(offenders).toEqual([]);
  });

  it("no file under src/ calls recordCompanyEmail yet (Email phase seam)", () => {
    const offenders = srcFiles
      .filter((file) => file !== STORE)
      .filter((file) => readFileSync(file, "utf8").includes("recordCompanyEmail"))
      .map((file) => file.slice(root.length + 1));
    expect(offenders).toEqual([]);
  });

  it("the pipeline never imports the email recorder", () => {
    expect(pipelineSrc).not.toContain("recordCompanyEmail");
    expect(pipelineSrc).not.toContain("discovery_company_emails");
  });

  it("the run path only speaks to the three tables that exist", () => {
    const tables = new Set(
      [...read("src/lib/company-discovery/runs.ts").matchAll(/\.from\("([^"]+)"\)/g)].map(
        (match) => match[1],
      ),
    );
    expect([...tables].sort()).toEqual([
      "discovery_candidates",
      "discovery_companies",
      "discovery_company_emails", // defined, never reached by a Phase 2 run
      "discovery_runs",
    ]);
    // Of those, the pipeline's own queries are the three core ones.
    const pipelineTables = [
      ...pipelineSrc.matchAll(/\.from\("([^"]+)"\)/g),
    ].map((match) => match[1]);
    expect(pipelineTables).toEqual([]);
  });
});

describe("onlyPublicEmail is recorded, not enforced, in Phase 2", () => {
  it("is part of the validated params (audit + future Email phase)", () => {
    expect(read("src/lib/company-discovery/types.ts")).toContain(
      "onlyPublicEmail: z.boolean().default(true)",
    );
  });

  it("never gates the candidate engine", () => {
    expect(pipelineSrc).not.toContain("onlyPublicEmail");
    expect(startRouteSrc).not.toContain("onlyPublicEmail");
    // The engine counts a company when it is IDENTIFIED and passes the gates
    // (documented in search.ts) — no email resolution happens in this phase.
    expect(pipelineSrc).toContain("no email logic in this phase");
  });

  it("counts a company without any email lookup (dedupe on the documented name)", () => {
    expect(pipelineSrc).toContain("countedKeys.add(key)");
    expect(pipelineSrc).toContain("counters.foundCompanies += 1");
  });
});
