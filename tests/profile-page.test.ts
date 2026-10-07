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

  it("account rows link to existing internal settings routes only", () => {
    // Internal links only (social tiles use full https: URLs — checked separately):
    const hrefs = [...PAGE.matchAll(/href: "\/([^"]+)"/g)].map((m) => `/${m[1]}`);
    expect(hrefs).toHaveLength(4);
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

describe("settings profile — social media section", () => {
  const ICON = read("src/components/icon.tsx");

  it("contains exactly the three requested links with the exact URLs", () => {
    expect(PAGE).toContain('href: "https://wa.me/4915210523155"');
    expect(PAGE).toContain('href: "https://www.facebook.com/ceodrif?mibextid=wwXIfr"');
    expect(PAGE).toContain('href: "https://www.tiktok.com/@ceodrif"');
    expect(PAGE).toContain('label: "WhatsApp"');
    expect(PAGE).toContain('label: "Facebook"');
    expect(PAGE).toContain('label: "TikTok"');
  });

  it("no unrelated social channels were added (page or icon set)", () => {
    const pageLower = PAGE.toLowerCase();
    for (const u of ["youtube", "instagram", "telegram", "linkedin", "twitter", "x.com", "t.me", "pinterest"]) {
      expect(pageLower, `page must not reference "${u}"`).not.toContain(u);
    }
    const iconLower = ICON.toLowerCase();
    for (const u of ["youtube", "instagram", "telegram", "linkedin", "whatsapp-alt"]) {
      expect(iconLower, `icon set must not reference "${u}"`).not.toContain(u);
    }
  });

  it("all three open externally with safe rel and accessible labels", () => {
    // Exactly three external (https:) social targets:
    expect((PAGE.match(/href: "https:[^"]+"/g) ?? []).length).toBe(3);
    // The shared tile markup opens in a new, safe tab — applied to all three
    // entries via the map, and stays keyboard-accessible with per-tile labels:
    const socialBlock = PAGE.split("SOCIALS.map")[1];
    expect(socialBlock).toContain('target="_blank"');
    expect(socialBlock).toContain('rel="noopener noreferrer"');
    expect(socialBlock).toContain("aria-label={s.label}");
    expect(socialBlock).toContain("<Link");
  });

  it("brand icons exist in the icon system as official filled glyphs", () => {
    for (const name of ["whatsapp", "facebook", "tiktok"]) {
      expect(ICON).toContain(`| "${name}"`);
      expect(ICON).toContain(`${name}: (`);
    }
    // Filled brand marks (not the stroke set):
    expect(ICON.split("whatsapp: (")[1].slice(0, 200)).toContain('fill="currentColor"');
  });

  it("premium glass tiles: one centered row, responsive size, reduced-motion safe", () => {
    // Centered flex row with even spacing, single row on phones:
    expect(PAGE).toContain("flex items-center justify-center gap-3 sm:gap-4");
    // 64px tiles on mobile → 96px at sm+; radius 22px → 24px:
    expect(PAGE).toContain("h-16 w-16");
    expect(PAGE).toContain("sm:h-24 sm:w-24");
    expect(PAGE).toContain("rounded-[22px]");
    expect(PAGE).toContain("sm:rounded-3xl");
    // Consistent icon size (32px, within the 28–34 band):
    expect(PAGE).toContain("size={32}");
    // Hover: ~5% scale + lift + brand glow, 200ms transition:
    expect(PAGE).toContain("hover:scale-[1.05]");
    expect(PAGE).toContain("duration-200");
    expect(PAGE).toContain("drop-shadow-[0_0_10px");
    // Touch target ≥44px (h-16 = 64px) and prefers-reduced-motion respected:
    expect(PAGE).toContain("motion-reduce:transition-none");
    expect(PAGE).toContain("motion-reduce:hover:scale-100");
  });

  it("the social heading is localized in all four languages", () => {
    for (const lang of LANGS) {
      const v = translate(lang, "profile.page.social.title");
      expect(v, `${lang} · social.title`).not.toBe("profile.page.social.title");
      expect(v.trim().length, `${lang} · social.title`).toBeGreaterThan(0);
    }
    expect(translate("de", "profile.page.social.title")).toBe("Social Media");
    expect(translate("ar", "profile.page.social.title")).toBe("وسائل التواصل الاجتماعي");
  });
});
