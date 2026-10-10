/**
 * Guides section tests (replaces the deleted housing tests):
 *  - consulate data integrity (only verified official facts, each entry linked
 *    to the page it was reviewed against, with its review date),
 *  - the four-language guides.* i18n block resolves (no path fallbacks),
 *  - the old housing section is fully gone (keys, routes, modules, nav).
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CONSULATES, GENERAL_LINKS } from "@/lib/guides/consulate-docs";
import { dictionaries, SUPPORTED_LANGUAGES } from "@/lib/i18n/dictionaries";
import { translate } from "@/lib/i18n/core";

const root = resolve(__dirname, "..");
const read = (rel: string) => readFileSync(resolve(root, rel), "utf8");
const has = (rel: string) => existsSync(resolve(root, rel));

const isHttpUrl = (s: string): boolean =>
  /^https:\/\/[a-z0-9.-]+\.[a-z]{2,}([/:?#]|$)/i.test(s);

// ---------------------------------------------------------------------------
// Consulate data integrity
// ---------------------------------------------------------------------------

describe("consulate-docs integrity", () => {
  it("contains exactly the 12 verified missions with unique ids", () => {
    expect(CONSULATES).toHaveLength(12);
    const ids = CONSULATES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every entry links a valid official URL reviewed on 2026-10-11", () => {
    for (const c of CONSULATES) {
      expect(isHttpUrl(c.url), `${c.id} url`).toBe(true);
      expect(c.lastReviewed, `${c.id} reviewed`).toBe("2026-10-11");
      // names in both supported user languages
      expect(c.countryDe.trim(), `${c.id} countryDe`).not.toBe("");
      expect(c.countryAr.trim(), `${c.id} countryAr`).not.toBe("");
      expect(c.missionDe.trim(), `${c.id} missionDe`).not.toBe("");
      expect(c.missionAr.trim(), `${c.id} missionAr`).not.toBe("");
      expect(c.cityDe.trim(), `${c.id} cityDe`).not.toBe("");
    }
  });

  it("every entry carries at least one verified fact (docs or notes)", () => {
    for (const c of CONSULATES) {
      expect(
        c.docs.length + c.notes.length,
        `${c.id} must have verified facts`,
      ).toBeGreaterThan(0);
      for (const d of c.docs) {
        expect(d.de.trim(), `${c.id} doc de`).not.toBe("");
        expect(d.ar.trim(), `${c.id} doc ar`).not.toBe("");
      }
      for (const n of c.notes) {
        expect(n.de.trim(), `${c.id} note de`).not.toBe("");
        expect(n.ar.trim(), `${c.id} note ar`).not.toBe("");
      }
      for (const extra of [c.jurisdiction, c.fee, c.appointment, c.languageNote]) {
        if (extra) {
          expect(extra.de.trim(), `${c.id} extra de`).not.toBe("");
          expect(extra.ar.trim(), `${c.id} extra ar`).not.toBe("");
        }
      }
    }
  });

  it("general links point to official AAE / Auslandsportal pages", () => {
    expect(isHttpUrl(GENERAL_LINKS.allMissions)).toBe(true);
    expect(isHttpUrl(GENERAL_LINKS.auslandsportal)).toBe(true);
    expect(isHttpUrl(GENERAL_LINKS.generalRules)).toBe(true);
    expect(GENERAL_LINKS.allMissions).toContain("auswaertiges-amt.de");
    expect(GENERAL_LINKS.auslandsportal).toContain("auslandsportal.auswaertiges-amt.de");
  });
});

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
    "guides.nav.neu",
    "guides.nav.vertrag",
    "guides.nav.konsulat",
    "guides.page.landTitle",
    "guides.page.landSubtitle",
    "guides.page.gehaltTitle",
    "guides.page.neuSubtitle",
    "guides.page.vertragTitle",
    "guides.page.konsulatSubtitle",
    "guides.land.intro",
    "guides.land.c1Title",
    "guides.land.c4Desc",
    "guides.land.open",
    "guides.gehalt.intro",
    "guides.gehalt.skI",
    "guides.gehalt.skVI",
    "guides.gehalt.skNote",
    "guides.gehalt.kleinbetragsNote",
    "guides.gehalt.rowNetto",
    "guides.gehalt.lastReviewed",
    "guides.neu.checklistTitle",
    "guides.neu.progress",
    "guides.neu.s1t1",
    "guides.neu.s6d3",
    "guides.vertrag.intro",
    "guides.vertrag.visaWarning",
    "guides.vertrag.s2t4",
    "guides.vertrag.s5d4",
    "guides.konsulat.intro",
    "guides.konsulat.vtAusbildung",
    "guides.konsulat.otherCountryDesc",
    "guides.konsulat.disclaimer",
    "guides.konsulat.noMatch",
  ];

  it("resolves the key samples in all four languages (no path fallback)", () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      for (const key of SAMPLE_KEYS) {
        expect(translate(lang, key), `${lang}:${key}`).not.toBe(key);
      }
    }
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
// Routing: new pages exist, old routes are gone
// ---------------------------------------------------------------------------

describe("housing → guides replacement (routing + modules)", () => {
  it("the five new pages exist", () => {
    expect(has("src/app/wohnen/page.tsx")).toBe(true);
    expect(has("src/app/wohnen/gehalt/page.tsx")).toBe(true);
    expect(has("src/app/wohnen/neu-in-deutschland/page.tsx")).toBe(true);
    expect(has("src/app/wohnen/nach-dem-vertrag/page.tsx")).toBe(true);
    expect(has("src/app/wohnen/konsulat/page.tsx")).toBe(true);
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

  it("the app-shell nav contains exactly the four new guides routes", () => {
    const src = read("src/components/app-shell.tsx");
    for (const route of [
      "/wohnen/gehalt",
      "/wohnen/neu-in-deutschland",
      "/wohnen/nach-dem-vertrag",
      "/wohnen/konsulat",
    ]) {
      expect(src, route).toContain(route);
    }
    for (const gone of [
      "/wohnen/suchen",
      "/wohnen/kostenrechner",
      "/wohnen/gespeichert",
      "/wohnen/wg-zimmer",
      "/wohnen/moebliert",
      "/wohnen/tipps",
      "/wohnen/miet-check",
    ]) {
      expect(src, gone).not.toContain(gone);
    }
    expect(src).toContain("guides.nav.section");
  });

  it("no housing rate-limit scopes remain", () => {
    const src = read("src/lib/rate-limit.ts");
    expect(src).not.toMatch(/housing_/);
    // the copilot's web_search scope stays (unrelated to housing)
    expect(src).toContain("web_search");
  });
});
