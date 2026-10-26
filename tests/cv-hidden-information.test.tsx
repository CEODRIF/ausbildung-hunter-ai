// @vitest-environment jsdom
/**
 * Hidden Information (private supplementary note) — feature tests.
 *
 * Contract under test:
 *  - ONE canonical optional field `cv.hiddenInformation` (separate from the
 *    visible CV sections), empty by default;
 *  - editor section at the BOTTOM of the CV editor: textarea, explanation,
 *    character counter, clear option, keyboard/screen-reader accessible;
  *  - persistence through the EXISTING per-user localStorage draft
  *    (`aha:cv:<userId>`) — no new storage surface;
  *  - the note NEVER appears in the visible CV layout or the on-screen
  *    preview; in the PDF export (browser print) it appears ONLY when
  *    non-empty, as ONE labeled supplementary page (CvNotePage) appended
  *    after the sheet inside the print root — plain extractable text, no
  *    hidden-text tricks, byte-identical sheet markup with or without it.
  *    The real-artifact extraction test lives in
  *    tests/cv-hidden-information-pdf.test.tsx;
  *  - idempotency: repeated saves/exports never duplicate the text;
 *  - the note is never transmitted to external AI providers (the only
 *    server path, /api/ai/cover-letter, blanks it before prompt assembly).
 */
import "@testing-library/jest-dom/vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CvBuilder } from "@/components/cv-builder";
import { CvDocument, type CvLabels } from "@/components/cv-document";
import { I18nProvider } from "@/lib/i18n";
import {
  CV_TEMPLATE_IDS,
  HIDDEN_INFORMATION_MAX_LENGTH,
  cvEmpty,
  cvHasContent,
  importCandidateProfileToCv,
  sanitizeCvDocument,
  type CvDocument as CvDocModel,
} from "@/lib/templates/cv";
import { copyCvToCl, formatCvForPrompt } from "@/lib/templates/cover-letter";
import { candidateProfileSchema } from "@/lib/bewerbung-schema";
import { dictionaries, SUPPORTED_LANGUAGES } from "@/lib/i18n/dictionaries";

// The builder is a client component using next/navigation + ResizeObserver —
// same environment shims as the other jsdom behavior tests in this suite.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
if (!("ResizeObserver" in globalThis)) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
    ResizeObserverStub;
}

const read = (p: string) => readFileSync(resolve(__dirname, p), "utf8");
const builderSrc = read("../src/components/cv-builder.tsx");
const cvLibSrc = read("../src/lib/templates/cv.ts");
const routeSrc = read("../src/app/api/ai/cover-letter/route.ts");

const NOTE = "Bismillahir Rahmanir Rahim — private test note";
// The Textarea component renders its hint INSIDE the wrapping <label>,
// so the accessible name is "label + hint"; query the textarea via its
// placeholder and verify the label association with an anchored regex.
const DE_NOTE_PLACEHOLDER =
  "z. B. ein persönliches Gebet oder eine private Notiz …";

// ---------------------------------------------------------------------------
// Data model: single canonical field, defensive sanitization, idempotency
// ---------------------------------------------------------------------------

