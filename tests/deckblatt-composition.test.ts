/**
 * Deckblatt VISUAL COMPOSITION regression suite (the "designed page" contract).
 *
 * Guards the eight production defects reported for the old composition:
 *  1. AI background only filling part of the A4 page
 *  2. large empty white area
 *  3. portrait rendered as a small circular sticker
 *  4. a person generated INTO the background by the model
 *  5. applicant information scattered / disconnected
 *  6. contact info pushed to the bottom without anchor or contrast
 *  7. overall not reading as a professional German Bewerbung Deckblatt
 *  8. a second, completely blank A4 page in the preview/export
 *
 * The rules under test live in src/lib/deckblatt/styles.ts (zones + prompt),
 * src/lib/deckblatt/render.ts + src/components/deckblatt-sheet.tsx
 * (the shared local composition) and src/app/globals.css (print geometry).
 * The preview-scaling suites (deckblatt-preview-scaling.test.ts,
 * preview-scaling.test.ts) separately guard the mobile fit-to-width fix —
 * the last section here cross-checks that it survived the rework.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DECKBLATT_HEIGHT,
  DECKBLATT_STYLES,
  DECKBLATT_WIDTH,
  buildDeckblattPrompt,
  selectDeckblattStyle,
} from "@/lib/deckblatt/styles";
import { buildDeckblattBaseImage } from "@/lib/deckblatt/pollinations";
import {
  contactDisplayLines,
  contactFontSize,
  heroBaselines,
  nameDisplayLines,
  nameLineSizes,
  professionFontSize,
  type DeckblattData,
} from "@/lib/deckblatt/render";
import { availableSheetWidth, computePreviewScale } from "@/lib/use-scaled-sheet";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (relative: string) => readFileSync(resolve(root, relative), "utf8");

/** Realistic worst case: two-line hero name (21 combined characters), the
 *  longest standard German occupation (43 characters), full contact set. */
const worstCase: DeckblattData = {
  firstName: "Maximilian",
  lastName: "Mustermann",
  profession: "Fachinformatiker für Anwendungsentwicklung",
  email: "max.mustermann@example-mail.de",
  phone: "+49 171 2345678",
  address: "Musterstraße 12, 50667 Köln",
};

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const inPage = (z: Rect): boolean =>
  z.x >= 0 && z.y >= 0 && z.x + z.w <= DECKBLATT_WIDTH && z.y + z.h <= DECKBLATT_HEIGHT;

const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/** Independent percentage formatter (mirrors the prompt's zone text). */
const pct = (n: number, total: number): number => Math.round((n / total) * 100);

// WCAG contrast helpers (relative luminance + contrast ratio).
function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}
function parseRgba(value: string): [number, number, number, number] {
  const m = value.match(/rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)/);
  if (!m) throw new Error(`unexpected rgba format: ${value}`);
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
}
function rgbaOver(
  fg: [number, number, number, number],
  bg: [number, number, number],
): [number, number, number] {
  return [
    fg[0] * fg[3] + bg[0] * (1 - fg[3]),
    fg[1] * fg[3] + bg[1] * (1 - fg[3]),
    fg[2] * fg[3] + bg[2] * (1 - fg[3]),
  ];
}
function relLuminance(rgb: [number, number, number]): number {
  const channel = (v: number): number => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}
