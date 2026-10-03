import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Limiter key for the UNAUTHENTICATED auth flows.
 *
 * The register / login / resend actions run before a session exists, so the
 * existing `scope:<user_id>` keying cannot apply. These tests pin the
 * replacement contract:
 *  - the first hop of `x-forwarded-for` (the client) is used, `x-real-ip` is
 *    the fallback;
 *  - the address is hashed before it becomes a limiter key, so the limiter
 *    table never stores a raw IP address (no personal data);
 *  - the key is stable per IP and scope, and distinct across IPs;
 *  - when the deployment exposes no IP header at all the helper returns null,
 *    which callers treat as FAIL OPEN (never lump every visitor into one
 *    shared bucket).
 */
const headerStore = new Map<string, string>();

vi.mock("next/headers", () => ({
  headers: async () => ({
    get: (name: string) => headerStore.get(name.toLowerCase()) ?? null,
  }),
}));

const { clientIpKey } = await import("@/lib/rate-limit");

afterEach(() => {
  headerStore.clear();
  vi.clearAllMocks();
});

describe("clientIpKey", () => {
  it("uses the first (client) hop of x-forwarded-for", async () => {
    headerStore.set("x-forwarded-for", "203.0.113.7, 70.41.3.18, 150.172.238.178");
    const key = await clientIpKey("login");
    expect(key).toBeTruthy();
    expect(key).toBe(await clientIpKey("login"));
  });

  it("falls back to x-real-ip", async () => {
    headerStore.set("x-real-ip", "198.51.100.9");
    expect(await clientIpKey("register")).toBeTruthy();
  });

  it("returns null when no IP header exists (callers fail open)", async () => {
    expect(await clientIpKey("register")).toBeNull();
  });

  it("never embeds the raw address in the key", async () => {
    headerStore.set("x-forwarded-for", "203.0.113.7");
    const key = (await clientIpKey("register")) as string;
    expect(key).not.toContain("203.0.113.7");
    expect(key).not.toContain("203");
    // sha256 hex prefix, comfortably inside the limiter's 200-char limit.
    expect(key).toMatch(/^[0-9a-f]{40}$/);
  });

  it("separates different IPs and different scopes", async () => {
    headerStore.set("x-forwarded-for", "203.0.113.7");
    const a = await clientIpKey("login");
    const b = await clientIpKey("register");
    headerStore.set("x-forwarded-for", "203.0.113.8");
    const c = await clientIpKey("login");
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});
