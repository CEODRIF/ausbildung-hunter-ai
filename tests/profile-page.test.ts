/**
 * Settings Profile page (/settings/profile) — visual redesign regression.
 *
 * The page is a premium identity dashboard over EXISTING profile data only
 * (no new backend). These tests pin:
 *   - the route exists and stays a server component (no client JS)
 *   - every new i18n key resolves in all four languages (no hardcoded
 *     languages, no silent fallback to the raw key path)
 *   - only real `profiles` fields are rendered (nothing invented)
 *   - account rows link to existing settings routes only
 *   - the old broken nav target is restored (sidebar + avatar menu)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { translate, type Language } from "@/lib/i18n/core";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const PAGE = read("src/app/settings/profile/page.tsx");
const SHARED_PROFILE_KEYS = [
  "profile.page.memberSince",
  "profile.page.status.active",
  "profile.page.status.pending",
  "profile.page.status.suspended",
  "profile.page.personal.title",
  "profile.page.personal.hint",
  "profile.page.accounts.title",
  "profile.page.accounts.hint",
] as const;

const LANGS: Language[] = ["de", "en", "fr", "ar"];

describe("settings profile page — premium visual redesign", () => {
  it("route exists, is force-dynamic, and stays a server component", () => {
    expect(PAGE).toContain('export const dynamic = "force-dynamic"');
    expect(PAGE).not.toContain('"use client"');
    // Auth gate identical to the other settings pages:
    expect(PAGE).toContain("getCurrentUserAndProfile");
    expect(PAGE).toContain('redirect("/login")');
    expect(PAGE).toContain('account_status !== "active"');
  });

  it("every new i18n key resolves in all four languages (no raw-path fallback)", () => {
    for (const lang of LANGS) {
      for (const key of SHARED_PROFILE_KEYS) {
        const value = translate(lang, key);
        expect(value, `${lang} · ${key}`).not.toBe(key);
        expect(value.trim().length, `${lang} · ${key} must be non-empty`).toBeGreaterThan(0);
      }
    }
  });

  it("reuses existing keys for page heading, back button and account rows", () => {
    // Heading comes from the existing shell page-heading map:
    expect(translate("de", "pages.settingsProfile.title")).toBe("Profil");
    expect(translate("en", "pages.settingsProfile.title")).toBe("Profile");
    expect(translate("ar", "pages.settingsProfile.title")).toBe("الملف الشخصي");
    // Back button + account rows reuse established keys:
    expect(PAGE).toContain('t("common.back")');
    for (const key of [
      "pages.settingsEmail.title",
      "pages.settingsUsage.title",
      "pages.settingsBilling.title",
      "pages.settingsData.title",
      "dash.detail.fullName",
      "dash.detail.email",
      "dash.detail.emailLimit",
    ]) {
      expect(PAGE, `page must use t("${key}")`).toContain(`t("${key}"`);
      expect(translate("de", key)).not.toBe(key);
      expect(translate("ar", key)).not.toBe(key);
    }
  });

  it("renders ONLY real profiles fields — nothing invented", () => {
    const realFields = [
      "full_name",
      "email",
      "avatar_url",
      "account_status",
      "selected_goal",
      "daily_email_limit",
      "created_at",
    ];
    for (const field of realFields) {
      expect(PAGE, `field ${field} must be used`).toContain(field);
    }
    // No invented profile data (word-boundary: "opacity" must not trip "city"):
    for (const invented of ["phone", "date_of_birth", "address", "city", "username"]) {
      expect(PAGE, `must not reference invented field "${invented}"`).not.toMatch(
        new RegExp(`\\b${invented}\\b`),
      );
    }
    // No new endpoints or mutations — pure presentation:
    expect(PAGE).not.toContain("fetch(");
    expect(PAGE).not.toContain("supabase");
    expect(PAGE).not.toContain("<form");
  });

  it("account rows link to existing settings routes only", () => {
    const hrefs = [...PAGE.matchAll(/href: "([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(hrefs).size).toBe(hrefs.length); // no duplicate targets
    for (const href of hrefs) {
      expect(["/settings/email", "/settings/usage", "/settings/billing", "/settings/data"], href).toContain(href);
    }
  });

  it("hero shows the real avatar when set, initials fallback when missing", () => {
    expect(PAGE).toContain("profile.avatar_url ?");
    expect(PAGE).toContain("object-cover");
    expect(PAGE).toContain("initials");
    // Gradient ring + atmospheric orbs from the existing token system:
    expect(PAGE).toContain("var(--gradient-neon)");
    expect(PAGE).toContain("hero-orb");
  });

  it("mobile-first: no fixed widths, logical (RTL-safe) utilities, safe spacing", () => {
    // Logical properties for RTL correctness:
    expect(PAGE).toContain("ms-auto");
    expect(PAGE).toContain("-start-24");
    expect(PAGE).toContain("rtl:-scale-x-100");
    // No hardcoded pixel widths that could overflow 390px viewports:
    expect(PAGE).not.toMatch(/w-\[\d{3,}px\]/);
    // Long names/emails wrap:
    expect(PAGE).toContain("break-words");
    expect(PAGE).toContain("break-all");
    // Two-column section grid only on xl (single column on phones):
    expect(PAGE).toContain("xl:grid-cols-2");
  });

  it("the dead /settings/profile nav target is restored (sidebar + avatar menu)", () => {
    const shell = read("src/components/app-shell.tsx");
    const menu = read("src/components/profile-menu.tsx");
    // Sidebar entry (pre-existing) still points at the now-existing route:
    expect(shell).toContain('href: "/settings/profile"');
    // Avatar menu got the profile link back (removed in the c9353ca refactor):
    expect(menu).toContain('href="/settings/profile"');
    expect(menu).toContain('t("pages.settingsProfile.title")');
  });
});
