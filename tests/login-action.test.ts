import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Login / logout contract (Supabase Auth, server actions).
 *
 *  - credentials are validated before Supabase is touched;
 *  - every credential failure that is NOT an unconfirmed email produces the
 *    same generic message (no user enumeration);
 *  - an unconfirmed email is the exception: Supabase only returns
 *    "Email not confirmed" when the PASSWORD WAS CORRECT, so it discloses
 *    nothing new to the caller and it is the only way the user learns what to
 *    fix — the previous generic message left them stuck. It also flags
 *    `needsVerification` so the form can link to /verify;
 *  - sign-in attempts are capped per (hashed) client IP;
 *  - a successful sign-in redirects to /dashboard, logout clears the session
 *    and redirects to /login.
 */
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
  AUTH_RATE_LIMIT_MESSAGE:
    "Too many attempts from this device. Please wait a few minutes and try again.",
  clientIpKey: vi.fn(async () => "hashed-ip"),
  checkRateLimit: vi.fn(async () => ({
    allowed: true,
    count: 1,
    limit: 15,
    retryAfterSeconds: 0,
  })),
}));

const { login, logout } = await import("@/app/login/actions");
const { createClient } = await import("@/lib/supabase/server");
const { checkRateLimit } = await import("@/lib/rate-limit");

const signInWithPassword = vi.fn();
const signOut = vi.fn();

function mockClient() {
  vi.mocked(createClient).mockResolvedValue({
    auth: { signInWithPassword, signOut },
  } as never);
}

function form(email = "jane@example.com", password = "password123") {
  const body = new FormData();
  body.set("email", email);
  body.set("password", password);
  return body;
}

async function caught(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    return await fn();
  } catch (error) {
    return error;
  }
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("login", () => {
  it("rejects malformed input without calling Supabase", async () => {
    mockClient();
    expect(await login({}, form("not-an-email", ""))).toEqual({
      error: "Enter a valid email address.",
    });
    expect(await login({}, form("jane@example.com", ""))).toEqual({
      error: "Enter your password.",
    });
    expect(signInWithPassword).not.toHaveBeenCalled();
  });

  it("trims the email before authenticating", async () => {
    mockClient();
    signInWithPassword.mockResolvedValue({ error: { message: "Invalid login credentials" } });
    await login({}, form("  jane@example.com  "));
    expect(signInWithPassword).toHaveBeenCalledWith({
      email: "jane@example.com",
      password: "password123",
    });
  });

  it("gives one identical message for a wrong password and an unknown email", async () => {
    mockClient();
    signInWithPassword.mockResolvedValue({
      error: { message: "Invalid login credentials" },
    });
    expect(await login({}, form("jane@example.com", "wrong"))).toEqual({
      error: "Email or password is incorrect.",
    });
    expect(await login({}, form("nobody@example.com", "whatever"))).toEqual({
      error: "Email or password is incorrect.",
    });
  });

  it("tells an unconfirmed user exactly what to fix and points at /verify", async () => {
    mockClient();
    signInWithPassword.mockResolvedValue({
      error: { message: "Email not confirmed" },
    });
    const res = await login({}, form());
    expect(res).toEqual({
      error:
        "Your email address is not confirmed yet. Click the verification link we sent you, or request a new one.",
      needsVerification: true,
    });
  });

  it("rates limits sign-in attempts per hashed client IP (fail-open without one)", async () => {
    mockClient();
    vi.mocked(checkRateLimit).mockResolvedValueOnce({
      allowed: false,
      count: 16,
      limit: 15,
      retryAfterSeconds: 300,
    });
    expect(await login({}, form())).toEqual({
      error:
        "Too many attempts from this device. Please wait a few minutes and try again.",
    });
    expect(checkRateLimit).toHaveBeenCalledWith("login", "hashed-ip");
    expect(signInWithPassword).not.toHaveBeenCalled();
  });

  it("still signs in when the limiter itself throws (never blocks a legitimate user)", async () => {
    mockClient();
    vi.mocked(checkRateLimit).mockRejectedValueOnce(new Error("limiter down"));
    signInWithPassword.mockResolvedValue({ error: null });
    const error = await caught(() => login({}, form()));
    expect(String(error)).toContain("NEXT_REDIRECT:/dashboard");
  });

  it("redirects to /dashboard on success", async () => {
    mockClient();
    signInWithPassword.mockResolvedValue({ error: null });
    const error = await caught(() => login({}, form()));
    expect(String(error)).toContain("NEXT_REDIRECT:/dashboard");
  });
});

describe("logout", () => {
  it("clears the Supabase session and redirects to /login", async () => {
    mockClient();
    signOut.mockResolvedValue({ error: null });
    const error = await caught(() => logout());
    expect(String(error)).toContain("NEXT_REDIRECT:/login");
    expect(signOut).toHaveBeenCalledTimes(1);
  });
});
