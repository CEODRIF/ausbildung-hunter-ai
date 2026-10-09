import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Permanent guard: the housing surface may NEVER contain demo/sample
 * listings or the "Demo-Daten — keine echten Mietangebote" banner again.
 *
 * On 2026-10-10 the demo pipeline (fixture grid, demo API, banner
 * components, i18n keys) was removed and replaced by the live Azure web
 * search. The only listing source is now:
 *   - `/api/housing/web-search`  → Azure AI Foundry Responses API +
 *     `web_search` tool, citations with real source URLs, or
 *   - an empty state ("Keine echten Mietangebote gefunden. …")
 *
 * This test fails if any part of the demo pipeline reappears.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const DEMO_COMPONENT_FILES = [
  "src/components/housing/demo-banner.tsx",
  "src/components/housing/listing-card.tsx",
];
const DEMO_API_FILES = ["src/app/api/housing/search/route.ts"];
const FIXTURE_DIRS = ["src/lib/housing/fixtures"];
const FIXTURE_FILES = ["src/lib/housing/fixtures/demo-listings.json"];

/** All .tsx/.ts files under the housing UI + pages directories. */
function collectHousingUiSources(): string[] {
  const roots = [
    join(repoRoot, "src/components/housing"),
    join(repoRoot, "src/app/wohnen"),
  ];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (/\.(tsx?|ts)$/.test(entry)) out.push(p);
    }
  };
  for (const r of roots) if (existsSync(r)) walk(r);
  return out;
}

/** Source files of the live web-search pipeline (the ONLY listing source). */
function collectWebSearchPipelineSources(): string[] {
  const libDir = join(repoRoot, "src/lib/housing/web-search");
  const out: string[] = [];
  if (existsSync(libDir)) {
    for (const entry of readdirSync(libDir)) {
      if (entry.endsWith(".ts")) out.push(join(libDir, entry));
    }
  }
  out.push(join(repoRoot, "src/app/api/housing/web-search/route.ts"));
  return out;
}

describe("demo data files are permanently deleted", () => {
  for (const rel of [...DEMO_COMPONENT_FILES, ...DEMO_API_FILES, ...FIXTURE_FILES]) {
    it(`${rel} does not exist`, () => {
      expect(existsSync(join(repoRoot, rel)), `${rel} must not exist`).toBe(false);
    });
  }

  it("no fixtures directory remains under src/lib/housing", () => {
    for (const rel of FIXTURE_DIRS) {
      expect(existsSync(join(repoRoot, rel)), `${rel} must not exist`).toBe(false);
    }
  });
});

describe("no demo references remain in the housing UI sources", () => {
  const patterns: Array<[string, RegExp]> = [
    ["DemoBanner component", /DemoBanner|demo-banner/],
    ["demo i18n keys", /demoBanner|demoNote|demoSource/],
    ["demo search API endpoint", /api\/housing\/search/],
    ["demo fixture path", /demo-listings/],
    ["demo-stamped listing field in UI", /is_demo/],
    ["demo listing card", /ListingCard|listing-card/],
  ];

  it.each(patterns)("%s is not referenced", (_label, pattern) => {
    const offenders = collectHousingUiSources().filter((p) =>
      pattern.test(readFileSync(p, "utf8")),
    );
    expect(offenders.map((p) => p.slice(repoRoot.length + 1))).toEqual([]);
  });
});

describe("the web-search pipeline has no demo/sample fallback", () => {
  it("never imports fixtures or demo data", () => {
    const offenders = collectWebSearchPipelineSources().filter((p) =>
      /fixtures|demo-listings|demoListings|DEMO_LABEL|sampleData/i.test(
        readFileSync(p, "utf8"),
      ),
    );
    expect(offenders.map((p) => p.slice(repoRoot.length + 1))).toEqual([]);
  });
});

describe("i18n dictionaries no longer contain demo keys", () => {
  it("demoBanner / demoNote / demoSource / emptyHint are gone from all 4 languages", () => {
    const src = readFileSync(
      join(repoRoot, "src/lib/i18n/dictionaries.ts"),
      "utf8",
    );
    for (const key of ["demoBanner", "demoNote", "demoSource", "emptyHint"]) {
      expect(src, `key "${key}" must not exist`).not.toContain(key);
    }
  });

  it("the required German empty state is present, verbatim", () => {
    const src = readFileSync(
      join(repoRoot, "src/lib/i18n/dictionaries.ts"),
      "utf8",
    );
    expect(src).toContain(
      "Keine echten Mietangebote gefunden. Bitte ändere deine Suchkriterien oder versuche es später erneut.",
    );
  });
});