function contrastRatio(fg: [number, number, number], bg: [number, number, number]): number {
  const l1 = relLuminance(fg);
  const l2 = relLuminance(bg);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

// ---------------------------------------------------------------------------
// 1. Full A4 composition — every element inside the 1240×1754 sheet
// ---------------------------------------------------------------------------

describe("full A4 composition (all six styles)", () => {
  for (const style of Object.values(DECKBLATT_STYLES)) {
    it(`${style.id}: portrait, contact card, title and profession zones are fully in-page`, () => {
      const { zones, divider } = style.layout;
      expect(inPage(zones.portrait), "portrait zone escapes the sheet").toBe(true);
      expect(inPage(zones.contact), "contact card escapes the sheet").toBe(true);
      expect(inPage(zones.title), "title zone escapes the sheet").toBe(true);
      expect(inPage(zones.profession), "profession zone escapes the sheet").toBe(true);
      expect(
        inPage(divider),
        "divider escapes the sheet",
      ).toBe(true);
      if (style.layout.band) expect(inPage(style.layout.band), "band escapes the sheet").toBe(true);
    });

    it(`${style.id}: no two composition blocks overlap (card/portrait/band are disjoint)`, () => {
      const { zones, band } = style.layout;
      expect(overlaps(zones.portrait, zones.contact), "portrait overlaps contact card").toBe(false);
      if (band) expect(overlaps(band, zones.contact), "band overlaps contact card").toBe(false);
    });
  }

  it("the renderer paints the base underlay FULL-BLEED before the AI background", () => {
    const renderer = read("src/lib/deckblatt/render.ts");
    const underlayIdx = renderer.indexOf("baseGradient.addColorStop(0, L.base.top)");
    expect(underlayIdx).toBeGreaterThan(-1);
    // The underlay covers the whole canvas …
    expect(renderer.slice(underlayIdx, underlayIdx + 400)).toContain(
      "ctx.fillRect(0, 0, DECKBLATT_WIDTH, DECKBLATT_HEIGHT)",
    );
    // … and the AI background is cover-fitted onto the FULL canvas (edge
    // to edge) — the "background only on the left half" bug class.
    const bgIdx = renderer.indexOf("ctx.drawImage(background,");
    expect(bgIdx).toBeGreaterThan(underlayIdx);
    expect(renderer.slice(bgIdx, bgIdx + 200)).toContain(
      "0, 0, DECKBLATT_WIDTH, DECKBLATT_HEIGHT",
    );
    // The HTML twin uses the SAME base gradient (never raw white).
    const sheet = read("src/components/deckblatt-sheet.tsx");
    expect(sheet).toContain("linear-gradient(180deg, ${L.base.top} 0%, ${L.base.bottom} 100%)");
  });

  it("the prompt demands 100% canvas coverage and its reserved areas match the local zones", () => {
    for (const style of Object.values(DECKBLATT_STYLES)) {
      const prompt = buildDeckblattPrompt(style, "Auszubildender");
      expect(prompt).toContain("100% of the width and 100% of the height");
      const p = style.layout.zones.portrait;
      expect(prompt).toContain(
        `Portrait area (from ${pct(p.x, DECKBLATT_WIDTH)}% to ${pct(p.x + p.w, DECKBLATT_WIDTH)}% of the width and from ${pct(p.y, DECKBLATT_HEIGHT)}% to ${pct(p.y + p.h, DECKBLATT_HEIGHT)}% of the height)`,
      );
      const c = style.layout.zones.contact;
      expect(prompt).toContain(
        `Contact area (from ${pct(c.x, DECKBLATT_WIDTH)}% to ${pct(c.x + c.w, DECKBLATT_WIDTH)}% of the width and from ${pct(c.y, DECKBLATT_HEIGHT)}% to ${pct(c.y + c.h, DECKBLATT_HEIGHT)}% of the height)`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 2. No generated people — structurally impossible + prompt-enforced
// ---------------------------------------------------------------------------

describe("no generated people", () => {
  const NO_PEOPLE_MARKERS = [
    "CRITICAL — ABSOLUTELY NO PEOPLE IN THE IMAGE (hard requirement):",
    "Do not include any person, human figure, face, head, body, hand or silhouette.",
    "Do not include workers, candidates, students, models, mannequins, cartoon or robotic people.",
    "Do not include the person from any reference image. Do not depict anyone at all.",
    "The image must contain zero humans. If in doubt, keep the area abstract.",
  ];

  for (const style of Object.values(DECKBLATT_STYLES)) {
    it(`${style.id}: every prompt carries the full no-people battery`, () => {
      const prompt = buildDeckblattPrompt(style, "Kaufmann im E-Commerce");
      for (const marker of NO_PEOPLE_MARKERS) {
        expect(prompt, `missing: ${marker}`).toContain(marker);
      }
    });
  }

  it("the profession-aware selection still yields a person-free prompt", () => {
    const style = selectDeckblattStyle("Kaufmann im E-Commerce");
    expect(style.id).toBe("digital");
    expect(buildDeckblattPrompt(style, "Kaufmann im E-Commerce")).toContain("zero humans");
  });

  it("the provider payload NEVER contains the applicant's photo", () => {
    const provider = read("src/lib/deckblatt/pollinations.ts");
    const route = read("src/app/api/deckblatt/generate/route.ts");
    // The edits input is the neutral base only.
    expect(provider).toContain("image: [{ image_url: baseImage }]");
    expect(provider).not.toContain("portraitDataUrl");
    expect(route).toContain("generateDeckblattDesign(prompt, buildDeckblattBaseImage(style))");
    expect(route).not.toContain("generateDeckblattDesign(prompt, photo)");
    // …while the API contract stays: the photo is still received + validated.
    expect(route).toContain("validateDeckblattPhotoDataUrl(photo)");
  });

  it("the base image is a valid, deterministic 512×768 RGB PNG in the style palette", () => {
    const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    for (const style of Object.values(DECKBLATT_STYLES)) {
      const dataUrl = buildDeckblattBaseImage(style);
      expect(dataUrl.startsWith("data:image/png;base64,")).toBe(true);
      const bytes = Buffer.from(dataUrl.split(",")[1], "base64");
      expect(Array.from(bytes.slice(0, 8))).toEqual(PNG_SIGNATURE);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      expect(bytes[12]).toBe(0x49); // "I"
      expect(bytes[13]).toBe(0x48); // "H"
      expect(view.getUint32(16)).toBe(512);
      expect(view.getUint32(20)).toBe(768);
      expect(bytes[24]).toBe(8); // bit depth
      expect(bytes[25]).toBe(2); // color type: truecolor RGB
      // Deterministic: same style → same payload bytes.
      expect(buildDeckblattBaseImage(style)).toBe(dataUrl);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Portrait zone — a MAJOR element (35–45% page width × 30–45% page height)
// ---------------------------------------------------------------------------

describe("portrait zone (the major element)", () => {
  for (const style of Object.values(DECKBLATT_STYLES)) {
    it(`${style.id}: portrait occupies 35–45% of the width AND 30–45% of the height`, () => {
      const p = style.layout.zones.portrait;
      const wShare = p.w / DECKBLATT_WIDTH;
      const hShare = p.h / DECKBLATT_HEIGHT;
      expect(wShare).toBeGreaterThanOrEqual(0.35);
      expect(wShare).toBeLessThanOrEqual(0.45);
      expect(hShare).toBeGreaterThanOrEqual(0.3);
      expect(hShare).toBeLessThanOrEqual(0.45);
    });

    it(`${style.id}: shape and radius are consistent (true circle / sane rect)`, () => {
      const ph = style.layout.photo;
      if (ph.shape === "circle") {
        expect(ph.w).toBe(ph.h);
        expect(ph.radius).toBe(ph.w / 2);
      } else {
        expect(ph.radius).toBeGreaterThan(0);
        expect(ph.radius).toBeLessThan(Math.min(ph.w, ph.h) / 2);
      }
      // The zones' portrait rect IS the photo rect (single source of truth).
      expect(style.layout.zones.portrait).toEqual({
        x: ph.x,
        y: ph.y,
        w: ph.w,
        h: ph.h,
      });
    });
  }
});

// ---------------------------------------------------------------------------
// 4. Text safe zones — text never over the portrait, never off the page
// ---------------------------------------------------------------------------

describe("text safe zones", () => {
  for (const style of Object.values(DECKBLATT_STYLES)) {
    it(`${style.id}: title/profession zones stop ≥ 24px before the portrait`, () => {
      const { title, profession, portrait } = style.layout.zones;
      expect(title.x + title.w).toBeLessThanOrEqual(portrait.x - 24);
      expect(profession.x + profession.w).toBeLessThanOrEqual(portrait.x - 24);
    });

    it(`${style.id}: the worst-case hero block (2-line name) never reaches the contact card`, () => {
      const hero = heroBaselines(style, worstCase);
      expect(nameDisplayLines(worstCase)).toHaveLength(2);
      const lowestInk = Math.max(
        hero.profession,
        hero.divider + style.layout.divider.h,
      );
      expect(lowestInk + 20).toBeLessThanOrEqual(style.layout.zones.contact.y);
    });

    it(`${style.id}: the fitted name lines stay inside their zone (both renderers share the math)`, () => {
      const L = style.layout;
      const sizes = nameLineSizes(worstCase, style);
      nameDisplayLines(worstCase).forEach((line, i) => {
        const inkWidth = line.length * sizes[i] * 0.6; // bold factor, as in fitFontSize
        expect(inkWidth).toBeLessThanOrEqual(L.name.w);
        // …and the ink's right edge stays clear of the portrait.
        expect(L.name.x + inkWidth).toBeLessThanOrEqual(L.zones.portrait.x - 4);
      });
    });

    it(`${style.id}: even the longest German occupation stays clear of the portrait`, () => {
      const L = style.layout;
      const size = professionFontSize(worstCase, style);
      const inkWidth = worstCase.profession.length * size * 0.5;
      expect(L.profession.x + inkWidth).toBeLessThanOrEqual(L.zones.portrait.x - 4);
    });
  }
});

// ---------------------------------------------------------------------------
// 5. Contact zone — a deliberate, contained, high-contrast card
// ---------------------------------------------------------------------------

describe("contact zone (deliberate card with contrast)", () => {
  for (const style of Object.values(DECKBLATT_STYLES)) {
    it(`${style.id}: the card is a self-contained block with semi-opaque fill (α ≥ 0.6)`, () => {
      const card = style.layout.contactCard;
      expect(card.w).toBeGreaterThanOrEqual(600);
      expect(card.h).toBeGreaterThanOrEqual(180);
      expect(inPage(card)).toBe(true);
      const [, , , alpha] = parseRgba(card.background);
      expect(alpha).toBeGreaterThanOrEqual(0.6);
    });

    it(`${style.id}: all contact lines render INSIDE the card with padding`, () => {
      const L = style.layout;
      const card = L.contactCard;
      const size = contactFontSize(worstCase, style);
      const lines = contactDisplayLines(worstCase);
      expect(lines).toHaveLength(3); // email, phone, address
      lines.forEach((_line, i) => {
        const baseline = L.contact.y + i * L.contact.lineGap;
        expect(baseline - size * 0.8, "ascender above card").toBeGreaterThanOrEqual(card.y + 16);
        expect(baseline + size * 0.3, "descender below card").toBeLessThanOrEqual(
          card.y + card.h - 16,
        );
      });
      expect(L.contact.x).toBeGreaterThanOrEqual(card.x + 24);
      expect(L.contact.x + L.contact.w).toBeLessThanOrEqual(card.x + card.w - 24);
      // The widest line fits the card's inner width at the fitted size.
      const widest = Math.max(...lines.map((l) => l.length));
      expect(widest * size * 0.5).toBeLessThanOrEqual(L.contact.w);
    });

    it(`${style.id}: contact text vs. card background has ≥ 4.5:1 contrast (WCAG AA+)`, () => {
      const card = style.layout.contactCard;
      // Composite the semi-opaque card over the style's base BOTTOM color
      // (the darkest part of the sheet's own gradient — a conservative
      // backdrop; the AI design adds detail, the α ≥ 0.6 fill dominates).
      const backdrop = rgbaOver(parseRgba(card.background), hexToRgb(style.layout.base.bottom));
      const ratio = contrastRatio(hexToRgb(style.layout.contact.color), backdrop);
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    });
  }
});

// ---------------------------------------------------------------------------
// 6. Exactly ONE printed A4 page (no second blank page)
// ---------------------------------------------------------------------------

describe("exactly one printed A4 page", () => {
  const globals = read("src/app/globals.css");
  const printBlock = globals.slice(globals.indexOf("/* Deckblatt print export"));

  it("the printable box is strictly below the physical A4 page in px (engine-proof)", () => {
    // A4 @ 96dpi: 210mm = 793.70px, 297mm = 1122.52px. The shipped box must
    // be strictly smaller in BOTH dimensions — the old `height: 297mm` sat
    // exactly on the page boundary; WebKit (iOS Safari) rounds that PAST the
    // page height and emits the second, completely blank A4 page.
    const sheetRule =
      printBlock.match(/\.deckblatt-print-root \.deckblatt-sheet \{[^}]*\}/)?.[0] ?? "";
    const w = Number(sheetRule.match(/width: (\d+)px/)?.[1]);
    const h = Number(sheetRule.match(/height: (\d+)px/)?.[1]);
    expect(w).toBe(793);
    expect(h).toBe(1122);
    expect(w).toBeLessThan((210 / 25.4) * 96);
    expect(h).toBeLessThan((297 / 25.4) * 96);
    // …while the scaled design content still covers the box on every edge
    // (1240×1754 × 0.64 = 793.6×1122.6px > 793×1122px) — no white sliver.
    expect(DECKBLATT_WIDTH * 0.64).toBeGreaterThan(w);
    expect(DECKBLATT_HEIGHT * 0.64).toBeGreaterThan(h);
  });

  it("the print root pins the document box (no stray block can add a page)", () => {
    expect(printBlock).toContain(
      "body.deckblatt-print-active .deckblatt-print-root {\n    display: block !important;\n    width: 793px !important;\n    height: 1122px !important;\n    margin: 0 !important;\n    padding: 0 !important;\n    overflow: hidden !important;\n  }",
    );
    expect(printBlock).toContain("body.deckblatt-print-active {\n    background: #ffffff !important;\n    margin: 0 !important;\n    padding: 0 !important;\n  }");
    expect(printBlock).toContain("body.deckblatt-print-active .app-shell-root {\n    display: none !important;\n  }");
  });

  it("headless Chrome: the SHIPPED print CSS produces exactly 1 PDF page", () => {
    // Harness = the actual deckblatt print CSS extracted from globals.css +
    // the sheet's real 1240×1754 box → --print-to-pdf → page count.
    const cssEnd = printBlock.indexOf("/* Deckblatt generation shimmer");
    expect(cssEnd).toBeGreaterThan(0);
    const css = printBlock.slice(0, cssEnd);
    const html = `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>
      html, body { margin: 0; padding: 0; }
      * { box-sizing: border-box; }
      ${css}
    </style></head><body class="deckblatt-print-active">
      <div class="app-shell-root" style="min-height:100vh;background:#111;color:#fff">app shell</div>
      <div class="deckblatt-print-root" aria-hidden="true">
        <div class="deckblatt-sheet" style="position:relative;overflow:hidden;width:1240px;height:1754px;background:linear-gradient(180deg,#0d1526,#1c2b4d)">
          <div class="deckblatt-sheet-content" style="position:absolute;inset:0">
            <div style="position:absolute;inset:0;background:#0b1220"></div>
          </div>
        </div>
      </div>
    </body></html>`;
    const dir = mkdtempSync(join(tmpdir(), "deckblatt-print-"));
    const htmlPath = join(dir, "harness.html");
    const pdfPath = join(dir, "out.pdf");
    writeFileSync(htmlPath, html);
    execFileSync(
      "google-chrome",
      [
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--no-pdf-header-footer",
        `--print-to-pdf=${pdfPath}`,
        `file://${htmlPath}`,
      ],
      { stdio: "ignore", timeout: 90_000 },
    );
    const info = execFileSync("pdfinfo", [pdfPath], { encoding: "utf8", timeout: 30_000 });
    expect(info).toMatch(/Pages:\s+1\b/);
    expect(info).toMatch(/Page size:\s+594\.96 x 841\.92/);
  }, 120_000); // spawns a real headless Chrome — must exceed the internal 90 s budget
});

// ---------------------------------------------------------------------------
// 7. Final output stays 1240×1754 (PNG design resolution + A4 PDF)
// ---------------------------------------------------------------------------

describe("final output stays 1240×1754", () => {
  it("the design constants are untouched and the canvas paints exactly A4", () => {
    expect(DECKBLATT_WIDTH).toBe(1240);
    expect(DECKBLATT_HEIGHT).toBe(1754);
    const renderer = read("src/lib/deckblatt/render.ts");
    expect(renderer).toContain("canvas.width = DECKBLATT_WIDTH;");
    expect(renderer).toContain("canvas.height = DECKBLATT_HEIGHT;");
    expect(renderer).toContain('canvas.toDataURL("image/png")');
    expect(renderer).toContain("0, 0, DECKBLATT_WIDTH, DECKBLATT_HEIGHT");
  });

  it("the sheet (preview + print twin) keeps the true A4 box and LTR direction", () => {
    const sheet = read("src/components/deckblatt-sheet.tsx");
    expect(sheet).toContain("width: DECKBLATT_WIDTH,\n        height: DECKBLATT_HEIGHT,");
    expect(sheet).toContain('dir="ltr"');
    // The preview frame still scales the TRUE sheet (geometry untouched).
    const generator = read("src/components/deckblatt-generator.tsx");
    expect(generator).toContain("width: Math.round(DECKBLATT_WIDTH * preview.scale),");
    expect(generator).toContain("height: Math.round(DECKBLATT_HEIGHT * preview.scale),");
  });
});

// ---------------------------------------------------------------------------
// 8+9. Mobile scaling regression — the fit-to-width fix survived the rework
// ---------------------------------------------------------------------------

describe("mobile scaling regression (320–430px, no horizontal overflow)", () => {
  // Same chain as deckblatt-preview-scaling.test.ts: viewport → 1px card
  // borders → padded container (p-4 / sm:p-6).
  const paddingInline = (viewport: number) => (viewport >= 640 ? 48 : 32);

  for (const viewport of [320, 375, 390, 393, 430] as const) {
    it(`viewport ${viewport}px: the scaled A4 frame fits, nothing clipped`, () => {
      const available = availableSheetWidth(viewport - 2, paddingInline(viewport));
      const scale = computePreviewScale(available, DECKBLATT_WIDTH, 1);
      const displayWidth = DECKBLATT_WIDTH * scale;
      const displayHeight = DECKBLATT_HEIGHT * scale;
      expect(displayWidth).toBeLessThanOrEqual(available + 1e-9);
      expect(displayWidth).toBeLessThanOrEqual(viewport);
      expect(displayHeight / displayWidth).toBeCloseTo(DECKBLATT_HEIGHT / DECKBLATT_WIDTH, 12);
    });
  }

  it("the preview column keeps the bottom-nav clearance and the ltr pin", () => {
    const generator = read("src/components/deckblatt-generator.tsx");
    expect(generator).toContain('className="min-w-0 pb-24 lg:pb-0" dir="ltr"');
    expect(generator).toContain("flex w-full justify-center overflow-x-clip p-4 sm:p-6");
    expect(generator).toContain('direction: "ltr",');
  });
});
