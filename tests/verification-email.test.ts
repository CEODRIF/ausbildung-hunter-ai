import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Verification-code email (Resend) contract:
 *  - content carries the app name, the exact code, the 10-minute validity,
 *    and a do-not-share warning;
 *  - the code is used exactly as returned by create_verification_code();
 *  - failures never report success and never leak the API key, the sender
 *    address, or the code into server logs;
 *  - "Request a new code" (/verify) regenerates AND sends the email.
 */
const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));
vi.mock("resend", () => ({
  Resend: vi.fn().mockImplementation(() => ({ emails: { send: sendMock } })),
}));
const {
  buildVerificationCodeEmail,
  sendVerificationCodeEmail,
  VerificationEmailError,
} = await import("@/lib/verification-email");

const CODE = "123456";
const API_KEY = "re_abcdefghijklmnopqrstuvwxyz123456";
const FROM = "verification@my-domain.com";
const TO = "jane@example.com";

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  (console.error as unknown as { mockRestore?: () => void }).mockRestore?.();
});

describe("buildVerificationCodeEmail content", () => {
  it("includes the app name, the exact code, 10-minute validity, and a do-not-share warning", () => {
    const { subject, html } = buildVerificationCodeEmail(CODE);
    expect(subject).toContain("Ausbildung Hunter AI");
    expect(html).toContain("Ausbildung Hunter AI");
    expect(html).toContain(CODE);
    expect(html).toMatch(/valid for 10 minutes/i);
    expect(html).toMatch(/do not share/i);
  });

  it("escapes the code instead of injecting raw HTML", () => {
    const { html } = buildVerificationCodeEmail("<script>x</script>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("sendVerificationCodeEmail", () => {
  it("sends via Resend to the registered address with the given code", async () => {
    vi.stubEnv("RESEND_API_KEY", API_KEY);
    vi.stubEnv("RESEND_FROM_EMAIL", FROM);
    sendMock.mockResolvedValue({});
    await expect(
      sendVerificationCodeEmail({ email: TO, code: CODE }),
    ).resolves.toBeUndefined();
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: TO, from: FROM }),
    );
    const payload = sendMock.mock.calls[0][0];
    expect(payload.html).toContain(CODE);
  });

  it("throws VerificationEmailError when Resend is not configured (no provider call)", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("RESEND_FROM_EMAIL", "");
    await expect(
      sendVerificationCodeEmail({ email: TO, code: CODE }),
    ).rejects.toBeInstanceOf(VerificationEmailError);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("throws when the provider rejects, and scrubs the API key from the log", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("RESEND_API_KEY", API_KEY);
    vi.stubEnv("RESEND_FROM_EMAIL", FROM);
    sendMock.mockResolvedValue({
      error: { message: `Invalid API key ${API_KEY} provided` },
    });
    await expect(
      sendVerificationCodeEmail({ email: TO, code: CODE }),
    ).rejects.toBeInstanceOf(VerificationEmailError);
    const logged = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("[redacted-key]");
    expect(logged).not.toContain(API_KEY);
    expect(logged).not.toContain(FROM);
    expect(logged).not.toContain(CODE);
  });

  it("wraps network errors and never leaks the code into the log", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("RESEND_API_KEY", API_KEY);
    vi.stubEnv("RESEND_FROM_EMAIL", FROM);
    sendMock.mockRejectedValue(new Error("fetch failed"));
    await expect(
      sendVerificationCodeEmail({ email: TO, code: CODE }),
    ).rejects.toThrow(VerificationEmailError);
    const logged = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("fetch failed");
    expect(logged).not.toContain(API_KEY);
    expect(logged).not.toContain(CODE);
  });
});
