import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * /auth/callback contract (Supabase Auth email confirmation):
 *  - exchanges the `code` for a session via the anon-key server client;
 *  - verifies a user actually exists before forwarding;
 *  - honors a same-origin relative `next` target (default /onboarding) and
 *    never performs an open redirect;
 *  - any failure lands on /login (no secrets, no raw errors in URLs).
 */
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const { redirect } = await import("next/navigation");
const { createClient } = await import("@/lib/supabase/server");
const AuthCallbackPage = (await import("@/app/auth/callback/page"))
  .default as (props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) => Promise<void>;

const exchangeCodeForSession = vi.fn();
const getUser = vi.fn();

function mockSupabase() {
  vi.mocked(createClient).mockResolvedValue({
    auth: { exchangeCodeForSession, getUser },
  } as never);
}

async function render(params: Record<string, string | string[] | undefined>) {
  // next/navigation redirect() always throws; the mocked spy records the URL
  // and then throws the same way.
  await expect(
    AuthCallbackPage({ searchParams: Promise.resolve(params) }),
  ).rejects.toThrow("NEXT_REDIRECT");
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("/auth/callback", () => {
  it("exchanges the code, verifies the session, and forwards to the next target", async () => {
    mockSupabase();
    exchangeCodeForSession.mockResolvedValue({ error: null });
    getUser.mockResolvedValue({ data: { user: { id: "u1" } } });

    await render({ code: "abc123", next: "/onboarding" });

    expect(exchangeCodeForSession).toHaveBeenCalledWith("abc123", undefined);
    expect(getUser).toHaveBeenCalled();
    expect(redirect).toHaveBeenCalledWith("/onboarding");
  });

  it("passes the PKCE sb_flow_id from the URL to the exchange", async () => {
    mockSupabase();
    exchangeCodeForSession.mockResolvedValue({ error: null });
    getUser.mockResolvedValue({ data: { user: { id: "u1" } } });

    await render({
      code: "abc123",
      sb_flow_id: "sb-1234567890abcdef",
      next: "/onboarding",
    });

    expect(exchangeCodeForSession).toHaveBeenCalledWith("abc123", {
      flowId: "sb-1234567890abcdef",
    });
    expect(redirect).toHaveBeenCalledWith("/onboarding");
  });

  it("defaults to /onboarding when no next param is given", async () => {
    mockSupabase();
    exchangeCodeForSession.mockResolvedValue({ error: null });
    getUser.mockResolvedValue({ data: { user: { id: "u1" } } });

    await render({ code: "abc123" });

    expect(redirect).toHaveBeenCalledWith("/onboarding");
  });

  it("honors a relative next target", async () => {
    mockSupabase();
    exchangeCodeForSession.mockResolvedValue({ error: null });
    getUser.mockResolvedValue({ data: { user: { id: "u1" } } });

    await render({ code: "abc123", next: "/opportunities" });

    expect(redirect).toHaveBeenCalledWith("/opportunities");
  });

  it("never open-redirects (//host or absolute URLs fall back to /onboarding)", async () => {
    mockSupabase();
    exchangeCodeForSession.mockResolvedValue({ error: null });
    getUser.mockResolvedValue({ data: { user: { id: "u1" } } });

    await render({ code: "abc123", next: "//evil.com/x" });
    expect(redirect).toHaveBeenCalledWith("/onboarding");

    vi.clearAllMocks();
    exchangeCodeForSession.mockResolvedValue({ error: null });
    getUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    await render({ code: "abc123", next: "https://evil.com" });
    expect(redirect).toHaveBeenCalledWith("/onboarding");
  });

  it("routes to /login when the code exchange fails (and logs it scrubbed)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockSupabase();
    exchangeCodeForSession.mockResolvedValue({
      error: {
        message:
          "PKCE validation failed: code_verifier does not match eyJhbGciOiJIUzI1NiJ9.eyJhIjoiYiJ9.ccc111111",
      },
    });

    await render({ code: "stale-code" });

    expect(redirect).toHaveBeenCalledWith("/login");
    expect(getUser).not.toHaveBeenCalled();
    const logged = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("[callback] code exchange failed");
    expect(logged).not.toContain("eyJhbGciOiJIUzI1NiJ9.eyJhIjoiYiJ9.ccc111111");
  });

  it("routes to /login when there is no code at all", async () => {
    mockSupabase();
    exchangeCodeForSession.mockResolvedValue({
      error: { message: "auth_code_required" },
    });

    await render({});

    expect(exchangeCodeForSession).toHaveBeenCalledWith("", undefined);
    expect(redirect).toHaveBeenCalledWith("/login");
  });

  it("routes to /login when no user exists after exchange", async () => {
    mockSupabase();
    exchangeCodeForSession.mockResolvedValue({ error: null });
    getUser.mockResolvedValue({ data: { user: null } });

    await render({ code: "abc123" });

    expect(redirect).toHaveBeenCalledWith("/login");
  });
});
