/**
 * /settings/usage — removal of the "Unlock 100 daily application emails"
 * quota-upgrade card (2026-10-25).
 *
 * The card (heading, explainer text, code input, Activate button, its
 * search-param success/error notices and the section-dedicated server
 * action) is gone from the account page. What MUST stay pinned here:
 *   1. the card and its code field no longer render / exist,
 *   2. the DAILY QUOTA DISPLAY is preserved (current daily limit, emails
 *      sent today, remaining — same server-derived source, the shared
 *      green QuotaIndicator + the detailed stats),
 *   3. the obsolete i18n keys are removed in ALL four languages (the
 *      exclusive-use rule — no other UI referenced them),
 *   4. the BACKEND is preserved: `activateQuotaCode` (email-campaigns)
 *      and the `activate_quota_upgrade` RPC stay in place (historical
 *      quota-upgrade records and database objects are untouched; quota
 *      values / plan entitlements are unchanged — this is a UI-only
 *      removal).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { translate, type Language } from "@/lib/i18n/core";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const PAGE = read("src/app/settings/usage/page.tsx");
const LIB = read("src/lib/email-campaigns.ts");
const DICT = read("src/lib/i18n/dictionaries.ts");
const LANGS: Language[] = ["de", "en", "fr", "ar"];

describe("the quota-upgrade card no longer renders", () => {
  it("the page source carries no unlock card, code field, form or action import", () => {
    expect(PAGE).not.toContain("unlockTitle");
    expect(PAGE).not.toContain("unlockBody");
    expect(PAGE).not.toContain("codePlaceholder");
    expect(PAGE).not.toMatch(/\bactivateQuota\b/);
    expect(PAGE).not.toContain("daily_limit < 100");
    expect(PAGE).not.toContain('name="code"');
    // No section-dedicated success/error plumbing:
    expect(PAGE).not.toMatch(/\bactivated\b/);
    expect(PAGE).not.toContain("ErrorNotice");
    expect(PAGE).not.toMatch(/\bactivatedNotice\b/);
    // …and the searchParams the notices consumed are gone with them:
    expect(PAGE).not.toContain("searchParams");
  });

  it("the section-dedicated server action file is deleted", () => {
    expect(existsSync(join(ROOT, "src/app/settings/usage/actions.ts"))).toBe(false);
  });
});

describe("the daily quota display is preserved", () => {
  it("the stats still come from the server-derived usage snapshot", () => {
    // Same server source as before — the page reads the snapshot ONCE and
    // feeds both the shared indicator and the detailed stats from it:
    expect(PAGE).toContain("getUsageSnapshot");
    expect(PAGE).toContain("usage.daily_limit");
    expect(PAGE).toContain("usage.emails_sent");
    expect(PAGE).toContain("usage.remaining");
    // The three required stats (Current daily limit / Emails sent today /
    // Remaining) with their unit:
    expect(PAGE).toContain('t("account.dailyLimit")');
    expect(PAGE).toContain('t("account.sentToday")');
    expect(PAGE).toContain('t("account.remaining")');
    expect(PAGE).toContain('t("account.emailsUnit")');
    // The shared green quota indicator (P0 quota audit) is intact:
    expect(PAGE).toContain("<QuotaIndicator");
    expect(PAGE).toContain('variant="bar"');
    expect(PAGE).toContain("makeQuotaLabels");
    expect(PAGE).toContain('t("quota.unitEmails")');
    expect(PAGE).toContain('t("quota.resetsDaily")');
    expect(PAGE).toContain('t("quota.upgrade")');
    // The intro note + billing/data links (subscription status context):
    expect(PAGE).toContain('t("account.usageNote1")');
    expect(PAGE).toContain('href="/settings/billing"');
    expect(PAGE).toContain('href="/settings/data"');
  });

  it("every preserved key still resolves in all four languages", () => {
    for (const lang of LANGS) {
      for (const key of [
        "account.dailyLimit",
        "account.sentToday",
        "account.remaining",
        "account.emailsUnit",
        "account.usageNote1",
        "account.usageNoteLinkBilling",
        "account.usageNote2",
        "account.usageNoteLinkData",
        "quota.unitEmails",
        "quota.resetsDaily",
        "quota.upgrade",
      ]) {
        const value = translate(lang, key);
        expect(value, `${lang} · ${key}`).not.toBe(key);
        expect(value.trim().length, `${lang} · ${key} must be non-empty`).toBeGreaterThan(0);
      }
    }
  });
});

describe("the obsolete i18n keys are removed in all four languages", () => {
  it("none of the five section-exclusive keys survives in the dictionaries", () => {
    // Five keys × four languages were deleted; the dictionary source must
    // not carry any of them anymore (word boundaries keep the unrelated
    // `reactivate` / `actionReactivate` admin keys out of the match).
    expect(DICT).not.toMatch(/\bunlockTitle\b/);
    expect(DICT).not.toMatch(/\bunlockBody\b/);
    expect(DICT).not.toMatch(/\bcodePlaceholder\b/);
    expect(DICT).not.toMatch(/\bactivatedNotice\b/);
    expect(DICT).not.toMatch(/\bactivate:/);
  });

  it("the removed keys no longer resolve (the parity scan keeps them out)", () => {
    for (const lang of LANGS) {
      for (const key of [
        "account.unlockTitle",
        "account.unlockBody",
        "account.codePlaceholder",
        "account.activatedNotice",
        "account.activate",
      ]) {
        // A missing key falls back to the raw path — pin that fallback,
        // i.e. that the key is GONE, not silently re-added:
        expect(translate(lang, key), `${lang} · ${key} must be removed`).toBe(key);
      }
    }
  });
});

describe("the backend stays preserved (UI-only removal)", () => {
  it("activateQuotaCode and the activate_quota_upgrade RPC are untouched", () => {
    expect(LIB).toContain("export async function activateQuotaCode");
    expect(LIB).toContain('rpc("activate_quota_upgrade"');
    // The activation record + activity log behaviour is unchanged:
    expect(LIB).toContain("quota_upgrade_activated");
  });
});
