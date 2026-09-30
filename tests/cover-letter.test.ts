import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { dictionaries, SUPPORTED_LANGUAGES } from "@/lib/i18n/dictionaries";
import { candidateProfileSchema } from "@/lib/bewerbung-schema";
import { cvEmpty } from "@/lib/templates/cv";
import {
  bodyParagraphs,
  clEmpty,
  clHasContent,
  copyCvToCl,
  formatCvForPrompt,
  formatGermanDate,
  formatProfileForPrompt,
  GREETING_DEFAULT,
  CLOSING_DEFAULT,
  importCandidateProfileToCl,
  isValidIsoDate,
  parseAiBody,
  recipientLines,
  recipientSummary,
  sanitizeClDocument,
  senderLines,
  senderSummary,
  todayISO,
  type ClDocument,
} from "@/lib/templates/cover-letter";

/**
 * Cover Letter / Anschreiben Builder — pure model tests.
 *
 *  - initial empty state + conventional defaults
 *  - German date formatting (deterministic, no Intl)
 *  - persistence round-trip + corrupted-storage recovery
 *  - profile / CV imports with the strict no-invention contract
 *  - document data (sender/recipient lines, paragraphs, signature)
 *  - AI helpers (parseAiBody + prompt context builders)
 *  - print/export + live-preview wiring (source-level, the same
 *    source-of-truth pattern the i18n/nav tests use)
 *  - i18n key parity for the new namespace
 */

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const readSrc = (relative: string) =>
  readFileSync(resolve(root, relative), "utf8");

const FIXED_NOW = new Date(2026, 8, 30); // 30 September 2026

// ---------------------------------------------------------------------------
// Initial empty state + defaults
// ---------------------------------------------------------------------------

