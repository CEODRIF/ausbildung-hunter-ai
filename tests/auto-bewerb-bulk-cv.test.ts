/**
 * AUTO BEWERB — Step 4: BULK tailored CV generation (source-of-truth contract).
 *
 * The redesigned step must (1) drive the EXISTING per-company generate-cv
 * API (quota/rate-limit/fact-guard unchanged), (2) persist every generated
 * CV via saveCompanyDocumentAction before it counts as successful,
 * (3) skip companies that already have a saved CV (never overwrite),
 * (4) keep preview and PDF export strictly scoped to one company id, and
 * (5) no longer render the per-company selection tabs.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(p, "utf8");
const STEP4 = read("src/components/auto-bewerb/step4-cv-generation.tsx");

describe("bulk CV generation contract (Step 4)", () => {
  it("uses the existing per-company generate-cv API", () => {
    expect(STEP4).toContain('"/api/auto-bewerb/generate-cv"');
    expect(STEP4).toContain("companyId: view.company.id");
  });

  it("persists each CV (save action) before it counts as successful", () => {
    expect(STEP4).toContain('saveCompanyDocumentAction(view.company.id, "cv", data.cv)');
  });

  it("skips companies that already have a saved CV — no unnecessary overwrite", () => {
    expect(STEP4).toContain("ws.companies.filter((c) => !c.cv)");
  });

  it("prevents duplicate concurrent bulk-generation operations", () => {
    expect(STEP4).toContain("if (running || targets.length === 0 || !ws.profile?.extracted) return;");
    // Per-company retry is blocked while a bulk run is in flight.
    expect(STEP4).toContain("if (running) return;");
  });

  it("continues past a single company's failure (no abort, per-company state)", () => {
    // Each outcome is stored per company; the loop has no early return on error.
    expect(STEP4).toContain('setPerCompany((p) => ({ ...p, [c.company.id]: outcome }))');
  });

  it("keeps preview and PDF export scoped to a single company id", () => {
    expect(STEP4).toContain("drafts.cv[previewView.company.id]");
    expect(STEP4).toContain("export-pdf?companyId=${encodeURIComponent(c.company.id)}&doc=cv");
    expect(STEP4).toContain("export-pdf?companyId=${encodeURIComponent(previewView.company.id)}&doc=cv");
  });

  it("no longer renders the per-company selection tabs", () => {
    expect(STEP4).not.toContain("CompanyPicker");
    expect(STEP4).not.toContain("cvGenTitle");
    expect(STEP4).not.toContain("generateCvButton");
    expect(STEP4).not.toContain("cvNotGenerated");
  });

  it("shows the required status states (none / generating / ready / failed)", () => {
    expect(STEP4).toContain("cvStatusNone");
    expect(STEP4).toContain("cvStatusGenerating");
    expect(STEP4).toContain("cvStatusReady");
    expect(STEP4).toContain("cvStatusFailed");
    expect(STEP4).toContain("cvRetry");
    expect(STEP4).toContain("cvPreviewButton");
  });
});
