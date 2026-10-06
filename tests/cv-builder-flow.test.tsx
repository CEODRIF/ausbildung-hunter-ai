import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CvBuilder } from "@/components/cv-builder";
import { I18nProvider } from "@/lib/i18n";
import { CvTemplateSelector } from "@/components/cv-template-selector";
import { buildDemoCv } from "@/components/cv-templates/demo-cv";
import { dictionaries, SUPPORTED_LANGUAGES } from "@/lib/i18n/dictionaries";
import { cvEmpty } from "@/lib/templates/cv";

/**
 * The 3-step CV builder flow (start → template → edit) is a client-side
 * state machine; like the other builder contracts in this suite it is
 * guarded by source assertions on the exact wiring, plus a real SSR render
 * of the step-2 selector (live thumbnails, radiogroup, i18n).
 */

const read = (p: string) => readFileSync(resolve(__dirname, p), "utf8");
const builder = read("../src/components/cv-builder.tsx");
const selector = read("../src/components/cv-template-selector.tsx");
const cvLib = read("../src/lib/templates/cv.ts");

describe("3-step flow: start → template → edit", () => {
  it("entering the builder always lands on the start step (never the full editor)", () => {
    // Initial state is "start"; the editor workspace only renders inside
    // the step === "edit" branch.
    expect(builder).toContain('useState<BuilderStep>("start")');
    expect(builder).toContain("{step === \"edit\" && (");
    expect(builder).toContain("{step === \"template\" && (");
    expect(builder).toContain("{step === \"start\" && (");
  });

  it("back navigation never touches the document and follows the step rules", () => {
    // start → dashboard (history), template → start, edit → template.
    const back = builder.match(
      /const handleBack = useCallback\(\(\) => \{[\s\S]*?\n  \}, \[step, router\]\);/,
    )?.[0] ?? "";
    expect(back).not.toBe("");
    expect(back).toContain("router.back()");
    expect(back).toContain('if (step === "template")');
    expect(back).toContain('setStep("template")');
    // Going backward must NOT modify the document (no data loss).
    expect(back).not.toContain("setCv");
    expect(back).not.toContain("localStorage.removeItem");
  });

  it("the document is committed only when leaving the template step", () => {
    const cont = builder.match(
      /const handleContinueFromTemplate = useCallback\(\(\) => \{[\s\S]*?\n  \}, \[\]\);/,
    )?.[0] ?? "";
    expect(cont).toContain("setStarted(true)");
    expect(cont).toContain('setStep("edit")');
  });

  it("a successful import lands on the template step (existing runImport, no second parser)", () => {
    const apply = builder.match(
      /const applyImport = useCallback\(\(doc: CvDocument\) => \{[\s\S]*?\n  \}, \[\]\);/,
    )?.[0] ?? "";
    expect(apply).toContain('setStep("template")');
    // Exactly one import source (the Bewerbung Scanner candidate profile).
    expect(builder.match(/importCandidateProfileToCv\(/g)?.length ?? 0).toBe(1);
    expect(builder).toContain('from("candidate_profiles")');
  });
});

describe("'Create a new CV' is confirmation-gated (existing CV stays untouched)", () => {
  it("the reset lives ONLY in the confirmed handler and returns to the start screen", () => {
    const handler = builder.match(
      /const handleConfirmNewCv = useCallback\(\(\) => \{[\s\S]*?\n  \}, \[profileFullName, profileEmail\]\);/,
    )?.[0] ?? "";
    expect(handler).toContain("setCv(fresh)");
    expect(handler).toContain("setStarted(false)");
    expect(handler).toContain('setStep("start")');
    // The handler is referenced exactly twice: the modal action + nothing
    // else (no accidental reset paths).
    expect(builder.match(/handleConfirmNewCv/g)?.length ?? 0).toBe(2);
    // The confirmation modal exists and is the only way to open it.
    expect(builder).toContain("open={newCvConfirmOpen}");
    expect(builder.match(/setNewCvConfirmOpen\(true\)/g)?.length ?? 0).toBe(1);
  });

  it("legacy: 'last edited' is display metadata, not part of CvDocument", () => {
    expect(builder).toContain('aha:cv-saved-at');
    expect(cvLib).not.toContain("savedAt");
    // Autosave keeps the exact existing keys (document + started flag).
    expect(builder).toContain("aha:cv:${userId}");
    expect(builder).toContain("aha:cv-started:${userId}");
  });
});

describe("step indicator: no skipping into invalid states", () => {
  it("template/edit steps are gated by canTemplate/canEdit", () => {
    expect(builder).toContain(
      "const canTemplate = started || templateReached || cvHasContent(cv);",
    );
    expect(builder).toContain("const canEdit = started;");
    expect(builder).toContain("canTemplate={canTemplate}");
    expect(builder).toContain("canEdit={canEdit}");
    // Disabled steps render as non-interactive (aria-disabled), current as
    // aria-current.
    expect(builder).toContain('aria-current="step"');
    expect(builder).toContain('aria-disabled="true"');
  });
});

describe("edit step: Content / Design / Preview without losing functionality", () => {
  it("the three tabs map onto the existing editor, panel and preview", () => {
    expect(builder).toContain(
      'useState<"content" | "design" | "preview">("content")',
    );
    // Content = the section editor, Design = CvCustomizationPanel,
    // Preview = the same A4 preview subtree.
    expect(builder).toContain("view === \"design\" ? (");
    expect(builder).toContain("<CvCustomizationPanel");
    expect(builder).toContain('onClick={() => setView("preview")}');
    // The sticky pane unmounts while the Preview tab is active (single ref
    // attachment at any time).
    expect(builder).toContain("{view !== \"preview\" && (");
  });

  it("mobile keeps the existing Edit/Preview toggle (no side-by-side)", () => {
    expect(builder).toContain("templates.tabEdit");
    expect(builder).toContain("templates.tabPreview");
    expect(builder).toContain('mobileView === "preview" ? "" : "hidden lg:block"');
    expect(builder).toContain('mobileView === "edit" ? "" : "hidden lg:block"');
  });
});

describe("step-2 template selection: real renderer, large A4 gallery, demo data", () => {
  it("the step uses the existing CvTemplateSelector (large variant), not a re-implementation", () => {
    expect(builder).toContain("<CvTemplateSelector");
    expect(builder).toContain('size="large"');
    // The selector renders the ACTUAL template renderer — no screenshots.
    expect(selector).toContain("renderCvTemplate(id, previewDoc, labels)");
    expect(selector).toContain("role=\"radiogroup\"");
    expect(selector).toContain("role=\"radio\"");
    // Gallery geometry: A4 ratio (794:1123 ≈ 1:1.414) filling the card
    // width, 1 column mobile / 2 columns desktop.
    expect(selector).toContain('aspectRatio: "794 / 1123"');
    expect(selector).toContain('transform: "scale(calc(100cqi / 794px))"');
    expect(selector).toContain("containerType: \"inline-size\"");
    expect(selector).toContain("grid grid-cols-1 gap-5 lg:grid-cols-2");
  });

  it("demo data is gallery-only and never persisted or used for the real CV", () => {
    // The builder feeds the demo document ONLY to the selector previews.
    expect(builder).toContain("import { buildDemoCv } from \"@/components/cv-templates/demo-cv\";");
    expect(builder).toContain("previewCv={demoCv}");
    // The demo document is never serialized anywhere (no localStorage/PDF).
    expect(builder).not.toContain("JSON.stringify(demoCv)");
    // Compact (user-data) previews stay the default; only large uses demo.
    expect(selector).toContain("const previewDoc = large && previewCv ? previewCv : cv;");
  });

  it("renders all four templates with live A4 miniatures + selection state (SSR)", () => {
    const cv = cvEmpty();
    cv.personal.fullName = "Test Name"; // the REAL doc — must NOT appear
    cv.templateId = "modern";
    const labels = {
      summary: "Zusammenfassung",
      experience: "Berufserfahrung",
      education: "Ausbildung & Weiterbildung",
      skills: "Kompetenzen",
      languages: "Sprachen",
      certificates: "Zertifikate",
      projects: "Projekte",
      interests: "Interessen",
      present: "heute",
      documentTitle: "Ihr Lebenslauf",
    };
    const html = renderToStaticMarkup(
      <I18nProvider>
        <CvTemplateSelector
          cv={cv}
          previewCv={buildDemoCv()}
          labels={labels}
          selected="modern"
          onSelect={() => {}}
          size="large"
          showTitle={false}
        />
      </I18nProvider>,
    );
    // Four live thumbnails, one selected.
    expect(html.match(/role="radio"/g)?.length ?? 0).toBe(4);
    expect(html.match(/aria-checked="true"/g)?.length ?? 0).toBe(1);
    // German names + descriptions from the dictionaries (i18n, not hard-coded).
    expect(html).toContain("Modern");
    expect(html).toContain("Executive");
    // Every card previews the DEMO document (Alex Morgan × 4 — header of
    // each rendered template), never the user's empty CV.
    expect(html.match(/Alex Morgan/g)?.length ?? 0).toBe(4);
    expect(html).not.toContain("Test Name");
    // Each card scales the real 794px sheet (4 wrappers + 4 sheets).
    expect(html.match(/width:794px/g)?.length ?? 0).toBe(8);
    expect(html).toContain("scale(calc(100cqi / 794px))");
  });
});

describe("i18n: every new flow string exists in all four languages", () => {
  const keys = [
    "back",
    "templateLabel",
    "stepNav",
    "stepStart",
    "stepTemplate",
    "stepEdit",
    "startTitle",
    "startSubtitle",
    "startCardScratch",
    "startCardScratchDesc",
    "startCardUpload",
    "startCardUploadDesc",
    "continueTitle",
    "continueText",
    "continueEditing",
    "createNewCv",
    "lastEdited",
    "newCvConfirmTitle",
    "newCvConfirmText",
    "newCvConfirmAction",
    "chooseTemplateTitle",
    "chooseTemplateText",
    "continueCta",
    "tabDesign",
  ] as const;

  for (const lang of SUPPORTED_LANGUAGES) {
    it(`${lang}: all flow keys present and non-empty`, () => {
      const templates = dictionaries[lang].templates as Record<string, string>;
      for (const key of keys) {
        expect(templates[key], `${lang}.templates.${key}`).toBeTruthy();
        expect(String(templates[key]).trim().length, `${lang}.templates.${key}`).toBeGreaterThan(2);
      }
    });
  }
});

// The builder component itself compiles into this suite (import guard: a
// broken flow component would fail the whole module load above).
export { CvBuilder as __cvBuilderImportGuard };
