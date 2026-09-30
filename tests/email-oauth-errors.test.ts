/**
 * Gmail OAuth callback — error surfacing.
 *
 * The callback redirects to /settings/email?error=connection_failed for ANY
 * failure inside its try block. The provider/DB details must survive in the
 * thrown message (and therefore in the function log) so the real cause —
 * e.g. Google's `invalid_client`, a 401 from userinfo, a missing
 * EMAIL_TOKEN_ENCRYPTION_KEY, or a PostgREST `42P01` — is diagnosable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const { createAdminClient } = await import("@/lib/supabase/admin");
const {
  exchangeGoogleCode,
  fetchGoogleIdentity,
  saveEmailAccount,
} = await import("@/lib/email-oauth");

function mockFetch(status: number, json?: unknown, nonJson = false) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (nonJson) throw new Error("body is not json");
        return json;
      },
    }),
  );
}

beforeEach(() => {
  vi.stubEnv("GOOGLE_CLIENT_ID", "test-client-id");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "test-client-secret");
  vi.stubEnv(
    "GOOGLE_REDIRECT_URI",
    "https://example.com/api/email/callback/gmail",
  );
  vi.stubEnv("EMAIL_TOKEN_ENCRYPTION_KEY", "0".repeat(64));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("exchangeGoogleCode", () => {
  it("keeps the happy path", async () => {
    mockFetch(200, {
      access_token: "at-123",
      refresh_token: "rt-456",
      expires_in: 3599,
      scope: "openid email",
    });
    const tokens = await exchangeGoogleCode("auth-code");
    expect(tokens.access_token).toBe("at-123");
    expect(tokens.refresh_token).toBe("rt-456");
  });

  it("surfaces Google's error code and description (e.g. bad client secret)", async () => {
    mockFetch(401, {
      error: "invalid_client",
      error_description: "Bad Request: client_secret is incorrect",
    });
    await expect(exchangeGoogleCode("auth-code")).rejects.toThrow(
      /Gmail authorization failed\. \(HTTP 401: invalid_client: Bad Request: client_secret is incorrect\)/,
    );
  });

  it("keeps the fallback when the error body is not JSON", async () => {
    mockFetch(502, undefined, true);
    await expect(exchangeGoogleCode("auth-code")).rejects.toThrow(
      /Gmail authorization failed\. \(HTTP 502\)/,
    );
  });
});

describe("fetchGoogleIdentity", () => {
  it("surfaces Google's error body on failure", async () => {
    mockFetch(401, {
      error: "invalid_scope",
      error_description: "Invalid or insufficient scope",
    });
    await expect(fetchGoogleIdentity("token")).rejects.toThrow(
      /Gmail account verification failed\. \(HTTP 401: invalid_scope: Invalid or insufficient scope\)/,
    );
  });

  it("keeps the fallback when the error body is not JSON", async () => {
    mockFetch(500, undefined, true);
    await expect(fetchGoogleIdentity("token")).rejects.toThrow(
      /Gmail account verification failed\. \(HTTP 500\)/,
    );
  });
});

describe("saveEmailAccount", () => {
  it("includes the PostgREST error code when the upsert fails", async () => {
    vi.mocked(createAdminClient).mockReturnValue({
      from: () => ({
        upsert: () => ({
          select: () => ({
            single: async () => ({
              data: null,
              error: {
                message:
                  'relation "public.email_accounts" does not exist',
                code: "42P01",
              },
            }),
          }),
        }),
      }),
    } as never);
    await expect(
      saveEmailAccount({
        userId: "u-1",
        provider: "gmail",
        providerAccountId: "google-sub",
        email: "user@example.com",
        accessToken: "at",
        refreshToken: null,
        expiresAt: null,
        scopes: ["openid"],
      }),
    ).rejects.toThrow(
      /Saving email account failed \[42P01\]: relation "public.email_accounts" does not exist/,
    );
  });

  it("propagates a missing encryption key as-is", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("GOOGLE_CLIENT_ID", "test-client-id");
    await expect(
      saveEmailAccount({
        userId: "u-1",
        provider: "gmail",
        providerAccountId: "google-sub",
        email: "user@example.com",
        accessToken: "at",
        refreshToken: null,
        expiresAt: null,
        scopes: ["openid"],
      }),
    ).rejects.toThrow(/EMAIL_TOKEN_ENCRYPTION_KEY is not configured/);
  });
});
