import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { htmlToText, sanitizeEmailHtml } from "@/lib/application-drafts";
import { langPreloadScript } from "@/lib/i18n/core";
import { themePreloadScript } from "@/lib/theme";

/**
 * XSS contracts.
 *
 * The app has exactly TWO HTML sinks, and both are pinned here:
 *  1. `RichEmailEditor` mounts stored draft HTML with `innerHTML`.
 *  2. `app/layout.tsx` injects two bootstrap scripts via
 *     `dangerouslySetInnerHTML`.
 * Everything else renders through React (auto-escaped) or react-markdown
 * (escapes raw HTML unless a rehype-raw plugin is added — asserted below).
 *
 * The payloads are the classic ones: a sanitizer that only strips `<script>`
 * still loses to `<img onerror>`, `<svg onload>` or a `javascript:` href.
 */
const root = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/+$/, "");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

const XSS_PAYLOADS = [
  `<script>alert(1)</script>`,
  `<img src=x onerror=alert(1)>`,
  `<svg onload=alert(1)>`,
  `<body onload=alert(1)>`,
  `<iframe src="javascript:alert(1)"></iframe>`,
  `<a href="javascript:alert(1)">click</a>`,
  `<a href="JaVaScRiPt:alert(1)">click</a>`,
  `<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>`,
  `<div onmouseover="alert(1)">hover</div>`,
  `<p style="background:url(javascript:alert(1))">styled</p>`,
  `<object data="data:text/html,<script>alert(1)</script>"></object>`,
  `<embed src="data:text/html,<script>alert(1)</script>">`,
  `<form action="https://evil.example"><input name=x></form>`,
  `<style>@import url("https://evil.example/x.css");</style>`,
  `<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>`,
  `"><script>alert(1)</script>`,
];

/** Nothing that can execute or navigate in any of the payloads above. */
function expectInert(html: string) {
  const lower = html.toLowerCase();
  expect(lower).not.toContain("<script");
  expect(lower).not.toContain("javascript:");
  expect(lower).not.toContain("<iframe");
  expect(lower).not.toContain("<object");
  expect(lower).not.toContain("<embed");
  expect(lower).not.toContain("<form");
  expect(lower).not.toContain("<style");
  expect(lower).not.toContain("<svg");
  expect(lower).not.toContain("<math");
  // No inline event handlers survive.
  expect(/\son[a-z]+\s*=/.test(lower)).toBe(false);
}

describe("sanitizeEmailHtml neutralises stored-XSS payloads", () => {
  for (const payload of XSS_PAYLOADS) {
    it(`inerts ${payload.slice(0, 42)}`, () => {
      expectInert(sanitizeEmailHtml(payload));
    });
  }

  it("keeps ordinary formatting and safe links intact", () => {
    const clean = sanitizeEmailHtml(
      `<p>Hallo <strong>Welt</strong> <em>kursiv</em></p><ul><li>eins</li></ul>` +
        `<a href="https://example.com/bewerbung">Link</a>`,
    );
    expect(clean).toContain("<strong>Welt</strong>");
    expect(clean).toContain("<em>kursiv</em>");
    expect(clean).toContain("<li>eins</li>");
    expect(clean).toContain("https://example.com/bewerbung");
  });

  it("forces rel=noopener noreferrer on every surviving link (tabnabbing)", () => {
    const clean = sanitizeEmailHtml(`<a href="https://example.com">x</a>`);
    expect(clean).toContain('rel="noopener noreferrer"');
    expect(clean).toContain('target="_blank"');
  });

  it("drops the protocols that are not explicitly allowed", () => {
    for (const href of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
    ]) {
      const clean = sanitizeEmailHtml(`<a href="${href}">x</a>`);
      expect(clean.toLowerCase()).not.toContain("javascript:");
      expect(clean.toLowerCase()).not.toContain("data:");
      expect(clean.toLowerCase()).not.toContain("vbscript:");
      expect(clean.toLowerCase()).not.toContain("file:");
    }
  });
});

describe("htmlToText flattens to text (no markup can survive)", () => {
  for (const payload of XSS_PAYLOADS) {
    it(`yields plain text for ${payload.slice(0, 42)}`, () => {
      const text = htmlToText(payload);
      expect(text).not.toContain("<");
      expect(text).not.toContain(">");
    });
  }
});

describe("markdown rendering never permits raw HTML", () => {
  it("no rehype-raw (or any HTML-enabling markdown plugin) anywhere in src", () => {
    const offenders = sourceFiles(join(root, "src")).filter((file) =>
      /rehype-raw|rehypeRaw|allowDangerousHtml|skipHtml:\s*false/.test(
        readFileSync(file, "utf8"),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("react-markdown is the only markdown renderer and passes no raw-HTML option", () => {
    const chat = readFileSync(join(root, "src/components/ai-chat.tsx"), "utf8");
    expect(chat).toContain("ReactMarkdown");
    expect(chat).not.toContain("dangerouslySetInnerHTML");
    expect(chat).not.toMatch(/rehype/);
  });
});

describe("innerHTML sinks are fed sanitized data", () => {
  it("the rich editor is the only innerHTML writer, and the composer data is sanitized on read", () => {
    const sinks = sourceFiles(join(root, "src")).filter((file) =>
      /\.innerHTML\s*=/.test(readFileSync(file, "utf8")),
    );
    // Exactly one sink may exist; a new one must be reviewed (and covered).
    expect(sinks.map((file) => file.replace(`${root}/`, ""))).toEqual([
      "src/components/rich-email-editor.tsx",
    ]);
  });

  it("loadOwnedDraft sanitizes body_html before it reaches the browser", () => {
    const draft = readFileSync(
      join(root, "src/lib/application-drafts.ts"),
      "utf8",
    );
    expect(draft).toContain("body_html: sanitizeEmailHtml(data.body_html ?? \"\")");
  });

  it("every write path that stores body_html runs it through the sanitizer", () => {
    for (const [file, marker] of [
      ["src/app/applications/new/actions.ts", "sanitizeEmailHtml"],
      ["src/lib/opportunity-prefill.ts", "sanitizeEmailHtml"],
      ["src/lib/email-campaigns.ts", "sanitizeEmailHtml"],
    ] as const) {
      expect(readFileSync(join(root, file), "utf8")).toContain(marker);
    }
  });
});

describe("the two dangerouslySetInnerHTML scripts are static and inert", () => {
  it("contains no closing-script sequence and no markup at all", () => {
    for (const script of [themePreloadScript, langPreloadScript()]) {
      expect(script).not.toContain("</script");
      expect(script).not.toContain("<");
      expect(script).not.toContain(">");
    }
  });

  it("validates the persisted language against the supported set before use", () => {
    const script = langPreloadScript();
    // A cookie/localStorage value is attacker-writable in the victim's own
    // browser: it must be whitelisted, never interpolated.
    expect(script).toContain('["de","en","fr","ar"].indexOf(lang) === -1');
    expect(script).toContain('lang = "de"');
    // The direction map is fixed, so dir can never become an arbitrary string.
    expect(script).not.toContain("document.documentElement.setAttribute(\"dir\", lang");
  });

  it("layout.tsx interpolates no runtime/user data into those scripts", () => {
    const layout = readFileSync(join(root, "src/app/layout.tsx"), "utf8");
    expect(layout).toContain("{ __html: themePreloadScript }");
    expect(layout).toContain("{ __html: langPreloadScript() }");
    expect(layout).not.toMatch(/\{ __html: [^}]*\$\{/);
    expect(layout).not.toContain("searchParams");
    expect(layout).not.toContain("cookies()");
  });
});
