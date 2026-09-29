import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * /verify action contract: "Request a new code" must regenerate the code
 * AND deliver it by email — never claim success when the email fails.
 */
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  createVerificationCode: vi.fn(),
  verifyCode: vi.fn(),
}));
vi.mock("@/lib/verification-email", () => ({
  sendVerificationCodeEmail: vi.fn(),
  VerificationEmailError: class VerificationEmailError extends Error {},
}));

const { createClient } = await import("@/lib/supabase/server");
const { createVerificationCode } = await import("@/lib/auth");
const { sendVerificationCodeEmail, VerificationEmailError } =
  await import("@/lib/verification-email");
const { requestVerificationCode } = await import("@/app/verify/actions");

const CODE = "123456";
const TO = "jane@example.com";

function mockSessionUser(email: string | null) {
  vi.mocked(createClient).mockResolvedValue({
    auth: {
      getUser: async () => ({
        data: { user: email ? { id: "u1", email } : null },
      }),
    },
  } as never);
}

afterEach(() => {
  vi.clearAllMocks();
  (console.error as unknown as { mockRestore?: () => void }).mockRestore?.();
});

describe("verify page: 'Request a new code'", () => {
  it("regenerates the code AND sends it by email", async () => {
    vi.mocked(sendVerificationCodeEmail).mockResolvedValue(undefined);
    mockSessionUser(TO);
    vi.mocked(createVerificationCode).mockResolvedValue(CODE);

    const res = await requestVerificationCode({} as never, new FormData());

    expect(res).toEqual({
      success: "A new verification code has been sent to your email.",
    });
    expect(createVerificationCode).toHaveBeenCalledWith("u1");
    // The email must carry the exact code returned by the RPC.
    expect(sendVerificationCodeEmail).toHaveBeenCalledWith({
      email: TO,
      code: CODE,
    });
  });

  it("returns the safe retry message when the email fails (never success)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(sendVerificationCodeEmail).mockRejectedValue(
      new VerificationEmailError("verification_email_send_failed"),
    );
    mockSessionUser(TO);
    vi.mocked(createVerificationCode).mockResolvedValue(CODE);

    const res = await requestVerificationCode({} as never, new FormData());

    expect(res).toEqual({
      error: "We couldn't send the verification email. Please try again.",
    });
  });

  it("keeps the rate-limit message for rapid re-requests", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockSessionUser(TO);
    vi.mocked(createVerificationCode).mockRejectedValue(
      new Error("verification_rate_limited"),
    );

    const res = await requestVerificationCode({} as never, new FormData());

    expect(res).toEqual({
      error: "Please wait a minute before requesting another code.",
    });
    expect(sendVerificationCodeEmail).not.toHaveBeenCalled();
  });

  it("requires an authenticated session first", async () => {
    mockSessionUser(null);
    const res = await requestVerificationCode({} as never, new FormData());
    expect(res).toEqual({
      error: "Your session expired. Please sign in again.",
    });
    expect(createVerificationCode).not.toHaveBeenCalled();
  });
});
