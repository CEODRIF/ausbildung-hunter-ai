import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "@/lib/i18n";
import { translate } from "@/lib/i18n/core";
import { SUPPORTED_LANGUAGES } from "@/lib/i18n/dictionaries";
import { DECKBLATT_COMING_SOON } from "@/lib/deckblatt/availability";

/**
 * Deckblatt AI — Coming Soon.
 *
 * The generator is parked behind one boolean. These tests pin the two halves of
 * that switch so the feature can be re-enabled safely AND so it cannot silently
 * come back on:
 *
 *  - the PAGE renders the Coming Soon screen and never mounts the generator, so
 *    no form, no portrait upload, no design selection, no "Create Deckblatt"
 *    button, no quota indicator and no request to /api/deckblatt/* — opening the
 *    page must not prepare or start a generation;
 *  - the API refuses to start a run even for a replayed request;
 *  - nothing was deleted: the generator, routes, provider, quota ledger,
 *    migrations, renderer and types are all still in place and flip back with
 *    the constant.
 */
const root = fileURLToPath(new URL("..", import.meta.url));
const read = (relative: string) => readFileSync(resolve(root, relative), "utf8");
const exists = (relative: string) => existsSync(resolve(root, relative));

const page = read("src/app/deckblatt/page.tsx");
const comingSoon = read("src/components/deckblatt-coming-soon.tsx");
const route = read("src/app/api/deckblatt/generate/route.ts");
const availability = read("src/lib/deckblatt/availability.ts");

// Flat leaves, like every other key in this namespace.
const COMING_SOON_KEYS = [
  "comingSoonTitle",
  "comingSoonBadge",
  "comingSoonMessage",
  "comingSoonNote",
  "comingSoonBackToDashboard",
] as const;

describe("the switch itself", () => {
  it("is a single boolean, currently ON (feature parked)", () => {
    expect(DECKBLATT_COMING_SOON).toBe(true);
    expect(availability).toContain("export const DECKBLATT_COMING_SOON = true;");
    // It is a switch, not a removal: the module documents both states.
    expect(availability).toContain("availability switch");
  });

  it("is used by exactly two sources — the page and the API route", () => {
    const walk = (dir: string): string[] =>
      readdirSync(resolve(root, dir)).flatMap((entry) => {
        const rel = `${dir}/${entry}`;
        if (statSync(resolve(root, rel)).isDirectory()) return walk(rel);
        return /\.(ts|tsx)$/.test(entry) ? [rel] : [];
      });
    const importers = walk("src").filter((file) =>
      /DECKBLATT_COMING_SOON/.test(read(file)),
    );
    expect(importers.sort()).toEqual([
      "src/app/api/deckblatt/generate/route.ts",
      "src/app/deckblatt/page.tsx",
      "src/lib/deckblatt/availability.ts",
    ]);
  });
});

describe("1 + 2 + 3. /deckblatt really renders Coming Soon (server render of the route module)", () => {
  it("outputs the Coming Soon screen and none of the generator UI", async () => {
    // The actual route module, server-rendered — not a paraphrase of it.
    const { default: DeckblattPage } = await import("@/app/deckblatt/page");
    const html = renderToStaticMarkup(
      createElement(I18nProvider, null, createElement(DeckblattPage)),
    );

    // The headline message the user asked for.
    expect(html).toContain("Deckblatt AI");
    expect(html).toContain("Coming Soon");

    // …and the requested copy.
    expect(html).toContain(
      "Wir arbeiten gerade an einer neuen Version des Deckblatt-Generators.",
    );
    expect(html).toContain("Der Deckblatt-Generator wird bald wieder verfügbar sein.");

    // The back-to-dashboard action.
    expect(html).toContain('href="/dashboard"');
    expect(html).toContain("Zurück zum Dashboard");

    // The old UI is absent: no generate button, no form/inputs, no portrait
    // upload, no design options and no quota indicator ("2 Designs heute…").
    expect(html).not.toContain("Deckblatt erstellen");
    expect(html).not.toContain("hochladen");
    expect(html).not.toContain("Bewerbungsfoto");
    expect(html).not.toContain("Design");
    expect(html).not.toContain("Vorlagen");
    expect(html).not.toMatch(/<input|<form|<select|<textarea/);
  });

  it("serves the Coming Soon metadata", async () => {
    const { generateMetadata } = await import("@/app/deckblatt/page");
    expect(generateMetadata()).toEqual({
      title: { absolute: "Deckblatt AI — Coming Soon" },
    });
  });
});

