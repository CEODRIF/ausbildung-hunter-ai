import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RecipientTable } from "@/components/recipient-table";
import { RichEmailEditor } from "@/components/rich-email-editor";
import {
  COMPANY_TOKEN,
  CONTACT_TOKEN,
  GREETING_TOKEN,
  PERSONALIZATION_TOKENS,
} from "@/lib/personalization";

/**
 * Smart personalization — the UI contracts.
 *
 * The test environment is `node` (no DOM), following the repo's existing
 * pattern (renderToStaticMarkup + source contracts, e.g.
 * cover-letter-ai-modal-mobile.test.tsx):
 *
 *  1. The toolbar renders the three variable buttons (Arabic labels,
 *     accessible labels, the exact documented tokens) next to — without
 *     removing — the existing formatting tools.
 *  2. The buttons insert through the editor's EXISTING insertion API
 *     (execCommand "insertText", same path as the other toolbar tools) and
 *     prevent the mousedown from stealing the selection — which is what
 *     preserves the cursor position and the surrounding formatting,
 *     exactly like typing or bold/italic.
 *  3. The recipient table exposes editable Company (override) and Contact
 *     (trusted name) fields and previews the domain-inferred company name.
 */

const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\/+$/, "");

const editorSource = readFileSync(
  `${root}/src/components/rich-email-editor.tsx`,
  "utf8",
);

describe("editor toolbar: variable buttons", () => {
  it("renders all three variables with Arabic labels + accessible tokens", () => {
    const html = renderToStaticMarkup(
      createElement(RichEmailEditor, { value: "<p>hi</p>", onChange: () => {} }),
    );
    // All three buttons are present, each exposing the documented token in
    // BOTH the tooltip (title) and the accessible label (aria-label).
    for (const token of [COMPANY_TOKEN, CONTACT_TOKEN, GREETING_TOKEN]) {
      const occurrences =
        html.match(new RegExp(token.replace(/[{}]/g, "\\$&"), "g")) ?? [];
      expect(occurrences.length, token).toBeGreaterThanOrEqual(2);
    }
    expect(html).toContain("personalized per recipient");
    // The Arabic labels from the product copy.
    expect(html).toContain("اسم الشركة");
    expect(html).toContain("اسم المشغّل");
    expect(html).toContain("الافتتاحية");
    // The existing formatting tools are untouched.
    for (const label of ["Bold", "Italic", "Underline", "Insert link"]) {
      expect(html).toContain(label);
    }
    // The editor surface itself is still there (the value is mounted via
    // useEffect, which renderToStaticMarkup does not run).
    expect(html).toContain('aria-label="Email message"');
  });

  it("inserts through the existing execCommand API at the cursor (selection-safe)", () => {
    // Same insertion path as the other toolbar commands: exec("insertText")
    // → document.execCommand("insertText", false, token) — a plain text
    // insert at the CURRENT selection that inherits the surrounding
    // formatting and leaves the cursor right after the token.
    expect(editorSource).toContain('exec("insertText", variable.token)');
    expect(editorSource).toContain('document.execCommand(command, false, arg)');
    // The mousedown handler keeps the editor selection alive (same pattern
    // as every existing toolbar button) — without it the cursor would
    // jump to the button.
    expect(editorSource).toMatch(
      /onMouseDown=\{\(event\) => event\.preventDefault\(\)\}/,
    );
    // The toolbar tokens are the documented stable tokens (no drift).
    for (const token of PERSONALIZATION_TOKENS) {
      expect(editorSource).toContain(token);
    }
  });
});

describe("recipient table: per-recipient override + contact fields", () => {
  it("renders editable Company/Contact inputs and previews the inferred company", () => {
    const html = renderToStaticMarkup(
      createElement(RecipientTable, {
        recipients: [
          { email: "bewerbung@carrier.de", status: "valid" },
          {
            email: "info@bosch.de",
            companyName: "Bosch GmbH",
            contactName: "Frau Dr. Schmidt",
            status: "valid",
          },
          { email: "me@gmail.com", status: "valid" },
        ],
        onChange: () => {},
      }),
    );
    // Accessible fields per recipient.
    expect(html).toContain('aria-label="Company for bewerbung@carrier.de"');
    expect(html).toContain('aria-label="Contact person for info@bosch.de"');
    // Inferred company preview (placeholder) for the domain-known case…
    expect(html).toContain("placeholder=\"Carrier\"");
    // …and nothing inferred for free-mail (the safe fallback applies).
    expect(html).not.toContain('placeholder="Gmail"');
    // Explicit values are rendered as the input value.
    expect(html).toContain('value="Bosch GmbH"');
    expect(html).toContain('value="Frau Dr. Schmidt"');
    // Header + status rendering intact.
    expect(html).toContain("Company");
    expect(html).toContain("Contact");
    expect(html).toContain("Valid");
  });
});
