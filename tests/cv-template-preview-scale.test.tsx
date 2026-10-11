import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CvTemplateSelector } from "@/components/cv-template-selector";
import { buildDemoCv } from "@/components/cv-templates/demo-cv";
import { I18nProvider } from "@/lib/i18n";
import { cvEmpty, type CvDocument } from "@/lib/templates/cv";
import type { CvLabels } from "@/components/cv-document";

/**
 * Regression: desktop CV template previews were clipped horizontally.
 *
 * Root cause locked in here: the large gallery scaled the 794px A4 sheet
 * with `transform: scale(calc(100cqi / 794px))` — a container-query unit
 * that did NOT resolve against the preview card and fell back to the
 * VIEWPORT width. Result: scale ≈ viewport/794 (≈1.3–1.6 on 1024–1440px
 * desktops), so the sheet rendered far wider than the card and
 * `overflow-hidden` clipped the right side. Mobile only looked correct by
 * coincidence (viewport width ≈ card width in the 1-column layout).
 *
 * The fix measures the card's rendered width (ResizeObserver) and scales
 * by `containerWidth / CV_SHEET_WIDTH` — exact at every width, no
 * container-query dependency, A4 ratio preserved by the aspect-ratio box.
 */

const selector = readFileSync(
  "src/components/cv-template-selector.tsx",
  "utf8",
);

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

function sampleCv(): CvDocument {
  const cv = cvEmpty();
  cv.personal.fullName = "Alex Morgan";
  cv.personal.professionalTitle = "Project Coordinator";
  cv.personal.email = "alex.morgan@email.com";
  return cv;
}

function renderLarge(): string {
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      null,
      createElement(CvTemplateSelector, {
        size: "large",
        showTitle: false,
        cv: sampleCv(),
        previewCv: buildDemoCv(),
        labels: LABELS,
        selected: "classic" as const,
        onSelect: () => undefined,
      }),
    ),
  );
}

function renderCompact(): string {
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      null,
      createElement(CvTemplateSelector, {
        cv: sampleCv(),
        labels: LABELS,
        selected: "classic" as const,
        onSelect: () => undefined,
      }),
    ),
  );
}

describe("root cause: the viewport-resolved cqi scale is gone", () => {
  it("no container-query unit or container-type in the selector", () => {
    expect(selector).not.toContain("100cqi");
    expect(selector).not.toContain("cqi");
    expect(selector).not.toContain("containerType");
  });

  it("scale is computed from the MEASURED container width", () => {
    // The fit scale = box.clientWidth / 794, kept fresh by a
    // ResizeObserver (window-resize fallback for old engines):
    expect(selector).toContain("clientWidth");
    expect(selector).toContain("/ CV_SHEET_WIDTH");
    expect(selector).toContain("ResizeObserver");
    // The measured scale is what reaches the transform:
    expect(selector).toContain("`scale(${scale})`");
    // Until the first measurement (SSR/pre-hydration) the sheet renders at
    // scale(0) INSIDE the aspect-ratio box: no overflow flash, no CLS.
    expect(selector).toContain('"scale(0)"');
  });

  it("A4 proportions and sheet geometry are preserved", () => {
    expect(selector).toContain('aspectRatio: "794 / 1123"');
    expect(selector).toContain("width: CV_SHEET_WIDTH");
    expect(selector).toContain('transformOrigin: "top left"');
    expect(selector).toContain("overflow-hidden");
  });

  it("the compact (mobile/dense) path is unchanged — fixed 132px box, deterministic scale", () => {
    expect(selector).toContain("const THUMB_W = 132;");
    expect(selector).toContain(
      "const THUMB_SCALE = THUMB_W / CV_SHEET_WIDTH;",
    );
    // Fixed-height A4-ratio box:
    expect(selector).toContain(
      '"pointer-events-none overflow-hidden border-b border-line bg-surface-2/60"',
    );
    // Centered scaled sheet inside it (the original mobile behavior):
    expect(selector).toContain('className="mx-auto"');
    expect(selector).toContain("transform: `scale(${thumbScale})`");
    expect(selector).toContain('transformOrigin: "top center"');
  });
});

describe("rendered output (SSR snapshot of the markup)", () => {
  it("large gallery: 4 A4 cards, sheet at 794px, safe pre-measurement scale, no cqi", () => {
    const html = renderLarge();
    // All four templates, radio semantics intact:
    expect(html.match(/role="radio"/g)).toHaveLength(4);
    // Each card: the A4-ratio preview box:
    expect(html.match(/aspect-ratio:794 \/ 1123/g)).toHaveLength(4);
    // Each card: the 794px fit wrapper AND the template's own 794px root
    // sheet (2 per card, 8 total):
    expect(html.match(/width:794px/g)).toHaveLength(8);
    // Each wrapper: hidden (scale 0) until the client measures the card —
    // nothing can overflow the SSR markup:
    expect(html.match(/transform:scale\(0\)/g)).toHaveLength(4);
    expect(html).not.toContain("cqi");
    // Selection indicator preserved: exactly one card is checked:
    expect(html.match(/aria-checked="true"/g)).toHaveLength(1);
  });

  it("compact gallery: fixed 132×187 boxes, deterministic scale, centered", () => {
    const html = renderCompact();
    expect(html.match(/role="radio"/g)).toHaveLength(4);
    // Fixed-height A4-ratio thumbnail boxes (the unchanged mobile geometry):
    expect(html.match(/height:187px/g)).toHaveLength(4);
    // Deterministic thumbnail scale (132/794) applied to the 794px sheet —
    // wrapper + template root per card:
    expect(html.match(/width:794px/g)).toHaveLength(8);
    expect(html.match(/transform:scale\(0\.16624/g)).toHaveLength(4);
    // Centered inside the fixed box (mobile behavior unchanged):
    expect(html.match(/class="mx-auto"/g)).toHaveLength(4);
    expect(html.match(/transform-origin:top center/g)).toHaveLength(4);
    expect(html).not.toContain("cqi");
  });
});
