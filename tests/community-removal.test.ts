/**
 * Community feature removal — absence invariants.
 *
 * Pins the post-removal state so the feature cannot creep back in
 * piecemeal: no route tree, no navigation entry points, no i18n
 * namespace, no community-exclusive modules, and no LiveKit/voice
 * environment machinery.
 *
 * NOTE: the Supabase migrations and docs/ are intentionally NOT asserted
 * here — the DB objects and historical documentation are retained by
 * design (a separately approved future cleanup would remove them).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const readSrc = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("community feature removal", () => {
  it("the /community route tree does not exist", () => {
    expect(existsSync(join(ROOT, "src/app/community"))).toBe(false);
    expect(existsSync(join(ROOT, "src/app/api/community"))).toBe(false);
    expect(existsSync(join(ROOT, "src/app/api/admin/community"))).toBe(false);
    // announcements were community-exclusive admin tooling:
    expect(existsSync(join(ROOT, "src/app/api/admin/announcements"))).toBe(false);
    expect(existsSync(join(ROOT, "src/app/admin/announcements"))).toBe(false);
  });

  it("the app shell has no community navigation entry points", () => {
    const shell = readSrc("src/components/app-shell.tsx");
    expect(shell).not.toMatch(/community/i);
    // the communityUnread prop is gone entirely:
    expect(shell).not.toContain("communityUnread");
  });

  it("the i18n dictionaries carry no community namespace or keys", () => {
    const dicts = readSrc("src/lib/i18n/dictionaries.ts");
    // all four languages (de/en/fr/ar) are shape-parity-checked by the
    // Dict type, so zero occurrences is the strongest assertion:
    expect(dicts).not.toMatch(/community/i);
    expect(dicts).not.toMatch(/announcements/i);
  });

  it("community-exclusive source modules are gone", () => {
    expect(existsSync(join(ROOT, "src/lib/community"))).toBe(false);
    expect(existsSync(join(ROOT, "src/lib/community.ts"))).toBe(false);
    expect(existsSync(join(ROOT, "src/lib/voice"))).toBe(false);
    expect(existsSync(join(ROOT, "src/components/community"))).toBe(false);
    // feature components deleted individually:
    expect(existsSync(join(ROOT, "src/components/community-coming-soon.tsx"))).toBe(false);
    expect(existsSync(join(ROOT, "src/components/community-onboarding.tsx"))).toBe(false);
    expect(existsSync(join(ROOT, "src/components/admin-community.tsx"))).toBe(false);
    expect(existsSync(join(ROOT, "src/components/admin-announcements.tsx"))).toBe(false);
  });

  it("the environment check no longer knows LiveKit/voice", () => {
    const checker = readSrc("scripts/check-env.mjs");
    expect(checker).not.toMatch(/livekit/i);
    // the production-mode mechanism existed only for the LiveKit trio:
    expect(checker).not.toContain('required: "production"');
  });

  it("globals.css carries no community/voice animation classes", () => {
    const css = readSrc("src/app/globals.css");
    expect(css).not.toMatch(/community|voice-tile|typing-dot/i);
  });
});