describe("1 + 2 + 3. /deckblatt renders Coming Soon and the old form is unreachable", () => {
  it("returns the Coming Soon screen when the switch is on", () => {
    expect(page).toContain(
      "if (DECKBLATT_COMING_SOON) return <DeckblattComingSoon />;",
    );
    expect(page).toContain('import { DeckblattComingSoon } from "@/components/deckblatt-coming-soon";');
  });

  it("keeps the generator behind the switch — its branch is unreachable", () => {
    // The generator mount still exists (the code was NOT deleted)…
    expect(page).toContain("<DeckblattGenerator />");
    // …but only after the Coming Soon branch, so it can never render.
    expect(page.indexOf("<DeckblattComingSoon />")).toBeLessThan(
      page.indexOf("return <DeckblattGenerator />;"),
    );
  });

  it("the Coming Soon screen pulls in no generator code", () => {
    expect(comingSoon).not.toContain("deckblatt-generator");
    expect(comingSoon).not.toContain("DeckblattGenerator");
    // No form, no generate button, no quota UI, no provider reference.
    expect(comingSoon).not.toContain("deckblatt.generate");
    expect(comingSoon).not.toContain("usage");
    expect(comingSoon).not.toContain("pollinations");
    expect(comingSoon).not.toContain("<form");
    expect(comingSoon).not.toContain("<input");
  });
});

describe("4. opening the page triggers no generation work", () => {
  it("the page and the Coming Soon screen perform no I/O", () => {
    for (const source of [page, comingSoon]) {
      expect(source).not.toContain("fetch(");
      expect(source).not.toContain("useEffect");
      // No request target — a prose mention in a comment is not a call, so the
      // check is for the quoted literal.
      expect(source).not.toContain('"/api/deckblatt');
      expect(source).not.toContain("reserveDeckblattGeneration");
      expect(source).not.toContain("getDeckblattUsageStatus");
    }
  });

  it("a replayed API request cannot start a run either", () => {
    expect(route).toContain('return json({ code: "coming_soon" }, { status: 503 });');
    // Guard runs AFTER auth (authorization behaviour unchanged)…
    expect(route.indexOf('if (DECKBLATT_COMING_SOON)')).toBeGreaterThan(
      route.indexOf("getCurrentUserAndProfile()"),
    );
    expect(route.indexOf('if (DECKBLATT_COMING_SOON)')).toBeGreaterThan(
      route.indexOf("return json({ code: \"unauthorized\" }, { status: 401 });"),
    );
    // …and BEFORE anything that could cost money, quota or a provider call.
    for (const later of [
      'checkRateLimit("deckblatt_generate", user.id)',
      "reserveDeckblattGeneration(runId)",
      "generateDeckblattDesign(prompt, buildDeckblattBaseImage(style))",
    ]) {
      expect(route.indexOf('if (DECKBLATT_COMING_SOON)')).toBeLessThan(
        route.indexOf(later),
      );
    }
  });
});

describe("5. the back button returns to the dashboard", () => {
  it("links to /dashboard and is a real Button, usable on desktop and mobile", () => {
    expect(comingSoon).toContain('<Link href="/dashboard"');
    expect(comingSoon).toContain('t("deckblatt.comingSoonBackToDashboard")');
    // Full-width on small screens, content-width from sm: up.
    expect(comingSoon).toContain("w-full sm:w-auto");
  });
});

