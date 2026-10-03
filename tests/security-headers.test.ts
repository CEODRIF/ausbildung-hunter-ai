import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildSecurityHeaders } from "@/lib/security-headers";

function csp(supabaseUrl?: string): string {
  const headers = buildSecurityHeaders(supabaseUrl);
  const entry = headers.find((h) => h.key === "content-security-policy");
  expect(entry?.value).toBeTruthy();
  return entry!.value;
}

function directive(cspValue: string, name: string): string {
  const match = cspValue.match(new RegExp(`(?:^|;)\\s*${name}\\s+([^;]+)`));
  expect(match, `directive ${name} missing`).toBeTruthy();
  return match![1].trim();
}

describe("CSP core strictness", () => {
  const value = csp();

  it("defaults everything to 'self'", () => {
    expect(directive(value, "default-src")).toBe("'self'");
  });

  it("blocks objects, framing, base-tag hijack, and form cross-posting", () => {
    expect(directive(value, "object-src")).toBe("'none'");
    expect(directive(value, "frame-ancestors")).toBe("'none'");
    expect(directive(value, "base-uri")).toBe("'self'");
    expect(directive(value, "form-action")).toBe("'self'");
  });

  it("enforces HTTPS upgrade", () => {
    expect(value).toContain("upgrade-insecure-requests");
  });

  it("never allows eval", () => {
    expect(value).not.toContain("'unsafe-eval'");
  });

  it("unsafe-inline is confined to script-src and style-src only", () => {
    // Only value-bearing directives; upgrade-insecure-requests is standalone.
    const valueDirectives = value
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part.includes(" "))
      .map((part) => part.split(" ")[0]);
    expect(valueDirectives.length).toBeGreaterThanOrEqual(9);
    for (const name of valueDirectives) {
      const parts = directive(value, name).split(/\s+/);
      const expected = name === "script-src" || name === "style-src";
      expect(parts.includes("'unsafe-inline'")).toBe(expected);
    }
  });

  it("img-src falls back to self + inert data:/blob: when no Supabase URL is configured", () => {
    expect(directive(value, "img-src").split(/\s+/)).toEqual([
      "'self'",
      "data:",
      "blob:",
    ]);
  });

  it("img-src never uses a wildcard or an http: source", () => {
    const parts = directive(value, "img-src").split(/\s+/);
    expect(parts).not.toContain("*");
    expect(parts.some((part) => part.startsWith("http:"))).toBe(false);
  });

  it("allows the Supabase storage origin in img-src (public avatars)", () => {
    // profiles.avatar_url is a storage.getPublicUrl() value on the Supabase
    // origin; without it in img-src the browser blocks every avatar.
    const parts = directive(csp("https://abcxyzcompany.supabase.co"), "img-src").split(
      /\s+/,
    );
    expect(parts).toContain("https://abcxyzcompany.supabase.co");
    expect(parts.slice(0, 3)).toEqual(["'self'", "data:", "blob:"]);
  });
});

describe("CSP Supabase origin derivation", () => {
  it("adds the Supabase origin to connect-src", () => {
    const value = csp("https://abcxyzcompany.supabase.co");
    const connect = directive(value, "connect-src").split(/\s+/);
    expect(connect).toContain("https://abcxyzcompany.supabase.co");
    expect(connect[0]).toBe("'self'");
  });

  it("strips paths from the Supabase URL (origin only)", () => {
    const value = csp("https://abcxyzcompany.supabase.co/some/path?x=1");
    expect(directive(value, "connect-src")).toContain(
      "https://abcxyzcompany.supabase.co",
    );
    expect(directive(value, "connect-src")).not.toContain("/some/path");
  });

  it("falls back to 'self' only when the env var is absent", () => {
    expect(directive(csp(), "connect-src")).toBe("'self'");
    expect(directive(csp(undefined), "connect-src")).toBe("'self'");
  });

  it("fails safe on a malformed URL (no crash, no broken directive)", () => {
    expect(directive(csp("not a url"), "connect-src")).toBe("'self'");
    expect(directive(csp("https://"), "connect-src")).toBe("'self'");
  });

  it("does not duplicate an origin equal to self-like scheme handling", () => {
    const value = csp("https://abcxyzcompany.supabase.co");
    const connect = directive(value, "connect-src").split(/\s+/);
    expect(
      connect.filter((o) => o === "https://abcxyzcompany.supabase.co"),
    ).toHaveLength(1);
  });
});

describe("companion headers (Phase 12 baseline preserved)", () => {
  const headers = buildSecurityHeaders("https://abc.supabase.co");
  const byKey = Object.fromEntries(headers.map((h) => [h.key, h.value]));

  it("keeps nosniff, DENY framing, strict referrer, locked permissions", () => {
    expect(byKey["x-content-type-options"]).toBe("nosniff");
    expect(byKey["x-frame-options"]).toBe("DENY");
    expect(byKey["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(byKey["permissions-policy"]).toContain("camera=()");
    expect(byKey["permissions-policy"]).toContain("geolocation=()");
  });

  it("emits exactly the six hardened headers", () => {
    expect(Object.keys(byKey).sort()).toEqual([
      "content-security-policy",
      "permissions-policy",
      "referrer-policy",
      "strict-transport-security",
      "x-content-type-options",
      "x-frame-options",
    ]);
  });

  it("enforces HSTS without commit-to-preload", () => {
    const hsts = byKey["strict-transport-security"];
    expect(hsts).toContain("max-age=63072000");
    expect(hsts).toContain("includeSubDomains");
    expect(hsts).not.toContain("preload");
  });
});

describe("next.config wiring guard", () => {
  const config = readFileSync(
    fileURLToPath(new URL("../next.config.ts", import.meta.url)),
    "utf8",
  );

  it("next.config.ts uses the tested builder (no inline/drifted policy)", () => {
    expect(config).toMatch(/buildSecurityHeaders/);
    expect(config).toMatch(/NEXT_PUBLIC_SUPABASE_URL/);
  });

  it("applies headers to every route", () => {
    expect(config).toMatch(/source:\s*["'][^"']*path\*["']/);
  });
});
