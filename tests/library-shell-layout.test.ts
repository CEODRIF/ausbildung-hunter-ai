import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Deutsch Bibliothek — shell integration invariants (root-cause regression
 * guard).
 *
 * Incident: the library once rendered as a STANDALONE page (own
 * min-h-screen chrome, no sidebar) because /bibliothek had no section
 * layout — every other platform section renders inside the shared
 * AppShell via its own layout.tsx. These invariants pin the correct shape:
 *
 *   1. a section layout wraps the page in the real AppShell;
 *   2. the section stays PUBLIC — no auth redirect, no plan/entitlement
 *      gate (AppShell is built for null profiles: neutral "Konto"
 *      fallback, admin section hidden by the server-computed flag);
 *   3. the page itself carries no duplicate page chrome (background,
 *      mesh, own <main>, own header) — the shell owns those;
 *   4. the platform navigation + top-bar heading include the section.
 */
const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("bibliothek section layout (shell integration)", () => {
  const layout = read("src/app/bibliothek/layout.tsx");

  it("wraps the section in the shared AppShell (the real sidebar, not a copy)", () => {
    expect(layout).toContain('from "@/components/app-shell"');
    expect(layout).toMatch(/<AppShell\s+profile=\{profile \?\? null\}/);
    expect(layout).toContain("getCurrentUserAndProfile");
    // Dynamic: the session (and therefore the sidebar's profile state)
    // must be resolved per request, never cached per deployment.
    expect(layout).toContain('export const dynamic = "force-dynamic"');
  });

  it("keeps the library PUBLIC: no auth redirect, no billing/plan gate", () => {
    // A redirect here would make /bibliothek private (login wall) — the
    // opposite of the intended access model. Content authorization stays
    // in the data layer (RLS + published=true).
    expect(layout).not.toContain("redirect(");
    expect(layout).not.toContain("getPlanGate");
    expect(layout).not.toContain("requireAdmin");
    // The null-profile fallback IS the anonymous path (not an error).
    expect(layout).toContain("profile ?? null");
  });
});

describe("bibliothek page chrome (no standalone duplication)", () => {
  const page = read("src/app/bibliothek/page.tsx");

  it("renders inside the shell: no own page background, mesh, or <main>", () => {
    expect(page).not.toContain("min-h-screen");
    expect(page).not.toContain("GradientMesh");
    expect(page).not.toMatch(/<main[\s>]/);
    // …but the content stays: data layer, states, pagination, cards.
    expect(page).toContain("listPublishedBooks");
    expect(page).toContain("bookCoverPublicUrl");
    expect(page).toContain('export const dynamic = "force-dynamic"');
  });
});

describe("platform navigation includes the section", () => {
  const shell = read("src/components/app-shell.tsx");

  it("nav item + top-bar heading exist for /bibliothek", () => {
    // Sidebar/drawer item (shared NAV_SECTIONS — one nav model).
    expect(shell).toMatch(/labelKey: "library\.nav",\s*href: "\/bibliothek"/);
    // Top-bar heading (title + subtitle) via PAGE_HEADINGS.
    expect(shell).toMatch(/p === "\/bibliothek"/);
    expect(shell).toContain('titleKey: "library.pageTitle"');
  });
});
