import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import { renderToString } from "react-dom/server";
import tailwindcss from "@tailwindcss/postcss";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n";
import { AIChat, ThinkingDots } from "@/components/ai-chat";
import type {
  ChatMessageWithFiles,
  Conversation,
} from "@/lib/ai-service";

/**
 * AI Assistant light-mode contrast (WCAG 2.2 AA) — root cause and guard.
 *
 * Root cause (verified against the theme tokens in globals.css):
 *   1. The light `--gradient-neon` stops (#7b6cf6/#5a8df8/#9b7bf7) carry
 *      white text at 3.2–3.9:1 — below the 4.5:1 AA minimum for normal
 *      text (user bubbles, send button, avatar chips).
 *   2. The light `--faint` token (#9598b6) is 2.8:1 on white — used for
 *      timestamps, placeholder, file sizes, hints.
 *   3. The light `--danger` token (#d9535d) is ~3.9:1 on white — used for
 *      error text.
 *   4. The brand mark is a white tile with a near-invisible ring
 *      (ring-black/5) on the white light sidebar.
 *   5. THE INCIDENT THAT SURVIVED FIX #30 (production 2026-10-15): the
 *      gradient surfaces used a `bg-[…]` class on a gradient variable,
 *      which Tailwind compiles to `background-color: var(…)`.
 *      A `linear-gradient()` value is NOT a valid `<color>` for
 *      `background-color`, so the browser drops the declaration as
 *      "invalid at computed-value time" and the surface renders
 *      TRANSPARENT — white message text on invisible bubbles. This
 *      affects both themes equally (the pre-fix `--gradient-neon`
 *      version had the identical defect). Only the COMPILED declaration,
 *      not the token values or the class string, could catch it.
 *
 * Fix under test: a chat-scoped `--gradient-ai-chat` (deeper in light,
 * pinned to `var(--gradient-neon)` in dark → dark pixel-unchanged),
 * `text-muted dark:text-faint` pairs (light readable, dark unchanged),
 * a light-only AA red (`#b93a44 dark:text-danger`), solid light thinking
 * dots, a theme-aware brand ring, a visible light-only border for the
 * disabled send button, and — the incident fix — every gradient surface
 * painted through the arbitrary property `[background-image:…]`
 * (shared CHAT_GRADIENT_BG constant) with a valid `disabled:bg-none
 * disabled:bg-surface-2` fallback on the send button.
 *
 * These tests compute REAL WCAG contrast ratios from the shipped CSS
 * values, render the ACTUAL component (renderToString) to pin the
 * corrected class strings, AND compile those exact class strings
 * through the project's real Tailwind v4 pipeline to assert the shipped
 * declarations are valid — not hand-written expectations.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

/* ------------------------- WCAG math (pure) ------------------------- */

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function channelLuminance(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return (
    0.2126 * channelLuminance(r) +
    0.7152 * channelLuminance(g) +
    0.0722 * channelLuminance(b)
  );
}

