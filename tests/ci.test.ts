import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function read(path: string): string {
  return readFileSync(resolve(root, path), "utf8");
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Phase 9 — CI & deployment integrity guards.
 *
 * These tests protect the deployment contract without running CI itself:
 *  1. Every env var used in code is documented in `.env.example` (no silent
 *     configuration drift between code and deployment docs).
 *  2. `.env.example` contains placeholders only — never real-looking secrets.
 *  3. The CI workflow exists, pins the right Node major, and runs the full
 *     validation gate (typecheck, lint, tests, build) with `npm ci`.
 *  4. `package.json` pins the Node major the CI workflow assumes.
 */
describe("environment documentation (deployment contract)", () => {
  it("every process.env var in src is documented in .env.example", () => {
    const used = new Set<string>();
    for (const file of listSourceFiles(join(root, "src"))) {
      const content = readFileSync(file, "utf8");
      for (const match of content.matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
        used.add(match[1]);
      }
    }
    // Provided by Next.js itself, not by deployment configuration.
    used.delete("NODE_ENV");

    const example = read(".env.example");
    const documented = new Set<string>();
    for (const line of example.split("\n")) {
      const match = line.match(/^([A-Z0-9_]+)=/);
      if (match) documented.add(match[1]);
    }

    const missing = [...used].filter((name) => !documented.has(name)).sort();
    expect(
      missing,
      `process.env vars used in src but missing from .env.example: ${missing.join(", ")}`,
    ).toEqual([]);
    // Sanity: the example is not accidentally empty.
    expect(documented.size).toBeGreaterThan(10);
  });

  it("no real-looking secrets are committed in .env.example", () => {
    const example = read(".env.example");
    const lines = example
      .split("\n")
      .filter((line) => /^([A-Z0-9_]+)=/.test(line));
    expect(lines.length).toBeGreaterThan(10);
    for (const line of lines) {
      const name = line.slice(0, line.indexOf("="));
      const value = line.slice(line.indexOf("=") + 1).trim();
      // Placeholder conventions: "your-…", "replace-…", localhost redirects,
      // a documented public API base URL, the provider label, or the
      // documented public BA client id.
      const isPlaceholder =
        value === "" ||
        value.startsWith("your-") ||
        value.startsWith("replace-") ||
        value === "jobboerse-jobsuche" ||
        value.startsWith("http://localhost") ||
        value.startsWith("https://api.openai.com") ||
        value === "custom" ||
        value.startsWith("https://your-project") ||
        value.startsWith("https://your-app");
      expect(
        isPlaceholder,
        `.env.example value for ${name} looks real: ${value.slice(0, 12)}…`,
      ).toBe(true);
    }
  });
});

describe("CI workflow", () => {
  const path = ".github/workflows/ci.yml";

  it("exists and is not empty", () => {
    expect(existsSync(resolve(root, path))).toBe(true);
    expect(read(path).trim().length).toBeGreaterThan(0);
  });

  it("runs the full validation gate with npm ci on the pinned Node major", () => {
    const workflow = read(path);
    expect(workflow).toContain("npm ci");
    expect(workflow).toContain("npm run typecheck");
    expect(workflow).toContain("npm run lint");
    expect(workflow).toContain("npm test");
    expect(workflow).toContain("npm run build");
    // Node major must be 22 (matches package.json engines — see test below).
    const nodeMatch = workflow.match(/node-version:\s*"?(\d+)/);
    expect(nodeMatch?.[1]).toBe("22");
  });

  it("triggers on push to main and on pull requests", () => {
    const workflow = read(path);
    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("branches: [main]");
  });
});

describe("package.json engines", () => {
  it("pins Node >=22, matching the CI workflow", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.engines?.node).toBe(">=22");
  });
});
