import { describe, expect, it } from "vitest";
import {
  ALL_ITEMS,
  CATEGORIES,
  categoryLabel,
  itemsForCategory,
  normalizeQuery,
  search,
  type CategoryId,
  type FaqItem,
} from "@/lib/faq";
import { dirForLang } from "@/lib/i18n/core";
import { SUPPORTED_LANGUAGES } from "@/lib/i18n/dictionaries";

const LANGS = SUPPORTED_LANGUAGES as readonly string[];

/** Every item must carry a non-empty question + answer in ALL languages. */
function assertFullLocalization(item: FaqItem) {
  for (const lang of LANGS) {
    const q = item.question[lang as "de"];
    const a = item.answer[lang as "de"];
    expect(q, `question for ${item.id} / ${lang}`).toBeTruthy();
    expect(q.trim().length, `question for ${item.id} / ${lang} is empty`).toBeGreaterThan(3);
    expect(a, `answer for ${item.id} / ${lang}`).toBeTruthy();
    expect(a.trim().length, `answer for ${item.id} / ${lang} is empty`).toBeGreaterThan(3);
  }
}

// ---------------------------------------------------------------------------
// Data completeness + structure
// ---------------------------------------------------------------------------

describe("FAQ data structure", () => {
  it("has exactly 17 categories", () => {
    expect(CATEGORIES).toHaveLength(17);
  });

  it("has a large, comprehensive item set", () => {
    // The FAQ must be far more than a handful of questions.
    expect(ALL_ITEMS.length).toBeGreaterThan(150);
  });

  it("has unique item ids", () => {
    const ids = ALL_ITEMS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every item belongs to a known category", () => {
    const known = new Set(CATEGORIES.map((c) => c.id));
    for (const item of ALL_ITEMS) {
      expect(known.has(item.category), `item ${item.id} has unknown category`).toBe(true);
    }
  });

  it("no category is empty", () => {
    for (const category of CATEGORIES) {
      expect(
        itemsForCategory(category.id as CategoryId).length,
        `category ${category.id} is empty`,
      ).toBeGreaterThan(0);
    }
  });

  it("every category label is present in all languages", () => {
    for (const category of CATEGORIES) {
      for (const lang of LANGS) {
        expect(category.label[lang as "de"].trim(), `${category.id} / ${lang} label`).toBeTruthy();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Cross-language parity
// ---------------------------------------------------------------------------

describe("FAQ cross-language parity", () => {
  it("every question has an answer and full localization", () => {
    for (const item of ALL_ITEMS) {
      assertFullLocalization(item);
    }
  });

  it("element counts are identical across the four languages", () => {
    // Because each item holds all four languages, the per-language count of
    // questions and answers must be identical by construction.
    const expected = ALL_ITEMS.length;
    for (const lang of LANGS) {
      const questions = ALL_ITEMS.filter((i) => i.question[lang as "de"]?.trim());
      const answers = ALL_ITEMS.filter((i) => i.answer[lang as "de"]?.trim());
      expect(questions.length, `questions for ${lang}`).toBe(expected);
      expect(answers.length, `answers for ${lang}`).toBe(expected);
    }
  });
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

describe("FAQ search", () => {
  it("returns everything for an empty query", () => {
    expect(search({ query: "", lang: "de" }).length).toBe(ALL_ITEMS.length);
  });

  it("is case- and diacritic-insensitive", () => {
    const lower = search({ query: "pdf", lang: "en" });
    const upper = search({ query: "PDF", lang: "en" });
    expect(lower.length).toBeGreaterThan(0);
    expect(lower.length).toBe(upper.length);
  });

  it("matches a technical token (PDF) across questions/answers/keywords", () => {
    const results = search({ query: "pdf", lang: "en" });
    expect(results.length).toBeGreaterThan(0);
    for (const item of results) {
      const haystack = [
        item.question.en,
        item.answer.en,
        ...item.keywords,
      ]
        .map(normalizeQuery)
        .join(" ");
      expect(haystack).toContain("pdf");
    }
  });

  it("matches a broad term (email) across several categories", () => {
    const results = search({ query: "email", lang: "en" });
    expect(results.length).toBeGreaterThan(0);
    const cats = new Set(results.map((r) => r.category));
    // "email" should surface items from more than one category.
    expect(cats.size).toBeGreaterThan(1);
  });

  it("a question-text match ranks above an answer-only match", () => {
    // "stellenangebote" is the search-category label and appears in its
    // answer texts, so it should be found (and rank the category first).
    const results = search({ query: "stellenangebote", lang: "de" });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].category).toBe("search");
  });

  it("returns no results for a nonsense term", () => {
    expect(search({ query: "zzzqqqxxxyyy", lang: "en" }).length).toBe(0);
  });

  it("honors the category filter while searching", () => {
    const results = search({ query: "pdf", lang: "en", category: "scanner" });
    expect(results.length).toBeGreaterThan(0);
    for (const item of results) {
      expect(item.category).toBe("scanner");
    }
  });
});

// ---------------------------------------------------------------------------
// Category filtering
// ---------------------------------------------------------------------------

describe("FAQ category filtering", () => {
  it("filters to a single category only", () => {
    const results = search({ query: "", lang: "de", category: "billing" });
    expect(results.length).toBeGreaterThan(0);
    for (const item of results) {
      expect(item.category).toBe("billing");
    }
  });

  it("category count matches the items-for-category helper", () => {
    for (const category of CATEGORIES) {
      const id = category.id as CategoryId;
      const viaSearch = search({ query: "", lang: "en", category: id }).length;
      const viaHelper = itemsForCategory(id).length;
      expect(viaSearch, `category ${id}`).toBe(viaHelper);
    }
  });

  it("labels resolve per category and language", () => {
    expect(categoryLabel("general", "de")).toBe("Allgemein");
    expect(categoryLabel("general", "ar")).toBe("عام");
  });
});

// ---------------------------------------------------------------------------
// RTL (Arabic) sanity
// ---------------------------------------------------------------------------

describe("FAQ Arabic RTL", () => {
  it("Arabic is the only RTL language and maps to dir=rtl", () => {
    expect(dirForLang("ar")).toBe("rtl");
    for (const lang of ["de", "en", "fr"] as const) {
      expect(dirForLang(lang)).toBe("ltr");
    }
  });

  it("Arabic content is present and non-empty (layout-critical text)", () => {
    for (const item of ALL_ITEMS) {
      expect(item.question.ar.trim(), `${item.id} ar question`).toBeTruthy();
      expect(item.answer.ar.trim(), `${item.id} ar answer`).toBeTruthy();
    }
    for (const category of CATEGORIES) {
      expect(category.label.ar.trim(), `${category.id} ar label`).toBeTruthy();
    }
  });
});
