/**
 * Guides section tests:
 *  - the four-language guides.* i18n block resolves (no path fallbacks),
 *  - the removed guide features (neu-in-deutschland / nach-dem-vertrag /
 *    konsulat) are fully gone: routes, components, data, nav, i18n keys,
 *  - the retained salary calculator (/wohnen/gehalt) and the /wohnen
 *    landing stay intact,
 *  - the old housing section is fully gone (keys, routes, modules, nav).
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { dictionaries, SUPPORTED_LANGUAGES } from "@/lib/i18n/dictionaries";
import { translate } from "@/lib/i18n/core";

const root = resolve(__dirname, "..");
const read = (rel: string) => readFileSync(resolve(root, rel), "utf8");
const has = (rel: string) => existsSync(resolve(root, rel));

// ---------------------------------------------------------------------------
// guides.* i18n resolution
// ---------------------------------------------------------------------------

describe("guides i18n (de/en/fr/ar)", () => {
  // Full key-set parity across languages is enforced by i18n-theme.test.ts
  // (its walker indexes array elements too). Here: spot resolution — a
  // missing key makes translate() return the path, which we assert against.
  const SAMPLE_KEYS = [
    "guides.nav.section",
    "guides.nav.land",
    "guides.nav.gehalt",
    "guides.page.landTitle",
    "guides.page.landSubtitle",
    "guides.page.gehaltTitle",
    "guides.page.gehaltSubtitle",
    "guides.land.intro",
    "guides.land.c1Title",
    "guides.land.c1Desc",
    "guides.land.open",
    "guides.gehalt.intro",
    "guides.gehalt.skI",
    "guides.gehalt.skVI",
    "guides.gehalt.skNote",
    "guides.gehalt.kleinbetragsNote",
    "guides.gehalt.rowNetto",
    "guides.gehalt.lastReviewed",
  ];

  it("resolves the key samples in all four languages (no path fallback)", () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      for (const key of SAMPLE_KEYS) {
        expect(translate(lang, key), `${lang}:${key}`).not.toBe(key);
      }
    }
  });

  it("the removed guide keys are fully gone in all four languages", () => {
    for (const key of [
      "guides.nav.neu",
      "guides.nav.vertrag",
      "guides.nav.konsulat",
      "guides.page.neuTitle",
      "guides.page.neuSubtitle",
      "guides.page.vertragTitle",
      "guides.page.vertragSubtitle",
      "guides.page.konsulatTitle",
      "guides.page.konsulatSubtitle",
      "guides.land.c2Title",
      "guides.land.c2Desc",
      "guides.land.c3Title",
      "guides.land.c3Desc",
      "guides.land.c4Title",
      "guides.land.c4Desc",
      "guides.neu.intro",
      "guides.neu.checklistTitle",
      "guides.vertrag.intro",
      "guides.vertrag.visaWarning",
      "guides.konsulat.intro",
      "guides.konsulat.disclaimer",
    ]) {
      for (const lang of SUPPORTED_LANGUAGES) {
        // missing key → translate() returns the path verbatim
        expect(translate(lang, key), `${lang}:${key}`).toBe(key);
      }
    }
    // and the content blocks are gone from the source
    const dict = read("src/lib/i18n/dictionaries.ts");
    expect(dict).not.toMatch(/\n    neu: \{/);
    expect(dict).not.toMatch(/\n    vertrag: \{/);
    expect(dict).not.toMatch(/\n    konsulat: \{/);
  });

  it("the params arrays have the same length in all languages", () => {
    const n = dictionaries.de.guides.gehalt.params.length;
    expect(n).toBe(10);
    for (const lang of SUPPORTED_LANGUAGES) {
      expect(dictionaries[lang].guides.gehalt.params.length, lang).toBe(n);
    }
  });

  it("the old housing i18n keys are fully removed", () => {
    for (const key of [
      "housing.nav.find",
      "housing.nav.cost",
      "housing.nav.searches",
      "housing.nav.saved",
      "housing.page.title",
    ]) {
      for (const lang of SUPPORTED_LANGUAGES) {
        // missing key → translate() returns the path verbatim
        expect(translate(lang, key), `${lang}:${key}`).toBe(key);
      }
    }
    expect(read("src/lib/i18n/dictionaries.ts")).not.toMatch(/housing\s*:\s*\{/);
  });
});

// ---------------------------------------------------------------------------
// Routing: retained pages exist, removed and old routes are gone
// ---------------------------------------------------------------------------

describe("guides replacement (routing + modules)", () => {
  it("the retained woehnen pages exist and the three removed guide pages are gone", () => {
    expect(has("src/app/wohnen/page.tsx")).toBe(true);
    expect(has("src/app/wohnen/gehalt/page.tsx")).toBe(true);
    for (const gone of [
      "src/app/wohnen/neu-in-deutschland/page.tsx",
      "src/app/wohnen/nach-dem-vertrag/page.tsx",
      "src/app/wohnen/konsulat/page.tsx",
    ]) {
      expect(has(gone), gone).toBe(false);
    }
    // the feature-exclusive components and data are deleted too
    for (const gone of [
      "src/components/guides/guide-layout.tsx",
      "src/components/guides/checklist.tsx",
      "src/components/guides/consulate-explorer.tsx",
      "src/lib/guides/consulate-docs.ts",
    ]) {
      expect(has(gone), gone).toBe(false);
    }
    // the retained calculator component and the section shell stay
    expect(has("src/components/guides/salary-calculator.tsx")).toBe(true);
    expect(has("src/app/wohnen/layout.tsx")).toBe(true);
  });

  it("all eight old housing pages and the API routes are deleted", () => {
    for (const old of [
      "suchen",
      "kostenrechner",
      "gespeichert",
      "wg-zimmer",
      "moebliert",
      "tipps",
      "miet-check",
    ]) {
      expect(has(`src/app/wohnen/${old}/page.tsx`), old).toBe(false);
    }
    for (const api of [
      "src/app/api/housing/application/route.ts",
      "src/app/api/housing/save/route.ts",
      "src/app/api/housing/scam-check/route.ts",
      "src/app/api/housing/web-search/route.ts",
      "src/app/api/housing/web-search/domains/route.ts",
    ]) {
      expect(has(api), api).toBe(false);
    }
    expect(has("src/lib/housing")).toBe(false);
    expect(has("src/components/housing")).toBe(false);
    expect(has("tests/housing")).toBe(false);
  });

  it("no source file imports a deleted housing module", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = resolve(dir, name);
        const st = statSync(p);
        if (st.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name)) files.push(p);
      }
    };
    walk(resolve(root, "src"));
    const offenders = files.filter((f) =>
      readFileSync(f, "utf8").includes("@/lib/housing"),
    );
    expect(offenders, "imports of @/lib/housing").toEqual([]);
    const offenders2 = files.filter((f) =>
      readFileSync(f, "utf8").includes("@/components/housing"),
    );
    expect(offenders2, "imports of @/components/housing").toEqual([]);
  });

  it("no retained source file imports a deleted guides module", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = resolve(dir, name);
        const st = statSync(p);
        if (st.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name)) files.push(p);
      }
    };
    walk(resolve(root, "src"));
    for (const mod of [
      "guides/guide-layout",
      "guides/checklist",
      "guides/consulate-explorer",
      "guides/consulate-docs",
    ]) {
      const offenders = files.filter((f) => readFileSync(f, "utf8").includes(mod));
      expect(offenders, `imports of ${mod}`).toEqual([]);
    }
  });

  it("the app-shell nav contains only the retained guide route", () => {
    const src = read("src/components/app-shell.tsx");
    expect(src).toContain("/wohnen/gehalt");
    for (const gone of [
      "/wohnen/neu-in-deutschland",
      "/wohnen/nach-dem-vertrag",
      "/wohnen/konsulat",
    ]) {
      expect(src, gone).not.toContain(gone);
    }
    for (const old of [
      "/wohnen/suchen",
      "/wohnen/kostenrechner",
      "/wohnen/gespeichert",
      "/wohnen/wg-zimmer",
      "/wohnen/moebliert",
      "/wohnen/tipps",
      "/wohnen/miet-check",
    ]) {
      expect(src, old).not.toContain(old);
    }
    expect(src).toContain("guides.nav.section");
  });

  it("the woehnen landing page links only the retained guide", () => {
    const src = read("src/app/wohnen/page.tsx");
    expect(src).toContain("/wohnen/gehalt");
    for (const gone of [
      "/wohnen/neu-in-deutschland",
      "/wohnen/nach-dem-vertrag",
      "/wohnen/konsulat",
    ]) {
      expect(src, gone).not.toContain(gone);
    }
    for (const gone of ["c2Title", "c3Title", "c4Title", "c2Desc", "c3Desc", "c4Desc"]) {
      expect(src, gone).not.toContain(gone);
    }
  });

  it("no housing rate-limit scopes remain", () => {
    const src = read("src/lib/rate-limit.ts");
    expect(src).not.toMatch(/housing_/);
    // the copilot's web_search scope stays (unrelated to housing)
    expect(src).toContain("web_search");
  });
});