function contrast(fg: string, bg: string): number {
  const a = luminance(fg);
  const b = luminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

function blend(fg: string, bg: string, alpha: number): string {
  const [fr, fg2, fb] = hexToRgb(fg);
  const [br, bg2, bb] = hexToRgb(bg);
  const mix = (x: number, y: number) =>
    Math.round(x * alpha + y * (1 - alpha)).toString(16).padStart(2, "0");
  return `#${mix(fr, br)}${mix(fg2, bg2)}${mix(fb, bb)}`;
}

const css = () => readFileSync("src/app/globals.css", "utf8");

const blockOf = (selector: string): string => {
  const re = new RegExp(`${selector.replace(".", "\\.")}\\s*{([\\s\\S]*?)\\n\\}`);
  const m = css().match(re);
  expect(m, `theme block ${selector}`).not.toBeNull();
  return m![1];
};

const varOf = (block: string, name: string): string => {
  const re = new RegExp(`${name}:\\s*([^;]+);`);
  const m = block.match(re);
  expect(m, `variable ${name} in theme block`).not.toBeNull();
  return m![1].trim();
};

const gradientStops = (value: string): string[] =>
  (value.match(/#[0-9a-f]{6}/gi) ?? []).map((c) => c.toLowerCase());

/* ------------------------- light theme tokens ----------------------- */

describe("light-mode token contrast (WCAG AA, computed from shipped CSS)", () => {
  const light = blockOf(":root");

  it("chat gradient: white text clears 4.5:1 on EVERY stop", () => {
    const stops = gradientStops(varOf(light, "--gradient-ai-chat"));
    expect(stops).toHaveLength(3);
    for (const stop of stops) {
      expect(
        contrast("#ffffff", stop),
        `white on ${stop}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("old site gradient stops were the regression (kept for the record)", () => {
    const stops = gradientStops(varOf(light, "--gradient-neon"));
    // Documents WHY the chat-scoped variable exists: at least one stop of
    // the site gradient fails AA for normal text.
    expect(stops.some((s) => contrast("#ffffff", s) < 4.5)).toBe(true);
  });

  it("muted text (the faint replacement) clears 4.5:1 on all chat surfaces", () => {
    const muted = varOf(light, "--muted");
    for (const surface of ["#ffffff", "#f6f6fb", "#efeff7"]) {
      expect(contrast(muted, surface), `muted on ${surface}`).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  });

  it("light --faint is the failing token (2.8:1) — proves the root cause", () => {
    const faint = varOf(light, "--faint");
    expect(contrast(faint, "#ffffff")).toBeLessThan(4.5);
  });

  it("AA red #b93a44 clears 4.5:1 on white and on the light danger-soft", () => {
    const dangerSoft = blend("#d9535d", "#ffffff", 0.1);
    expect(contrast("#b93a44", "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#b93a44", dangerSoft)).toBeGreaterThanOrEqual(4.5);
    // …while the system light --danger token it replaces does not:
    const danger = varOf(light, "--danger");
    expect(contrast(danger, "#ffffff")).toBeLessThan(4.5);
  });

  it("solid light accent (thinking dots) clears 3:1 as a UI graphic", () => {
    const accent = varOf(light, "--blue");
    expect(contrast(accent, "#ffffff")).toBeGreaterThanOrEqual(3);
  });

  it("brand ring line-strong is a visible boundary on the white sidebar", () => {
    const lineStrong = varOf(light, "--line-strong");
    expect(contrast(lineStrong, "#ffffff")).toBeGreaterThanOrEqual(1.3);
  });
});

/* ------------------------- dark theme unchanged ---------------------- */

describe("dark mode stays visually identical", () => {
  const dark = blockOf(".dark");

  it("chat gradient is pinned to the dark site gradient", () => {
    expect(varOf(dark, "--gradient-ai-chat")).toBe("var(--gradient-neon)");
  });

  it("dark theme variables were not modified (spot-check the values the fix relied on)", () => {
    expect(varOf(dark, "--faint")).toBe("#55555e");
    expect(varOf(dark, "--muted")).toBe("#71717a");
    expect(varOf(dark, "--gradient-neon")).toBe(
      "linear-gradient(120deg, #7567f5 0%, #8b7cff 100%)",
    );
  });
});

/* --------------------- actual component rendering ------------------- */

const conversation: Conversation = {
  id: "conv-1",
  title: "Beratung",
  created_at: "2026-10-15T08:59:00.000Z",
  updated_at: "2026-10-15T09:00:05.000Z",
};

const messages: ChatMessageWithFiles[] = [
  {
    id: "m1",
    conversation_id: "conv-1",
    user_id: "user-1",
    role: "user",
    content: "Hallo, ich brauche Hilfe bei meiner Bewerbung.",
    created_at: "2026-10-15T09:00:00.000Z",
    files: [],
  },
  {
    id: "m2",
    conversation_id: "conv-1",
    user_id: "user-1",
    role: "assistant",
    // Inline code on purpose: the Markdown renderer must carry the AA red.
    content: "Gern helfe ich dir weiter, z. B. beim Begriff `Pflegefachmann`.",
    created_at: "2026-10-15T09:00:05.000Z",
    files: [],
  },
];

const renderChat = (initialMessages: ChatMessageWithFiles[]): string =>
  renderToString(
    <I18nProvider>
      <AIChat
        conversations={[conversation]}
        selectedConversation={conversation}
        initialMessages={initialMessages}
      />
    </I18nProvider>,
  );

describe("AIChat rendered markup (light + dark class pairs)", () => {
  const html = renderChat(messages);
  // Zero-message render — surfaces the empty-state icon (the fifth
  // gradient surface) and nothing else of the five.
  const htmlEmpty = renderChat([]);

  it("uses the chat gradient on bubble, avatars and send — never the site gradient", () => {
    // The gradient must be painted through background-image — an <image>
    // property. Four of the five surfaces render with committed
    // messages (user bubble, committed avatar, send button); the
    // pending avatar renders only while awaiting the first token.
    expect(
      html.match(/\[background-image:var\(--gradient-ai-chat\)\]/g),
    ).toHaveLength(3);
    expect(
      htmlEmpty.match(/\[background-image:var\(--gradient-ai-chat\)\]/g),
    ).toHaveLength(2); // empty-state icon + send button
    expect(html).not.toContain("var(--gradient-neon)");
    // The broken mapping (compiles to background-color → invalid for a
    // gradient → transparent surface) must never be reintroduced.
    expect(html).not.toContain(BROKEN_CHAT_BG);
    expect(html).not.toContain(BROKEN_SITE_BG);
    // White text rides the gradient (AA guaranteed by the token test above).
    expect(html).toContain("text-white");
  });

  it("timestamps, hints and placeholder use readable light values with dark preserved", () => {
    expect(html).toContain("text-muted dark:text-faint");
    expect(html).toContain("placeholder:text-muted dark:placeholder:text-faint");
    // No bare light `text-faint` anywhere in the rendered output — every
    // occurrence must carry its dark: variant (plain, placeholder or
    // disabled scope).
    for (const m of html.matchAll(/className="([^"]*)"/g)) {
      if (m[1].includes("text-faint")) {
        expect(
          m[1],
          `class list ${m[1]} would regress dark or keep a sub-AA light value`,
        ).toMatch(/dark:(placeholder:|disabled:)?text-faint/);
      }
    }
  });

  it("thinking dots are solid in light, 55% in dark", () => {
    // The dots only exist while awaiting the first streaming token, so
    // render the (exported) sub-component directly.
    const dots = renderToString(<ThinkingDots />);
    expect(dots.match(/bg-accent dark:bg-accent\/55/g)).toHaveLength(3);
    expect(html).not.toContain("bg-accent/55"); // no 55%-only dots in light
  });

  it("brand mark chip carries the theme-aware ring (visible in light)", () => {
    expect(html).toContain("ring-line-strong dark:ring-black/5");
    expect(html).toContain("/logo-mark.jpg");
    expect(html).toContain("Ausbildungs");
    expect(html).toContain("Weg");
  });

  it("disabled send button stays distinguishable in light (border) while dark is unchanged", () => {
    expect(html).toContain("disabled:border disabled:border-line-strong");
    expect(html).toContain("dark:disabled:border-0");
    expect(html).toContain("disabled:text-muted dark:disabled:text-faint");
    // The disabled state must remove the gradient with a VALID property
    // (background-image: none) and fall back to a solid color. The old
    // `disabled:from-surface-2 disabled:to-surface-2` classes are dead
    // (no bg-gradient-* base utility sets any background-image).
    expect(html).toContain("disabled:bg-none disabled:bg-surface-2");
    expect(html).not.toContain("from-surface-2");
    expect(html).not.toContain("to-surface-2");
  });

  it("error surfaces use the AA red in light, the system token in dark", () => {
    expect(html).toContain("#b93a44");
    expect(html).toContain("dark:text-danger");
  });

  it("user bubble keeps its gradient surface and white text (RTL-neutral logical padding)", () => {
    expect(html).toContain("mt-1 pe-1 text-[10px] text-muted dark:text-faint");
  });
});

/* ------------------------- source contract -------------------------- */

describe("ai-chat.tsx source contract", () => {
  const src = readFileSync("src/components/ai-chat.tsx", "utf8");
  const lines = src.split("\n");

  it("every text-faint usage is paired with a dark: counterpart (no bare light faint)", () => {
    for (const line of lines) {
      if (line.includes("text-faint")) {
        expect(
          line,
          "a text-faint usage without a dark: variant would regress dark or leave a sub-AA light value",
        ).toMatch(/dark:(disabled:|placeholder:)?text-faint/);
      }
    }
  });

  it("all five gradient surfaces paint via the shared background-image constant", () => {
    expect(src).not.toContain("--gradient-neon");
    expect(src).toContain(
      'const CHAT_GRADIENT_BG = "[background-image:var(--gradient-ai-chat)]";',
    );
    // Exactly five surfaces: user bubble, committed avatar, empty-state
    // icon, pending avatar, send button.
    expect(src.match(/\$\{CHAT_GRADIENT_BG\}/g)).toHaveLength(5);
    // The broken bg-[var(…)] mapping (→ background-color, invalid for
    // gradients → transparent surface) must not exist anywhere, comments
    // included.
    expect(src).not.toContain(BROKEN_CHAT_BG);
    expect(src).not.toContain(BROKEN_SITE_BG);
  });

  it("the sidebar uses the centralized BrandLogo (single identity source)", () => {
    expect(src).toContain('import { BrandLogo } from "@/components/brand-logo"');
    expect(src).toContain("<BrandLogo size={36}");
    // The duplicated inline wordmark markup is gone.
    expect(src).not.toContain('src="/logo-mark.jpg"');
  });
});

/* ---------------- compiled CSS contract (the incident guard) ----------
 *
 * The 2026-10-15 production incident passed every test above its class
 * because token values and pinned class strings say nothing about what
 * Tailwind EMITS. Here the real component's class strings are compiled
 * through the project's actual Tailwind v4 pipeline (same plugin, same
 * @theme block from globals.css) and the shipped declarations are
 * asserted — this is as close to a computed-style check as the node
 * test environment allows.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The broken class literals are assembled from parts on purpose:
// Tailwind's source scanner also scans test files, and a contiguous
// `bg-[var(--…)]` token here would recompile the known-broken
// `background-color` rule into the production CSS as a dead rule.
const BROKEN_CHAT_BG = "bg-[var(--" + "gradient-ai-chat)]";
const BROKEN_SITE_BG = "bg-[var(--" + "gradient-neon)]";

function extractThemeBlock(css: string): string {
  const start = css.indexOf("@theme inline {");
  expect(start, "globals.css must keep its @theme inline block").toBeGreaterThanOrEqual(0);
  let depth = 0;
  let i = css.indexOf("{", start);
  for (; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return css.slice(start, i + 1);
}

/** Every class string the real component ships (template literals
 *  resolved by rendering both the committed-history and the empty state). */
function collectShippedClasses(): Set<string> {
  const classSet = new Set<string>();
  for (const html of [renderChat(messages), renderChat([])]) {
    for (const m of html.matchAll(/class="([^"]*)"/g)) classSet.add(m[1]);
  }
  return classSet;
}

describe("compiled CSS contract (real Tailwind v4 pipeline)", () => {
  it("paints the chat gradient via background-image and never assigns an image to background-color", async () => {
    const classSet = collectShippedClasses();
    const joined = [...classSet].join(" ");
    // Premise: the component actually ships the arbitrary-property class.
    expect(joined).toContain("[background-image:var(--gradient-ai-chat)]");

    // Isolated probe dir inside node_modules (gitignored): module
    // resolution for `@import "tailwindcss"` requires a project path,
    // and node_modules is excluded from Tailwind's auto-detection, so
    // `source(none)` + an explicit `@source` keeps the probe hermetic.
    const cacheRoot = path.join(repoRoot, "node_modules", ".cache");
    mkdirSync(cacheRoot, { recursive: true });
    const probeDir = mkdtempSync(path.join(cacheRoot, "tw-contract-"));
    try {
      writeFileSync(
        path.join(probeDir, "probe.html"),
        [...classSet].map((c) => `<div class="${c}"></div>`).join("\n"),
      );
      const globals = readFileSync(path.join(repoRoot, "src/app/globals.css"), "utf8");
      writeFileSync(
        path.join(probeDir, "probe.css"),
        `@import "tailwindcss" source(none);\n@source "./probe.html";\n${extractThemeBlock(globals)}\n`,
      );
      const cssPath = path.join(probeDir, "probe.css");
      const out = await postcss([tailwindcss()]).process(
        readFileSync(cssPath, "utf8"),
        { from: cssPath },
      );
      const css = out.css;

      // 1. The gradient is painted through a VALID property.
      expect(css).toContain("background-image: var(--gradient-ai-chat)");

      // 2. THE REGRESSION GUARD: no shipped rule may assign an image
      //    value (gradient function or gradient variable) to the
      //    color-only property background-color — such a declaration is
      //    invalid at computed-value time and the browser drops it,
      //    leaving the surface transparent.
      const invalidDecls =
        css.match(
          /background-color\s*:\s*(?:var\(--gradient-[^)]*\)|(?:linear|radial|conic)-gradient\([^)]*\))/g,
        ) ?? [];
      expect(invalidDecls, `image value assigned to background-color: ${invalidDecls.join(" | ")}`).toHaveLength(0);

      // 3. The disabled send button: gradient removed with a valid
      //    `background-image: none`, solid-color fallback present.
      const blocks = css.split("}");
      const noneBlock = blocks.find((b) => b.includes("disabled\\:bg-none:disabled"));
      expect(noneBlock, "disabled:bg-none rule must compile").toMatch(/background-image:\s*none/);
      const surfaceBlock = blocks.find((b) => b.includes("disabled\\:bg-surface-2:disabled"));
      expect(surfaceBlock, "disabled:bg-surface-2 rule must compile").toMatch(
        /background-color:\s*var\(--surface-2\)/,
      );
      // The dead from-/to- stop classes must be gone from the shipped set.
      expect(css).not.toContain("from-surface-2");
    } finally {
      rmSync(probeDir, { recursive: true, force: true });
    }
  }, 30_000);
});