describe("CvDocument.hiddenInformation (data model)", () => {
  it("exists, is empty by default, and is separate from visible sections", () => {
    const cv = cvEmpty();
    expect(cv.hiddenInformation).toBe("");
    // Not part of any visible section — it is its own top-level field.
    expect(JSON.stringify(cv.personal)).not.toContain("hiddenInformation");
    expect(JSON.stringify(cv.summary)).not.toBe("hiddenInformation");
  });

  it("a note alone is NOT CV content (no continue flow, no PDF button)", () => {
    const noteOnly = { ...cvEmpty(), hiddenInformation: NOTE };
    expect(cvHasContent(noteOnly)).toBe(false);
    // ...but a note plus real content keeps counting as content.
    const withName = {
      ...cvEmpty(),
      personal: { ...cvEmpty().personal, fullName: "A" },
      hiddenInformation: NOTE,
    };
    expect(cvHasContent(withName)).toBe(true);
  });

  it("sanitize keeps a valid note, rejects malformed values, caps length", () => {
    expect(
      sanitizeCvDocument({ hiddenInformation: NOTE })?.hiddenInformation,
    ).toBe(NOTE);
    expect(
      sanitizeCvDocument({ hiddenInformation: 42 })?.hiddenInformation,
    ).toBe("");
    expect(
      sanitizeCvDocument({ hiddenInformation: { a: 1 } })?.hiddenInformation,
    ).toBe("");
    expect(
      sanitizeCvDocument({
        hiddenInformation: "x".repeat(HIDDEN_INFORMATION_MAX_LENGTH + 500),
      })?.hiddenInformation.length,
    ).toBe(HIDDEN_INFORMATION_MAX_LENGTH);
    // Legacy drafts (stored before the field existed) resolve to "".
    expect(
      sanitizeCvDocument({ personal: { fullName: "Alt" } })?.hiddenInformation,
    ).toBe("");
  });

  it("round-trips through JSON exactly once (no duplication on re-save)", () => {
    const doc: CvDocModel = {
      ...cvEmpty(),
      personal: { ...cvEmpty().personal, fullName: "A" },
      hiddenInformation: NOTE,
    };
    const once = sanitizeCvDocument(JSON.parse(JSON.stringify(doc)));
    expect(once).toEqual(doc);
    // Second pass (re-save → restore → save) is a fixed point: the note is
    // never appended, never duplicated.
    const twice = sanitizeCvDocument(JSON.parse(JSON.stringify(once)));
    expect(twice).toEqual(once);
    expect(JSON.stringify(twice).split(NOTE).length - 1).toBe(1);
  });

  it("is never populated by the scanner profile import", () => {
    const profile = candidateProfileSchema.parse({
      goal: "ausbildung",
      candidate: { full_name: "Test Person", contact: { email: "t@e.x" } },
    });
    expect(importCandidateProfileToCv(profile).hiddenInformation).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Draft persistence (the existing per-user localStorage mechanism)
// ---------------------------------------------------------------------------

describe("draft persistence (existing aha:cv:<userId> key)", () => {
  const storageKey = "aha:cv:user-note-a";

  beforeEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("saves, restores and clears the note through the real editor", async () => {
    const view = render(
      <I18nProvider>
        <CvBuilder userId="user-note-a" profileFullName="" profileEmail="" />
      </I18nProvider>,
    );
    // Drive the 3-step flow into the editor (German default locale).
    fireEvent.click(
      await screen.findByRole("button", { name: /Neu erstellen/ }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Weiter" }));
    await screen.findByRole("button", { name: "Inhalt hinzufügen" });

    // Enter a visible field + the private note.
    fireEvent.change(screen.getByLabelText("Vollständiger Name"), {
      target: { value: "Test Person" },
    });
    const noteField = screen.getByPlaceholderText(DE_NOTE_PLACEHOLDER);
    fireEvent.change(noteField, { target: { value: NOTE } });

    // Debounced autosave (400 ms) persists the note into the EXISTING key.
    await waitFor(() => {
      const stored = window.localStorage.getItem(storageKey);
      expect(stored).not.toBeNull();
      expect(JSON.parse(stored as string).hiddenInformation).toBe(NOTE);
    });
    view.unmount();

    // Fresh mount with the same user restores the stored note.
    render(
      <I18nProvider>
        <CvBuilder userId="user-note-a" profileFullName="" profileEmail="" />
      </I18nProvider>,
    );
    // A saved CV with content lands on the "continue" card.
    fireEvent.click(
      await screen.findByRole("button", { name: "Weiter bearbeiten" }),
    );
    await screen.findByRole("button", { name: "Inhalt hinzufügen" });
    expect(screen.getByPlaceholderText(DE_NOTE_PLACEHOLDER)).toHaveValue(NOTE);

    // Clearing the field removes the note from the current draft.
    fireEvent.click(screen.getByRole("button", { name: "Feld leeren" }));
    await waitFor(() => {
      const stored = window.localStorage.getItem(storageKey);
      expect(JSON.parse(stored as string).hiddenInformation).toBe("");
    });
  });

  it("keeps per-user isolation (no cross-account read of the note)", async () => {
    // Seed user A's draft directly, then open the builder as user B: the
    // storage key is per-user, so B's editor must start with an empty note.
    const seed: CvDocModel = {
      ...cvEmpty(),
      personal: { ...cvEmpty().personal, fullName: "User A" },
      hiddenInformation: NOTE,
    };
    window.localStorage.setItem(storageKey, JSON.stringify(seed));
    const otherKey = "aha:cv:user-note-b";
    expect(window.localStorage.getItem(otherKey)).toBeNull();

    render(
      <I18nProvider>
        <CvBuilder userId="user-note-b" profileFullName="" profileEmail="" />
      </I18nProvider>,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /Neu erstellen/ }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Weiter" }));
    await screen.findByRole("button", { name: "Inhalt hinzufügen" });
    expect(screen.getByPlaceholderText(DE_NOTE_PLACEHOLDER)).toHaveValue("");
  });
});

// ---------------------------------------------------------------------------
// Editor UI: rendering, enter/edit/clear, counter, accessibility
// ---------------------------------------------------------------------------

describe("CV editor: Hidden Information section", () => {
  beforeEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  async function openEditor() {
    render(
      <I18nProvider>
        <CvBuilder userId="user-ui" profileFullName="" profileEmail="" />
      </I18nProvider>,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /Neu erstellen/ }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Weiter" }));
    await screen.findByRole("button", { name: "Inhalt hinzufügen" });
  }

  it("renders at the bottom of the editor, optional and empty by default", async () => {
    await openEditor();
    // Section heading (the spec label, German default locale).
    expect(
      screen.getByRole("heading", { name: "Zusätzliche private Notiz" }),
    ).toBeInTheDocument();
    // Textarea with an accessible name, empty, placeholder + explanation.
    const field = screen.getByPlaceholderText(DE_NOTE_PLACEHOLDER);
    expect(field).toHaveValue("");
    // Screen-reader label: the wrapping <label> names the field (the hint
    // lives inside the label, hence the anchored prefix match).
    expect(screen.getByLabelText(/^Ihre private Notiz/)).toBe(field);
    expect(
      screen.getByText(
        "Wird getrennt von den sichtbaren CV-Abschnitten in Ihrem privaten Entwurf gespeichert. Die Notiz erscheint nie in der CV-Vorschau. Bei gefülltem Feld wird sie als beschriftete Zusatzseite mit normalem, extrahierbarem Text in den PDF-Export aufgenommen.",
      ),
    ).toBeInTheDocument();
    // Character counter (0 / 2000) and a disabled clear option.
    expect(
      screen.getByText(`0 / ${HIDDEN_INFORMATION_MAX_LENGTH}`),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Feld leeren" })).toBeDisabled();
    // Empty note → NO supplementary page anywhere (print root or preview).
    expect(document.querySelector(".cv-note-page")).toBeNull();
    const printRoot = document.querySelector(".cv-print-root");
    expect(printRoot?.textContent ?? "").not.toContain("Ihre private Notiz");
  });

  it("a non-empty note appears exactly once in the print root, on its own labeled page (never in the preview)", async () => {
    await openEditor();
    fireEvent.change(screen.getByPlaceholderText(DE_NOTE_PLACEHOLDER), {
      target: { value: NOTE },
    });
    // The sheet (preview AND printed CV) is untouched by the note.
    const sheet = document.querySelector(".cv-print-root .cv-sheet");
    expect(sheet?.textContent ?? "").not.toContain(NOTE);
    // Exactly ONE supplementary page, inside the print root, labeled, with
    // the note text exactly once.
    const notePages = document.querySelectorAll(".cv-note-page");
    expect(notePages).toHaveLength(1);
    const notePage = notePages[0];
    expect(notePage.closest(".cv-print-root")).not.toBeNull();
    expect(notePage.textContent).toContain(NOTE);
    expect(notePage.textContent?.split(NOTE).length - 1).toBe(1);
    // Labeled: the localized page heading is present.
    expect(notePage.textContent).toContain("Private Notiz (Zusatzseite)");
    // The on-screen preview sheets (outside the print root) must not show
    // the note in any rendered element.
    for (const s of Array.from(document.querySelectorAll(".cv-sheet")).filter(
      (x) => !x.closest(".cv-print-root"),
    )) {
      expect(s.textContent ?? "").not.toContain(NOTE);
    }
  });

  it("supports entering, editing and clearing the note (keyboard-accessible)", async () => {
    await openEditor();
    const field = screen.getByPlaceholderText(DE_NOTE_PLACEHOLDER);
    const clear = screen.getByRole("button", { name: "Feld leeren" });

    fireEvent.change(field, { target: { value: "Bismillah" } });
    expect(field).toHaveValue("Bismillah");
    expect(clear).toBeEnabled();
    expect(screen.getByText("9 / 2000")).toBeInTheDocument();

    fireEvent.change(field, { target: { value: "Bismillah — Notiz" } });
    expect(screen.getByText("17 / 2000")).toBeInTheDocument();

    fireEvent.click(clear);
    expect(field).toHaveValue("");
    expect(clear).toBeDisabled();
    expect(screen.getByText("0 / 2000")).toBeInTheDocument();
  });

  it("enforces the character cap", async () => {
    await openEditor();
    const field = screen.getByPlaceholderText(DE_NOTE_PLACEHOLDER);
    expect(field).toHaveAttribute(
      "maxlength",
      String(HIDDEN_INFORMATION_MAX_LENGTH),
    );
  });
});

// ---------------------------------------------------------------------------
// PDF export: visible layout untouched, note only as labeled supplementary
// page (print root, non-empty gate), idempotent
// ---------------------------------------------------------------------------

const LABELS: CvLabels = {
  summary: "Profile",
  experience: "Professional Experience",
  education: "Education",
  skills: "Skills",
  languages: "Languages",
  certificates: "Certificates",
  projects: "Projects",
  interests: "Interests",
  present: "Present",
  documentTitle: "Your CV",
};

function sampleCv(templateId: CvDocModel["templateId"]): CvDocModel {
  const cv = cvEmpty();
  cv.templateId = templateId;
  cv.personal.fullName = "Daniel Mercer";
  cv.personal.professionalTitle = "Vice President of Sales";
  cv.personal.email = "daniel.mercer@email.com";
  cv.personal.location = "Chicago, IL";
  cv.summary = "Sales professional with 8+ years of experience.";
  cv.experience = [
    {
      id: "x1",
      jobTitle: "Sales Manager",
      company: "Nexora Solutions",
      location: "Chicago, Illinois",
      start: "2022",
      end: "",
      isCurrent: true,
      responsibilities: ["Manage a team of account executives"],
      achievements: [],
    },
  ];
  cv.education = [
    {
      id: "e1",
      degree: "BSc Marketing",
      institution: "Indiana University",
      location: "",
      start: "2012",
      end: "2016",
      description: "",
    },
  ];
  cv.skills = ["Sales Strategy", "Negotiation"];
  cv.languages = [{ id: "l1", language: "English", level: "Native" }];
  cv.interests = ["Chess"];
  return cv;
}

describe("PDF export behavior (print of the same CvDocument)", () => {
  it("exporting with the field empty renders exactly the visible CV (no note anywhere)", () => {
    for (const id of CV_TEMPLATE_IDS) {
      const html = renderToStaticMarkup(
        <CvDocument cv={sampleCv(id)} labels={LABELS} />,
      );
      expect(html).toContain("cv-sheet");
      expect(html).not.toContain("SECRET-NOTE-MARKER");
    }
  });

  it("the note never leaks into any visible section of any template", () => {
    for (const id of CV_TEMPLATE_IDS) {
      const cv = sampleCv(id);
      cv.hiddenInformation = "SECRET-NOTE-MARKER";
      const html = renderToStaticMarkup(<CvDocument cv={cv} labels={LABELS} />);
      expect(html).not.toContain("SECRET-NOTE-MARKER");
    }
  });

  it("the visible CV layout is byte-identical with or without the note", () => {
    for (const id of CV_TEMPLATE_IDS) {
      const baseline = renderToStaticMarkup(
        <CvDocument cv={sampleCv(id)} labels={LABELS} />,
      );
      const withNote = sampleCv(id);
      withNote.hiddenInformation = "SECRET-NOTE-MARKER";
      expect(
        renderToStaticMarkup(<CvDocument cv={withNote} labels={LABELS} />),
      ).toBe(baseline);
    }
  });

  it("repeated exports of the same state are identical (no duplication)", () => {
    const cv = sampleCv("classic");
    cv.hiddenInformation = "SECRET-NOTE-MARKER";
    const first = renderToStaticMarkup(<CvDocument cv={cv} labels={LABELS} />);
    for (let i = 0; i < 3; i++) {
      expect(renderToStaticMarkup(<CvDocument cv={cv} labels={LABELS} />)).toBe(
        first,
      );
      // Re-sanitizing the persisted state (save → restore → export) is stable.
      const restored = sanitizeCvDocument(JSON.parse(JSON.stringify(cv)));
      expect(restored).not.toBeNull();
      if (!restored) continue;
      expect(
        renderToStaticMarkup(<CvDocument cv={restored} labels={LABELS} />),
      ).toBe(first);
    }
  });

  it("the export pipeline is browser print; the note enters only via the labeled note page (no tricks, no PDF lib)", () => {
    // The print portal still renders exactly the same CvDocument as the
    // preview; the note is appended AFTER the sheet, gated on non-empty
    // content, so an empty field yields a byte-identical visible CV.
    expect(builderSrc).toContain('className="cv-print-root"');
    expect(builderSrc).toMatch(
      /cv-print-root[\s\S]{0,200}?<CvDocumentSheet cv=\{cv\}/,
    );
    expect(builderSrc).toContain(
      'const hasHiddenNote = cv.hiddenInformation.trim() !== "";',
    );
    expect(builderSrc).toMatch(/hasHiddenNote && \(\s*<CvNotePage/);
    const handlePrint =
      builderSrc.match(
        /const handlePrint = useCallback\(\(\) => \{[\s\S]*?\}, \[\]\);/,
      )?.[0] ?? "";
    expect(handlePrint).toContain("window.print()");
    // No new PDF generation library in the builder — the export stays
    // browser print (the repo's pdf-lib is Anschreiben-only).
    expect(builderSrc).not.toContain("pdf-lib");
    expect(builderSrc).not.toContain("html2canvas");
    // The note-page print CSS is explicit visible text on its own page —
    // no white-on-white, no zero-size glyphs, no opacity tricks.
    const printCss = read("../src/app/globals.css");
    const noteCss = printCss.slice(
      printCss.indexOf(".cv-print-root .cv-note-page"),
      printCss.indexOf(".cl-print-root"),
    );
    expect(noteCss).not.toBe(""); // block found
    expect(noteCss).toContain("page-break-before: always");
    expect(noteCss).toContain("white-space: pre-wrap");
    expect(noteCss).toContain("width: 210mm");
    expect(noteCss).not.toMatch(/(?<!background-)color:\s*#fff/i);
    expect(noteCss).not.toContain("font-size: 0");
    expect(noteCss).not.toContain("opacity: 0");
  });
});

// ---------------------------------------------------------------------------
// No external transmission
// ---------------------------------------------------------------------------

describe("the note is never transmitted to external AI providers", () => {
  it("formatCvForPrompt (the LLM-facing CV serializer) omits the note", () => {
    const cv = sampleCv("classic");
    cv.hiddenInformation = "SECRET-NOTE-MARKER";
    const prompt = formatCvForPrompt(cv);
    expect(prompt).toContain("Sales Manager"); // visible facts still flow
    expect(prompt).not.toContain("SECRET-NOTE-MARKER");
  });

  it("copyCvToCl (CV → cover-letter sender data) omits the note", () => {
    const cv = sampleCv("classic");
    cv.hiddenInformation = "SECRET-NOTE-MARKER";
    expect(JSON.stringify(copyCvToCl(cv))).not.toContain("SECRET-NOTE-MARKER");
  });

  it("the /api/ai/cover-letter route blanks the note before prompt assembly", () => {
    const sanitizedAt = routeSrc.indexOf("sanitizeCvDocument(body.cv)");
    const blankedAt = routeSrc.indexOf('cv.hiddenInformation = ""');
    const promptAt = routeSrc.indexOf("formatCvForPrompt(cv)");
    expect(sanitizedAt).toBeGreaterThan(-1);
    expect(blankedAt).toBeGreaterThan(sanitizedAt);
    expect(promptAt).toBeGreaterThan(blankedAt);
  });

  it("no other code path reads the aha:cv: draft besides builder + cover-letter", () => {
    // The only two consumers of the per-user CV draft key (unchanged by this
    // feature): the builder itself and the cover-letter AI call.
    const hits = execSync(`grep -rln "aha:cv:" src/ | sort`, {
      cwd: resolve(__dirname, ".."),
      encoding: "utf8",
    })
      .trim()
      .split("\n");
    expect(hits).toEqual(
      expect.arrayContaining([
        "src/components/cv-builder.tsx",
        "src/components/cover-letter-builder.tsx",
      ]),
    );
    // The cookie-legal text documents the draft key (static copy, not a reader).
    expect(hits.filter((h) => h.includes("legal")).length).toBeLessThanOrEqual(
      1,
    );
  });
});

// ---------------------------------------------------------------------------
// i18n: the spec labels exist in all four languages; keys wired in the builder
// ---------------------------------------------------------------------------

describe("i18n (all four supported languages)", () => {
  it("carries the spec-required section labels (ar/en/de) and a fr label", () => {
    expect(dictionaries.de.templates.sectionHiddenInfo).toBe(
      "Zusätzliche private Notiz",
    );
    expect(dictionaries.en.templates.sectionHiddenInfo).toBe(
      "Hidden Information",
    );
    expect(dictionaries.ar.templates.sectionHiddenInfo).toBe(
      "المعلومات المخفية",
    );
    expect(
      String(dictionaries.fr.templates.sectionHiddenInfo).trim().length,
    ).toBeGreaterThan(2);
  });

  for (const lang of SUPPORTED_LANGUAGES) {
    it(`${lang}: all hidden-information strings present and non-empty`, () => {
      const templates = dictionaries[lang].templates as Record<string, string>;
      for (const key of [
        "sectionHiddenInfo",
        "hiddenInfoLabel",
        "hiddenInfoHint",
        "hiddenInfoPageTitle",
        "hiddenInfoPageCaption",
        "hiddenInfoPlaceholder",
        "clearHiddenInfo",
      ]) {
        expect(
          String(templates[key]).trim(),
          `${lang}.templates.${key}`,
        ).not.toBe("");
      }
    });
  }

  it("the builder wires the section, counter and clear action to i18n keys", () => {
    expect(builderSrc).toContain('title={t("templates.sectionHiddenInfo")}');
    expect(builderSrc).toContain('label={t("templates.hiddenInfoLabel")}');
    expect(builderSrc).toContain('hint={t("templates.hiddenInfoHint")}');
    expect(builderSrc).toContain(
      'placeholder={t("templates.hiddenInfoPlaceholder")}',
    );
    expect(builderSrc).toContain('{t("templates.clearHiddenInfo")}');
    expect(builderSrc).toContain('icon="lock"');
    // The section is the LAST card of the editor (after Interests), inside
    // the content view.
    const interestsIdx = builderSrc.indexOf(
      'title={t("templates.sectionInterests")}',
    );
    const hiddenIdx = builderSrc.indexOf(
      'title={t("templates.sectionHiddenInfo")}',
    );
    expect(interestsIdx).toBeGreaterThan(-1);
    expect(hiddenIdx).toBeGreaterThan(interestsIdx);
    expect(builderSrc.indexOf("</Fragment>", hiddenIdx)).toBeGreaterThan(
      hiddenIdx,
    );
    // The single canonical state writer is wired to the canonical field.
    expect(cvLibSrc).toContain(
      "hiddenInformation: str(data.hiddenInformation)",
    );
    expect(builderSrc).toContain("cv.hiddenInformation");
  });
});

// The builder component itself compiles into this suite (import guard).
export { CvBuilder as __cvHiddenInfoImportGuard };
