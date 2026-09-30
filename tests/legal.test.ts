import { describe, expect, it } from "vitest";
import {
  CONTACT_EMAIL,
  LEGAL_DOCS,
  LEGAL_ORDER,
  LEGAL_ROUTES,
  type LegalDoc,
  type LegalSlug,
} from "@/lib/legal";
import { translate } from "@/lib/i18n/core";
import { SUPPORTED_LANGUAGES } from "@/lib/i18n/dictionaries";

const LANGS = SUPPORTED_LANGUAGES as readonly "de"[];

/** Collect every localized string inside a document (flattened). */
function allStrings(doc: LegalDoc): string[] {
  const out: string[] = [doc.title.de, doc.intro.de];
  for (const section of doc.sections) {
    out.push(section.title.de);
    for (const p of section.p ?? []) out.push(p.de);
    for (const b of section.li ?? []) out.push(b.de);
    for (const p of section.pAfter ?? []) out.push(p.de);
    if (section.toLabel) out.push(section.toLabel.de);
  }
  return out;
}

/** Collect all strings of one language across all docs. */
function allLanguageStrings(lang: "de" | "en" | "fr" | "ar"): string[] {
  const out: string[] = [];
  for (const slug of LEGAL_ORDER) {
    const doc = LEGAL_DOCS[slug];
    out.push(doc.title[lang], doc.intro[lang]);
    for (const section of doc.sections) {
      out.push(section.title[lang]);
      for (const p of section.p ?? []) out.push(p[lang]);
      for (const b of section.li ?? []) out.push(b[lang]);
      for (const p of section.pAfter ?? []) out.push(p[lang]);
      if (section.toLabel) out.push(section.toLabel[lang]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

describe("legal pages structure", () => {
  it("has exactly the six required pages", () => {
    expect(LEGAL_ORDER).toHaveLength(6);
    const expected: LegalSlug[] = [
      "privacy",
      "terms",
      "cookies",
      "ai-usage",
      "data-deletion",
      "contact",
    ];
    for (const slug of expected) {
      expect(LEGAL_DOCS[slug], `doc ${slug}`).toBeTruthy();
      expect(LEGAL_DOCS[slug].slug).toBe(slug);
    }
  });

  it("routes are the clear, required paths", () => {
    expect(LEGAL_ROUTES).toEqual({
      privacy: "/privacy",
      terms: "/terms",
      cookies: "/cookies",
      "ai-usage": "/ai-usage",
      "data-deletion": "/data-deletion",
      contact: "/contact",
    });
  });

  it("every doc has non-empty title and intro in all languages", () => {
    for (const slug of LEGAL_ORDER) {
      const doc = LEGAL_DOCS[slug];
      for (const lang of LANGS) {
        expect(doc.title[lang].trim(), `${slug} title ${lang}`).toBeTruthy();
        expect(doc.intro[lang].trim(), `${slug} intro ${lang}`).toBeTruthy();
      }
    }
  });

  it("section ids are unique per document and non-empty", () => {
    for (const slug of LEGAL_ORDER) {
      const doc = LEGAL_DOCS[slug];
      const ids = doc.sections.map((s) => s.id);
      expect(new Set(ids).size, `${slug} duplicate ids`).toBe(ids.length);
      for (const id of ids) expect(id.trim(), `${slug} empty id`).toBeTruthy();
      expect(doc.sections.length, `${slug} has sections`).toBeGreaterThan(3);
    }
  });

  it("every section heading is localized in all languages", () => {
    for (const slug of LEGAL_ORDER) {
      for (const section of LEGAL_DOCS[slug].sections) {
        for (const lang of LANGS) {
          expect(
            section.title[lang].trim(),
            `${slug}#${section.id} title ${lang}`,
          ).toBeTruthy();
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Full localization parity (no language with missing content)
// ---------------------------------------------------------------------------

describe("legal localization parity", () => {
  it("paragraph/bullet counts are identical across the four languages", () => {
    for (const slug of LEGAL_ORDER) {
      const doc = LEGAL_DOCS[slug];
      for (const section of doc.sections) {
        for (const lang of LANGS) {
          for (const p of section.p ?? []) {
            expect(p[lang].trim(), `${slug}#${section.id} p ${lang}`).toBeTruthy();
          }
          for (const b of section.li ?? []) {
            expect(b[lang].trim(), `${slug}#${section.id} li ${lang}`).toBeTruthy();
          }
          for (const p of section.pAfter ?? []) {
            expect(p[lang].trim(), `${slug}#${section.id} pAfter ${lang}`).toBeTruthy();
          }
          if (section.toLabel) {
            expect(section.toLabel[lang].trim()).toBeTruthy();
          }
        }
      }
    }
  });

  it("total content volume is substantial (full translations, not headings only)", () => {
    // Every language must carry a comparable, meaningful amount of text.
    for (const lang of LANGS) {
      const totalChars = allLanguageStrings(lang).join(" ").length;
      expect(totalChars, `${lang} volume`).toBeGreaterThan(8000);
    }
  });
});

// ---------------------------------------------------------------------------
// Legal accuracy guards (no invented claims, controlled placeholders)
// ---------------------------------------------------------------------------

const FORBIDDEN_CLAIMS = [
  "military",
  "militärisch",
  "100% secure",
  "100 % sûr",
  "100% sicher",
  "100% آمن",
  "fully GDPR compliant",
  "pleinement RGPD",
  "vollständig DSGVO-konform",
  "fully compliant",
  "legally compliant",
  "gesetzlich konform",
  "معتمد قانونًا",
];

describe("legal accuracy", () => {
  it("contains no forbidden compliance/security claims", () => {
    for (const lang of LANGS) {
      for (const str of allLanguageStrings(lang)) {
        const lower = str.toLowerCase();
        for (const claim of FORBIDDEN_CLAIMS) {
          expect(
            lower.includes(claim.toLowerCase()),
            `forbidden claim "${claim}" in ${lang}: ${str.slice(0, 80)}`,
          ).toBe(false);
        }
      }
    }
  });

  it("uses the two known placeholders only in privacy + terms", () => {
    for (const slug of LEGAL_ORDER) {
      const doc = LEGAL_DOCS[slug];
      const de = allStrings(doc).join("\n");
      const allowed = slug === "privacy" || slug === "terms";
      if (allowed) {
        expect(de).toContain("[LEGAL ENTITY NAME]");
        expect(de).toContain("[BUSINESS ADDRESS]");
      } else {
        expect(de).not.toContain("[LEGAL ENTITY NAME]");
        expect(de).not.toContain("[BUSINESS ADDRESS]");
      }
    }
  });

  it("has no other unreviewed bracket placeholders", () => {
    const pattern = /\[[A-Z][A-Z0-9 _-]{2,}\]/g;
    const allowed = new Set(["[LEGAL ENTITY NAME]", "[BUSINESS ADDRESS]"]);
    for (const lang of LANGS) {
      for (const str of allLanguageStrings(lang)) {
        const found = str.match(pattern) ?? [];
        for (const token of found) {
          expect(allowed.has(token), `unexpected placeholder ${token} in ${lang}`).toBe(true);
        }
      }
    }
  });

  it("contact email is a real address (not a placeholder)", () => {
    expect(CONTACT_EMAIL).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
    expect(CONTACT_EMAIL).not.toContain("[");
    expect(LEGAL_DOCS.contact.contactEmail).toBe(CONTACT_EMAIL);
  });

  it("deckblatt is not advertised as an existing feature", () => {
    const terms = LEGAL_DOCS.terms;
    const deckblatt = terms.sections.find((s) => s.id === "deckblatt");
    expect(deckblatt, "terms deckblatt section").toBeTruthy();
    expect(deckblatt!.title.de).toBeTruthy();
    // The German copy must make the unavailability explicit.
    expect(deckblatt!.p![0].de.toLowerCase()).toContain("nicht");
  });

  it("no job/apprenticeship guarantee appears in terms", () => {
    const termsDe = allStrings(LEGAL_DOCS.terms).join("\n").toLowerCase();
    // The doc must contain the explicit negative guarantee.
    expect(termsDe).toContain("keine garantie");
  });
});

// ---------------------------------------------------------------------------
// i18n chrome used by footer / register / legal layout
// ---------------------------------------------------------------------------

describe("legal i18n chrome", () => {
  const chromeKeys = [
    "legal.toc",
    "legal.tocAria",
    "legal.backToApp",
    "legal.footerSection",
    "legal.privacyPolicy",
    "legal.termsOfService",
    "legal.cookiePolicy",
    "legal.aiUsage",
    "legal.dataDeletion",
    "legal.contact",
    "legal.brandTagline",
    "legal.emailLabel",
    "legal.copyright",
  ];

  it("all chrome keys exist in all four languages", () => {
    for (const lang of LANGS) {
      for (const key of chromeKeys) {
        const value = translate(lang, key);
        // translate() falls back to the raw path when a key is missing.
        expect(value, `${key} missing in ${lang}`).not.toBe(key);
        expect(value.trim(), `${key} empty in ${lang}`).toBeTruthy();
      }
    }
  });

  it("copyright interpolates the year", () => {
    for (const lang of LANGS) {
      const value = translate(lang, "legal.copyright", { year: 2026 });
      expect(value).toContain("2026");
      expect(value).not.toContain("{year}");
    }
  });

  it("register consent keys exist in all four languages", () => {
    for (const lang of LANGS) {
      for (const key of [
        "auth.form.termsPrefix",
        "auth.form.termsOfService",
        "auth.form.termsAnd",
        "auth.form.privacyPolicy",
        "auth.form.termsSuffix",
      ]) {
        const value = translate(lang, key);
        expect(value, `${key} missing in ${lang}`).not.toBe(key);
        expect(value.trim(), `${key} empty in ${lang}`).toBeTruthy();
      }
    }
  });
});
