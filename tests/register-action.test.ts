import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Supabase Auth email-confirmation registration contract:
 *  - the invitation code is validated (service role) before any user is
 *    created;
 *  - the user is created with the standard anon-key `auth.signUp()` —
 *    Supabase itself sends the confirmation email (no Resend, no service
 *    role user creation, no 6-digit code);
 *  - full_name + invitation_code travel in the user metadata (the profile
 *    trigger and the confirmation trigger consume them);
 *  - emailRedirectTo points at /auth/callback?next=/onboarding;
 *  - success shows "check your email" — never claims the account is active;
 *  - raw provider errors are never leaked (they are logged scrubbed); the
 *    "already registered" message is preserved.
 */
vi.mock("@/lib/auth", () => ({
  validateInvitationCode: vi.fn(),
  getAuthCallbackUrl: () => {
    const appUrl = process.env.APP_URL?.trim().replace(/\/+$/, "");
    return appUrl ? `${appUrl}/auth/callback?next=/onboarding` : undefined;
  },
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
// The limiter is infrastructure (it needs a live Postgres); its own contract is
// covered by rate-limit.test.ts. Here it is stubbed ALLOWED by default so the
// register contract is what is under test — and stubbed DENIED in the dedicated
// abuse test below.
vi.mock("@/lib/rate-limit", () => ({
  AUTH_RATE_LIMIT_MESSAGE:
    "Too many attempts from this device. Please wait a few minutes and try again.",
  clientIpKey: vi.fn(async () => "hashed-ip"),
  checkRateLimit: vi.fn(async () => ({
    allowed: true,
    count: 1,
    limit: 8,
    retryAfterSeconds: 0,
  })),
}));

const { register } = await import("@/app/register/actions");
const { validateInvitationCode } = await import("@/lib/auth");
const { createClient } = await import("@/lib/supabase/server");
const { checkRateLimit, clientIpKey } = await import("@/lib/rate-limit");

const signUp = vi.fn();

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  (console.error as unknown as { mockRestore?: () => void }).mockRestore?.();
});

function mockSignUp(result: unknown) {
  signUp.mockResolvedValue(result);
  vi.mocked(createClient).mockResolvedValue({
    auth: { signUp },
  } as never);
}

function makeFormData(overrides: Record<string, string> = {}): FormData {
  const body = new FormData();
  body.set("fullName", "Jane Doe");
  body.set("email", "jane@example.com");
  body.set("password", "password123");
  body.set("invitationCode", "DRIF26");
  body.set("terms", "on");
  for (const [key, value] of Object.entries(overrides)) {
    if (value === "") body.delete(key);
    else body.set(key, value);
  }
  return body;
}

describe("register (Supabase Auth email confirmation)", () => {
  it("rejects invalid input before touching Supabase", async () => {
    mockSignUp({});
    const res = await register({ error: "" }, makeFormData({ fullName: "J" }));
    expect(res).toEqual({ error: "Enter your full name." });
    expect(signUp).not.toHaveBeenCalled();
  });

  it("rejects an invalid/expired invitation code", async () => {
    mockSignUp({});
    vi.mocked(validateInvitationCode).mockResolvedValue(false);
    const res = await register({ error: "" }, makeFormData());
    expect(res).toEqual({
      error: "That invitation code is invalid or no longer active.",
    });
    expect(signUp).not.toHaveBeenCalled();
  });

  it("signs the user up with metadata + emailRedirectTo and shows the check-your-email state", async () => {
    vi.stubEnv("APP_URL", "https://app.example.com/");
    mockSignUp({ data: { user: { id: "u1" }, session: null }, error: null });
    vi.mocked(validateInvitationCode).mockResolvedValue(true);

    const res = await register({ error: "" }, makeFormData());

    expect(res).toEqual({
      success:
        "Check your email and click the verification link to activate your account.",
    });
    expect(signUp).toHaveBeenCalledTimes(1);
    expect(signUp).toHaveBeenCalledWith({
      email: "jane@example.com",
      password: "password123",
      options: {
        data: {
          full_name: "Jane Doe",
          invitation_code: "DRIF26",
        },
        emailRedirectTo:
          "https://app.example.com/auth/callback?next=/onboarding",
      },
    });
  });

  it("leaves emailRedirectTo undefined when APP_URL is unset (dashboard Site URL fallback)", async () => {
    vi.stubEnv("APP_URL", "");
    mockSignUp({ data: { user: { id: "u1" }, session: null }, error: null });
    vi.mocked(validateInvitationCode).mockResolvedValue(true);

    const res = await register({ error: "" }, makeFormData());

    expect(res).toEqual(
      expect.objectContaining({
        success:
          "Check your email and click the verification link to activate your account.",
      }),
    );
    expect(signUp.mock.calls[0][0].options.emailRedirectTo).toBeUndefined();
  });

  it("keeps the existing 'already registered' message", async () => {
    mockSignUp({ data: null, error: { message: "User already registered" } });
    vi.mocked(validateInvitationCode).mockResolvedValue(true);

    const res = await register({ error: "" }, makeFormData());

    expect(res).toEqual({
      error: "An account with this email already exists.",
    });
  });

  it("passes through user-safe sign-up errors (anon-key messages)", async () => {
    mockSignUp({
      data: null,
      error: {
        message:
          "For your security, we limit login attempts after many failed attempts.",
      },
    });
    vi.mocked(validateInvitationCode).mockResolvedValue(true);

    const res = await register({ error: "" }, makeFormData());

    expect(res).toEqual({
      error:
        "For your security, we limit login attempts after many failed attempts.",
    });
  });

  it("logs scrubbed errors and returns a safe generic message when sign-up throws", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    signUp.mockRejectedValue(
      new Error(
        "fetch failed Bearer eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.aaaa1111bbbb",
      ),
    );
    vi.mocked(validateInvitationCode).mockResolvedValue(true);

    const res = await register({ error: "" }, makeFormData());

    expect(res).toEqual({
      error: "Registration is temporarily unavailable. Please try again.",
    });
    const logged = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("[register]");
    expect(logged).toContain("fetch failed");
    expect(logged).not.toContain(
      "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.aaaa1111bbbb",
    );
  });

  it("rejects a submission without the Terms acceptance (server-side, not just the checkbox)", async () => {
    mockSignUp({});
    const res = await register({ error: "" }, makeFormData({ terms: "" }));
    expect(res).toEqual({
      error: "Please accept the Terms of Service and Privacy Policy to continue.",
    });
    expect(signUp).not.toHaveBeenCalled();
    expect(validateInvitationCode).not.toHaveBeenCalled();
  });

  it("caps signup spam / invitation-code guessing per client IP before touching Supabase", async () => {
    mockSignUp({});
    vi.mocked(checkRateLimit).mockResolvedValueOnce({
      allowed: false,
      count: 9,
      limit: 8,
      retryAfterSeconds: 420,
    });

    const res = await register({ error: "" }, makeFormData());

    expect(res).toEqual({
      error:
        "Too many attempts from this device. Please wait a few minutes and try again.",
    });
    // The limiter is consulted with the HASHED client IP (never a raw address),
    // and nothing downstream runs.
    expect(clientIpKey).toHaveBeenCalledWith("register");
    expect(checkRateLimit).toHaveBeenCalledWith("register", "hashed-ip");
    expect(validateInvitationCode).not.toHaveBeenCalled();
    expect(signUp).not.toHaveBeenCalled();
  });

  it("still registers when the limiter itself throws (fail open)", async () => {
    mockSignUp({ data: { user: { id: "u1" }, session: null }, error: null });
    vi.mocked(validateInvitationCode).mockResolvedValue(true);
    vi.mocked(checkRateLimit).mockRejectedValueOnce(new Error("limiter down"));

    const res = await register({ error: "" }, makeFormData());

    expect(res).toEqual({
      success:
        "Check your email and click the verification link to activate your account.",
    });
    expect(signUp).toHaveBeenCalledTimes(1);
  });

  it("maps a database-level invitation rejection (race for the last use) to the invitation error", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Supabase Auth returns this opaque message when the on_auth_user_created
    // trigger raises — the real reason is only in the Postgres log.
    mockSignUp({
      data: null,
      error: { message: "Database error saving new user" },
    });
    vi.mocked(validateInvitationCode).mockResolvedValue(true);

    const res = await register({ error: "" }, makeFormData());

    expect(res).toEqual({
      error: "That invitation code is invalid or no longer active.",
    });
    // Diagnosable server-side, opaque to the client.
    expect(spy.mock.calls.map((c) => c.join(" ")).join("\n")).toContain(
      "[register]",
    );
  });
});