describe("6. every language has the copy (no hardcoded strings)", () => {
  it("renders all five strings through t()", () => {
    for (const key of COMING_SOON_KEYS) {
      expect(comingSoon).toContain(`t("deckblatt.${key}")`);
    }
    // The copy lives in the dictionary, not in the component.
    expect(comingSoon).not.toContain("Wir arbeiten gerade");
    expect(comingSoon).not.toContain("Coming Soon\"");
  });

  it("resolves in de/en/fr/ar and matches the requested German copy", () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      for (const key of COMING_SOON_KEYS) {
        const value = translate(lang, `deckblatt.${key}`);
        expect(value.length, `${lang}.${key}`).toBeGreaterThan(0);
        // A missing key would echo the path back.
        expect(value, `${lang}.${key}`).not.toContain("deckblatt.");
      }
      expect(translate(lang, "deckblatt.comingSoonTitle")).toBe("Deckblatt AI");
      expect(translate(lang, "deckblatt.comingSoonBadge")).toBe("Coming Soon");
    }
    expect(translate("de", "deckblatt.comingSoonMessage")).toBe(
      "Wir arbeiten gerade an einer neuen Version des Deckblatt-Generators.",
    );
    expect(translate("de", "deckblatt.comingSoonNote")).toBe(
      "Der Deckblatt-Generator wird bald wieder verfügbar sein.",
    );
    expect(translate("en", "deckblatt.comingSoonBackToDashboard")).toBe(
      "Back to Dashboard",
    );
  });

  it("sets the Coming Soon title only while parked", () => {
    expect(page).toContain('title: { absolute: "Deckblatt AI — Coming Soon" }');
    expect(page.indexOf("if (!DECKBLATT_COMING_SOON) return {};")).toBeLessThan(
      page.indexOf('title: { absolute: "Deckblatt AI — Coming Soon" }'),
    );
  });
});

describe("7. nothing else changed, nothing was deleted", () => {
  it("keeps the navigation entry and the shell heading for /deckblatt", () => {
    const shell = read("src/components/app-shell.tsx");
    expect(shell).toContain(
      '{ labelKey: "nav.deckblatt", href: "/deckblatt", icon: "image" }',
    );
    expect(shell).toContain('heading: { titleKey: "pages.deckblatt.title"');
  });

  it("keeps every backend file of the feature on disk", () => {
    for (const file of [
      "src/app/api/deckblatt/generate/route.ts",
      "src/app/api/deckblatt/status/route.ts",
      "src/app/deckblatt/layout.tsx",
      "src/components/deckblatt-generator.tsx",
      "src/components/deckblatt-sheet.tsx",
      "src/lib/deckblatt/pollinations.ts",
      "src/lib/deckblatt/usage.ts",
      "src/lib/deckblatt/styles.ts",
      "src/lib/deckblatt/render.ts",
      "src/lib/deckblatt/validate.ts",
    ]) {
      expect(exists(file), file).toBe(true);
    }
    // The quota ledger's migration remains.
    const migrations = readdirSync(resolve(root, "supabase/migrations"));
    expect(migrations.some((f) => f.includes("deckblatt_usage"))).toBe(true);
    expect(
      migrations.some((f) => f.includes("deckblatt_stale_reservation_recovery")),
    ).toBe(true);
  });

  it("leaves the generator and the provider integration fully functional", () => {
    const generator = read("src/components/deckblatt-generator.tsx");
    // Still wired to the real API and still offering the real action.
    expect(generator).toContain('fetch("/api/deckblatt/generate"');
    expect(generator).toContain('t("deckblatt.generate")');
    const provider = read("src/lib/deckblatt/pollinations.ts");
    expect(provider).toContain("POLLINATIONS_API_KEY");
    expect(provider).toContain("https://gen.pollinations.ai/v1/images/edits");
    // The quota module is untouched by the switch.
    expect(read("src/lib/deckblatt/usage.ts")).not.toContain("DECKBLATT_COMING_SOON");
  });

  it("does not touch the other API routes", () => {
    const walk = (dir: string): string[] =>
      readdirSync(resolve(root, dir)).flatMap((entry) => {
        const rel = `${dir}/${entry}`;
        if (statSync(resolve(root, rel)).isDirectory()) return walk(rel);
        return entry === "route.ts" || entry === "route.tsx" ? [rel] : [];
      });
    const otherRoutes = walk("src/app/api").filter(
      (file) => !file.includes("/deckblatt/"),
    );
    expect(otherRoutes.length).toBeGreaterThan(0);
    for (const file of otherRoutes) {
      expect(read(file), file).not.toContain("deckblatt/availability");
    }
  });
});
