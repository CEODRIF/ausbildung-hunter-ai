import { afterEach, describe, expect, it, vi } from "vitest";

// The register action must never leak a raw Supabase/DB/provider error to the
// browser, but it also must not swallow it silently. These tests pin that
// contract: a thrown step returns the safe generic message AND logs the
// failing step + non-sensitive error server-side, with credentials scrubbed.
vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  validateInvitationCode: vi.fn(),
  consumeInvitationCode: vi.fn(),
  createVerificationCode: vi.fn(),
}));
vi.mock("@/lib/verification-email", () => ({
  sendVerificationCodeEmail: vi.fn(),
  VerificationEmailError: class VerificationEmailError extends Error {},
}));

const { register } = await import("@/app/register/actions");
const { redirect } = await import("next/navigation");
const {
  validateInvitationCode,
  consumeInvitationCode,
  createVerificationCode,
} = await import("@/lib/auth");
const { createAdminClient } = await import("@/lib/supabase/admin");
const { createClient } = await import("@/lib/supabase/server");
const { sendVerificationCodeEmail, VerificationEmailError } =
  await import("@/lib/verification-email");

function makeFormData() {
  const fd = new FormData();
  fd.set("fullName", "Jane Doe");
  fd.set("email", "jane@example.com");
  fd.set("password", "supersecret123");
  fd.set("invitationCode", "DRIF928");
  return fd;
}

afterEach(() => {
  vi.clearAllMocks();
  (console.error as unknown as { mockRestore?: () => void }).mockRestore?.();
});

describe("register() error diagnostics", () => {
  it("returns the safe generic message but logs the failing step + upstream error", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const raw =
      "function public.validate_invitation_code(text, public.invitation_code_type) does not exist";
    vi.mocked(validateInvitationCode).mockRejectedValue(new Error(raw));

    const res = await register({} as never, makeFormData());

    expect(res).toEqual({
      error: "Registration is temporarily unavailable. Please try again.",
    });
    const logged = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain('step="validate_invitation_code"');
    expect(logged).toContain(raw);
    // The user-facing message must not contain the raw DB error.
    expect((res as { error: string }).error).not.toContain(raw);
  });

  it("scrubs credential-like values from the diagnostic log", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    vi.mocked(createAdminClient).mockReturnValue({
      auth: {
        admin: {
          createUser: vi
            .fn()
            .mockResolvedValue({ data: { user: { id: "u1" } }, error: null }),
        },
      },
      from: vi.fn(() => ({
        upsert: vi.fn().mockResolvedValue({ error: null }),
      })),
    } as never);
    vi.mocked(validateInvitationCode).mockResolvedValue(true);
    // Simulate a later step throwing with a token embedded in the message.
    vi.mocked(consumeInvitationCode).mockRejectedValue(
      new Error(`auth failed: Bearer ${jwt}`),
    );

    const res = await register({} as never, makeFormData());

    expect(res).toEqual({
      error: "Registration is temporarily unavailable. Please try again.",
    });
    const logged = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).not.toContain(jwt);
    expect(logged).not.toContain("supersecret123");
    expect(logged).toContain("[redacted");
  });

  it("still maps 'already registered' to the specific message without a diagnostic", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(validateInvitationCode).mockResolvedValue(true);
    vi.mocked(createAdminClient).mockReturnValue({
      auth: {
        admin: {
          createUser: vi
            .fn()
            .mockRejectedValue(new Error("User already registered")),
        },
      },
      from: vi.fn(),
    } as never);

    const res = await register({} as never, makeFormData());

    expect(res).toEqual({
      error: "An account with this email already exists.",
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("completes the intended flow, sends the code email, and redirects to /verify", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(validateInvitationCode).mockResolvedValue(true);
    vi.mocked(consumeInvitationCode).mockResolvedValue(true);
    vi.mocked(createVerificationCode).mockResolvedValue("123456");
    vi.mocked(sendVerificationCodeEmail).mockResolvedValue(undefined);
    vi.mocked(createAdminClient).mockReturnValue({
      auth: {
        admin: {
          createUser: vi
            .fn()
            .mockResolvedValue({ data: { user: { id: "u1" } }, error: null }),
        },
      },
      from: vi.fn(() => ({
        upsert: vi.fn().mockResolvedValue({ error: null }),
      })),
    } as never);
    vi.mocked(createClient).mockResolvedValue({
      auth: { signInWithPassword: vi.fn().mockResolvedValue({ error: null }) },
    } as never);

    let threw = false;
    try {
      await register({} as never, makeFormData());
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(redirect).toHaveBeenCalledWith("/verify");
    expect(createVerificationCode).toHaveBeenCalledWith("u1");
    // The email must carry the exact code returned by create_verification_code()
    // and go to the registered address.
    expect(sendVerificationCodeEmail).toHaveBeenCalledWith({
      email: "jane@example.com",
      code: "123456",
    });
  });

  it("never claims success when the verification email fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(validateInvitationCode).mockResolvedValue(true);
    vi.mocked(consumeInvitationCode).mockResolvedValue(true);
    vi.mocked(createVerificationCode).mockResolvedValue("123456");
    vi.mocked(sendVerificationCodeEmail).mockRejectedValue(
      new VerificationEmailError("verification_email_send_failed"),
    );
    vi.mocked(createAdminClient).mockReturnValue({
      auth: {
        admin: {
          createUser: vi
            .fn()
            .mockResolvedValue({ data: { user: { id: "u1" } }, error: null }),
        },
      },
      from: vi.fn(() => ({
        upsert: vi.fn().mockResolvedValue({ error: null }),
      })),
    } as never);
    vi.mocked(createClient).mockResolvedValue({
      auth: { signInWithPassword: vi.fn().mockResolvedValue({ error: null }) },
    } as never);

    const res = await register({} as never, makeFormData());

    expect(res).toEqual({
      error: "We couldn't send the verification email. Please try again.",
    });
    expect(redirect).not.toHaveBeenCalled();
  });
});