describe("clEmpty / initial state", () => {
  it("defaults to today's date, German greeting and closing", () => {
    const doc = clEmpty(FIXED_NOW);
    expect(doc.version).toBe(1);
    expect(doc.date).toBe("2026-09-30");
    expect(doc.greeting).toBe(GREETING_DEFAULT);
    expect(doc.closing).toBe(CLOSING_DEFAULT);
    expect(doc.body).toEqual([]);
    expect(doc.signature).toEqual({ kind: "none", text: "", image: null });
    expect(doc.ai).toEqual({
      position: "",
      company: "",
      jobDescription: "",
      tone: "professional",
      language: "de",
    });
  });

  it("an untouched document has NO content (stays in the empty state)", () => {
    const doc = clEmpty(FIXED_NOW);
    expect(clHasContent(doc)).toBe(false);
  });

  it("detects content in every meaningful field", () => {
    const base = clEmpty(FIXED_NOW);
    expect(
      clHasContent({ ...base, sender: { ...base.sender, fullName: "A" } }),
    ).toBe(true);
    expect(
      clHasContent({ ...base, recipient: { ...base.recipient, company: "Muster GmbH" } }),
    ).toBe(true);
    expect(clHasContent({ ...base, subject: "Bewerbung" })).toBe(true);
    expect(clHasContent({ ...base, body: ["Sehr geehrte ..."] })).toBe(true);
    expect(clHasContent({ ...base, body: ["   "] })).toBe(false);
    expect(
      clHasContent({ ...base, signature: { kind: "text", text: "M. Drif", image: null } }),
    ).toBe(true);
    expect(
      clHasContent({ ...base, signature: { kind: "image", text: "", image: "data:image/png;base64,AA" } }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Date handling
// ---------------------------------------------------------------------------

describe("German date", () => {
  it("formats ISO dates in German long form", () => {
    expect(formatGermanDate("2026-09-30")).toBe("30. September 2026");
    expect(formatGermanDate("2027-01-01")).toBe("1. Januar 2027");
    expect(formatGermanDate("2024-12-31")).toBe("31. Dezember 2024");
  });

  it("rejects invalid dates", () => {
    expect(isValidIsoDate("2026-02-30")).toBe(false);
    expect(isValidIsoDate("30.09.2026")).toBe(false);
    expect(isValidIsoDate("2026-13-01")).toBe(false);
    expect(formatGermanDate("garbage")).toBe("");
    expect(formatGermanDate("")).toBe("");
  });

  it("todayISO is a valid ISO date", () => {
    const iso = todayISO(FIXED_NOW);
    expect(iso).toBe("2026-09-30");
    expect(isValidIsoDate(todayISO())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Persistence: round-trip + corrupted storage recovery
// ---------------------------------------------------------------------------

describe("persistence (sanitizeClDocument)", () => {
  it("round-trips a full document through JSON", () => {
    const doc: ClDocument = {
      ...clEmpty(FIXED_NOW),
      sender: {
        ...clEmpty(FIXED_NOW).sender,
        fullName: "Mustapha Drif",
        street: "Musterstraße 12",
        postalCode: "50667",
        city: "Köln",
      },
      recipient: { ...clEmpty(FIXED_NOW).recipient, company: "Muster GmbH", city: "Berlin" },
      subject: "Bewerbung um einen Ausbildungsplatz",
      body: ["Erster Absatz.", "Zweiter Absatz."],
      signature: { kind: "text", text: "Mustapha Drif", image: null },
    };
    const restored = sanitizeClDocument(JSON.parse(JSON.stringify(doc)));
    expect(restored).toEqual(doc);
  });

  it("rejects non-object input (corrupt storage)", () => {
    expect(sanitizeClDocument(null)).toBeNull();
    expect(sanitizeClDocument("text")).toBeNull();
    expect(sanitizeClDocument(42)).toBeNull();
    expect(sanitizeClDocument(["array"])).toBeNull();
  });

  it("recovers a malformed document with valid defaults", () => {
    const doc = sanitizeClDocument({
      date: "not-a-date",
      greeting: "",
      body: "just a string",
      signature: { kind: "sparkly", image: "http://evil.example/x.png" },
      ai: { tone: "sassy", language: "xx" },
    });
    expect(doc).not.toBeNull();
    if (!doc) return;
    expect(isValidIsoDate(doc.date)).toBe(true);
    expect(doc.greeting).toBe(GREETING_DEFAULT);
    expect(doc.body).toEqual([]); // a plain string is not a paragraph list
    expect(doc.signature.kind).toBe("none");
    expect(doc.signature.image).toBeNull(); // remote URLs are dropped
    expect(doc.ai.tone).toBe("professional");
    expect(doc.ai.language).toBe("de");
  });

  it("keeps a data-URL signature image only when small enough", () => {
    const ok = "data:image/png;base64,iVBORw0KGgo=";
    const recovered = sanitizeClDocument({ signature: { kind: "image", image: ok } });
    expect(recovered?.signature.image).toBe(ok);
    expect(recovered?.signature.kind).toBe("image");
  });
});

// ---------------------------------------------------------------------------
// Imports (no-invention contract)
// ---------------------------------------------------------------------------

const REALISTIC_PROFILE = {
  goal: "ausbildung",
  candidate: {
    full_name: "Mustafa Drif",
    location: "Köln",
    country: "Deutschland",
    current_location: null,
    target_location: ["Berlin"],
    contact: {
      email: "mustafa.drif@example.com",
      phone: "+49 151 2345678",
      linkedin: "https://linkedin.com/in/mustafa-drif",
    },
  },
  education: [
    {
      school: "Berufskolleg am Schloss",
      university: null,
      degree: "Fachhochschulreife",
      field_of_study: "Wirtschaft",
      graduation_year: 2023,
    },
  ],
  training: [
    { name: "Ausbildung zum E-Commerce-Spezialisten", provider: "Muster GmbH", year: "2023" },
  ],
  experience: [
    {
      job_title: "Auszubildender E-Commerce",
      company: "Muster GmbH",
      responsibilities: ["Betreuung der Online-Shops"],
      start_date: "03/2024",
      end_date: null,
    },
  ],
  skills: { technical: ["SEO"], software_tools: ["Excel"], marketing: [], it: [], soft: ["Zuverlässigkeit"] },
  languages: [{ language: "Deutsch", level: "B1" }],
  target_roles: [{ role: "E-Commerce-Auszubildende(r)", reason: "Praktikumserfahrung" }],
};

function parseProfile() {
  return candidateProfileSchema.parse(REALISTIC_PROFILE);
}

describe("importCandidateProfileToCl", () => {
  it("fills the sender from the candidate block only", () => {
    const doc = importCandidateProfileToCl(parseProfile());
    expect(doc.sender.fullName).toBe("Mustafa Drif");
    expect(doc.sender.city).toBe("Köln");
    expect(doc.sender.country).toBe("Deutschland");
    expect(doc.sender.email).toBe("mustafa.drif@example.com");
    expect(doc.sender.phone).toBe("+49 151 2345678");
    expect(doc.sender.linkedin).toBe("https://linkedin.com/in/mustafa-drif");
    // The profile has no street/PLZ/website — those must stay empty.
    expect(doc.sender.street).toBe("");
    expect(doc.sender.postalCode).toBe("");
    expect(doc.sender.website).toBe("");
  });

  it("never touches recipient, subject, body or signature (application-specific)", () => {
    const doc = importCandidateProfileToCl(parseProfile());
    expect(doc.recipient).toEqual(clEmpty().recipient);
    expect(doc.subject).toBe("");
    expect(doc.body).toEqual([]);
    expect(doc.signature).toEqual({ kind: "none", text: "", image: null });
  });

  it("fills empty fields only — never overwrites user edits", () => {
    const edited: ClDocument = {
      ...clEmpty(),
      sender: { ...clEmpty().sender, fullName: "M. Drif (manuell)", email: "a@b.c" },
    };
    const doc = importCandidateProfileToCl(parseProfile(), edited);
    expect(doc.sender.fullName).toBe("M. Drif (manuell)");
    expect(doc.sender.email).toBe("a@b.c");
    // The still-empty phone gets the profile value.
    expect(doc.sender.phone).toBe("+49 151 2345678");
  });

  it("handles an empty profile without inventing anything", () => {
    const empty = candidateProfileSchema.parse({ goal: "arbeit" });
    const doc = importCandidateProfileToCl(empty);
    expect(doc.sender).toEqual(clEmpty().sender);
  });
});

describe("copyCvToCl", () => {
  it("copies CV personal data into empty sender fields", () => {
    const cv = cvEmpty();
    cv.personal.fullName = "Mustapha Drif";
    cv.personal.email = "m@example.com";
    cv.personal.phone = "+49 170 1234567";
    cv.personal.location = "Köln";
    cv.personal.linkedin = "https://linkedin.com/in/mdrif";
    cv.personal.website = "https://drif.example";
    const doc = copyCvToCl(cv);
    expect(doc.sender.fullName).toBe("Mustapha Drif");
    expect(doc.sender.email).toBe("m@example.com");
    expect(doc.sender.phone).toBe("+49 170 1234567");
    expect(doc.sender.city).toBe("Köln");
    expect(doc.sender.linkedin).toBe("https://linkedin.com/in/mdrif");
    expect(doc.sender.website).toBe("https://drif.example");
    // The CV has no street/PLZ/country — never invented.
    expect(doc.sender.street).toBe("");
    expect(doc.sender.postalCode).toBe("");
    expect(doc.sender.country).toBe("");
  });

  it("does not overwrite existing sender values", () => {
    const cv = cvEmpty();
    cv.personal.fullName = "CV-Name";
    const edited: ClDocument = {
      ...clEmpty(),
      sender: { ...clEmpty().sender, fullName: "Manueller Name", email: "e@x.de" },
    };
    const doc = copyCvToCl(cv, edited);
    expect(doc.sender.fullName).toBe("Manueller Name");
    expect(doc.sender.email).toBe("e@x.de");
  });
});

// ---------------------------------------------------------------------------
// Document data (what the A4 renderer consumes)
// ---------------------------------------------------------------------------

describe("document lines (sender / recipient)", () => {
  it("builds the sender block with empty values skipped", () => {
    const { address, contact } = senderLines({
      fullName: "M. Drif",
      street: "Musterstraße 12",
      postalCode: "50667",
      city: "Köln",
      country: "",
      email: "m@example.com",
      phone: "",
      linkedin: "https://linkedin.com/in/x",
      website: "",
    });
    expect(address).toEqual(["Musterstraße 12", "50667 Köln"]);
    expect(contact).toEqual(["m@example.com", "https://linkedin.com/in/x"]);
  });

  it("builds the recipient block in business-letter order", () => {
    const lines = recipientLines({
      company: "Muster GmbH",
      contactPerson: "Frau Meier",
      department: "Personalabteilung",
      street: "Beispielweg 1",
      postalCode: "10115",
      city: "Berlin",
      country: "",
    });
    expect(lines).toEqual([
      "Muster GmbH",
      "Frau Meier",
      "Personalabteilung",
      "Beispielweg 1",
      "10115 Berlin",
    ]);
  });

  it("skips unknown recipient fields (no fake contact info)", () => {
    expect(recipientLines(clEmpty().recipient)).toEqual([]);
    expect(senderSummary(clEmpty())).toBe("");
    expect(recipientSummary(clEmpty())).toBe("");
  });

  it("produces useful collapsed-card summaries", () => {
    const doc: ClDocument = {
      ...clEmpty(),
      sender: { ...clEmpty().sender, fullName: "M. Drif", postalCode: "50667", city: "Köln" },
      recipient: { ...clEmpty().recipient, company: "Muster GmbH", city: "Berlin" },
    };
    expect(senderSummary(doc)).toBe("M. Drif · 50667 Köln");
    expect(recipientSummary(doc)).toBe("Muster GmbH · Berlin");
  });
});

describe("body paragraphs", () => {
  it("keeps paragraph breaks and ignores whitespace-only paragraphs", () => {
    const doc: ClDocument = {
      ...clEmpty(),
      body: ["Einleitung.", "   ", "Erlebnis.", ""],
    };
    expect(bodyParagraphs(doc)).toEqual(["Einleitung.", "Erlebnis."]);
  });
});

describe("signature", () => {
  it("text signature counts as content; none does not", () => {
    const base = clEmpty();
    expect(clHasContent(base)).toBe(false);
    expect(
      clHasContent({ ...base, signature: { kind: "text", text: "M. Drif", image: null } }),
    ).toBe(true);
    expect(clHasContent({ ...base, signature: { kind: "none", text: "", image: null } })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AI helpers
// ---------------------------------------------------------------------------

describe("parseAiBody", () => {
  it("splits on blank lines and normalizes inner whitespace", () => {
    expect(parseAiBody("Absatz eins.\n\nAbsatz zwei.")).toEqual([
      "Absatz eins.",
      "Absatz zwei.",
    ]);
    expect(parseAiBody("Zeile a\nZeile b\n\nWeiter.")).toEqual([
      "Zeile a Zeile b",
      "Weiter.",
    ]);
    expect(parseAiBody("   \n\n  ")).toEqual([]);
    expect(parseAiBody("  \r\n\r\n  Zwei  ")).toEqual(["Zwei"]);
  });
});

describe("AI prompt context (no-invention)", () => {
  it("renders only real profile facts and marks missing data", () => {
    const text = formatProfileForPrompt(parseProfile());
    expect(text).toContain("KANDIDATENPROFIL");
    expect(text).toContain("Name: Mustafa Drif");
    expect(text).toContain("Ort: Köln");
    expect(text).toContain("E-Mail: mustafa.drif@example.com");
    expect(text).toContain("Berufserfahrung");
    expect(text).toContain("Auszubildender E-Commerce");
    expect(text).toContain("Fähigkeiten");
    expect(text).toContain("Sprachen: Deutsch B1");
    // No phone? The profile has one — check a truly absent field instead:
    expect(text).not.toContain("Website");
  });

  it("states explicitly when profile/CV data is unavailable", () => {
    expect(formatProfileForPrompt(null)).toContain("nicht verfügbar");
    expect(formatProfileForPrompt(null)).toContain("Erfinde KEINE");
    expect(formatCvForPrompt(null)).toContain("nicht verfügbar");
    expect(formatCvForPrompt(cvEmpty())).toContain("ohne Inhalt");
  });

  it("renders CV facts with visibility predicates", () => {
    const cv = cvEmpty();
    cv.summary = "Organisiert und motiviert.";
    cv.skills = ["SEO"];
    const text = formatCvForPrompt(cv);
    expect(text).toContain("LEBENSLAUF");
    expect(text).toContain("Profil: Organisiert und motiviert.");
    expect(text).toContain("Fähigkeiten: SEO");
    // Empty sections must not appear as (empty) facts.
    expect(text).not.toContain("Berufserfahrung:");
    expect(text).not.toContain("Ausbildung/Studium:");
  });
});

// ---------------------------------------------------------------------------
// Live preview + print/export wiring (source-level, like the nav/i18n tests)
// ---------------------------------------------------------------------------

describe("preview + print wiring", () => {
  it("the document component renders the model's lines (single source of truth)", () => {
    const doc = readSrc("src/components/cover-letter-document.tsx");
    for (const fn of ["senderLines", "recipientLines", "bodyParagraphs", "formatGermanDate"]) {
      expect(doc, `CoverLetterDocument must use ${fn}()`).toContain(fn);
    }
    // The sheet is always LTR German paper.
    expect(doc).toContain('dir="ltr"');
    expect(doc).toContain('lang="de"');
    expect(doc).toContain("cl-sheet");
  });

  it("builder and print root share ONE component (preview === PDF)", () => {
    const builder = readSrc("src/components/cover-letter-builder.tsx");
    expect(builder).toContain("cl-print-root");
    expect(builder).toContain('document.body');
    expect(builder).toContain("cl-builder-active");
    const docImports = (builder.match(/CoverLetterDocument/g) ?? []).length;
    expect(docImports).toBeGreaterThanOrEqual(3); // import + preview + print
  });

  it("print CSS hides the app shell and sets A4 with professional margins", () => {
    const css = readSrc("src/app/globals.css");
    expect(css).toContain(".cl-print-root");
    expect(css).toContain("body.cl-builder-active .app-shell-root");
    expect(css).toContain("size: A4");
    expect(css).toMatch(/\.cl-print-root \.cl-sheet[\s\S]*?padding: 20mm 25mm !important/);
  });

  it("the route is wired into the navigation system (real href, no soon flag)", () => {
    const shell = readSrc("src/components/app-shell.tsx");
    expect(shell).toContain('href: "/dashboard/cover-letter"');
    const line = shell
      .split("\n")
      .find((l) => l.includes('href: "/dashboard/cover-letter"'));
    expect(line).toBeDefined();
    expect(line).not.toContain("soon: true");
  });
});

// ---------------------------------------------------------------------------
// i18n parity for the new namespace
// ---------------------------------------------------------------------------

describe("i18n coverLetter namespace", () => {
  const deCover = (dictionaries.de as Record<string, unknown>).coverLetter as Record<string, string>;

  it("exists in every language with the same keys", () => {
    expect(Object.keys(deCover).length).toBeGreaterThan(50);
    const deKeys = new Set(Object.keys(deCover));
    for (const lang of SUPPORTED_LANGUAGES) {
      const dict = dictionaries[lang] as Record<string, unknown>;
      const block = dict.coverLetter as Record<string, string>;
      expect(Object.keys(block).sort()).toEqual([...deKeys].sort());
    }
  });

  it("has no empty translations and German greeting presets stay German", () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      const dict = dictionaries[lang] as Record<string, unknown>;
      const block = dict.coverLetter as Record<string, string>;
      for (const [key, value] of Object.entries(block)) {
        expect(value.trim(), `${lang}:coverLetter.${key}`).not.toBe("");
      }
    }
    // The letter itself is a German business letter in every UI language:
    // greeting/closing are model-level German defaults, not UI translations.
    expect(deCover["sectionSender"]).toBe("Absender");
    expect(GREETING_DEFAULT).toBe("Sehr geehrte Damen und Herren,");
    expect(CLOSING_DEFAULT).toBe("Mit freundlichen Grüßen");
  });
});
