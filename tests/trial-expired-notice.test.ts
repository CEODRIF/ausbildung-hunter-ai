/**
 * The prominent trial-expired banner (TrialExpiredNotice) — pinned the
 * house way for ASYNC SERVER COMPONENTS (billing-page.test.ts idiom):
 * source contract + real-dictionary parity. (jsdom render cannot
 * suspend-resolve a server component; the LAYOUT-level "when is it shown"
 * property is pinned in plan-gate.test.ts, which proves the banner appears
 * ONLY when the server gate reports an expired trial — never for a valid
 * active paid subscription, never on a lookup failure.)
 *
 * Pinned properties (spec §2 — free trial expiry):
 *   - the banner is a role="alert" notice with localized copy from the
 *     standard dictionary (de is the source of truth; en carries the
 *     EXACT mandated English sentence);
 *   - it links to the plan-selection page (/settings/billing);
 *   - it is red/danger-styled so it stands out near the top;
 *   - all four languages carry non-empty message + CTA (a missing key
 *     would otherwise render the raw key path at runtime);
 *   - the component is a SERVER component (no 'use client') fed by
 *     getServerT(), i.e. the state is server-authoritative, never
 *     client-supplied.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const { dictionaries, SUPPORTED_LANGUAGES } =
  await import("@/lib/i18n/dictionaries");

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (relative: string) =>
  readFileSync(resolve(root, relative), "utf8");

const SRC = read("src/components/plan-state-notice.tsx");

describe("TrialExpiredNotice — server-authoritative banner (source contract)", () => {
  it("is a server component fed by getServerT() (no client state, no 'use client')", () => {
    expect(SRC).not.toContain('"use client"');
    expect(SRC).toContain("getServerT()");
  });

  it("renders an ALERT (not a wall) with the localized message and a working plan-selection link", () => {
    expect(SRC).toContain('role="alert"');
    expect(SRC).toContain('t("billing.trialExpired")');
    expect(SRC).toContain('t("billing.trialExpiredCta")');
    expect(SRC).toContain('href="/settings/billing"');
  });

  it("is visually prominent (red/danger styling, bold)", () => {
    expect(SRC).toContain("border-danger");
    expect(SRC).toMatch(/bg-danger/);
    expect(SRC).toContain("text-danger");
  });
});

describe("TrialExpiredNotice — dictionary parity (all four languages)", () => {
  it("every supported language carries a non-empty message AND CTA", () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      const billing = dictionaries[lang].billing as Record<string, unknown>;
      const msg = billing["trialExpired"];
      const cta = billing["trialExpiredCta"];
      expect(typeof msg, `${lang}.billing.trialExpired`).toBe("string");
      expect(
        (msg as string).trim().length,
        `${lang} message non-empty`,
      ).toBeGreaterThan(5);
      expect(typeof cta, `${lang}.billing.trialExpiredCta`).toBe("string");
      expect(
        (cta as string).trim().length,
        `${lang} CTA non-empty`,
      ).toBeGreaterThan(2);
    }
  });

  it("the EN text is EXACTLY the mandated sentence", () => {
    expect(dictionaries.en.billing.trialExpired).toBe(
      "Your free trial has expired. Choose a plan to continue using protected features.",
    );
  });

  it("the DE text (source of truth) says the trial expired and asks to choose a plan", () => {
    const de = (dictionaries.de.billing.trialExpired as string).toLowerCase();
    expect(de).toContain("testphase");
    expect(de).toContain("abgelaufen");
    expect(de).toContain("plan");
  });

  it("no language hardcodes the English sentence as its German/French/Arabic copy", () => {
    const en = dictionaries.en.billing.trialExpired;
    for (const lang of ["de", "fr", "ar"] as const) {
      expect(dictionaries[lang].billing.trialExpired).not.toBe(en);
    }
  });
});
